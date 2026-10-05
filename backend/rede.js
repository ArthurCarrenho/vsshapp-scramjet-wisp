// A política de rede do servidor wisp: por onde o motor resolve um nome e que destinos ele alcança.
//
// O motor sai do servidor Linux como a conta da pessoa, e quem pede é a página que ela abriu no
// navegador embutido, de qualquer site. A política responde duas perguntas, e as duas moram aqui,
// com bancada própria (`tests/rede.test.js`), porque nenhuma delas se prova sem tirá-la do
// `server.js`.
//
// ─── Família: IPv4 primeiro, IPv6 só quando não há IPv4 ─────────────────────────────────────────
//
// O `dns_method` do wisp-js é uma função nossa (`criarResolvedorIPv4`), e é o único lugar do pacote
// onde a família é decisão de quem o usa. Pedimos `{ family: 4 }` ao `dns.lookup` e recuamos para
// `{ family: 6 }` só quando o nome não tem registro A. Um host dual-stack sai por IPv4, que não
// depende de a rota IPv6 do servidor existir; um host só-AAAA (a infraestrutura de desafio do
// Cloudflare, `brunhild.challenges.cloudflare.com`, é um) continua alcançável.
//
// Destino IPv6 literal (`http://[2606:4700::1]/`) não chega ao DNS: a `hostname_blacklist` com
// `/:/` o recusa antes, no `is_stream_allowed`. Nome de host não tem dois pontos (RFC 1123), então
// a regra casa só literal IPv6. ⚠ Não configure `hostname_whitelist` junto: no wisp-js ela tem
// precedência e pula a blacklist inteira.
//
// ─── Destino: a régua, conferida sobre o endereço resolvido ─────────────────────────────────────
//
// `decidirDestino` decide sobre o IP que o socket vai usar, depois do DNS. Conferir o nome não
// basta: `metadata.google.internal`, `2130706433` e um domínio qualquer que aponte para `127.0.0.1`
// só mostram o que são depois de resolvidos, e o socket conecta no mesmo endereço que foi
// conferido, sem uma segunda resolução no meio. A régua:
//
//   - internet pública: sempre;
//   - link-local (169.254.0.0/16, fe80::/10, onde mora o metadata das nuvens), os endereços de
//     metadata fora dele, 0.0.0.0/8 (que no Linux conecta no loopback), multicast e reservados:
//     nunca;
//   - loopback: só a porta cujo socket em LISTEN, o que o kernel escolhe para a conexão, é desta
//     conta. O loopback do servidor é compartilhado entre as contas, e sem isto uma página alcança
//     o dev server, o Jupyter ou o Redis do vizinho. É o mesmo critério do `portaEhDoUsuario` do
//     portal (`src/services/portas-do-usuario.ts` no vssh-sso), com a mesma escada de bind;
//   - rede privada (RFC 1918, 100.64.0.0/10, fc00::/7): só com o nível de rede do servidor em 2
//     ou mais. O portal manda o nível no cabeçalho `X-Vssh-Rede-Nivel` do upgrade, apagando o que
//     vier do navegador; sem o cabeçalho, o nível é 0.
//
// UDP fica desligado: o transporte do navegador (libcurl sobre wisp) só abre TCP, e o DNS dele roda
// aqui no servidor.

import dns from 'node:dns/promises';
import net from 'node:net';
import { readFileSync } from 'node:fs';

// A regra que recusa literal IPv6. Exportada para a bancada poder afirmar o que ela casa e o que
// não casa, em vez de reescrever a regex no teste.
export const LITERAL_IPV6 = /:/;

// Teto de streams abertas numa conexão wisp, que é uma página do shell com todas as abas dela. O
// cliente abre até 16 conexões HTTP (`connections` no `ScramjetEngine.js`), e cada WebSocket de uma
// página proxiada é outra stream; 128 deixa folga para dezenas de abas. O wisp-js registra a stream
// antes de conferir o teto (`connection.mjs`), então o valor configurado é o teto mais 1.
export const TETO_DE_STREAMS = 128;

// Erros de resolução que significam "não há endereço DESTA família", e não "este nome não existe".
// `ENODATA` é o caso exato do host só-AAAA; o `dns.lookup` do Node reporta `ENOTFOUND` para ele em
// várias plataformas, então os dois entram.
const SEM_ENDERECO = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NODATA', 'EAI_NONAME']);

/**
 * Resolvedor de nomes que prefere IPv4 e recua para IPv6 quando o nome não tem registro A.
 *
 * @param {object}   [opcoes]
 * @param {Function} [opcoes.lookup]   `dns.lookup` (injetável: a bancada não toca a rede)
 * @param {Function} [opcoes.aoFalhar] chamado com (hostname, erro) quando a resolução falha de vez
 * @param {Function} [opcoes.aoRecuar] chamado com (hostname, endereço) quando cai para IPv6
 * @returns {(hostname: string) => Promise<string>}
 */
