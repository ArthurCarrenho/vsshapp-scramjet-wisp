// Sites reais, duas versões do libcurl, dois tetos de conexão — e a contagem de TCP junto.
//
// A bateria anterior mediu só tetos, contra o wasm publicado, e concluiu "não aumente o teto".
// Aquela conclusão vale para um transporte que não multiplexa. Agora que o `novo` multiplexa (40
// requisições ao mesmo host h2 numa conexão só, medido), a pergunta muda: o teto ainda governa?
//
// Duas fases, como em real.mjs:
//   A) descobre — carrega a página no Chromium SEM proxy e anota as URLs que ela realmente busca
//   B) mede — refaz esse conjunto pelo wisp, uma vez por (versão × teto), contando conexões
//
// Cuidados que já custaram caro antes: uma passada de aquecimento descartada, ordem das
// configurações alternada entre repetições (senão o cache do CDN premia quem rodou por último), e
// mediana de verdade — `v[floor(N/2)]` com N par devolve o PIOR, e foi o que produziu um outlier de
// 10 s na primeira bateria.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium, esperarServidor } = await import("./comum.mjs");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BENCH_PORT || 39590);
const BASE = `http://127.0.0.1:${PORT}`;
const MAX_RECURSOS = Number(process.env.BENCH_MAX_REC || 40);
const REPS = Number(process.env.BENCH_REP || 2);

