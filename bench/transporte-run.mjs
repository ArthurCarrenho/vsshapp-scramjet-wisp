// Prova o TRANSPORTE, não o wasm solto.
//
// O A/B anterior mede libcurl.js direto. O que o cliente carrega em produção é o bundle do
// @mercuryworkshop/libcurl-transport, com o libcurl_full.mjs inlineado dentro pelo esbuild — e é
// esse arquivo vendorizado que estamos publicando. Se a vendorização pegou o wasm errado, ou o
// esbuild inlineou uma cópia antiga, é aqui que aparece.
//
// Mesma pergunta de sempre: 40 requisições ao mesmo host h2 abrem quantas conexões TCP?
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, esperarServidor } = await import("./comum.mjs");
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BENCH_PORT || 39640);
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(AQUI, 'conta-conexoes.mjs')], {
  env: { ...process.env, BENCH_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
await esperarServidor(BASE);

const ICONES = ['alarm','archive','award','bag','bell','book','box','brush','bug','calendar','camera','cart','chat','check','clock','cloud','code','compass','cpu','cup','disc','display','droplet','envelope','eye','filter','flag','folder','gear','gift','globe','grid','hammer','hash','heart','house','image','key','lock','map'];
const urls = ICONES.map((n) => `https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons/${n}.svg`);

const browser = await chromium.launch();
console.log(`transporte: ${process.env.BENCH_LIBCURL_DIST || '(o instalado no backend)'}`);
console.log(`${urls.length} requisições ao MESMO host (jsDelivr, HTTP/2)\n`);
console.log('porHost   ok     parede   conexões TCP');
for (const perHost of [4, 16]) {
  await fetch(`${BASE}/zerar`);
  const page = await browser.newPage();
  let r;
  try {
    await page.goto(BASE, { waitUntil: 'load' });
    r = await page.evaluate((c) => window.__bench(c), {
      total: 64, cache: 48, perHost, urls, rotulo: `porHost=${perHost}`,
    });
  } catch (e) { r = { erro: String(e).slice(0, 70), ok: 0, paredeMs: -1 }; }
  await page.close();
  const c = await (await fetch(`${BASE}/contagem`)).json();
  const conn = c.filter(([k]) => k.includes(':443')).reduce((s, [, n]) => s + n, 0);
  console.log(`  ${String(perHost).padStart(2)}    ${String(r.ok).padStart(2)}/${urls.length}  ` +
    `${String(r.paredeMs).padStart(6)}ms   ${String(conn).padStart(3)}` + (r.erro ? `   erro=${r.erro}` : ''));
}
await browser.close(); srv.kill();