export function criarResolvedorIPv4({ lookup = dns.lookup, aoFalhar, aoRecuar } = {}) {
  return async function resolverPreferindoIPv4(hostname) {
    let erroV4;
    try {
      const { address } = await lookup(hostname, { family: 4 });
      return address;
    } catch (erro) {
      erroV4 = erro;
      // Nome que não existe, servidor de DNS fora, etc.: recuar para IPv6 não ajudaria em nada.
      if (!SEM_ENDERECO.has(erro?.code)) {
        try { aoFalhar?.(hostname, erro); } catch { /* diagnóstico não derruba resolução */ }
        throw erro;
      }
    }

    try {
      const { address } = await lookup(hostname, { family: 6 });
      try { aoRecuar?.(hostname, address); } catch { /* idem */ }
      return address;
    } catch {
      // Não tem A nem AAAA: o erro que interessa ao diagnóstico é o da família preferida.
      try { aoFalhar?.(hostname, erroV4); } catch { /* idem */ }
      throw erroV4;
    }
  };
}

// ─── A régua de destinos ─────────────────────────────────────────────────────────────────────────

function blocos(faixas) {
  const lista = new net.BlockList();
  for (const [endereco, prefixo] of faixas) {
    lista.addSubnet(endereco, prefixo, net.isIP(endereco) === 6 ? 'ipv6' : 'ipv4');
  }
  return lista;
}

