// Primeira bancada deste repo. Ela existe por um motivo concreto: **as opções do wisp-js já
// derrubaram este serviço.** `stream_limit_total` ativa um caminho que itera `connection.streams`
// como iterável, e ele é um objeto plano — o processo crashava na PRIMEIRA conexão, sempre, em
// produção. Uma opção que "parece certa" e não é só aparece quando alguém liga.
//
// O que se mede aqui é a política de saída (`backend/rede.js`): que ela força IPv4, que recusa
// destino IPv6 literal, e que NÃO regride o caso de uso principal do motor — rede privada e
// loopback, que é servidor de dev do usuário.
//
// Sem rede: o `dns.lookup` é injetado. Roda em CI como gate do publish.

import { test } from 'node:test';
import assert from 'node:assert';
import { packet, server as wisp } from '@mercuryworkshop/wisp-js/server';
import { aplicarPolitica, criarResolvedorIPv4, LITERAL_IPV6 } from '../rede.js';

// ⚠ Import por CAMINHO DE ARQUIVO, de propósito. `is_stream_allowed` não é reexportado pelo
// entrypoint público, e o `exports` do pacote bloqueia subpath — mas é ele que decide se uma
// stream abre, e a afirmação que sustenta o conserto do IPv6 literal é sobre a ORDEM das checagens
// DENTRO dele (a blacklist de hostname é conferida ANTES do ramo de IP direto). Uma bancada que
// não chegasse até aqui provaria a regex, não a proteção.
//
// Se o wisp-js reorganizar os arquivos, este import quebra — e quebrar é o comportamento certo:
// significa que a afirmação precisa ser reconferida, não que o teste virou chato.
import { is_stream_allowed } from '../node_modules/@mercuryworkshop/wisp-js/src/server/filter.mjs';

const TCP = packet.stream_types.TCP;
const BLOQUEADO = packet.close_reasons.HostBlocked;
const PERMITIDO = 0;

/** Um `wisp` de mentira, só com o que a política toca. */
function opcoesLimpas() {
  return { options: { dns_result_order: 'ipv4first' } };
}

// ─── O resolvedor decide FAMÍLIA ────────────────────────────────────────────────────────

test('resolver um nome pede explicitamente família 4', async () => {
  const chamadas = [];
  const resolver = criarResolvedorIPv4({
    lookup: async (hostname, opcoes) => {
      chamadas.push({ hostname, opcoes });
      return { address: '93.184.216.34', family: 4 };
    },
  });

  assert.equal(await resolver('exemplo.com'), '93.184.216.34');
  assert.deepEqual(chamadas, [{ hostname: 'exemplo.com', opcoes: { family: 4 } }]);
});

test('host só-AAAA falha NOMEADO em vez de pendurar a stream', async () => {
  // É a troca deliberada do conserto. Antes, `dns_result_order: 'ipv4first'` devolvia o IPv6 (a
  // "ordem" de uma lista sem nenhum IPv4 é a lista inteira), o wisp conectava nele sem recuo, e num
  // host sem rota IPv6 a stream travava calada — nem CONNECT-ack nem CLOSE voltavam.
  const erro = Object.assign(new Error('getaddrinfo ENOTFOUND só-aaaa.exemplo'), { code: 'ENOTFOUND' });
  const resolver = criarResolvedorIPv4({ lookup: async () => { throw erro; } });

  await assert.rejects(() => resolver('só-aaaa.exemplo'), (e) => e.code === 'ENOTFOUND');
});

test('a falha de resolução é comunicada, senão vira "a página não carrega" sem pista', async () => {
  const vistos = [];
  const erro = Object.assign(new Error('sem A'), { code: 'ENOTFOUND' });
  const resolver = criarResolvedorIPv4({
    lookup: async () => { throw erro; },
    aoFalhar: (hostname, e) => vistos.push([hostname, e.code]),
  });

  await assert.rejects(() => resolver('só-aaaa.exemplo'));
  assert.deepEqual(vistos, [['só-aaaa.exemplo', 'ENOTFOUND']]);
});

