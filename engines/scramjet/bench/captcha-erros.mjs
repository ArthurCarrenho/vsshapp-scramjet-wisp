// O que são os 54 "CAUGHT ERROR" que um único carregamento do reCAPTCHA produz.
//
// O rewriter insere `$scramerr(e)` em TODO bloco `catch` do site (rewriter/js/src/changes.rs), e o
// cliente implementa isso como um `console.warn("CAUGHT ERROR", e)`. Quer dizer: o que aparece no
// console não é erro do motor — é o site tratando exceção dele mesmo, exatamente como faria sem
// proxy nenhum. Feature detection é escrita com try/catch, então um punhado é esperado.
//
// A pergunta que decide se isso é ruído ou defeito: as exceções são as que o site teria SEM o
// proxy, ou há entre elas alguma que só existe porque um shim quebrou o que o site esperava?
// Este script agrupa por mensagem e mostra a pilha, o que separa as duas coisas na hora — e
// compara com o mesmo site carregado direto, sem proxy, que é a única régua que vale.

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.google.com/recaptcha/api2/demo";
const ESPERA = Number(process.env.BENCH_ESPERA || 25000);
const DIRETO = process.env.BENCH_DIRETO === "1";
const LIMITE = Number(process.env.BENCH_LIMITE || 240000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

// Sem proxy não existe `$scramerr`, então não há o que contar do lado de lá pelo console. A régua
// do baseline é outra: conta-se quantas vezes um `catch` do próprio site engoliu exceção, e para
// isso serve o `window.onerror`… que NÃO vê exceção capturada. Por isso o baseline aqui mede o que
// dá para medir — erros que ESCAPARAM — e o valor da comparação está no lado proxiado.
const browser = await chromium.launch();

const agrupar = (lista) => {
	const por = new Map();
	for (const e of lista) {
		const chave = `${e.nome}: ${e.msg}`;
		const g = por.get(chave) || { n: 0, exemplo: e };
		g.n++;
		por.set(chave, g);
	}
	return [...por.entries()].sort((a, b) => b[1].n - a[1].n);
};

try {
	const ctx = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1600, height: 900 },
		locale: "pt-BR",
	});
	const page = await ctx.newPage();

	const capturados = [];
	const escaparam = [];

	page.on("console", async (m) => {
		if (m.type() !== "warning") return;
		if (!m.text().startsWith("CAUGHT ERROR")) return;
		const args = m.args();
		if (args.length < 2) return;
		try {
			const d = await args[1].evaluate((e) => ({
				nome: e && e.name ? String(e.name) : typeof e,
				msg: e && e.message ? String(e.message).slice(0, 160) : String(e).slice(0, 160),
				stack: e && e.stack ? String(e.stack).split("\n").slice(0, 4).join(" | ").slice(0, 300) : "",
			}));
			capturados.push(d);
		} catch {
			// o handle já pode ter sido descartado; contar mesmo assim não mente sobre o volume
			capturados.push({ nome: "?", msg: m.text().slice(0, 120), stack: "" });
		}
	});
	page.on("pageerror", (e) => escaparam.push(String(e).slice(0, 160)));

	console.log(`=== ${ALVO} ${DIRETO ? "SEM proxy" : "atravessando o proxy"} ===`);
	if (DIRETO) {
		await page.goto(ALVO, { waitUntil: "domcontentloaded", timeout: 45000 });
	} else {
		await esperarServidor(BASE, 15000);
		await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
		const input = await page.waitForSelector("input", { timeout: 20000 });
		await input.fill(ALVO);
		await input.press("Enter");
	}
	await page.waitForTimeout(ESPERA);

	// clicar faz o widget rodar o caminho que mais sonda o ambiente
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
			}
		} catch {}
	}
	await page.waitForTimeout(12000);

	console.log(`\n=== exceções que o SITE capturou nos próprios catch: ${capturados.length} ===`);
	for (const [chave, g] of agrupar(capturados)) {
		console.log(`\n  ${String(g.n).padStart(3)}×  ${chave}`);
		if (g.exemplo.stack) console.log(`        ${g.exemplo.stack}`);
	}

	console.log(`\n=== exceções que ESCAPARAM (pageerror): ${escaparam.length} ===`);
	for (const e of escaparam.slice(0, 10)) console.log("     " + e);

	console.log("\n=== leitura ===");
	console.log("  Mensagens do tipo 'x is not a function' / 'undefined' sobre APIs conhecidas são");
	console.log("  sondagem de ambiente e existem sem proxy nenhum. O que acusa defeito é exceção");
	console.log("  que cite um símbolo do motor, ou que só apareça na coluna proxiada.");
} finally {
	await browser.close();
}
