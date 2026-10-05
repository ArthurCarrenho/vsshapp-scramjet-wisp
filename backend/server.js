// Backend do vssh-app "scramjet-wisp", `type: engine`, sem janela nem frontend próprio. Ele serve
// dois papéis ao motor Scramjet que o `ScramjetEngine.js` do shell (`vssh-client/js/browser/`)
// consome:
//   1. o servidor wisp (WebSocket), o transporte pelo qual o LibcurlClient do lado cliente abre
//      conexões TCP reais através deste processo;
//   2. o estático dos bundles do Scramjet, do scramjet-controller e do libcurl-transport, servidos
//      de `backend/vendor/<pacote>/dist/`, que o shell nunca copia para dentro dele.
//
// Roda como qualquer outro vssh-app: escuta no socket unix de $VSSH_APP_SOCKET pelo runtime
// `vssh`, e o portal o sobe sob demanda (é `kind: service`, sem janela para abrir).

import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { server as wisp, logging } from '@mercuryworkshop/wisp-js/server';
import { aplicarPolitica, nivelDoPedido } from './rede.js';
import { criarSocketTcp } from './tcp.js';
import { conferirVersoes, resumirVersoes, conferirMotor, resumirMotor, hashDoMotor } from './versoes.js';

// O runtime de backend que o portal instala em `/opt/vssh/sdk/node` e que o `vssh-app-run` expõe
// pelo `NODE_PATH`. Este backend é ESM, e a resolução de ES modules do Node ignora o `NODE_PATH`,
// então o pacote entra pelo `createRequire`. Um servidor sem o runtime deixa este `require` lançar
// no topo do módulo, nomeando o pacote: o motor não tem como escutar sem ele, e morrer aqui diz o
// motivo, enquanto morrer no `listen` diria só que o endereço não abriu.
const { servidor } = createRequire(import.meta.url)('vssh');
const RAIZ = path.dirname(fileURLToPath(import.meta.url));

// Log estruturado em $VSSH_APP_DATA_DIR (~/.vssh-apps/<id>/data/app.log), NDJSON, uma linha por
// evento. Ele existe ao lado do stdout por causa do `run.log`: o portal manda stdout e stderr para
// `~/.vssh-apps/<id>/run.log`, e o lifecycle rotaciona esse arquivo a cada start, então um app que
// reinicia em laço apaga a própria evidência. Este arquivo fica fora desse caminho e sobrevive a
// reinício. `stdout: false` porque o boot já imprime o resumo humano lá embaixo, e repetir cada
// evento em JSON no `run.log` só encompridaria o que quem opera lê primeiro.
const log = servidor.criarLog({ stdout: false });

// WARN (não NONE nem DEBUG): loga falhas reais de stream/conexão sem inundar o log com uma linha
// por abertura/fechamento de stream em uso normal.
logging.set_level(logging.WARN);

// A política de rede (família de resolução, teto de streams e o que o motor alcança) mora em
// `rede.js`, com bancada própria; a régua de destinos roda no socket de cada stream (`tcp.js`).
aplicarPolitica(wisp, {
  aoFalhar: (hostname, erro) => log('dns_falhou', { hostname, erro: erro?.code || String(erro) }),
  // Host só-AAAA: a única situação em que uma conexão sai por IPv6. A linha no log separa "a rota
  // IPv6 deste servidor está quebrada" de "o site está fora".
  aoRecuar: (hostname, endereco) => log('dns_recuou_ipv6', { hostname, endereco }),
});

const TOKEN = process.env.VSSH_APP_TOKEN || null;

// Nenhuma conferência de endereço aqui: quem lê `VSSH_APP_SOCKET` é o `servidor.escutar()`, lá
// embaixo, e a mensagem dele distingue um ambiente sem endereço de um `vssh-app-run` antigo que só
// exporta `VSSH_APP_PORT`.

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

// A versão do motor que vai nas URLs do cliente (`/v/<versao>/scram/...`). Um arquivo servido por
// uma URL com a versão atual sai `immutable`, e o navegador não o pede de novo a cada navegação: o
// `controller.inject.js` e o `scramjet.js` que o controller injeta em todo documento reescrito,
// pelo túnel e pelo portal. Uma URL com outra versão recebe o arquivo atual com `no-store`, nunca
// um 404: o cliente que guardou a versão antiga continua funcionando até reler `/versao`.
const VERSAO = hashDoMotor(STATIC_ROUTES.map(r => r.root));
const PREFIXO_VERSIONADO = /^\/v\/([0-9a-f]{16})(\/.*)$/;

