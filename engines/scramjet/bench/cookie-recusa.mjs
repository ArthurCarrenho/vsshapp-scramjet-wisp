// A conferência de `Domain=` está recusando cookie legítimo em sites reais?
//
// A regra nova (RFC 6265 §5.3.6) recusa o cookie inteiro quando o `Domain=` não casa com o host que
// mandou. A tabela de lógica já mostrou que ela acerta os casos comuns; falta a pergunta que decide:
// em navegação de verdade, ela derruba algo que deveria passar?
//
// O `setCookies` está instrumentado para gritar em cada recusa. Aqui só carregamos sites que usam
// cookie de subdomínio a sério e lemos o que ele gritou.

const { chromium, esperarServidor } = await import("./comum.mjs");
const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const LIMITE = Number(process.env.BENCH_LIMITE || 600000);
const morte = setTimeout(() => { console.log(`\n[abortado: ${LIMITE}ms]`); process.exit(2); }, LIMITE);
morte.unref?.();

const SITES = (process.env.BENCH_SITES || [
	"https://accounts.google.com/ServiceLogin",
	"https://www.google.com/",
	"https://g1.globo.com/",
	"https://www.uol.com.br/",
	"https://www.gov.br/pt-br",
	"https://pt.wikipedia.org/wiki/Brasil",
].join(",")).split(",");

// O devserver do fork (`npm run dev`) é pré-requisito destes scripts, e não sobe sozinho.
// Falhar aqui, nomeando o endereço, é melhor que falhar dentro do Playwright com um erro
// de navegação que não diz o que está faltando.
await esperarServidor(BASE, 15000);

const browser = await chromium.launch();
try {
	const ctx = await browser.newContext({
		userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1400, height: 900 }, locale: "pt-BR",
	});
	const page = await ctx.newPage();
	const recusas = [];
	page.on("console", (m) => {
		const t = m.text();
		if (t.includes("sj-cookie-recusado")) recusas.push(t.replace(/^\[sj-cookie-recusado\]\s*/, "").slice(0, 160));
	});

	for (const site of SITES) {
		const antes = recusas.length;
		try {
			await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
			const input = await page.waitForSelector("input", { timeout: 20000 });
			await input.fill(site);
			await input.press("Enter");
			await page.waitForTimeout(15000);
		} catch (e) { console.log(`${site}: falhou (${String(e).slice(0, 50)})`); continue; }
		const novas = recusas.slice(antes);
		console.log(`\n=== ${site} — ${novas.length} recusa(s) ===`);
		const g = {};
		for (const r of novas) { g[r] = (g[r] || 0) + 1; }
		if (!novas.length) console.log("  (nenhum cookie recusado)");
		for (const [k, n] of Object.entries(g).slice(0, 10)) console.log(`  ${String(n).padStart(3)}x ${k}`);
	}

	console.log(`\n=== total: ${recusas.length} recusa(s) ===`);
} finally {
	await browser.close().catch(() => {});
	clearTimeout(morte);
}
