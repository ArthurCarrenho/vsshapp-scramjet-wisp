// O filtro de eventos do motor só alcança ouvinte que é FUNÇÃO.
//
// `addEventListener` aceita duas formas: uma função, ou um objeto com `handleEvent`. As duas são
// igualmente válidas e igualmente usadas. O trap do motor começa assim:
//
//     client.Proxy("EventTarget.prototype.addEventListener", {
//         apply(ctx) { if (typeof ctx.args[1] !== "function") return;  ...embrulha... }
//     })
//
// Ou seja: ouvinte-objeto passa direto, sem embrulho. E é o embrulho que faz todo o trabalho de
// isolamento em `client/shared/event.ts`:
//
//   storage   `_init` descarta evento de OUTRA origem lógica, e `key` tira o prefixo da partição
//   message   `_init` confere o `targetOrigin` que o remetente pediu (o conserto do fork), e
//             `origin`/`data` desembrulham o envelope `$scramjet$…`
//
// Sem ele, um site que escute por objeto recebe o evento CRU. Este script mede as duas pontas nas
// duas formas, lado a lado, no mesmo documento — a diferença entre as duas colunas é exatamente o
// que o filtro deixa de fazer.

import http from "node:http";

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const PORTA = Number(process.env.BENCH_PORTA || 5255);
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

const PAGINA = (r) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${r}</title></head>
<body><h1>${r}</h1><script>
window.__rotulo = ${JSON.stringify(r)};
window.__funcao = [];
window.__objeto = [];

// mesma coisa, escrita das duas formas que a plataforma aceita
window.addEventListener("storage", (e) => {
	window.__funcao.push({ ev: "storage", key: e.key, novo: e.newValue });
});
window.addEventListener("storage", {
	handleEvent(e) { window.__objeto.push({ ev: "storage", key: e.key, novo: e.newValue }); },
});

window.addEventListener("message", (e) => {
	window.__funcao.push({ ev: "message", origem: e.origin, dado: JSON.stringify(e.data).slice(0, 120) });
});
window.addEventListener("message", {
	handleEvent(e) { window.__objeto.push({ ev: "message", origem: e.origin, dado: JSON.stringify(e.data).slice(0, 120) }); },
});

window.__escrever = (k, v) => localStorage.setItem(k, v);
window.__mandar = (alvo) => window.parent.postMessage({ oi: "do filho " + window.__rotulo }, alvo);
window.__limpar = () => { window.__funcao = []; window.__objeto = []; };
document.title = "pronto";
</script></body></html>`;

const servidor = http.createServer((req, res) => {
	const r = new URL(req.url, "http://x").searchParams.get("r") || "?";
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(PAGINA(r));
});
await new Promise((r) => servidor.listen(PORTA, r));

await esperarServidor(BASE, 15000);
const browser = await chromium.launch();

async function abrir(ctx, url) {
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 150)}`));
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector(
		'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
		{ timeout: 20000 }
	);
	await input.fill(url);
	await input.press("Enter");
	await page.waitForTimeout(7000);
	return page;
}

const proxiado = (page) =>
	page.frames().find((f) => f !== page.mainFrame() && /5255/.test(f.url()));

const colher = async (f, rotulo) => {
	const r = await f.evaluate(() => ({ funcao: window.__funcao || [], objeto: window.__objeto || [] }));
	console.log(`  ${rotulo}`);
	console.log(`     ouvinte FUNÇÃO  (${r.funcao.length}):`);
	for (const e of r.funcao) console.log(`        ${JSON.stringify(e)}`);
	console.log(`     ouvinte OBJETO  (${r.objeto.length}):`);
	for (const e of r.objeto) console.log(`        ${JSON.stringify(e)}`);
	return r;
};

try {
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });

	const pageA = await abrir(ctx, `http://localhost:${PORTA}/?r=A`);
	const pageB = await abrir(ctx, `http://127.0.0.1:${PORTA}/?r=B`);
	const pageC = await abrir(ctx, `http://localhost:${PORTA}/?r=C`);
	const fA = proxiado(pageA);
	const fB = proxiado(pageB);
	const fC = proxiado(pageC);
	if (!fA || !fB || !fC) {
		console.log(`frames: A=${!!fA} B=${!!fB} C=${!!fC}`);
		for (const p of [pageA, pageB, pageC]) for (const f of p.frames()) console.log("   " + f.url().slice(0, 120));
		process.exit(1);
	}

	await fA.evaluate(() => window.__limpar());

	console.log("\n=== 1) a aba B (OUTRA origem lógica) escreve no storage; a aba A escuta ===");
	await fB.evaluate(() => window.__escrever("yt-player-volume", '{"muted":false,"volume":100}'));
	await pageA.waitForTimeout(1500);
	const outra = await colher(fA, "aba A recebeu:");

	await fA.evaluate(() => window.__limpar());

	// ⚠ Fechar o vazamento sem esta metade não valeria nada: descartar TODO evento entregue a
	// ouvinte-objeto também zeraria a coluna de cima e passaria no teste acima. O que se quer é
	// que a forma de escrever o ouvinte deixe de importar — nas duas direções.
	console.log("\n=== 2) a aba C (MESMA origem lógica de A) escreve; a aba A escuta ===");
	await fC.evaluate(() => window.__escrever("yt-player-volume", '{"muted":true,"volume":50}'));
	await pageA.waitForTimeout(1500);
	const mesma = await colher(fA, "aba A recebeu:");

	console.log("\n=== veredito ===");
	const vazouFuncao = outra.funcao.some((e) => e.ev === "storage");
	const vazouObjeto = outra.objeto.some((e) => e.ev === "storage");
	const chegouFuncao = mesma.funcao.find((e) => e.ev === "storage");
	const chegouObjeto = mesma.objeto.find((e) => e.ev === "storage");
	console.log(`  de OUTRA origem — ouvinte FUNÇÃO viu? ${vazouFuncao ? "SIM  <-- vazou" : "não  <- filtrado, correto"}`);
	console.log(`  de OUTRA origem — ouvinte OBJETO viu? ${vazouObjeto ? "SIM  <-- vazou" : "não  <- filtrado, correto"}`);
	console.log(
		`  da MESMA origem — ouvinte FUNÇÃO viu? ${chegouFuncao ? `sim, key=${JSON.stringify(chegouFuncao.key)}` : "NÃO  <-- o canal legítimo quebrou"}`
	);
	console.log(
		`  da MESMA origem — ouvinte OBJETO viu? ${chegouObjeto ? `sim, key=${JSON.stringify(chegouObjeto.key)}` : "NÃO  <-- o canal legítimo quebrou"}`
	);

	const certo =
		!vazouFuncao &&
		!vazouObjeto &&
		chegouFuncao?.key === "yt-player-volume" &&
		chegouObjeto?.key === "yt-player-volume";
	console.log(
		`\n  ${certo ? "As duas formas de ouvinte se comportam igual: isolam de fora, entregam de dentro, e a chave vem sem a partição." : "As duas formas AINDA divergem."}`
	);
	process.exitCode = certo ? 0 : 1;
} finally {
	await browser.close();
	servidor.close();
}