const MIME = {
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.map':  'application/json',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

async function tryServeStatic(req, res) {
  let url = req.url;
  let versaoPedida = null;
  const versionada = PREFIXO_VERSIONADO.exec(url);
  if (versionada) {
    versaoPedida = versionada[1];
    url = versionada[2];
  }
  const route = STATIC_ROUTES.find(r => url.startsWith(r.prefix));

  if (!route) {
    // Prefixo DECLARADO cujo pacote não resolveu. Sem este ramo a requisição cairia no catch-all
    // lá embaixo e receberia `200 scramjet-wisp ok` — texto puro servido no lugar de um bundle.
    // O estrago é silencioso e pior que um erro: _loadScript() resolve no onload mesmo quando o
    // corpo não é JS válido, então o cliente conclui que carregou o motor e segue com ele ausente.
    // 503 (não 404) porque o arquivo não está "faltando": o servidor é que está degradado, e é
    // essa distinção que diz ao operador para rodar o installCommand em vez de caçar um typo.
    const missing = MISSING.find(m => url.startsWith(m.prefix));
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

  // Um escape malformado (`%E0%A4%A`) faz o `decodeURIComponent` lançar. A página proxiada roda na
  // origem do portal e alcança estas rotas com `fetch`, então o caminho é dado de fora e responde
  // 400 como o traversal logo abaixo.
  let relPath;
  try {
    relPath = decodeURIComponent(url.slice(route.prefix.length).split('?')[0]);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  const filePath = path.join(route.root, relPath);

  // Nunca servir fora do dist/ do pacote (path traversal via "..").
  if (!filePath.startsWith(route.root + path.sep) && filePath !== route.root) {
    res.writeHead(400).end();
    return true;
  }

  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
    // A URL sem versão sai `no-store`. O `importScripts()` do `scram-sw.js`, que carrega o
    // `controller.sw.js`, só revalida o script principal do service worker (`updateViaCache:
    // "imports"`), e um importado com `max-age` seguiria velho depois de uma troca de motor. Na
    // URL versionada a troca muda a própria URL, e o cache não tem o que envelhecer. `private`,
    // porque a rota passa pela sessão do portal e nenhum cache compartilhado precisa guardá-la.
    res.writeHead(200, {
      'Content-Type':  MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': versaoPedida && versaoPedida === VERSAO
        ? 'private, max-age=31536000, immutable'
        : 'no-store',
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end();
  }
  return true;
}

// O que o cliente pergunta antes de montar as URLs: a versão atual e o `BUILD.json` de cada pacote.
function responderVersao(res) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({
    versao: VERSAO,
    pacotes: Object.fromEntries(MOTOR.pacotes.map(p => [p.dir, { versao: p.versao, origem: p.origem, fork: p.fork, fonte: p.fonte }])),
  }));
}

const server = createServer((req, res) => {
  if (req.url.split('?')[0] === '/versao') {
    responderVersao(res);
    return;
  }
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
  }).catch((err) => {
    // Sem este `.catch`, qualquer exceção no atendimento vira `unhandledRejection` e o Node encerra
    // o processo inteiro, com todas as conexões wisp de todas as abas junto.
    log('pedido-falhou', { url: req.url.split('?')[0], message: err?.message });
    if (!res.headersSent) res.writeHead(500);
    res.end();
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
    // O nível de rede vale para a conexão inteira: uma conexão wisp é uma página do shell, e o
    // portal escreve o cabeçalho a partir do servidor dela (ver `rede.js`).
    const nivel = nivelDoPedido(req.headers);
    wisp.routeRequest(req, socket, head, {
      TCPSocket: criarSocketTcp({
        nivel,
        resolver: wisp.options.dns_method,
        aoRecusar: ({ hostname, porta, ip, classe, motivo }) =>
          log('destino-recusado', { hostname, porta, ip, classe, motivo, nivel }),
      }),
    });
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

// O runtime anuncia sozinho `[scramjet-wisp] versão <v> escutando em <onde>`; o que vem abaixo é o
// que só este app sabe dizer.
servidor.escutar(server).then(({ transporte, endereco }) => {
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
    motorVersao: VERSAO,
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
  if (err.code === servidor.JA_ESCUTANDO) {
    log('already-listening', { message: err.message });
    process.exit(0);
  }
  console.error('[scramjet-wisp] não consegui escutar:', err.message);
  log('fatal', { reason: 'listen falhou', message: err.message, code: err.code ?? null });
  process.exit(1);
});