test('um `aoFalhar` que lança não engole o erro de verdade', async () => {
  const resolver = criarResolvedorIPv4({
    lookup: async () => { throw new Error('falha real'); },
    aoFalhar: () => { throw new Error('o log quebrou'); },
  });
  await assert.rejects(() => resolver('x.exemplo'), /falha real/);
});

// ─── aplicarPolitica ────────────────────────────────────────────────────────────────────

test('a política instala uma FUNÇÃO como dns_method — é o que decide família', async () => {
  const falso = opcoesLimpas();
  const o = aplicarPolitica(falso, { lookup: async () => ({ address: '1.2.3.4' }) });

  // Com `dns_method` sendo função, o `perform_lookup` do wisp devolve o que ela der e nunca chega
  // nos ramos que leem `dns_result_order`. Por isso a ordem deixou de ser configurada: manter a
  // linha seria manter algo que parece decidir e não decide.
  assert.equal(typeof o.dns_method, 'function');
  assert.equal(await o.dns_method('exemplo.com'), '1.2.3.4');
});

test('a política recusa literal IPv6 e não mexe em nome de host', () => {
  const o = aplicarPolitica(opcoesLimpas());
  const casa = (h) => o.hostname_blacklist.some((re) => re.test(h));

  for (const h of ['2606:4700::1', '[2606:4700::1]', '::1', 'fe80::1%eth0']) {
    assert.equal(casa(h), true, `devia recusar ${h}`);
  }
  // Dois pontos não aparece em nome de host (RFC 1123) — inclusive punycode, que é ASCII puro.
  for (const h of ['docs.astro.build', 'claude.ai', 'localhost', '127.0.0.1', 'xn--fsq.example', 'a-b_c.local']) {
    assert.equal(casa(h), false, `não devia recusar ${h}`);
  }
});

test('rede privada e loopback seguem liberadas — o caso de uso principal não regride', () => {
  const o = aplicarPolitica(opcoesLimpas());
  assert.equal(o.allow_private_ips, true);
  assert.equal(o.allow_loopback_ips, true);
});

test('a regex exportada é a mesma que a política instala', () => {
  const o = aplicarPolitica(opcoesLimpas());
  assert.deepEqual(o.hostname_blacklist, [LITERAL_IPV6]);
});

// ─── A prova de ponta: o filtro real do wisp ────────────────────────────────────────────

test('o filtro do wisp bloqueia IPv6 literal, e bloqueia ANTES de olhar IP direto', async () => {
  // `allow_direct_ip` é `true` por default, então sem a blacklist um `[2606:4700::1]` passaria
  // direto: o `lookup_ip` nem chega perto do DNS quando o destino já é um IP. É por isso que a
  // ordem importa, e é isto que este teste mede — não a regex, a proteção.
  const pedidos = [];
  aplicarPolitica(wisp, {
    lookup: async (hostname) => { pedidos.push(hostname); return { address: '93.184.216.34' }; },
  });

  for (const h of ['2606:4700::1', '[2606:4700::1]', '::1']) {
    assert.equal(await is_stream_allowed(null, TCP, h, 443), BLOQUEADO, `devia bloquear ${h}`);
  }
  assert.deepEqual(pedidos, [], 'nenhum deles chegou a pedir DNS: foram barrados antes');
});

test('o filtro do wisp deixa passar o que o motor existe para alcançar', async () => {
  const pedidos = [];
  aplicarPolitica(wisp, {
    lookup: async (hostname) => { pedidos.push(hostname); return { address: '192.168.1.10' }; },
  });

  for (const h of ['docs.astro.build', 'localhost']) {
    assert.equal(await is_stream_allowed(null, TCP, h, 443), PERMITIDO, `devia permitir ${h}`);
  }
  // IP privado literal: passa sem DNS, e é o servidor de dev do usuário.
  assert.equal(await is_stream_allowed(null, TCP, '192.168.1.10', 3000), PERMITIDO);
  assert.equal(await is_stream_allowed(null, TCP, '127.0.0.1', 3000), PERMITIDO);

  assert.deepEqual(pedidos, ['docs.astro.build', 'localhost'], 'só os nomes passaram pelo resolvedor');
});
