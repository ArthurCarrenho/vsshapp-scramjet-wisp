// O único canal que uma aba tem para mexer em outra aba do mesmo navegador é o evento `storage`.
// Este script mapeia esse canal atravessando o scramjet, sem depender de nenhum site real:
//
//   aba A  em  http://localhost:PORTA     (host lógico "localhost:PORTA")
//   aba B  em  http://127.0.0.1:PORTA     (host lógico "127.0.0.1:PORTA")  <- OUTRO host lógico
//   aba C  em  http://localhost:PORTA     (host lógico igual ao da A)
//
// São hosts lógicos diferentes servidos pelo MESMO servidor, que é o jeito de ter dois "sites"
// sem sair da máquina. O que se quer saber, em três perguntas:
//
//   1. A escrita de B (outro host) chega à A? Não deveria: é vazamento entre origens.
//   2. A escrita de C (mesmo host) chega à A? Deveria: é o canal legítimo.
//   3. O que o `key` do evento entregue contém — a chave do site ou a chave particionada?
//
// A sonda registra o listener DUAS vezes: uma pelo `addEventListener` que o scramjet embrulha
// (o que o site vê) e outra pelo nativo capturado antes (o que o navegador entregou). A diferença
// entre as duas listas é exatamente o que o filtro do motor faz — ou deixa de fazer.

import http from "node:http";

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const PORTA = Number(process.env.BENCH_PORTA || 5199);
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);

const morte = setTimeout(() => { console.log(`\n[abortado: estourou ${LIMITE}ms]`); process.exit(2); }, LIMITE);
morte.unref?.();

const PAGINA = (rotulo) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${rotulo}</title></head>
<body><h1>${rotulo}</h1><script>
window.__rotulo = ${JSON.stringify(rotulo)};
window.__vistos = [];
window.addEventListener("storage", (e) => {
	window.__vistos.push({ via: "shim", key: e.key, novo: e.newValue, url: String(e.url || "").slice(0, 90) });
});
window.__escrever = (k, v) => localStorage.setItem(k, v);
window.__limpar = () => localStorage.clear();
document.title = "pronto:" + ${JSON.stringify(rotulo)};
</script></body></html>`;

const servidor = http.createServer((req, res) => {
	const rotulo = new URL(req.url, "http://x").searchParams.get("r") || "sem-rotulo";
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(PAGINA(rotulo));
});
await new Promise((r) => servidor.listen(PORTA, r));

const SONDA = `
	(() => {
		if (window.__sondaStorage) return;
		window.__sondaStorage = true;
		window.__crus = [];
		const nativo = EventTarget.prototype.addEventListener;
		nativo.call(window, "storage", (e) => {
			try {
				window.__crus.push({ via: "cru", key: e.key, novo: e.newValue, url: String(e.url || "").slice(0, 90) });
			} catch {}
		}, true);
	})();
`;

await esperarServidor(BASE, 15000);
const browser = await chromium.launch();

const ctxOpts = {
	userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
	viewport: { width: 1280, height: 800 },
};

async function abrir(ctx, url) {
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 160)}`));
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector('input[type="text"], input:not([type]), input[type="url"], input[type="search"]', { timeout: 20000 });
	await input.fill(url);
	await input.press("Enter");
	await page.waitForTimeout(6000);
	return page;
}

const quadro = (page) => {
	const f = page.frames().find((fr) => /localhost%3A|127\.0\.0\.1%3A|localhost:|127\.0\.0\.1:/.test(fr.url()) && fr !== page.mainFrame());
	return f;
};

const colher = async (frame, rotulo) => {
	const r = await frame.evaluate(() => ({
		shim: window.__vistos || [],
		cru: window.__crus || [],
		host: location.host,
	}));
	console.log(`  ${rotulo}  (host lógico: ${r.host})`);
	console.log(`     pelo shim (o que o site vê): ${r.shim.length}`);
	for (const e of r.shim) console.log(`        key=${JSON.stringify(e.key)} novo=${JSON.stringify(e.novo)}`);
	console.log(`     cru (o que o navegador entregou): ${r.cru.length}`);
	for (const e of r.cru) console.log(`        key=${JSON.stringify(e.key)} novo=${JSON.stringify(e.novo)}`);
	return r;
};

try {
	const ctx = await browser.newContext(ctxOpts);
	await ctx.addInitScript(SONDA);

	console.log("=== abrindo as três abas ===");
	const pageA = await abrir(ctx, `http://localhost:${PORTA}/?r=A`);
	const pageB = await abrir(ctx, `http://127.0.0.1:${PORTA}/?r=B`);
	const pageC = await abrir(ctx, `http://localhost:${PORTA}/?r=C`);

	const fA = quadro(pageA), fB = quadro(pageB), fC = quadro(pageC);
	if (!fA || !fB || !fC) {
		console.log(`frames: A=${!!fA} B=${!!fB} C=${!!fC} — o proxy não carregou alguma delas`);
		for (const p of [pageA, pageB, pageC]) console.log("   urls: " + p.frames().map((f) => f.url().slice(0, 110)).join("\n          "));
		process.exit(1);
	}
	console.log(`  A host=${await fA.evaluate(() => location.host)}  B host=${await fB.evaluate(() => location.host)}  C host=${await fC.evaluate(() => location.host)}`);

	await fA.evaluate(() => { window.__vistos = []; window.__crus = []; });

	console.log("\n=== 1) B (OUTRO host) escreve; A escuta ===");
	await fB.evaluate(() => window.__escrever("yt-player-volume", '{"muted":false,"volume":100}'));
	await pageA.waitForTimeout(1500);
	await colher(fA, "aba A:");

	await fA.evaluate(() => { window.__vistos = []; window.__crus = []; });

	console.log("\n=== 2) C (MESMO host de A) escreve; A escuta ===");
	await fC.evaluate(() => window.__escrever("yt-player-volume", '{"muted":false,"volume":100}'));
	await pageA.waitForTimeout(1500);
	await colher(fA, "aba A:");

	await fA.evaluate(() => { window.__vistos = []; window.__crus = []; });

	console.log("\n=== 3) B chama localStorage.clear() (evento com key=null) ===");
	await fB.evaluate(() => window.__limpar());
	await pageA.waitForTimeout(1500);
	await colher(fA, "aba A:");

	await fA.evaluate(() => { window.__vistos = []; window.__crus = []; });

	console.log("\n=== 4) B é ATUALIZADA (o gatilho do relato) ===");
	await pageB.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
	await pageB.waitForTimeout(8000);
	await colher(fA, "aba A:");
} finally {
	await browser.close();
	servidor.close();
}
