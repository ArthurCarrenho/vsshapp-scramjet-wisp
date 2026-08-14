// Política de rede do servidor wisp: **a saída é IPv4, e só.**
//
// ─── Por que isto virou um arquivo ─────────────────────────────────────────────────────────
//
// Este repo já derrubou produção com uma opção do wisp-js: `stream_limit_total` ativa um caminho
// de código que itera `connection.streams` como se fosse iterável, e ele é um objeto plano — o
// processo crashava na PRIMEIRA conexão, sempre. Está escrito no `server.js`, no comentário que
// existe justamente para ninguém tentar de novo.
//
// A lição que sobrou não é "não mexer nas opções": é que as opções deste pacote merecem estar num
// lugar que dê para TESTAR sem subir o servidor. É o que este arquivo é, e é por isso que ele
// aceita `lookup` injetado — a bancada roda em CI sem tocar a rede.
//
// ─── O que estava errado ───────────────────────────────────────────────────────────────────
//
// Havia `wisp.options.dns_result_order = 'ipv4first'`, com um comentário dizendo que aquilo evitava
// travar em host sem rota IPv6. **`dns_result_order` é ORDEM, não família.** Ele diz por onde
// COMEÇAR a lista; não impede o IPv6 de ser escolhido. E o `wisp-js@0.4.1` não tem opção de
// família nenhuma — conferido lendo as 21 opções que ele expõe.
//
// Sobravam dois caminhos por onde o IPv6 saía:
//
//   1. **Host só-AAAA.** `dns.lookup(host, {order:'ipv4first'})` num nome que só tem AAAA devolve
//      o IPv6 — "primeiro os IPv4" de uma lista sem nenhum IPv4 é a lista inteira. O
//      `NodeTCPSocket.connect()` do wisp conecta nesse único endereço e não tem recuo (diferente
//      do curl, que tenta e volta sozinho). Em servidor sem rota IPv6 isso não dá erro: a stream
//      trava calada, porque nem CONNECT-ack nem CLOSE voltam.
//
//   2. **Destino IPv6 literal.** `lookup_ip()` começa com `net.isIP(hostname)` e devolve o próprio
//      hostname quando já é um IP — ou seja, um `http://[2606:4700::1]/` nunca chega perto do DNS,
//      e nenhuma configuração de resolução o alcança.
//
// ─── Como cada um é fechado ────────────────────────────────────────────────────────────────
//
// **(1) `dns_method` como FUNÇÃO.** É o único lugar do wisp-js onde a família é decisão nossa:
// `perform_lookup` faz `return await options.dns_method(hostname)` e não olha mais nada. Pedimos
// `{ family: 4 }` ao `dns.lookup`, então host só-AAAA falha com `ENOTFOUND` — rápido e nomeado, no
// lugar da trava silenciosa de hoje. É uma troca deliberada: um host só-AAAA deixa de funcionar de
// um jeito que dá para ler no log, em vez de não funcionar de um jeito que ninguém consegue
// diagnosticar.
//
// O `dns_result_order` sai de cena junto, e não por arrumação: com `dns_method` sendo função, o
// `perform_lookup` nem chega nos ramos que o leem. Mantê-lo escrito seria manter uma linha que
// parece decidir algo e não decide — que é exatamente o defeito que este arquivo veio consertar.
//
// **(2) `hostname_blacklist = [/:/]`.** Dois pontos não aparece em nome de host (RFC 1123), então
// a única coisa que essa regra casa é literal IPv6 — nas três formas: `2606:4700::1`,
// `[2606:4700::1]` e `::1`. E ela é conferida ANTES do ramo de IP direto no `is_stream_allowed`,
// então chega antes do `allow_direct_ip`; o `connection.mjs` fecha a stream com motivo.
//
// ⚠ **Não configure `hostname_whitelist` junto.** No `is_stream_allowed` a whitelist tem
// precedência e o `else if` pula a blacklist inteira — ligar uma desligaria esta proteção sem
// nenhum aviso.
//
// **(3) Entrada: não há o que fazer, e isso fica escrito.** O `escutar()` do toolkit v4 só faz
// `server.listen(caminho)` sobre socket unix — não existe superfície IPv6 de entrada para desligar.
// Está aqui porque "conferi e não havia nada" é informação; da próxima vez ninguém precisa
// reconferir.

import dns from 'node:dns/promises';

// A regra que recusa literal IPv6. Exportada para a bancada poder afirmar o que ela casa e o que
// não casa, em vez de reescrever a regex no teste.
export const LITERAL_IPV6 = /:/;

/**
 * Resolvedor de nomes que decide FAMÍLIA.
 *
 * @param {object}   [opcoes]
 * @param {Function} [opcoes.lookup]   `dns.lookup` (injetável — a bancada não toca a rede)
 * @param {Function} [opcoes.aoFalhar] chamado com (hostname, erro) quando a resolução falha
 * @returns {(hostname: string) => Promise<string>}
 */
export function criarResolvedorIPv4({ lookup = dns.lookup, aoFalhar } = {}) {
  return async function resolverIPv4(hostname) {
    try {
      const { address } = await lookup(hostname, { family: 4 });
      return address;
    } catch (erro) {
      // O erro SOBE — é ele que faz a stream fechar com motivo em vez de pendurar. O callback é só
      // para o chamador poder registrar: sem isto, "site que só tem AAAA" chega ao usuário como
      // uma página que não carrega, sem uma linha em lugar nenhum dizendo por quê.
      try { aoFalhar?.(hostname, erro); } catch { /* diagnóstico não derruba resolução */ }
      throw erro;
    }
  };
}

/**
 * Aplica a política inteira sobre um `wisp.options`. Devolve o objeto de opções, para o chamador
 * (e a bancada) poderem afirmar sobre ele.
 */
export function aplicarPolitica(wisp, { lookup, aoFalhar } = {}) {
  const opcoes = wisp.options;

  opcoes.dns_method        = criarResolvedorIPv4({ lookup, aoFalhar });
  opcoes.hostname_blacklist = [LITERAL_IPV6];

  // Sem isto o wisp-js aplica os defaults do pacote (false/false) e bloqueia qualquer destino em
  // rede privada/loopback — o que inviabiliza o caso de uso principal deste motor: servidor de dev
  // local, outras máquinas da rede do usuário. Mesmo modelo de confiança que o proxy-net do backend
  // principal já usa para RFC1918/loopback: a sessão autenticada já alcança essa rede por outro
  // caminho, e isto só estende a mesma capacidade ao motor.
  //
  // Fica aqui, junto do resto, porque estas duas e a blacklist são a MESMA decisão vista de dois
  // lados: o que este motor pode alcançar. Separá-las foi o que deixou o IPv6 passar despercebido.
  opcoes.allow_private_ips  = true;
  opcoes.allow_loopback_ips = true;

  return opcoes;
}