const NUNCA = blocos([
  ['0.0.0.0', 8],          // "este host": no Linux, conectar em 0.0.0.0 é conectar no loopback
  ['169.254.0.0', 16],     // link-local, com o 169.254.169.254 das nuvens
  ['100.100.100.200', 32], // metadata da Alibaba, dentro do CGNAT
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reservado, com o broadcast
  ['::', 128],             // não especificado
  ['fe80::', 10],          // link-local
  ['fd00:ec2::254', 128],  // metadata IPv6 da AWS, dentro do ULA
  ['ff00::', 8],           // multicast
]);
const LOOPBACK = blocos([['127.0.0.0', 8], ['::1', 128]]);
const PRIVADA = blocos([['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['fc00::', 7]]);

/** `::ffff:10.0.0.1` vira `10.0.0.1`: o endereço mapeado conecta no IPv4 que carrega. */
function semMapeamento(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

/**
 * A classe de um endereço resolvido: `'publica'`, `'privada'`, `'loopback'` ou `'nunca'`.
 * Um texto que não é IP cai em `'nunca'`.
 */
export function classificarEndereco(ip) {
  const endereco = semMapeamento(String(ip || ''));
  const familia = net.isIP(endereco);
  if (!familia) return 'nunca';
  const tipo = familia === 6 ? 'ipv6' : 'ipv4';
  if (NUNCA.check(endereco, tipo)) return 'nunca';
  if (LOOPBACK.check(endereco, tipo)) return 'loopback';
  if (PRIVADA.check(endereco, tipo)) return 'privada';
  return 'publica';
}

/** O nível de rede que o portal mandou no upgrade. Ausente, fora de 0 a 3 ou não inteiro vira 0. */
export function nivelDoPedido(headers) {
  const valor = Number(headers?.['x-vssh-rede-nivel']);
  return Number.isInteger(valor) && valor >= 0 && valor <= 3 ? valor : 0;
}

// ─── O dono de uma porta do loopback ─────────────────────────────────────────────────────────────

/** Um IPv4 do `/proc/net/tcp`: 8 hex em ordem de byte do host (`0100007F` é 127.0.0.1). */
function ipv4DoProc(hex) {
  const b = (hex.match(/../g) || []).map((h) => parseInt(h, 16));
  return b.length === 4 ? `${b[3]}.${b[2]}.${b[1]}.${b[0]}` : '';
}

/** Um IPv6 do `/proc/net/tcp6`: quatro palavras de 32 bits, cada uma em ordem do host. */
function ipv6DoProc(hex) {
  const b = [];
  for (let w = 0; w < 4; w++) {
    const palavra = (hex.slice(w * 8, w * 8 + 8).match(/../g) || []).map((h) => parseInt(h, 16));
    if (palavra.length !== 4) return '';
    b.push(palavra[3], palavra[2], palavra[1], palavra[0]);
  }
  const grupos = [];
  for (let i = 0; i < 16; i += 2) grupos.push(((b[i] << 8) | b[i + 1]).toString(16));
  // `net.SocketAddress` normaliza para a forma curta (`::1`, `::ffff:127.0.0.1`, `::`).
  return new net.SocketAddress({ address: grupos.join(':'), family: 'ipv6' }).address;
}

/**
 * As linhas de `/proc/net/tcp` e `/proc/net/tcp6` em LISTEN, como `{ endereco, porta, uid }`.
 * Os campos são posicionais: 2º o endereço local, 4º o estado (`0A` = LISTEN), 8º o uid do dono.
 */
export function socketsEmEscuta(textos) {
  const lista = [];
  for (const texto of textos) {
    for (const linha of String(texto || '').split('\n').slice(1)) {
      const campos = linha.trim().split(/\s+/);
      if (campos.length < 8 || campos[3] !== '0A') continue;
      const [hexEndereco, hexPorta] = campos[1].split(':');
      const uid = parseInt(campos[7], 10);
      const porta = parseInt(hexPorta, 16);
      if (!hexEndereco || !Number.isInteger(uid) || !Number.isInteger(porta)) continue;
      const endereco = hexEndereco.length === 8 ? ipv4DoProc(hexEndereco) : ipv6DoProc(hexEndereco);
      if (endereco) lista.push({ endereco: semMapeamento(endereco), porta, uid });
    }
  }
  return lista;
}

/** Lê os sockets em LISTEN desta máquina. Um arquivo que não abre conta como vazio. */
export function lerSocketsEmEscuta() {
  const ler = (caminho) => { try { return readFileSync(caminho, 'utf8'); } catch { return ''; } };
  return socketsEmEscuta([ler('/proc/net/tcp'), ler('/proc/net/tcp6')]);
}

/**
 * O degrau de um bind para uma conexão ao endereço `alvo`: menor vence, `null` não recebe.
 *
 * O kernel entrega a conexão ao bind mais específico: o endereço exato ganha do wildcard IPv4
 * (`0.0.0.0`), que ganha do wildcard IPv6 (`::`), que recebe IPv4 quando é dual-stack (o padrão do
 * Linux, `net.ipv6.bindv6only=0`; o `/proc` não diz se um `::` é v6only). Um bind em `127.0.0.2`
 * não recebe a conexão a `127.0.0.1`, e um bind em `0.0.0.0` não recebe a conexão a `::1`.
 */
function degrauDoBind(bind, alvo) {
  if (bind === alvo) return 1;
  const alvoIpv4 = net.isIP(alvo) === 4;
  if (alvoIpv4 && bind === '0.0.0.0') return 2;
  if (bind === '::') return alvoIpv4 ? 3 : 2;
  return null;
}

/**
 * O uid do socket que o kernel escolheria para uma conexão a `alvo:porta`, ou `null` quando nada
 * escuta ali.
 *
 * Agrupa por porta antes de olhar o dono: a pergunta é "o kernel entrega esta conexão para mim?",
 * e não "tenho um socket aqui?". As duas divergem quando duas contas escutam na mesma porta em
 * binds diferentes.
 */
export function donoDaPorta(alvo, porta, sockets) {
  let vencedor = null;
  for (const s of sockets) {
    if (s.porta !== porta) continue;
    const degrau = degrauDoBind(s.endereco, alvo);
    if (degrau === null) continue;
    if (!vencedor || degrau < vencedor.degrau) vencedor = { degrau, uid: s.uid };
  }
  return vencedor ? vencedor.uid : null;
}

/**
 * A decisão sobre um destino já resolvido.
 *
 * @param {{ ip: string, porta: number, nivel: number, uid?: number, sockets?: () => Array }} pedido
 * @returns {{ permitido: boolean, classe: string, motivo?: string }}
 */
export function decidirDestino({ ip, porta, nivel, uid = process.getuid?.(), sockets = lerSocketsEmEscuta }) {
  const classe = classificarEndereco(ip);
  if (classe === 'publica') return { permitido: true, classe };
  if (classe === 'nunca') return { permitido: false, classe, motivo: 'endereco_proibido' };
  if (classe === 'privada') {
    return nivel >= 2 ? { permitido: true, classe } : { permitido: false, classe, motivo: 'rede_privada' };
  }
  const dono = donoDaPorta(semMapeamento(ip), porta, sockets());
  if (dono === null) return { permitido: false, classe, motivo: 'loopback_sem_escuta' };
  if (dono !== uid) return { permitido: false, classe, motivo: 'loopback_de_outra_conta' };
  return { permitido: true, classe };
}

/**
 * Aplica a política ao `wisp.options` e devolve o objeto de opções, para o chamador (e a bancada)
 * poderem afirmar sobre ele.
 *
 * O filtro do wisp-js (`is_stream_allowed`) confere a classe do endereço antes de resolver, por
 * duas chaves que só sabem dizer "toda a rede privada" ou "todo o loopback". A régua daqui precisa
 * da porta, do dono e do nível, então as duas chaves ficam abertas e a decisão acontece no socket
 * (`tcp.js`), sobre o endereço resolvido.
 */
export function aplicarPolitica(wisp, { lookup, aoFalhar, aoRecuar } = {}) {
  const opcoes = wisp.options;

  opcoes.dns_method = criarResolvedorIPv4({ lookup, aoFalhar, aoRecuar });

  // Recusa literal IPv6 como destino digitado. O IPv6 que vem do DNS (host só-AAAA) passa pelo
  // resolvedor e pela régua como qualquer outro endereço.
  opcoes.hostname_blacklist = [LITERAL_IPV6];

  opcoes.allow_private_ips  = true;
  opcoes.allow_loopback_ips = true;
  opcoes.allow_udp_streams  = false;

  // `stream_limit_total` conta `Object.keys(connection.streams)` e é seguro. O
  // `stream_limit_per_host` não pode ser ligado: no wisp-js 0.4.1 e 0.5.0 ele itera
  // `connection.streams`, que é um objeto, e derruba o processo na primeira conexão.
  opcoes.stream_limit_total = TETO_DE_STREAMS + 1;

  return opcoes;
}
