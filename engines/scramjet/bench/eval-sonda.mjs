// A sonda do Google continua vendo o que ela espera ver?
//
// `eval("x='")` é uma sonda de ambiente: o site executa uma string que NÃO é javascript válido, de
// propósito, e espera pegar um `SyntaxError`. São nove linhas assim no dump de console de produção.
//
// Isso vira uma armadilha ao mexer no tratamento de falha do rewriter. O caminho "fonte inválida"
// precisa devolver a fonte intacta, para o navegador levantar o MESMO SyntaxError que levantaria
// sem proxy. Se ele passar a devolver outra coisa — um stub que joga um `Error` nosso, por exemplo
// — a sonda vê um erro de tipo errado, e a diferença é invisível no console.
//
// Este script mede as duas metades ao mesmo tempo: que o eval inválido ainda dá SyntaxError, e que
// o eval válido ainda roda com wrap (a origem lida de dentro é a proxiada, não a do portal).
//
// ⚠ O resultado depende da flag `allowInvalidJs`, e as duas metades importam:
//
//   ligada  (`defaultConfig`, o que roda em PRODUÇÃO) — a fonte volta intacta e o navegador dá o
//           SyntaxError, que é o que a sonda do site espera;
//   desligada (`defaultConfigDev`, o que o devserver usa) — o erro de parse sobe como exceção.
//
// Qualquer uma das duas é correta. O que NÃO pode acontecer, em nenhuma delas, é o stub de recusa
// — esse é só para falha do rewriter, e chegar aqui significaria que a classificação errou o lado.
//
// ⚠ O devserver roda com ela DESLIGADA e não dá para virar de fora: o `scramjet-flags` do demo não
// alcança o client dentro do frame proxiado, que recebe a config pelo service worker. Para
// exercitar a metade de produção é preciso mudar `defaultConfigDev` e reiniciar o devserver.
//
//   npm run dev            # noutro terminal, na 4141
//   node bench/eval-sonda.mjs

import { createServer } from "node:http";

const { chromium, esperarServidor } = await import("./comum.mjs");
const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const PORTA = Number(process.env.BENCH_PORTA || 4142);
const ESPERA = Number(process.env.BENCH_ESPERA || 8000);
const LIMITE = Number(process.env.BENCH_LIMITE || 180000);
const morte = setTimeout(() => { console.log(`\n[abortado: ${LIMITE}ms]`); process.exit(2); }, LIMITE);
morte.unref?.();

// A página sonda é servida daqui mesmo: o alvo precisa ser estável e offline, senão o teste mede a
// internet junto. O wisp conecta em localhost sem cerimônia.
const PAGINA = `<!doctype html><html><head><meta charset="utf-8"><title>sonda</title></head><body>
<h1>sonda</h1>
<script>
window.__sonda = { origem: location.origin };
try { eval("x='"); __sonda.evalInvalido = "NAO LEVANTOU"; }
catch (e) { __sonda.evalInvalido = e.constructor.name; __sonda.evalInvalidoMsg = String(e.message).slice(0, 90); }
try { __sonda.evalValido = eval("1+1"); } catch (e) { __sonda.evalValido = "erro: " + e.message; }
try { __sonda.novaFuncao = new Function("return 2+2")(); } catch (e) { __sonda.novaFuncao = "erro: " + e.message; }
</script>
</body></html>`;

const servidor = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	res.end(PAGINA);
});
await new Promise((r) => servidor.listen(PORTA, r));
const ALVO = process.env.BENCH_ALVO || `http://localhost:${PORTA}/`;

await esperarServidor(BASE, 15000);

const browser = await chromium.launch();
let falhas = 0;
try {
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
	const page = await ctx.newPage();
	const console_ = [];
	page.on("console", (m) => console_.push(`${m.type()}: ${m.text().replace(/\s+/g, " ").slice(0, 170)}`));

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector("input", { timeout: 20000 });
	await input.fill(ALVO);
	await input.press("Enter");
	await page.waitForTimeout(ESPERA);

	const frame = page.frames().find((f) => decodeURIComponent(f.url()).includes(`localhost:${PORTA}`));
	if (!frame) {
		console.log("não achei o frame da sonda — frames vistos:");
		for (const f of page.frames()) console.log("  " + decodeURIComponent(f.url()).slice(0, 90));
		process.exit(1);
	}

	const sonda = await frame.evaluate("window.__sonda");
	const msg = String(sonda?.evalInvalidoMsg || "");
	// Qual das duas metades acabou de ser exercitada, deduzida do que voltou. Ler a flag de fora
	// não serve: quem decide é o client DENTRO do frame proxiado, e ele recebe a config pelo
	// service worker.
	const metade =
		sonda?.evalInvalido === "SyntaxError"
			? "allowInvalidJs LIGADA (como em produção): a fonte voltou intacta"
			: msg.includes("not parseable javascript")
				? "allowInvalidJs DESLIGADA (como no devserver): o erro de parse subiu"
				: "NENHUMA DAS DUAS";
	console.log("=== sonda ===");
	console.log(" ", JSON.stringify(sonda, null, 1));
	console.log(` ${metade}`);

	const conferir = (nome, ok, visto) => {
		if (!ok) falhas++;
		console.log(`${ok ? "ok  " : "FALHOU"} ${nome}${ok ? "" : ` — veio ${JSON.stringify(visto)}`}`);
	};

	console.log("");
	// As duas metades são corretas; qual delas roda depende da flag. O que precisa valer sempre é
	// que a fonte inválida seja tratada COMO fonte inválida — se ela cair no caminho de falha do
	// rewriter, o site recebe um erro nosso no lugar do erro que ele mesmo provocou, e a
	// classificação errou o lado.
	conferir("`x='` foi tratado como fonte inválida", metade !== "NENHUMA DAS DUAS", `${sonda?.evalInvalido}: ${msg}`);
	conferir("e não como falha do rewriter", !msg.includes("sem reescrita"), msg);
	conferir("eval válido continua rodando", sonda?.evalValido === 2, sonda?.evalValido);
	conferir("Function() continua rodando", sonda?.novaFuncao === 4, sonda?.novaFuncao);
	conferir(`a origem lida de dentro é a proxiada`, sonda?.origem === `http://localhost:${PORTA}`, sonda?.origem);

	const recusas = console_.filter((l) => l.includes("refusing to serve unrewritten"));
	conferir("nenhum script foi recusado", recusas.length === 0, recusas.slice(0, 3));

	console.log(`\n${6 - falhas}/6 passaram`);
} finally {
	await browser.close().catch(() => {});
	servidor.close();
	clearTimeout(morte);
}
process.exit(falhas ? 1 : 0);
