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

// Log estruturado em $VSSH_APP_DATA_DIR (~/.vssh-apps/<id>/data/app.log), vendorizado do
// colabhd/vssh-app-toolkit. NÃO é redundante com o stdout: o portal manda stdout/stderr para
// ~/.vssh-apps/<id>/run.log, que é rotacionado a cada start e era truncado a cada relaunch do
// vssh-app-supervisor. Num incidente real, o app falhou 5 vezes seguidas e o operador encontrou
// run.log E run.log.1 os dois VAZIOS — a evidência apagada pelo próprio mecanismo que deveria
// guardá-la. Este arquivo fica fora desse caminho e sobrevive a reinício.
// Se a lib não estiver vendorizada, degrada para console em vez de derrubar o motor por causa do
// diagnóstico.
let log;
try {
  const { createAppLog } = require('./vendor/vssh/node/app-log.js');
  log = createAppLog({ appId: 'scramjet-wisp', stdout: false });
} catch {
  log = (event, detail) => console.error(`[scramjet-wisp] ${event}`, JSON.stringify(detail || {}));
}

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
  log('fatal', { reason: 'VSSH_APP_PORT ausente/inválido', value: process.env.VSSH_APP_PORT ?? null });
  process.exit(1);
}

// dist/ de cada pacote, resolvido via require.resolve (funciona mesmo sendo ESM-only — só
// localiza o path pelo exports map, nunca executa/`require()` o módulo de fato).
function distDirOf(pkgName) {
  return path.dirname(require.resolve(pkgName));
}

// Resolver NÃO pode ser fatal, e a razão é operacional, não estética. Antes, um require.resolve
// que falhasse derrubava o processo aqui, no topo do módulo — antes do listen() lá embaixo. O
// portal então media HTTP 000 ("não consegui conectar"), o que dispara a cascata inteira: túnel SSH
// derrubado, porta cacheada invalidada, 409 no proxy e um 502 na cara do usuário, sem UMA linha
// dizendo qual pacote faltava. Falhar com a porta aberta e um 503 nomeando o pacote é
// diagnosticável; morrer antes de escutar não é.
//
// `essential: false` no /utils/ alinha o servidor ao consumidor: ScramjetEngine.js:163 já carrega o
// scramjet-utils dentro de try/catch e degrada sem cache de página. O servidor era mais estrito que
// quem o consome — matava o motor inteiro por um bundle opcional.
const ROUTE_SPECS = [
  { prefix: '/scram/',      pkg: '@mercuryworkshop/scramjet',           essential: true  },
  { prefix: '/controller/', pkg: '@mercuryworkshop/scramjet-controller', essential: true  },
  { prefix: '/libcurl/',    pkg: '@mercuryworkshop/libcurl-transport',   essential: true  },
  // scramjet-utils: bundle IIFE (dist/scramjet-utils.js) do HttpCachePlugin — serve o cache HTTP
  // (CacheStorage) do lado página, carregado sob demanda por ScramjetEngine.js. Mesmo `no-store`
  // dos demais assets do motor (frescor via importScripts/reload; não confundir com o cache de
  // páginas que o próprio plugin gerencia em caches.open('scramjet-http-cache-v2')).
  { prefix: '/utils/',      pkg: '@mercuryworkshop/scramjet-utils',      essential: false },
];

const STATIC_ROUTES = [];
const MISSING = [];

for (const spec of ROUTE_SPECS) {
  try {
    STATIC_ROUTES.push({ prefix: spec.prefix, root: distDirOf(spec.pkg) });
  } catch (err) {
    MISSING.push({ pkg: spec.pkg, prefix: spec.prefix, essential: spec.essential, reason: err.code || String(err) });
    log('package-unresolved', { package: spec.pkg, route: spec.prefix, essential: spec.essential, code: err.code || null });
    console.error(
      `[scramjet-wisp] pacote ${spec.essential ? 'ESSENCIAL' : 'opcional'} não resolvido: ` +
      `${spec.pkg} (${err.code || err.message}) — rota ${spec.prefix} indisponível. ` +
      `Rode o installCommand do manifesto (npm ci --omit=dev em backend/).`
    );
  }
}

