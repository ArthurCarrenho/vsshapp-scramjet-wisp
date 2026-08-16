// Que chamadas o reCAPTCHA faz, e o que elas respondem?
//
// O clique não produz mensagem nova entre frames, e o anchor fica girando até `reCAPTCHA Timeout`.
// Antes de clicar, o anchor faz um POST em `/recaptcha/api2/reload` — é ele que decide se vem
// desafio. Nenhuma requisição "falha" no sentido do navegador, mas uma resposta 200 com corpo de
// erro se parece exatamente com isto: silêncio e timeout.
//
// Registra método, status, tamanho e um pedaço do corpo de tudo que for do reCAPTCHA, marcando o que
// aconteceu ANTES e DEPOIS do clique.

const { chromium, esperarServidor } = await import("./comum.mjs");
const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.google.com/recaptcha/api2/demo";
const LIMITE = Number(process.env.BENCH_LIMITE || 260000);
const morte = setTimeout(() => { console.log(`\n[abortado: ${LIMITE}ms]`); process.exit(2); }, LIMITE);
morte.unref?.();

// O devserver do fork (`npm run dev`) é pré-requisito destes scripts, e não sobe sozinho.
// Falhar aqui, nomeando o endereço, é melhor que falhar dentro do Playwright com um erro
// de navegação que não diz o que está faltando.
await esperarServidor(BASE, 15000);

const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1600, height: 900 }, locale: "pt-BR",
	});
	const page = await ctx.newPage();
	let fase = "antes";
	const reqs = [];
	page.on("response", async (resp) => {
		const u = decodeURIComponent(resp.url());
		if (!u.includes("recaptcha")) return;
		const caminho = u.slice(u.indexOf("recaptcha")).split("?")[0];
		let corpo = "";
		try { corpo = (await resp.text()).replace(/\s+/g, " ").slice(0, 90); } catch { corpo = "(sem corpo)"; }
		reqs.push({ fase, metodo: resp.request().method(), status: resp.status(), caminho: caminho.slice(0, 40), corpo });
	});

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector("input", { timeout: 20000 });
	await input.fill(ALVO);
	await input.press("Enter");
	await page.waitForTimeout(20000);

	const anchor = page.frames().find((f) => f.url().includes("anchor"));
	if (anchor) {
		const cx = await anchor.evaluate(`(() => { const c = document.querySelector('#recaptcha-anchor'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
		const fb = await (await anchor.frameElement()).boundingBox();
		fase = "depois";
		await page.mouse.move(fb.x + cx.x, fb.y + cx.y);
		await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
		console.log("cliquei\n");
	}
	await page.waitForTimeout(25000);

	console.log("fase   método status caminho                                  corpo");
	for (const r of reqs) {
		console.log(`${r.fase.padEnd(7)}${r.metodo.padEnd(7)}${String(r.status).padEnd(7)}${r.caminho.padEnd(42)}${r.corpo}`);
	}
	console.log("\nbframe:", page.frames().some((f) => f.url().includes("bframe")) ? "EXISTE" : "não existe");
} finally {
	await browser.close().catch(() => {});
	clearTimeout(morte);
}
