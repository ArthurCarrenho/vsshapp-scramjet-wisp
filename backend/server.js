// Backend do vssh-app "scramjet-wisp" — type: "engine" (ver SKILL.md), sem janela/frontend
// próprio. Serve dois papéis pro motor Scramjet consumido por ScramjetEngine.js (custom_xprahtml5):
//   1. servidor wisp (WebSocket) — o transporte que o BareCompatibleClient/LibcurlClient do lado
//      cliente usa pra abrir conexões TCP reais através deste processo;
//   2. estático dos bundles JS do Scramjet/scramjet-controller/libcurl-transport — servidos de
//      `backend/vendor/<pacote>/dist/`, nunca copiados/commitados em custom_xprahtml5/ (ver plano).
//
// Roda como qualquer outro vssh-app: bind 127.0.0.1:$VSSH_APP_PORT, iniciado sob demanda por
// AppLauncher.ensureRunning('scramjet-wisp') (não por AppLauncher.open() — não tem janela).

import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { aplicarPolitica } from './rede.js';
import { conferirVersoes, resumirVersoes, conferirMotor, resumirMotor } from './versoes.js';

const require = createRequire(import.meta.url);
const RAIZ = path.dirname(fileURLToPath(import.meta.url));

// Log estruturado em $VSSH_APP_DATA_DIR (~/.vssh-apps/<id>/data/app.log), do
// colabhd/vssh-app-toolkit — instalado por npm, como as outras dependências deste backend, e não
// mais copiado para dentro do repo. NÃO é redundante com o stdout: o portal manda stdout/stderr para
// ~/.vssh-apps/<id>/run.log, que é rotacionado a cada start e era truncado a cada relaunch do
// vssh-app-supervisor. Num incidente real, o app falhou 5 vezes seguidas e o operador encontrou
// run.log E run.log.1 os dois VAZIOS — a evidência apagada pelo próprio mecanismo que deveria
// guardá-la. Este arquivo fica fora desse caminho e sobrevive a reinício.
// Se a lib não estiver instalada, degrada para console em vez de derrubar o motor por causa do
// diagnóstico.
let log;
try {
  const { createAppLog } = require('vssh-app-toolkit/log');
  log = createAppLog({ appId: 'scramjet-wisp', stdout: false });
} catch {
  log = (event, detail) => console.error(`[scramjet-wisp] ${event}`, JSON.stringify(detail || {}));
}

// Onde escutar, do mesmo toolkit. Este NÃO degrada como o log acima: um motor sem log estruturado
// ainda serve navegação, mas um que não sabe onde escutar não sobe — e falhar aqui, nomeando o
// módulo ausente, é melhor que falhar depois sem dizer por quê.
//
// Continua por `require` (o do createRequire acima) e não por `import`: as libs do toolkit são
// CommonJS e este backend é ESM. Havia um `package.json` com "type": "commonjs" plantado dentro do
// vendor só para devolver aquela subárvore ao CommonJS; instalado por npm, o pacote traz o próprio
// e o problema deixa de existir.
const { escutar } = require('vssh-app-toolkit/listen');

// WARN (não NONE nem DEBUG): loga falhas reais de stream/conexão sem inundar o log com uma linha
// por abertura/fechamento de stream em uso normal.
logging.set_level(logging.WARN);

// Política de rede — IPv4 na saída, rede privada/loopback liberadas. Mora em `rede.js`, com
// bancada própria: são as opções que já derrubaram este serviço uma vez (ver o parágrafo do
// `stream_limit_total` logo abaixo), e não dá para provar nenhuma delas sem tirá-las daqui.
//
// A linha que estava aqui era `wisp.options.dns_result_order = 'ipv4first'`, com um comentário
// afirmando que aquilo evitava travar em host sem rota IPv6. **Era ordem, não família** — e
// deixava passar host só-AAAA e destino IPv6 literal. O `rede.js` explica os dois caminhos.
aplicarPolitica(wisp, {
  aoFalhar: (hostname, erro) => log('dns_falhou', { hostname, erro: erro?.code || String(erro) }),
  // Host só-AAAA. Não é erro — mas é a única situação em que uma conexão sai por IPv6, e saber
  // disso é o que separa "a rota IPv6 deste servidor está quebrada" de "o site está fora".
  aoRecuar: (hostname, endereco) => log('dns_recuou_ipv6', { hostname, endereco }),
});

