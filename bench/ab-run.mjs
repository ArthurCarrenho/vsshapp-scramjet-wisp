import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium, esperarServidor } = await import("./comum.mjs");
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BENCH_PORT || 39570);
const BASE = `http://127.0.0.1:${PORT}`;

const srv = spawn(process.execPath, [path.join(AQUI, 'conta-conexoes.mjs')], {
  env: { ...process.env, BENCH_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
await esperarServidor(BASE);

const ICONES = ['alarm','archive','award','bag','bell','book','box','brush','bug','calendar','camera','cart','chat','check','clock','cloud','code','compass','cpu','cup','disc','display','droplet','envelope','eye','filter','flag','folder','gear','gift','globe','grid','hammer','hash','heart','house','image','key','lock','map'];
const urls = ICONES.map((n) => `https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/icons/${n}.svg`);

const browser = await chromium.launch();
console.log(`${urls.length} requisições ao MESMO host (jsDelivr, HTTP/2)\n`);
console.log('versão    porHost   ok     parede   conexões TCP abertas');
// antigo = publicado hoje | limpo = fork rebuildado sem patch (controle) | pw = só CURLOPT_PIPEWAIT
// | novo = PIPEWAIT + CURLMOPT_PIPELINING. O 'pw' existe para responder se a segunda linha faz algo:
// CURLPIPE_MULTIPLEX é o default do curl desde a 7.62, então ela pode ser pura documentação.
for (const v of (process.env.BENCH_VERSOES || 'antigo,limpo,pw,novo').split(',')) {
  for (const perHost of [4, 16]) {
    await fetch(`${BASE}/zerar`);
    const page = await browser.newPage();
    const erros = [];
    page.on('pageerror', (e) => erros.push(String(e)));
    let r;
    try {
      await page.goto(`${BASE}/ab?v=${v}`, { waitUntil: 'load' });
      r = await page.evaluate((c) => window.__ab(c), { urls, perHost });
    } catch (e) { r = { erro: String(e).slice(0, 70), ok: 0, total: urls.length, paredeMs: -1 }; }
    await page.close();
    const c = await (await fetch(`${BASE}/contagem`)).json();
    const conn = c.filter(([k]) => k.includes(':443')).reduce((s, [, n]) => s + n, 0);
    console.log(`${v.padEnd(9)} ${String(perHost).padStart(2)}     ${String(r.ok).padStart(2)}/${r.total}  ` +
      `${String(r.paredeMs).padStart(6)}ms   ${String(conn).padStart(3)}` +
      (r.erro ? `   erro=${String(r.erro).slice(0,40)}` : ''));
    if (r.diag) console.log(`          cacert: ${JSON.stringify(r.diag)}`);
  }
}
await browser.close(); srv.kill();
