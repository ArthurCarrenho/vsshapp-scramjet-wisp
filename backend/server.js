// Backend do vssh-app "scramjet-wisp" — type: "engine" (ver SKILL.md), sem janela/frontend
// próprio. Serve dois papéis pro motor Scramjet consumido por ScramjetEngine.js (custom_xprahtml5):
//   1. servidor wisp (WebSocket) — o transporte que o BareCompatibleClient/LibcurlClient do lado
//      cliente usa pra abrir conexões TCP reais através deste processo;
//   2. estático dos bundles JS do Scramjet/scramjet-controller/libcurl-transport — servidos
//      direto de node_modules/, nunca copiados/commitados em custom_xprahtml5/ (ver plano).
//
// Roda como qualquer outro vssh-app: bind 127.0.0.1:$VSSH_APP_PORT, iniciado sob demanda por
// AppLauncher.ensureRunning('scramjet-wisp') (não por AppLauncher.open() — não tem janela).

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';

const require = createRequire(import.meta.url);

// WARN (não NONE nem DEBUG): loga falhas reais de stream/conexão sem inundar o log com uma linha
// por abertura/fechamento de stream em uso normal.
logging.set_level(logging.WARN);

// wisp.NodeTCPSocket.connect() (node_modules/@mercuryworkshop/wisp-js/src/server/net.mjs) faz
// uma ÚNICA resolução DNS (dns.lookup com order: options.dns_result_order) e conecta só nesse
// endereço, sem fallback — diferente de curl, que tenta IPv6 e recua pra IPv4 sozinho. Em
// servidores cuja rota IPv6 esteja quebrada/indisponível (comum em VMs privadas), isso trava a
// stream inteira em silêncio: o cliente manda CONNECT, o servidor tenta a família errada e nunca
// responde (nem CONNECT-ack nem CLOSE chegam de volta a tempo). Forçar IPv4 primeiro evita isso
// sem depender de IPv6 funcionar neste host — destinos IPv4-only continuam OK.
wisp.options.dns_result_order = 'ipv4first';

// Sem isso, o wisp-js aplica os defaults do pacote (false/false) e bloqueia qualquer destino em
// rede privada/loopback — inviabilizando o caso de uso principal deste motor (servidores de dev
// locais, outras máquinas da rede do usuário). Mesmo modelo de confiança que o proxy-net do
// backend principal já usa pra RFC1918/loopback (BrowserWindow._isProxyNetTarget, custom_
// xprahtml5/js/BrowserWindow.js): a sessão autenticada do usuário já alcança essa rede por outro
// caminho, isto só estende a mesma capacidade pro motor Scramjet. allow_direct_ip já é true por
// default — não precisa setar.
wisp.options.allow_private_ips  = true;
wisp.options.allow_loopback_ips = true;

// NÃO configurar wisp.options.stream_limit_total/stream_limit_per_host — tentativa real, revertida.
// Qualquer valor diferente de -1 (o default, "desabilitado") ativa is_stream_allowed()
// (node_modules/@mercuryworkshop/wisp-js/src/server/filter.mjs), que faz `for (let stream of
// connection.streams)` tratando connection.streams como iterável — mas connection.mjs guarda os
// streams num objeto plano (`this.streams[stream_id] = stream`), não um Map/Set. Resultado:
// `TypeError: connection.streams is not iterable`, crashando o processo inteiro na PRIMEIRA
// conexão — não é "arriscado sob carga pesada", quebra sempre. Confirmado em produção. O teto de
// concorrência do lado navegador (ScramjetEngine.js, opção `connections` do LibcurlClient) continua
// de pé e não usa esse caminho de código.

const PORT  = parseInt(process.env.VSSH_APP_PORT, 10);
const TOKEN = process.env.VSSH_APP_TOKEN || null;

if (!Number.isFinite(PORT)) {
  console.error('[scramjet-wisp] VSSH_APP_PORT ausente/inválido.');
  process.exit(1);
}

// dist/ de cada pacote, resolvido via require.resolve (funciona mesmo sendo ESM-only — só
// localiza o path pelo exports map, nunca executa/`require()` o módulo de fato).
function distDirOf(pkgName) {
  return path.dirname(require.resolve(pkgName));
}

const STATIC_ROUTES = [
  { prefix: '/scram/',      root: distDirOf('@mercuryworkshop/scramjet') },
  { prefix: '/controller/', root: distDirOf('@mercuryworkshop/scramjet-controller') },
  { prefix: '/libcurl/',    root: distDirOf('@mercuryworkshop/libcurl-transport') },
  // scramjet-utils: bundle IIFE (dist/scramjet-utils.js) do HttpCachePlugin — serve o cache HTTP
  // (CacheStorage) do lado página, carregado sob demanda por ScramjetEngine.js. Mesmo `no-store`
  // dos demais assets do motor (frescor via importScripts/reload; não confundir com o cache de
  // páginas que o próprio plugin gerencia em caches.open('scramjet-http-cache-v2')).
  { prefix: '/utils/',      root: distDirOf('@mercuryworkshop/scramjet-utils') },
];

const MIME = {
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.map':  'application/json',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

async function tryServeStatic(req, res) {
  const route = STATIC_ROUTES.find(r => req.url.startsWith(r.prefix));
  if (!route) return false;

  const relPath  = decodeURIComponent(req.url.slice(route.prefix.length).split('?')[0]);
  const filePath = path.join(route.root, relPath);

  // Nunca servir fora do dist/ do pacote (path traversal via "..").
  if (!filePath.startsWith(route.root + path.sep) && filePath !== route.root) {
    res.writeHead(400).end();
    return true;
  }

  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
    // Sem cache: importScripts() (usado por custom_xprahtml5/sw.js pra carregar
    // controller.sw.js) só revalida o BYTE do script PRINCIPAL do SW por padrão
    // (updateViaCache: "imports") — scripts importados como este ficam sujeitos ao
    // cache HTTP normal. Com max-age, um SW recém-instalado (até depois de
    // unregister()+reload) continua executando uma cópia velha destes arquivos,
    // indefinidamente, até o cache expirar — nada nunca é "revertido" de verdade.
    res.writeHead(200, {
      'Content-Type':  MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
  return true;
}

const server = createServer((req, res) => {
  tryServeStatic(req, res).then(served => {
    if (served) return;
    // Healthcheck de startApp (ver key-provisioner.js) — só precisa de qualquer HTTP != '000'.
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('scramjet-wisp ok');
  });
});

server.on('upgrade', (req, socket, head) => {
  // Defesa em profundidade: a porta é só loopback, mas ainda alcançável por outro processo do
  // mesmo usuário Linux (ver SKILL.md) — este app concede egress real de internet, então vale a
  // checagem, diferente de um app que não expõe nada sensível.
  if (TOKEN && req.headers['x-vssh-app-token'] !== TOKEN) {
    socket.destroy();
    return;
  }
  if (req.url.split('?')[0].endsWith('/wisp/')) {
    wisp.routeRequest(req, socket, head);
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[scramjet-wisp] listening on 127.0.0.1:${PORT}`);
});
