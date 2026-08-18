// O que um site lê quando lê a própria pilha de erro, atravessando o proxy.
//
// Código anti-bot lê pilha. O reCAPTCHA faz isso 54 vezes num único carregamento — são todos os
// "CAUGHT ERROR" que aparecem no console, e a pilha deles nasce de um `new Error()` que o próprio
// widget cria e captura (ver `captcha-erros.mjs`). Se o que ele lê aponta para o proxy, o ambiente
// está assinado: o host do portal, o prefixo do motor e a URL de destino, tudo em texto.
//
// Duas flags do motor decidem isso, e as duas vêm DESLIGADAS no `defaultConfig` (o que a produção
// usa, porque o portal constrói o Controller sem passar `scramjetConfig`):
//
//   cleanErrors     troca, na pilha, a URL do proxy pela URL lógica — e tira os frames dos
//                   arquivos listados em `maskedfiles`
//   debugSourceURL  carimba `//# sourceURL=` com a URL lógica, o que já faz a pilha parecer certa
//                   (é por isso que a bancada, que roda em `defaultConfigDev`, não vê o problema)
//
// Este script mede o que sai na pilha, de dentro de um frame proxiado, pelos dois caminhos que um
// site tem: exceção real e `new Error()`. Rode-o, mude a flag em `packages/core/src/index.ts`,
// reinicie o devserver e rode de novo — a diferença entre as duas saídas é o que o site vê.

import http from "node:http";

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const PORTA = Number(process.env.BENCH_PORTA || 5320);
const LIMITE = Number(process.env.BENCH_LIMITE || 180000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

// A página é servida de um arquivo .js SEPARADO de propósito: script inline e script externo
// passam por caminhos diferentes no rewriter, e é o externo que todo site de verdade usa.
const PAGINA = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>pilha</title></head>
<body><h1>pilha</h1><script src="/sonda.js"></script></body></html>`;

const SONDA = `
window.__pilhas = {};
try { null.naoExiste(); } catch (e) { window.__pilhas.excecao = String(e.stack || ''); }
window.__pilhas.novoErro = String(new Error('sonda').stack || '');
try {
  window.__pilhas.deFuncao = (function nivel1() {
    return (function nivel2() { return new Error('fundo').stack; })();
  })();
} catch (e) { window.__pilhas.deFuncao = 'erro: ' + e; }
document.title = 'pronto';
`;

const servidor = http.createServer((req, res) => {
	if (req.url.startsWith("/sonda.js")) {
		res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
		return res.end(SONDA);
	}
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(PAGINA);
});
await new Promise((r) => servidor.listen(PORTA, r));

await esperarServidor(BASE, 15000);
const browser = await chromium.launch();

try {
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
	const page = await ctx.newPage();

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector("input", { timeout: 20000 });
	await input.fill(`http://localhost:${PORTA}/`);
	await input.press("Enter");
	await page.waitForTimeout(9000);

	const f = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().includes(String(PORTA)));
	if (!f) {
		console.log("não achei o frame proxiado. frames:");
		for (const fr of page.frames()) console.log("   " + fr.url().slice(0, 110));
		process.exit(1);
	}

	const pilhas = await f.evaluate(() => window.__pilhas || {});

	// O que denuncia o ambiente: o host do proxy, o prefixo do motor, e a URL de destino escapada
	// dentro do caminho (a assinatura mais óbvia das três).
	const marcas = [
		["host do proxy", /localhost:4141/],
		["prefixo do motor", /\/~\/?sj\//],
		["URL de destino no caminho", /https?%3A%2F%2F/i],
		["símbolo do motor", /\$scram|scramjet/i],
	];

	console.log("=== o que o site lê na própria pilha ===\n");
	let vazou = 0;
	for (const [nome, pilha] of Object.entries(pilhas)) {
		const primeira = String(pilha).split("\n").slice(0, 3).join("\n      ");
		console.log(`  ${nome}:`);
		console.log(`      ${primeira || "(vazia)"}`);
		const achadas = marcas.filter(([, re]) => re.test(String(pilha))).map(([n]) => n);
		if (achadas.length) {
			vazou++;
			console.log(`      ⚠ denuncia: ${achadas.join(", ")}`);
		} else {
			console.log(`      ✓ nada do proxy aparece`);
		}
		console.log("");
	}

	console.log("=== veredito ===");
	console.log(`  ${vazou} de ${Object.keys(pilhas).length} pilhas denunciam o proxy.`);
	console.log("  Compare esta saída com a de outra configuração de flags — é a diferença que importa.");
	process.exitCode = vazou ? 1 : 0;
} finally {
	await browser.close();
	servidor.close();
}
