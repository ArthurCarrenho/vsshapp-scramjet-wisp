// A política de rede (`backend/rede.js`): por onde o motor resolve um nome e o que ele alcança. As
// opções do wisp-js mudam o comportamento de um jeito que só aparece quando alguém liga (o
// `stream_limit_per_host` derruba o processo na primeira conexão), então cada afirmação daqui roda
// contra o filtro real do pacote ou contra o `/proc` da máquina.
//
// Sem rede: o `dns.lookup` é injetado. Roda em CI como gate do publish.

import { test } from 'node:test';
import assert from 'node:assert';
import { packet, server as wisp } from '@mercuryworkshop/wisp-js/server';
import net from 'node:net';
import {
  aplicarPolitica, criarResolvedorIPv4, LITERAL_IPV6, classificarEndereco, decidirDestino, donoDaPorta,
  lerSocketsEmEscuta, nivelDoPedido, socketsEmEscuta,
} from '../rede.js';

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
const UDP = packet.stream_types.UDP;
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

test('host só-AAAA falha na resolução, na hora, sem perguntar por IPv6', async () => {
  // `brunhild.challenges.cloudflare.com` só tem AAAA. Numa máquina com rota IPv6 que não entrega
  // nada, a conexão a ele fica pendurada e o Turnstile termina em erro; com o nome falhando aqui, o
  // desafio segue (`bench/portal/turnstile.mjs`, `BENCH_BRUNHILD`).
  const familias = [];
  const resolver = criarResolvedorIPv4({
    lookup: async (_h, opcoes) => {
      familias.push(opcoes.family);
      if (opcoes.family === 4) throw Object.assign(new Error('getaddrinfo ENODATA'), { code: 'ENODATA' });
      return { address: '2606:4700::6812:1192', family: 6 };
    },
  });

  await assert.rejects(() => resolver('so-aaaa.exemplo'), (e) => e.code === 'ENODATA');
  assert.deepEqual(familias, [4]);
});

