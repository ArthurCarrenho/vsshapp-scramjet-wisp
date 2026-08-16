// Roda os scripts de teste do fork contra cada build, com o runner de suite.html.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, esperarServidor } = await import("./comum.mjs");
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BENCH_PORT || 39604);
const BASE = `http://127.0.0.1:${PORT}`;

const SCRIPTS = ['fetch_once.js', 'fetch_multiple.js', 'fetch_parallel.js', 'redirect_out.js',
  'test_download_hash.js', 'test_http_session.js', 'test_post.js', 'test_tls_socket.js', 'test_websocket.js'];
const VERSOES = (process.env.BENCH_VERSOES || 'antigo,novo').split(',');

const srv = spawn(process.execPath, [path.join(AQUI, 'conta-conexoes.mjs')], {
  env: { ...process.env, BENCH_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
await esperarServidor(BASE);

const browser = await chromium.launch();
let totalFalhas = 0;
for (const v of VERSOES) {
  console.log(`\n=== ${v} ===`);
  let falhas = 0;
  for (const script of SCRIPTS) {
    const page = await browser.newPage();
    const erros = [];
    page.on('pageerror', (e) => erros.push(String(e).slice(0, 140)));
    let saida;
    try {
      await page.goto(`${BASE}/suite?v=${v}`, { waitUntil: 'load' });
      const ms = await page.evaluate((s) => window.__suite(s), script);
      saida = `ok    ${String(ms).padStart(6)}ms`;
    } catch (e) {
      falhas++;
      saida = `FALHA         -> ${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 110)}`;
    }
    await page.close();
    console.log(`  ${script.padEnd(24)} ${saida}`);
    for (const x of erros.slice(0, 2)) console.log(`      ${x}`);
  }
  console.log(`  ${SCRIPTS.length - falhas}/${SCRIPTS.length} passaram`);
  totalFalhas += falhas;
}
await browser.close(); srv.kill();
process.exit(0);
