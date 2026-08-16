// Quantas conexões TCP o libcurl realmente abre para servir N requisições ao MESMO host?
//
// É a pergunta que decide se falta multiplexação. O wasm tem nghttp2 compilado (75 referências),
// mas ter o código não é usá-lo: para reaproveitar uma conexão HTTP/2 em requisições paralelas, o
// multi handle precisa de CURLPIPE_MULTIPLEX. Sem isso o curl abre uma conexão nova por requisição
// paralela mesmo contra um servidor h2 — e aí cada uma paga TLS do zero, em software, na thread
// única do WASM. Seria a explicação de por que mais conexões deixou tudo MAIS LENTO nos sites reais.
//
// Medir pelo lado do servidor wisp é definitivo: ali cada stream é um `net.connect` de verdade.
// Um navegador com h2 abriria ~1 conexão para 60 requisições ao mesmo host.
import { createServer } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// O backend deste mesmo repositório, por padrão — a bancada mede o que o app instala.
const BACKEND = process.env.BENCH_BACKEND || path.join(AQUI, '..', 'backend');
const PORT = Number(process.env.BENCH_PORT || 39540);

// Contador. O wisp abre saída com `new net.Socket()` seguido de `.connect()` (ver
// wisp-js/src/server/net.mjs:134), não com `net.connect()` — então é o prototype que precisa ser
// envolvido. Envolver a função de módulo não pegava nada, e "zero conexões" parecia resultado.
const porHost = new Map();
const connectOriginal = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  const chave = `${o.host ?? '?'}:${o.port ?? '?'}`;
  porHost.set(chave, (porHost.get(chave) || 0) + 1);
  return connectOriginal.apply(this, args);
};

const { server: wisp, logging } = await import(
  pathToFileURL(path.join(BACKEND, 'node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs')).href
);
const { aplicarPolitica } = await import(pathToFileURL(path.join(BACKEND, 'rede.js')).href);
logging.set_level(logging.WARN);
aplicarPolitica(wisp, { aoFalhar: () => {}, aoRecuar: () => {} });

// Por padrão o dist do transporte instalado no backend (o que roda hoje). BENCH_LIBCURL_DIST aponta
// para um build recém-feito — é assim que se prova o transporte VENDORIZADO antes de publicar, e não
// só o wasm solto: o que o cliente carrega é este bundle, com o libcurl inlineado dentro.
const LIBCURL_DIST = process.env.BENCH_LIBCURL_DIST
  || path.join(BACKEND, 'node_modules/@mercuryworkshop/libcurl-transport/dist');

const s = createServer((req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (u.pathname === '/zerar') { porHost.clear(); res.writeHead(200).end('ok'); return; }
  if (u.pathname === '/contagem') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([...porHost.entries()].sort((a, b) => b[1] - a[1])));
    return;
  }
  // /lc/<versao>/<arquivo> — serve o libcurl ANTIGO (o publicado em node_modules) ou o NOVO
  // (recém-compilado com PIPEWAIT+PIPELINING), para o A/B usar a mesma página nos dois.
  if (u.pathname.startsWith('/lc/')) {
    const [, , qual, arq] = u.pathname.split('/');
    // 'antigo' é o publicado (o que roda hoje); qualquer outro nome vira ../libcurl-<nome>, para
    // que acrescentar uma variante ao A/B seja só copiar um out/ para lá.
    const base = qual === 'antigo' ? path.join(BACKEND, 'node_modules/libcurl.js')
               : path.join(AQUI, `../libcurl-${qual}`);
    const tipo = arq.endsWith('.wasm') ? 'application/wasm' : 'application/javascript';
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(base, arq)));
    return;
  }
  if (u.pathname === '/ab') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(AQUI, 'ab.html')));
    return;
  }
  if (u.pathname === '/h2') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(AQUI, 'h2.html')));
    return;
  }
  if (u.pathname.startsWith('/libcurljs/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(BACKEND, 'node_modules/libcurl.js', u.pathname.slice('/libcurljs/'.length))));
    return;
  }
  // A suíte de testes do fork: a página é minha (ver suite.html), os scripts são os dele.
  if (u.pathname === '/suite') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(AQUI, 'suite.html')));
    return;
  }
  if (u.pathname.startsWith('/suite/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(process.env.FORK_TESTS, 'scripts', u.pathname.slice('/suite/'.length))));
    return;
  }
  if (u.pathname === '/real') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(AQUI, 'real-ab.html')));
    return;
  }
  if (u.pathname === '/' ) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(AQUI, 'page.html')));
    return;
  }
  if (u.pathname.startsWith('/libcurl/')) {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(LIBCURL_DIST, u.pathname.slice('/libcurl/'.length))));
    return;
  }
  res.writeHead(404).end();
});
s.on('upgrade', (q, sock, head) => {
  if (q.url.split('?')[0].endsWith('/wisp/')) wisp.routeRequest(q, sock, head);
  else sock.destroy();
});
s.listen(PORT, '127.0.0.1', () => console.log(`contador em http://127.0.0.1:${PORT}`));