// NÃO configurar wisp.options.stream_limit_total/stream_limit_per_host — tentativa real, revertida.
// Qualquer valor diferente de -1 (o default, "desabilitado") ativa is_stream_allowed()
// (node_modules/@mercuryworkshop/wisp-js/src/server/filter.mjs), que faz `for (let stream of
// connection.streams)` tratando connection.streams como iterável — mas connection.mjs guarda os
// streams num objeto plano (`this.streams[stream_id] = stream`), não um Map/Set. Resultado:
// `TypeError: connection.streams is not iterable`, crashando o processo inteiro na PRIMEIRA
// conexão — não é "arriscado sob carga pesada", quebra sempre. Confirmado em produção. O teto de
// concorrência do lado navegador (ScramjetEngine.js, opção `connections` do LibcurlClient) continua
// de pé e não usa esse caminho de código.

const TOKEN = process.env.VSSH_APP_TOKEN || null;

// A conferência do endereço saiu daqui: desde a v3 do toolkit são DUAS variáveis possíveis
// (VSSH_APP_SOCKET e VSSH_APP_PORT), e exigir a porta recusaria um motor perfeitamente configurado
// em socket. Quem confere é o `escutar()`, lá embaixo, e ele nomeia as duas quando não vem nenhuma.

// dist/ de cada pacote do motor, montado por caminho.
//
// Era `path.dirname(require.resolve(pkgName))`, com os quatro pacotes declarados como dependência
// npm. O comentário de então já dizia a parte mais importante: o resolve "só localiza o path pelo
// exports map, nunca executa o módulo". Ou seja, **nada em `backend/` importa esses pacotes** —
// pagávamos resolução, integrity, sincronia de lockfile, `--omit=dev` e hoisting para obter um
// nome de diretório.
//
// Agora o motor é construído neste repositório (`engines/` → `scripts/montar-motor.sh`) e viaja
// versionado em `backend/vendor/`. O que isso conserta, além de encurtar o caminho — cada item
// conferido no `infra/server/vssh-app-install` do vssh-sso, e não deduzido:
//
//   - a instalação para de baixar 14 MB de tarballs do GitHub a cada `npm ci` — e ele roda em TODA
//     instalação, porque a linha 335 passa `VSSH_APP_REBUILD=1`, que é o bypass do gate;
//   - a integridade sobe de nível: as linhas 112-113 já conferem o sha256 do tarball inteiro contra
//     o que o Worker declara, e abortam. Uma checagem no lugar de quatro, cobrindo mais;
//   - `vssh-app-install scramjet-wisp@4.0.N` passa a reverter app e motor JUNTOS;
//   - o `.installed-hash` (linha 355) exclui `*/node_modules/*`, então com o motor morando lá
//     dentro trocá-lo POR FORA do instalador não mudava o hash, e o portal não percebia que o
//     código mudou. Em `backend/vendor/`, percebe.
//
// ⚠ Este último item já esteve escrito aqui como "atualizar o motor não reiniciava o backend", e
// isso era FALSO no caminho normal: o bloco 2b do instalador (linhas 292-316) já dá `kill -TERM`
// em toda instância rodando, de qualquer usuário, antes do rsync. O ganho é o caso mais estreito
// acima — troca por fora do `--force` —, que é o que o `_computeInstalledHash` do portal cita.
function motorDir(dir) {
  return path.join(RAIZ, 'vendor', dir, 'dist');
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
//
// `pkg` continua sendo o nome do pacote e serve só para NOMEAR o problema em log e em 503 — é o
// que quem opera reconhece. Quem localiza os arquivos é `dir`, o diretório em `vendor/`.
const ROUTE_SPECS = [
  { prefix: '/scram/',      dir: 'scramjet',          pkg: '@mercuryworkshop/scramjet',            essential: true  },
  { prefix: '/controller/', dir: 'controller',        pkg: '@mercuryworkshop/scramjet-controller', essential: true  },
  { prefix: '/libcurl/',    dir: 'libcurl-transport', pkg: '@mercuryworkshop/libcurl-transport',   essential: true  },
  // scramjet-utils: bundle IIFE (dist/scramjet-utils.js) do HttpCachePlugin — serve o cache HTTP
  // (CacheStorage) do lado página, carregado sob demanda por ScramjetEngine.js. Mesmo `no-store`
  // dos demais assets do motor (frescor via importScripts/reload; não confundir com o cache de
  // páginas que o próprio plugin gerencia em caches.open('scramjet-http-cache-v2')).
  { prefix: '/utils/',      dir: 'utils',             pkg: '@mercuryworkshop/scramjet-utils',      essential: false },
];

const STATIC_ROUTES = [];
const MISSING = [];

// Some o try/catch que existia em volta do `require.resolve`: um caminho ou existe ou não, e
// `existsSync` responde isso sem lançar. O comportamento observável é o mesmo — porta aberta, 503
// nomeando o pacote —, que é o que importa e está coberto por teste no smoke.
for (const spec of ROUTE_SPECS) {
  const root = motorDir(spec.dir);
  if (existsSync(root)) {
    STATIC_ROUTES.push({ prefix: spec.prefix, root });
  } else {
    MISSING.push({ pkg: spec.pkg, prefix: spec.prefix, essential: spec.essential, reason: 'ENOENT' });
    log('package-unresolved', { package: spec.pkg, route: spec.prefix, essential: spec.essential, code: 'ENOENT' });
    console.error(
      `[scramjet-wisp] pacote ${spec.essential ? 'ESSENCIAL' : 'opcional'} ausente: ` +
      `${spec.pkg} (esperado em ${root}) — rota ${spec.prefix} indisponível. ` +
      `O motor viaja no tarball do app: reinstale com vssh-app-install scramjet-wisp --force.`
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
        // NÃO é mais `npm ci`: o motor deixou de ser dependência npm e viaja versionado no tarball
        // do app. Mandar rodar o installCommand aqui levaria quem opera a repetir um comando que
        // não pode consertar isto — o que falta é o pacote inteiro, e ele vem na reinstalação.
        hint: 'reinstale o app: sudo vssh-app-install scramjet-wisp --force',
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
        hint: 'reinstale o app: sudo vssh-app-install scramjet-wisp --force',
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

// Que versões estão realmente em disco. Roda no boot, antes do listen, porque o valor disto é
// aparecer no começo do log de um incidente — quem abre run.log depois de um problema vê a lista na
// primeira tela, sem procurar.
//
// Nunca fatal: um relatório de versões que derrubasse o motor seria pior que a cegueira que ele
// conserta. `conferirVersoes` já é escrito para não lançar, e o try aqui é a segunda rede.
let VERSOES = { pacotes: [], divergentes: [], lockAusente: false };
try {
  VERSOES = conferirVersoes({ raiz: RAIZ });
} catch (err) {
  log('versoes-falhou', { message: err.message });
}

// O motor não passa mais pelo npm, então não aparece no relatório acima. Ele responde à mesma
// pergunta, lendo os `BUILD.json` de `vendor/` — mesma regra: nunca fatal.
let MOTOR = { pacotes: [], ausentes: [], desalinhados: [] };
try {
  MOTOR = conferirMotor({ raiz: RAIZ, esperados: ROUTE_SPECS.map(s => s.dir) });
} catch (err) {
  log('motor-falhou', { message: err.message });
}

escutar(server).then(({ transporte, endereco }) => {
  console.log(`[scramjet-wisp] listening on ${endereco} (${transporte})`);
  for (const linha of resumirVersoes(VERSOES)) console.log(`[scramjet-wisp]   ${linha}`);
  for (const linha of resumirMotor(MOTOR)) console.log(`[scramjet-wisp]   ${linha}`);
  log('startup', {
    transporte,
    endereco,
    tokenGate: !!TOKEN,
    node: process.version,
    routes: STATIC_ROUTES.map(r => r.prefix),
    degraded: MISSING_ESSENTIAL.length > 0,
    missing: MISSING.map(m => m.pkg),
    // Objeto plano nome->versão: é o formato que se quer diffar entre dois boots.
    versoes: Object.fromEntries(VERSOES.pacotes.map(p => [p.nome, p.instalado])),
    versoesDivergentes: VERSOES.divergentes.map(p => ({ pacote: p.nome, instalado: p.instalado, lockfile: p.declarado })),
    motor: Object.fromEntries(MOTOR.pacotes.map(p => [p.dir, p.versao])),
    motorFonte: Object.fromEntries(MOTOR.pacotes.map(p => [p.dir, p.fonte])),
  });

  // Divergência não impede navegar, então não vira 503 — mas vai para stderr, em uma linha que
  // nomeia os pacotes. Foi a ausência EXATA desta linha que deixou o alpha.4 rodando por seis
  // releases: o motor funcionava, ninguém tinha motivo para desconfiar, e a única pista era um
  // stack trace com números de linha de outra versão.
  if (VERSOES.divergentes.length) {
    console.error(
      `[scramjet-wisp] ATENÇÃO: ${VERSOES.divergentes.length} dependência(s) fora do lockfile — ` +
      VERSOES.divergentes.map(p => `${p.nome} ${p.instalado ?? 'AUSENTE'} (lockfile pede ${p.declarado ?? '?'})`).join('; ') +
      `. Rode o installCommand do manifesto: cd backend && npm ci --omit=dev`
    );
  }
  if (VERSOES.lockAusente) {
    console.error('[scramjet-wisp] package-lock.json não encontrado — as versões acima não puderam ser conferidas.');
  }
  // Pacotes do mesmo fork com `fonte` diferente: o motor foi montado pela metade. Antes isso só
  // seria visto por um passo do CI comparando strings de versão dentro dos bundles; agora o próprio
  // boot acusa, que é onde a informação serve a quem está diante do incidente.
  if (MOTOR.desalinhados.length) {
    console.error(
      `[scramjet-wisp] ATENÇÃO: motor montado de árvores diferentes — ` +
      MOTOR.desalinhados.map(d => `${d.fork}: ${d.fontes.map(f => f.slice(0, 7)).join(' != ')}`).join('; ') +
      `. Os pacotes de um mesmo fork têm que sair do MESMO build.`
    );
  }
  if (MISSING_ESSENTIAL.length) {
    console.error(
      `[scramjet-wisp] DEGRADADO: ${MISSING_ESSENTIAL.map(m => m.pkg).join(', ')} ` +
      `não resolvido(s). O endereço está de pé e / responde 503 nomeando o problema, mas o motor ` +
      `não serve navegação.`
    );
  }
}).catch((err) => {
  // Outra instância já atende: é o contrato do lifecycle (o `vssh-app-run` sai 0 no mesmo caso), e
  // vale dobrado aqui, que é um `kind: service` relançado pelo supervisor com backoff. Sair 1 nesse
  // caso queimaria uma das cinco tentativas por um estado que está CERTO.
  if (err.code === 'VSSH_APP_JA_ESCUTANDO') {
    log('already-listening', { message: err.message });
    process.exit(0);
  }
  console.error('[scramjet-wisp] não consegui escutar:', err.message);
  log('fatal', { reason: 'listen falhou', message: err.message, code: err.code ?? null });
  process.exit(1);
});