test('host dual-stack sai por IPv4', async () => {
  const familias = [];
  const resolver = criarResolvedorIPv4({
    lookup: async (_h, opcoes) => {
      familias.push(opcoes.family);
      return { address: opcoes.family === 4 ? '104.18.94.41' : '2606:4700::1' };
    },
  });

  assert.equal(await resolver('dual.exemplo'), '104.18.94.41');
  assert.deepEqual(familias, [4], 'nem chegou a perguntar por IPv6');
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

test('o filtro do wisp passa loopback e rede privada adiante, e a régua decide no socket', async () => {
  const pedidos = [];
  aplicarPolitica(wisp, {
    lookup: async (hostname) => { pedidos.push(hostname); return { address: '192.168.1.10' }; },
  });

  for (const h of ['docs.astro.build', 'localhost']) {
    assert.equal(await is_stream_allowed(null, TCP, h, 443), PERMITIDO, `devia permitir ${h}`);
  }
  // O filtro só sabe dizer "toda a rede privada" ou "todo o loopback"; a régua precisa da porta, do
  // dono e do nível, e roda no socket (tests/tcp.test.js).
  assert.equal(await is_stream_allowed(null, TCP, '192.168.1.10', 3000), PERMITIDO);
  assert.equal(await is_stream_allowed(null, TCP, '127.0.0.1', 3000), PERMITIDO);

  assert.deepEqual(pedidos, ['docs.astro.build', 'localhost'], 'só os nomes passaram pelo resolvedor');
});

test('o filtro do wisp recusa UDP: o transporte do navegador só abre TCP', async () => {
  aplicarPolitica(wisp, { lookup: async () => ({ address: '93.184.216.34' }) });
  assert.equal(await is_stream_allowed(null, UDP, 'dns.exemplo', 53), BLOQUEADO);
});

// ─── A régua de destinos ─────────────────────────────────────────────────────────────────

test('a classe de cada endereço, com os mapeados em IPv6 lidos pelo IPv4 que carregam', () => {
  const casos = {
    publica: ['93.184.216.34', '8.8.8.8', '2606:4700::6812:1192', '172.32.0.1', '100.128.0.1'],
    privada: ['10.0.0.5', '172.16.3.4', '192.168.1.10', '100.64.0.1', 'fd12::1', '::ffff:10.0.0.5'],
    loopback: ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'],
    nunca: [
      '169.254.169.254', '::ffff:169.254.169.254', '0.0.0.0', '0.1.2.3', '100.100.100.200',
      'fd00:ec2::254', 'fe80::1', '::', '224.0.0.1', '255.255.255.255', 'nao-e-ip', '',
    ],
  };
  for (const [classe, enderecos] of Object.entries(casos)) {
    for (const ip of enderecos) assert.equal(classificarEndereco(ip), classe, ip);
  }
});

test('o nível de rede vem do cabeçalho do portal, e o que não é 0 a 3 vira 0', () => {
  assert.equal(nivelDoPedido({ 'x-vssh-rede-nivel': '2' }), 2);
  assert.equal(nivelDoPedido({ 'x-vssh-rede-nivel': '3' }), 3);
  for (const valor of [undefined, '', '7', '-1', '1.5', 'abc', '2, 3']) {
    assert.equal(nivelDoPedido({ 'x-vssh-rede-nivel': valor }), 0, String(valor));
  }
  assert.equal(nivelDoPedido(undefined), 0);
});

/** Linhas no formato de /proc/net/tcp e /proc/net/tcp6, com o cabeçalho que o kernel escreve. */
function proc(linhas) {
  const cab = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  return [cab, ...linhas.map(([local, st, uid], i) =>
    `  ${i}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  ${uid}        0 ${1000 + i} 1 0000000000000000 100 0 0 10 0`)].join('\n');
}

test('os sockets em escuta saem do /proc com endereço, porta e dono, e só os em LISTEN', () => {
  const v4 = proc([
    ['0100007F:1F72', '0A', 1000],  // 127.0.0.1:8050
    ['00000000:0BB8', '0A', 1001],  // 0.0.0.0:3000
    ['0100007F:1F73', '01', 1000],  // conexão estabelecida, não é escuta
  ]);
  const v6 = proc([
    ['00000000000000000000000001000000:1F72', '0A', 1002], // ::1:8050
    ['00000000000000000000000000000000:0BB8', '0A', 1003], // :::3000
    ['0000000000000000FFFF00000100007F:22B8', '0A', 1004], // ::ffff:127.0.0.1:8888
  ]);
  assert.deepEqual(socketsEmEscuta([v4, v6]), [
    { endereco: '127.0.0.1', porta: 8050, uid: 1000 },
    { endereco: '0.0.0.0', porta: 3000, uid: 1001 },
    { endereco: '::1', porta: 8050, uid: 1002 },
    { endereco: '::', porta: 3000, uid: 1003 },
    { endereco: '127.0.0.1', porta: 8888, uid: 1004 },
  ]);
});

test('o dono de uma porta do loopback é quem o kernel escolhe, pelo bind mais específico', () => {
  const sockets = [
    { endereco: '::', porta: 8050, uid: 1 },        // A, wildcard IPv6
    { endereco: '0.0.0.0', porta: 8050, uid: 2 },   // B, wildcard IPv4
    { endereco: '127.0.0.2', porta: 9000, uid: 3 }, // outro endereço do loopback
    { endereco: '::', porta: 9100, uid: 4 },
  ];
  // Uma conexão a 127.0.0.1 vai para B: o wildcard IPv4 ganha do IPv6, mesmo com A escutando.
  assert.equal(donoDaPorta('127.0.0.1', 8050, sockets), 2);
  // Uma conexão a ::1 não chega ao 0.0.0.0, e vai para A.
  assert.equal(donoDaPorta('::1', 8050, sockets), 1);
  // 127.0.0.2 não recebe a conexão a 127.0.0.1.
  assert.equal(donoDaPorta('127.0.0.1', 9000, sockets), null);
  assert.equal(donoDaPorta('127.0.0.2', 9000, sockets), 3);
  // O `::` dual-stack recebe IPv4 quando nada mais escuta na porta.
  assert.equal(donoDaPorta('127.0.0.1', 9100, sockets), 4);
  assert.equal(donoDaPorta('127.0.0.1', 1234, sockets), null);
});

test('a régua: pública sempre, metadata nunca, privada pelo nível, loopback só a porta da conta', () => {
  const sockets = () => [
    { endereco: '127.0.0.1', porta: 8050, uid: 1000 },
    { endereco: '0.0.0.0', porta: 6379, uid: 1001 },
  ];
  const decidir = (ip, porta, nivel) => decidirDestino({ ip, porta, nivel, uid: 1000, sockets });

  assert.equal(decidir('93.184.216.34', 443, 0).permitido, true);
  for (const nivel of [0, 1, 2, 3]) {
    assert.deepEqual(decidir('169.254.169.254', 80, nivel), { permitido: false, classe: 'nunca', motivo: 'endereco_proibido' });
  }
  assert.deepEqual(decidir('10.0.0.5', 5432, 0), { permitido: false, classe: 'privada', motivo: 'rede_privada' });
  assert.equal(decidir('10.0.0.5', 5432, 1).permitido, false);
  assert.equal(decidir('10.0.0.5', 5432, 2).permitido, true);
  assert.equal(decidir('fd12::1', 80, 3).permitido, true);

  // O dev server da própria conta abre em qualquer nível; o Redis do vizinho, em nenhum.
  assert.equal(decidir('127.0.0.1', 8050, 0).permitido, true);
  assert.deepEqual(decidir('127.0.0.1', 6379, 3), { permitido: false, classe: 'loopback', motivo: 'loopback_de_outra_conta' });
  assert.deepEqual(decidir('127.0.0.1', 22, 3), { permitido: false, classe: 'loopback', motivo: 'loopback_sem_escuta' });
});

test('o dono lido do /proc desta máquina é esta conta, para um listener deste processo', async () => {
  const servidor = net.createServer().listen(0, '127.0.0.1');
  await new Promise((ok) => servidor.once('listening', ok));
  try {
    const { port } = servidor.address();
    assert.equal(donoDaPorta('127.0.0.1', port, lerSocketsEmEscuta()), process.getuid());
    assert.equal(decidirDestino({ ip: '127.0.0.1', porta: port, nivel: 0 }).permitido, true);
  } finally {
    servidor.close();
  }
});

// ─── O cache de nomes ──────────────────────────────────────────────────────────────────────────

function lookupContado(respostas) {
  const chamadas = [];
  const lookup = async (hostname) => {
    chamadas.push(hostname);
    const r = respostas.shift();
    if (typeof r === 'function') return r();
    if (r instanceof Error) throw r;
    return { address: r, family: 4 };
  };
  return { lookup, chamadas };
}
const erroDe = (code) => Object.assign(new Error(code), { code });

test('resoluções simultâneas do mesmo nome viram uma consulta só, e a seguinte vem do cache', async () => {
  let soltar;
  const { lookup, chamadas } = lookupContado([() => new Promise((ok) => { soltar = () => ok({ address: '203.0.113.7', family: 4 }); })]);
  const resolver = criarResolvedorIPv4({ lookup });
  const vinte = Array.from({ length: 20 }, () => resolver('cdn.exemplo.com'));
  await new Promise((r) => setImmediate(r));
  soltar();
  assert.deepEqual(new Set(await Promise.all(vinte)), new Set(['203.0.113.7']));
  assert.equal(await resolver('CDN.exemplo.com'), '203.0.113.7');
  assert.equal(chamadas.length, 1);
});

test('vencida a validade, o nome resolve de novo', async () => {
  let t = 0;
  const { lookup, chamadas } = lookupContado(['203.0.113.7', '203.0.113.8']);
  const resolver = criarResolvedorIPv4({ lookup, agora: () => t, validadeMs: 1000 });
  assert.equal(await resolver('a.exemplo.com'), '203.0.113.7');
  t = 999;
  assert.equal(await resolver('a.exemplo.com'), '203.0.113.7');
  t = 1001;
  assert.equal(await resolver('a.exemplo.com'), '203.0.113.8');
  assert.equal(chamadas.length, 2);
});

test('o resolvedor que não responde não derruba um nome já conhecido: o endereço vencido serve', async () => {
  let t = 0;
  const velhos = [];
  const { lookup } = lookupContado(['203.0.113.7', erroDe('EAI_AGAIN')]);
  const resolver = criarResolvedorIPv4({ lookup, agora: () => t, validadeMs: 1000, aoServirVelho: (h) => velhos.push(h) });
  await resolver('a.exemplo.com');
  t = 5000;
  assert.equal(await resolver('a.exemplo.com'), '203.0.113.7');
  assert.deepEqual(velhos, ['a.exemplo.com']);
});

test('o vencido também serve quando a resolução nova demora, e a nova entra no cache quando chega', async () => {
  let t = 0;
  let soltar;
  const { lookup, chamadas } = lookupContado(['203.0.113.7', () => new Promise((ok) => { soltar = () => ok({ address: '203.0.113.9', family: 4 }); })]);
  const resolver = criarResolvedorIPv4({ lookup, agora: () => t, validadeMs: 1000, esperaDoVelhoMs: 50 });
  await resolver('a.exemplo.com');
  t = 5000;
  const inicio = Date.now();
  assert.equal(await resolver('a.exemplo.com'), '203.0.113.7');
  assert.ok(Date.now() - inicio < 1000);
  soltar();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(await resolver('a.exemplo.com'), '203.0.113.9');
  assert.equal(chamadas.length, 2);
});

test('um nome que não existe fica guardado como falha por pouco tempo; uma falha do link, não', async () => {
  let t = 0;
  const { lookup, chamadas } = lookupContado([erroDe('ENOTFOUND'), erroDe('EAI_AGAIN'), erroDe('EAI_AGAIN'), '203.0.113.7']);
  const resolver = criarResolvedorIPv4({ lookup, agora: () => t, negativoMs: 1000 });
  await assert.rejects(resolver('nao.existe'), { code: 'ENOTFOUND' });
  await assert.rejects(resolver('nao.existe'), { code: 'ENOTFOUND' });
  assert.equal(chamadas.length, 1);
  await assert.rejects(resolver('lento.exemplo.com'), { code: 'EAI_AGAIN' });
  await assert.rejects(resolver('lento.exemplo.com'), { code: 'EAI_AGAIN' });
  assert.equal(await resolver('lento.exemplo.com'), '203.0.113.7');
  assert.equal(chamadas.length, 4);
});
