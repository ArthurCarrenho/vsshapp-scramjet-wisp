// Quando a reescrita falha, o motor sabe de QUEM é a culpa?
//
// A pergunta importa porque as duas respostas pedem condutas opostas. Fonte inválida pode voltar
// intacta: ela não executa, e o site em geral quer justamente o SyntaxError (o Google avalia `x='`
// de propósito, como sonda). Falha do rewriter não pode: aquele código era válido, ia rodar, e
// devolvê-lo cru é rodá-lo SEM wrap — enxergando `location` e origem reais.
//
// Até aqui as duas chegavam ao JS como a mesma exceção, e o `allowInvalidJs` (ligado por padrão)
// deixava as duas passarem. Este script fala com o wasm direto, sem navegador, e mede o contrato.
//
//   node bench/rewriter-falha.mjs
//
// Precisa do wasm construído (`cd packages/core && npm run rewriter:build`).

import { readFileSync } from "node:fs";

const RAIZ = new URL("../", import.meta.url);
const GLUE = new URL("packages/core/rewriter/wasm/out/wasm.js", RAIZ);
const WASM = new URL("packages/core/dist/scramjet.wasm", RAIZ);

const { initSync, Rewriter } = await import(GLUE.href);
initSync({ module: new WebAssembly.Module(readFileSync(WASM)) });

const CONFIG = {
	prefix: "/scramjet/",
	wrapfn: "$wrap",
	wrappropertybase: "$sj_",
	wrappropertyfn: "$prop",
	cleanrestfn: "$clean",
	importfn: "$import",
	rewritefn: "$rewrite",
	wrappostmessagefn: "$wrapPostMessage",
	metafn: "$meta",
	pushsourcemapfn: "$pushsourcemap",
	trysetfn: "$tryset",
	templocid: "$temploc",
	tempunusedid: "$tempunused",
};

const FLAGS = {
	sourcemaps: false,
	captureErrors: false,
	scramitize: false,
	disableComputedWrap: false,
	destructureRewrites: false,
};

// O `codec.encode` do scramjet: recebe uma URL, devolve a reescrita. É uma função JS chamada de
// dentro do wasm, então o que ela levantar chega ao rewriter como erro do rewriter de URL — que é
// exatamente a falha "nossa" que este script precisa provocar.
const codecOk = (url) => url;
const codecQuebrado = () => {
	throw new Error("codec recusou de propósito");
};

const rw = new Rewriter();

function reescrever(codec, js, isModule = false) {
	try {
		rw.rewrite_js(CONFIG, FLAGS, codec, js, "https://exemplo.com/", "teste.js", isModule);

		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			culpaDaFonte: err?.scramjetSourceFault,
			msg: String(err?.message ?? err).split("\n")[0],
		};
	}
}

const casos = [
	{
		nome: "fonte inválida é culpa da FONTE",
		rodar: () => reescrever(codecOk, "x='"),
		esperado: (r) => r.ok === false && r.culpaDaFonte === true,
	},
	{
		nome: "e não contamina a próxima reescrita",
		rodar: () => reescrever(codecOk, "let x = 1;"),
		esperado: (r) => r.ok === true,
	},
	{
		nome: "codec que levanta é culpa NOSSA",
		rodar: () => reescrever(codecQuebrado, 'import "./a.js";', true),
		esperado: (r) => r.ok === false && r.culpaDaFonte === false,
	},
	{
		// A regressão. Antes do `Rewriter::restore`, o erro acima saía sem devolver as mudanças ao
		// slot, e daqui em diante TODA reescrita nesta instância falhava com "Already rewriting".
		// Como o pool de `wasm.ts` nunca despeja ninguém, era o resto da vida da página servida sem
		// wrap, em silêncio.
		nome: "e o rewriter sobrevive a ela",
		rodar: () => reescrever(codecOk, "let x = location.href;"),
		esperado: (r) => r.ok === true,
	},
];

let falhas = 0;
for (const caso of casos) {
	const r = caso.rodar();
	const passou = caso.esperado(r);
	if (!passou) falhas++;
	console.log(`${passou ? "ok  " : "FALHOU"} ${caso.nome}`);
	console.log(`       ${JSON.stringify(r)}`);
}

console.log(`\n${casos.length - falhas}/${casos.length} passaram`);
process.exit(falhas ? 1 : 0);