const SITES = [
  { nome: 'g1',            url: 'https://g1.globo.com/' },
  { nome: 'uol',           url: 'https://www.uol.com.br/' },
  { nome: 'capes',         url: 'https://www.periodicos.capes.gov.br/' },
  { nome: 'unesp franca',  url: 'https://www.franca.unesp.br/' },
  { nome: 'sampi',         url: 'https://www.sampi.net.br/' },
  { nome: 'wikipedia',     url: 'https://pt.wikipedia.org/wiki/Brasil' },
  { nome: 'gov.br',        url: 'https://www.gov.br/pt-br' },
  { nome: 'youtube home',  url: 'https://www.youtube.com/' },
  { nome: 'youtube vídeo', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
];
const FILTRO = (process.env.BENCH_SITES || '').trim().toLowerCase();
const SITES_ATIVOS = FILTRO ? SITES.filter((s) => FILTRO.split(',').some((f) => s.nome.includes(f.trim()))) : SITES;

// Quatro células: as duas versões nos dois tetos que estão em disputa no ScramjetEngine.
const CELULAS = [
  { nome: 'antigo 16/12/4', v: 'antigo', conn: [16, 12, 4] },
  { nome: 'antigo 32/24/6', v: 'antigo', conn: [32, 24, 6] },
  { nome: 'novo   16/12/4', v: 'novo',   conn: [16, 12, 4] },
  { nome: 'novo   32/24/6', v: 'novo',   conn: [32, 24, 6] },
];

const servidor = spawn(process.execPath, [path.join(AQUI, 'conta-conexoes.mjs')], {
  env: { ...process.env, BENCH_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
});
servidor.stderr.on('data', (d) => process.stderr.write(`[srv!] ${d}`));
await esperarServidor(BASE);

const browser = await chromium.launch();
const resultados = [];

try {
  for (const site of SITES_ATIVOS) {
    // ── Fase A ──
    let recursos = [];
    try {
      const p = await browser.newPage();
      const vistos = new Set();
      p.on('request', (req) => {
        const u = req.url();
        if (u.startsWith('https') && req.method() === 'GET' && !vistos.has(u)) vistos.add(u);
      });
      await p.goto(site.url, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      await p.close();
      recursos = [...vistos].slice(0, MAX_RECURSOS);
    } catch (e) {
      console.log(`${site.nome}: descoberta falhou (${String(e).slice(0, 60)})`);
      continue;
    }
    const hosts = new Set(recursos.map((u) => { try { return new URL(u).host; } catch { return '?'; } }));
    if (recursos.length < 8) { console.log(`${site.nome}: só ${recursos.length} recursos, pulando`); continue; }
    console.log(`\n${site.nome}: ${recursos.length} recursos em ${hosts.size} hosts`);

    // ── Fase B ──
    const porCelula = new Map(CELULAS.map((c) => [c.nome, []]));
    for (let rep = 0; rep < REPS + 1; rep++) {
      const ordem = rep % 2 === 0 ? CELULAS : [...CELULAS].reverse();
      for (const cel of ordem) {
        await fetch(`${BASE}/zerar`);
        const page = await browser.newPage();
        let r;
        try {
          await page.goto(`${BASE}/real?v=${cel.v}`, { waitUntil: 'load' });
          r = await page.evaluate((c) => window.__real(c), {
            urls: recursos, total: cel.conn[0], cache: cel.conn[1], perHost: cel.conn[2],
          });
        } catch (e) {
          r = { erro: String(e).slice(0, 70), ok: 0, falhas: recursos.length, paredeMs: -1, ttfbMedianaMs: -1, ttfbP95Ms: -1 };
        }
        await page.close();
        const c = await (await fetch(`${BASE}/contagem`)).json();
        r.conexoes = c.filter(([k]) => k.includes(':443')).reduce((s, [, n]) => s + n, 0);
        if (rep > 0) porCelula.get(cel.nome).push(r);
      }
    }

    for (const cel of CELULAS) {
      const a = porCelula.get(cel.nome);
      if (!a.length) continue;
      const mid = (k) => {
        const v = a.map((x) => x[k]).sort((x, y) => x - y);
        const m = Math.floor(v.length / 2);
        return Math.round(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2);
      };
      const linha = {
        site: site.nome, hosts: hosts.size, recursos: recursos.length, celula: cel.nome,
        paredeMs: mid('paredeMs'), ttfbMedMs: mid('ttfbMedianaMs'), ttfbP95Ms: mid('ttfbP95Ms'),
        conexoes: mid('conexoes'), ok: mid('ok'), falhas: a.reduce((s, x) => s + x.falhas, 0),
      };
      resultados.push(linha);
      console.log(`  ${cel.nome.padEnd(16)} parede=${String(linha.paredeMs).padStart(6)}ms ` +
        `ttfb_med=${String(linha.ttfbMedMs).padStart(5)}ms p95=${String(linha.ttfbP95Ms).padStart(5)}ms ` +
        `conn=${String(linha.conexoes).padStart(3)} ok=${linha.ok}/${recursos.length} falhas=${linha.falhas}`);
    }
  }
} finally {
  await browser.close();
  servidor.kill();
}

console.log('\n=== resumo: parede (ms) e conexões TCP, por site ===');
console.log('site            hosts   ' + CELULAS.map((c) => c.nome.padEnd(16)).join(''));
for (const site of [...new Set(resultados.map((r) => r.site))]) {
  const g = resultados.filter((r) => r.site === site);
  const cel = (n) => g.find((r) => r.celula === n);
  console.log(site.padEnd(15) + String(g[0].hosts).padStart(4) + '   ' +
    CELULAS.map((c) => { const r = cel(c.nome); return r ? `${r.paredeMs}ms/${r.conexoes}c`.padEnd(16) : '-'.padEnd(16); }).join(''));
}

console.log('\n=== ganho do `novo` sobre o `antigo`, no MESMO teto ===');
for (const site of [...new Set(resultados.map((r) => r.site))]) {
  const g = resultados.filter((r) => r.site === site);
  const par = (a, b) => {
    const x = g.find((r) => r.celula === a), y = g.find((r) => r.celula === b);
    if (!x || !y || x.paredeMs <= 0) return '     -';
    return `${(((x.paredeMs - y.paredeMs) / x.paredeMs) * 100).toFixed(0)}%`.padStart(6);
  };
  console.log(`${site.padEnd(15)} 16/12/4:${par('antigo 16/12/4', 'novo   16/12/4')}   32/24/6:${par('antigo 32/24/6', 'novo   32/24/6')}`);
}

console.log('\nJSON:');
console.log(JSON.stringify(resultados));
