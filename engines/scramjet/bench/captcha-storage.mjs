// O reCAPTCHA guarda estado em `localStorage` sob as chaves `rc::a` … `rc::f`, e ele o faz de
// MAIS DE UM contexto: a página que hospeda o widget, o iframe `api2/anchor` (a caixinha) e o
// iframe `api2/bframe` (o desafio). Os três precisam enxergar o mesmo estado.
//
// Sob o proxy, o storage é particionado por origem lógica: o cliente prefixa toda chave com
// `<host>@`. Se algum desses contextos escrever SEM passar pelo prefixo, ele passa a gravar e ler
// de uma gaveta diferente dos outros — e o reCAPTCHA deixa de achar o próprio estado.
//
// Numa sessão real chegaram as duas formas ao mesmo tempo:
//
//     key = "www.google.com@rc::a"     ← particionado, correto
//     key = "rc::c"                    ← CRU, sem partição
//
// Este script descobre de onde sai cada uma. A sonda troca `Storage.prototype.setItem` — o de
// verdade, capturado antes de o cliente do scramjet instalar o proxy dele — então ela vê o que
// REALMENTE chega ao armazenamento, com a chave já no formato final. Uma chave sem `@` é uma
// escrita que não passou pelo shim, e a pilha diz quem a fez.

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.google.com/recaptcha/api2/demo";
const ESPERA = Number(process.env.BENCH_ESPERA || 25000);
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

const SONDA = String.raw`
(() => {
	if (window.__sondaStorage) return;
	window.__sondaStorage = true;
	window.__escritas = [];

	// AVISO: trocar no PROTÓTIPO, e não em localStorage. O cliente do scramjet substitui o objeto
	// self.localStorage por um Proxy, mas esse Proxy chama target.setItem(...) — que resolve
	// aqui. É o único ponto por onde as duas formas de escrita passam.
	const proto = Storage.prototype;
	for (const metodo of ["setItem", "removeItem"]) {
		const orig = proto[metodo];
		proto[metodo] = function (k, v) {
			try {
				window.__escritas.push({
					metodo,
					chave: String(k),
					particionada: String(k).includes("@"),
					valor: metodo === "setItem" ? String(v).slice(0, 40) : null,
					contexto: String(location.href).slice(0, 120),
					temShim: typeof window.$scramjet !== "undefined" || !!window.__scramjet$bundle,
					pilha: String(new Error().stack || "").split("\n").slice(2, 7).join(" | ").slice(0, 400),
				});
			} catch {}
			return orig.call(this, k, v);
		};
	}
})();
`;

await esperarServidor(BASE, 15000);
const browser = await chromium.launch();

try {
	const ctx = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1600, height: 900 },
		locale: "pt-BR",
	});
	await ctx.addInitScript(SONDA);

	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 140)}`));

	console.log(`=== ${ALVO} atravessando o proxy ===`);
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector("input", { timeout: 20000 });
	await input.fill(ALVO);
	await input.press("Enter");
	await page.waitForTimeout(ESPERA);

	// clicar na caixinha faz o widget escrever bem mais do que só carregar
	const anchor = page.frames().find((f) => {
		try { return decodeURIComponent(f.url()).includes("api2/anchor"); } catch { return false; }
	});
	if (anchor) {
		try {
			const caixa = await anchor.frameElement().then((e) => e.boundingBox());
			if (caixa) {
				await page.mouse.move(caixa.x + 30, caixa.y + caixa.height / 2);
				await page.mouse.down();
				await page.mouse.up();
				console.log("  (cliquei na caixinha)");
			}
		} catch (e) {
			console.log("  (não deu para clicar: " + String(e.message || e).slice(0, 80) + ")");
		}
	} else {
		console.log("  (não achei o frame anchor)");
	}
	await page.waitForTimeout(12000);

	console.log("\n=== frames em cena ===");
	for (const f of page.frames()) {
		let u = f.url();
		try { u = decodeURIComponent(u); } catch {}
		console.log("   " + u.slice(0, 120));
	}

	const tudo = [];
	for (const f of page.frames()) {
		let escritas = [];
		try {
			escritas = await f.evaluate(() => window.__escritas || []);
		} catch {
			continue;
		}
		tudo.push(...escritas);
	}

	const rc = tudo.filter((e) => /rc::/.test(e.chave));
	console.log(`\n=== escritas no armazenamento real: ${tudo.length} (do reCAPTCHA: ${rc.length}) ===`);

	const cruas = rc.filter((e) => !e.particionada);
	const boas = rc.filter((e) => e.particionada);

	console.log(`\n  particionadas (corretas): ${boas.length}`);
	for (const e of boas.slice(0, 6)) console.log(`     ${e.metodo} ${e.chave}`);

	console.log(`\n  CRUAS, sem partição: ${cruas.length}`);
	for (const e of cruas.slice(0, 10)) {
		console.log(`     ${e.metodo} ${JSON.stringify(e.chave)}  temShim=${e.temShim}`);
		console.log(`        contexto: ${e.contexto}`);
		console.log(`        ${e.pilha.slice(0, 260)}`);
	}

	console.log("\n=== veredito ===");
	if (!rc.length) {
		console.log("  o reCAPTCHA não chegou a escrever nada — a rodada não mediu o que queria.");
		process.exitCode = 2;
	} else if (cruas.length) {
		console.log(`  ${cruas.length} escrita(s) do reCAPTCHA escapam do particionamento.`);
		console.log("  Elas vão para uma gaveta diferente da dos outros contextos do widget.");
		process.exitCode = 1;
	} else {
		console.log("  todas as escritas do reCAPTCHA passaram pelo particionamento.");
		process.exitCode = 0;
	}
} finally {
	await browser.close();
}
