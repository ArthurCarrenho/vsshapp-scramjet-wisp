// reCAPTCHA pelo scramjet local: o widget carrega, o clique responde, e o desafio abre?
//
// Sintoma relatado: o widget "fica só rodando" e a tela de selecionar imagens nunca aparece. Isso
// aponta para a conversa entre os DOIS iframes do reCAPTCHA:
//   anchor  (api2/anchor)  — a caixinha "não sou um robô"
//   bframe  (api2/bframe)  — o desafio das imagens
// O anchor pede o desafio ao bframe por postMessage, através da página que os contém. Spinner
// eterno = o pedido saiu e a resposta não voltou.
//
// Este script mede a cadeia inteira: quais frames existem, o que o clique produz, que mensagens
// atravessam, e o que o console diz. Tudo com prazo — nada aqui pode pendurar a sessão.

const { chromium, esperarServidor } = await import("./comum.mjs");
const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.google.com/recaptcha/api2/demo";
const ESPERA = Number(process.env.BENCH_ESPERA || 20000);
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);
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
	const console_ = [];
	page.on("console", (m) => console_.push(`${m.type()}: ${m.text().replace(/\s+/g, " ").slice(0, 190)}`));
	page.on("pageerror", (e) => console_.push(`pageerror: ${String(e).replace(/\s+/g, " ").slice(0, 190)}`));
	const falhas = [];
	page.on("requestfailed", (r) => falhas.push(`${r.failure()?.errorText} ${decodeURIComponent(r.url()).slice(-70)}`));

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector("input", { timeout: 20000 });
	await input.fill(ALVO);
	await input.press("Enter");
	await page.waitForTimeout(ESPERA);

	const listar = (rotulo) => {
		console.log(`\n=== frames (${rotulo}) ===`);
		for (const f of page.frames()) {
			const u = decodeURIComponent(f.url());
			const curto = u.includes("recaptcha") ? u.slice(u.indexOf("recaptcha")).slice(0, 70) : u.slice(0, 70);
			console.log("  " + curto);
		}
	};
	listar("antes do clique");

	const demo = page.frames().find((f) => f.url().includes("recaptcha%2Fapi2%2Fdemo"));
	if (!demo) { console.log("\nnão achei o frame da demo"); process.exit(1); }

	// O widget montou?
	const estado = await demo.evaluate(`(() => {
		const wrap = document.querySelector('.g-recaptcha');
		const iframes = [...document.querySelectorAll('iframe')].map((f) => (f.src || '').slice(-60));
		return { temWrapper: !!wrap, iframes };
	})()`);
	console.log("\n=== widget na página ===");
	console.log(" ", JSON.stringify(estado, null, 1));

	// O anchor é o frame da caixinha. Clicar nela é o gatilho.
	const anchor = page.frames().find((f) => f.url().includes("api2%2Fanchor") || f.url().includes("api2/anchor"));
	if (!anchor) {
		console.log("\nsem frame anchor — o widget nem montou");
	} else {
		const antes = await anchor.evaluate(`(() => {
			const c = document.querySelector('#recaptcha-anchor');
			return c ? { checked: c.getAttribute('aria-checked'), disabled: c.getAttribute('aria-disabled'), classe: c.className.slice(0, 60) } : null;
		})()`);
		console.log("\n=== caixinha antes ===");
		console.log(" ", JSON.stringify(antes));

		const cx = await anchor.evaluate(`(() => { const c = document.querySelector('#recaptcha-anchor'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
		const fe = await anchor.frameElement();
		const fb = fe ? await fe.boundingBox() : null;
		if (cx && fb) {
			await page.mouse.move(fb.x + cx.x, fb.y + cx.y);
			await page.mouse.down(); await page.waitForTimeout(70); await page.mouse.up();
			console.log("  cliquei na caixinha");
		} else console.log("  não consegui localizar a caixinha na tela");

		await page.waitForTimeout(12000);
		// O anchor é RECRIADO durante o fluxo — o objeto antigo fica destacado e qualquer
		// evaluate nele estoura com "Frame was detached". Reresolver pelo URL, sempre.
		const anchorAgora = page.frames().find((f) => f.url().includes("api2%2Fanchor") || f.url().includes("api2/anchor"));
		const depois = anchorAgora
			? await anchorAgora.evaluate(`(() => {
				const c = document.querySelector('#recaptcha-anchor');
				const spinner = document.querySelector('.recaptcha-checkbox-spinner');
				return c ? { checked: c.getAttribute('aria-checked'), classe: c.className.slice(0, 80), girando: !!spinner && getComputedStyle(spinner).display !== 'none' } : { semCaixinha: true };
			})()`).catch((e) => ({ erro: String(e).slice(0, 70) }))
			: { anchorSumiu: true };
		console.log("\n=== caixinha depois ===");
		console.log(" ", JSON.stringify(depois));
	}

	listar("depois do clique");

	// O desafio abriu?
	const bframe = page.frames().find((f) => f.url().includes("api2%2Fbframe") || f.url().includes("api2/bframe"));
	console.log(`\n=== desafio (bframe) ===\n  ${bframe ? "EXISTE" : "não existe"}`);
	if (bframe) {
		const conteudo = await bframe.evaluate(`(() => ({ texto: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120), imgs: document.querySelectorAll('img').length }))()`).catch((e) => ({ erro: String(e).slice(0, 60) }));
		console.log("  " + JSON.stringify(conteudo));
	}

	console.log("\n=== requisições que falharam ===");
	const gf = {};
	for (const f of falhas) { const k = f.slice(0, 110); gf[k] = (gf[k] || 0) + 1; }
	if (!Object.keys(gf).length) console.log("  (nenhuma)");
	for (const [k, n] of Object.entries(gf).slice(0, 12)) console.log(`  ${String(n).padStart(3)}x ${k}`);

	console.log("\n=== console ===");
	const g = {};
	for (const l of console_) { const k = l.replace(/\d+/g, "N").slice(0, 130); g[k] = (g[k] || 0) + 1; }
	for (const [k, n] of Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`  ${String(n).padStart(3)}x ${k}`);
} finally {
	await browser.close().catch(() => {});
	clearTimeout(morte);
}
