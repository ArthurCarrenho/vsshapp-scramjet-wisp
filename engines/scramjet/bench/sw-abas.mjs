// Uma aba derruba as requisições da outra?
//
// Todas as abas do proxy compartilham UM service worker, e é ele que busca tudo. Este script mede,
// sem depender de nenhum site real, o que acontece com o tráfego da aba 1 quando a aba 2 abre e
// quando a aba 2 é atualizada — que é o gatilho do relato do desmute no YouTube.
//
// A aba 1 é uma página proxiada que só faz uma coisa: `fetch()` a cada 250 ms num contador local,
// anotando cada sucesso e cada falha com o instante. A aba 2 abre, e depois recarrega. Se o motor
// isola as abas, a série da aba 1 não tem buraco nenhum. Cada falha é um subrecurso que um site de
// verdade teria perdido — para o YouTube, um segmento de mídia.
//
// O `?n=` em cada fetch existe para não medir o cache: sem ele o navegador responderia sem
// atravessar o service worker, e a série ficaria limpa por engano.

import http from "node:http";

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const PORTA = Number(process.env.BENCH_PORTA || 5211);
const LIMITE = Number(process.env.BENCH_LIMITE || 300000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

const PAGINA = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>batida</title></head>
<body><h1>batida</h1><script>
window.__ok = 0; window.__falhas = []; window.__t0 = Date.now(); window.__ligado = true;
let n = 0;
async function bater() {
	while (window.__ligado) {
		const marca = Date.now() - window.__t0;
		try {
			const r = await fetch("/batida?n=" + (n++), { cache: "no-store" });
			if (!r.ok) window.__falhas.push({ ms: marca, motivo: "status " + r.status });
			else window.__ok++;
		} catch (e) {
			window.__falhas.push({ ms: marca, motivo: String(e && e.message || e).slice(0, 90) });
		}
		await new Promise((r) => setTimeout(r, 250));
	}
}
bater();
document.title = "batendo";
</script></body></html>`;

const servidor = http.createServer((req, res) => {
	if (req.url.startsWith("/batida")) {
		res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
		res.end("ok");
		return;
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(PAGINA);
});
await new Promise((r) => servidor.listen(PORTA, r));

await esperarServidor(BASE, 15000);
const browser = await chromium.launch();

async function abrir(ctx, url) {
	const page = await ctx.newPage();
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector(
		'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
		{ timeout: 20000 }
	);
	await input.fill(url);
	await input.press("Enter");
	await page.waitForTimeout(6000);
	return page;
}

const batedor = (page) => page.frames().find((f) => f !== page.mainFrame() && /batida|%3A5211|:5211/.test(f.url()));

try {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

	console.log(`=== aba 1: página de batida atravessando o proxy ===`);
	const page1 = await abrir(ctx, `http://localhost:${PORTA}/`);
	page1.on("console", (m) => {
		const s = m.text();
		if (/No frame found|porta de comunica|revive|Service Worker error/i.test(s))
			console.log(`  [console aba1] ${s.slice(0, 170)}`);
	});

	const f1 = batedor(page1);
	if (!f1) {
		console.log("não achei o frame da batida:");
		for (const f of page1.frames()) console.log("   " + f.url().slice(0, 120));
		process.exit(1);
	}

	const ler = () => f1.evaluate(() => ({ ok: window.__ok, falhas: window.__falhas.slice() }));
	const marcarFase = async (nome) => {
		const r = await ler();
		console.log(`  [${nome}] ok acumulados=${r.ok}  falhas acumuladas=${r.falhas.length}`);
		return r;
	};

	await page1.waitForTimeout(6000);
	const base = await marcarFase("linha de base, só a aba 1 rodando");

	console.log(`\n=== aba 2 ABRE ===`);
	const page2 = await abrir(ctx, `http://localhost:${PORTA}/`);
	await page1.waitForTimeout(6000);
	const apos1 = await marcarFase("depois da aba 2 abrir");

	console.log(`\n=== aba 2 ATUALIZA ===`);
	await page2.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
	await page1.waitForTimeout(10000);
	const apos2 = await marcarFase("depois da aba 2 atualizar");

	console.log(`\n=== aba 2 ATUALIZA de novo ===`);
	await page2.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
	await page1.waitForTimeout(10000);
	const apos3 = await marcarFase("depois do segundo reload");

	const novas = apos3.falhas.slice(base.falhas.length);
	console.log(`\n  --- falhas da aba 1 depois que a aba 2 entrou em cena: ${novas.length} ---`);
	for (const f of novas.slice(0, 25)) console.log(`     +${String(f.ms).padStart(7)}ms  ${f.motivo}`);

	console.log("\n=== veredito ===");
	console.log(`  falhas antes da aba 2 existir: ${base.falhas.length}`);
	console.log(`  falhas causadas pela aba 2:    ${novas.length}`);
	console.log(
		`  a aba 2 derruba tráfego da aba 1: ${novas.length > 0 ? "SIM  <-- as abas não estão isoladas" : "não"}`
	);
	process.exitCode = novas.length > 0 ? 1 : 0;

	await f1.evaluate(() => {
		window.__ligado = false;
	});
} finally {
	await browser.close();
	servidor.close();
}