const MISSING_ESSENTIAL = MISSING.filter(m => m.essential);

const MIME = {
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.map':  'application/json',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

async function tryServeStatic(req, res) {
  const route = STATIC_ROUTES.find(r => req.url.startsWith(r.prefix));

  if (!route) {
    // Prefixo DECLARADO cujo pacote não resolveu. Sem este ramo a requisição cairia no catch-all
    // lá embaixo e receberia `200 scramjet-wisp ok` — texto puro servido no lugar de um bundle.
    // O estrago é silencioso e pior que um erro: _loadScript() resolve no onload mesmo quando o
    // corpo não é JS válido, então o cliente conclui que carregou o motor e segue com ele ausente.
    // 503 (não 404) porque o arquivo não está "faltando": o servidor é que está degradado, e é
    // essa distinção que diz ao operador para rodar o installCommand em vez de caçar um typo.
    const missing = MISSING.find(m => req.url.startsWith(m.prefix));
    if (missing) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        status: 'degraded',
        error: `pacote não resolvido: ${missing.pkg}`,
        route: missing.prefix,
        essential: missing.essential,
        reason: missing.reason,
        hint: 'rode o installCommand do manifesto: cd backend && npm ci --omit=dev',
      }));
      return true;
    }
    return false;
  }

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

    // Healthcheck de startApp (ver provisioning/vssh-apps.ts). Desde o commit 7bd90e1 do vssh-sso
    // um 5xx NÃO conta mais como pronto — e aqui isso joga a favor: se falta pacote essencial, o
    // 503 faz o portal registrar `ready:false` com `lastCode:503` e o cliente mostrar o aviso
    // (AppLauncher.js), em vez do silêncio de um 200 mentiroso ou do 000 de um processo morto.
    // O corpo nomeia o pacote, que é o que falta para diagnosticar sem acesso ao servidor.
    if (MISSING_ESSENTIAL.length) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        status: 'degraded',
        error: 'pacotes essenciais do motor não resolvidos',
        missing: MISSING.map(m => ({ package: m.pkg, route: m.prefix, essential: m.essential, reason: m.reason })),
        hint: 'rode o installCommand do manifesto: cd backend && npm ci --omit=dev',
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('scramjet-wisp ok');
  });
});

server.on('upgrade', (req, socket, head) => {
  // Defesa em profundidade: a porta é só loopback, mas ainda alcançável por outro processo do
  // mesmo usuário Linux (ver SKILL.md) — este app concede egress real de internet, então vale a
  // checagem, diferente de um app que não expõe nada sensível.
  if (TOKEN && req.headers['x-vssh-app-token'] !== TOKEN) {
    // Vale logar: um upgrade recusado por token é indistinguível, do lado do navegador, de rede
    // caída — o ScramjetEngine só vê o socket fechar. Sem esta linha, um token dessincronizado
    // entre portal e app (ex.: env file reescrito com o app já no ar) vira horas de caça.
    log('upgrade-rejected', { reason: 'token', hasHeader: !!req.headers['x-vssh-app-token'] });
    socket.destroy();
    return;
  }
  if (req.url.split('?')[0].endsWith('/wisp/')) {
    wisp.routeRequest(req, socket, head);
  } else {
    log('upgrade-rejected', { reason: 'path', url: req.url.split('?')[0] });
    socket.destroy();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[scramjet-wisp] listening on 127.0.0.1:${PORT}`);
  log('startup', {
    port: PORT,
    tokenGate: !!TOKEN,
    node: process.version,
    routes: STATIC_ROUTES.map(r => r.prefix),
    degraded: MISSING_ESSENTIAL.length > 0,
    missing: MISSING.map(m => m.pkg),
  });
  if (MISSING_ESSENTIAL.length) {
    console.error(
      `[scramjet-wisp] DEGRADADO: ${MISSING_ESSENTIAL.map(m => m.pkg).join(', ')} ` +
      `não resolvido(s). A porta está aberta e / responde 503 nomeando o problema, mas o motor ` +
      `não serve navegação.`
    );
  }
});
