// Que formas de código escapam do `$wrap`?
//
// A pergunta importa porque escapar do wrap não é um defeito cosmético: `location` sem embrulho é a
// origem REAL do servidor, não a do site proxiado. Um script que leia isso sabe onde está e pode
// mandar o navegador para fora do proxy — é o mesmo tipo de furo que `06e978c0` fechou em quatro
// lugares.
//
// O `coverage_checked` do próprio rewriter já cospe seis avisos desses no build, e `53973c91` os
// afrouxou "temporariamente" no CI. Este script diz quais deles são reais.
//
//   node bench/wrap-escape.mjs
//
// Precisa do wasm construído (`cd packages/core && npm run rewriter:build`).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const RAIZ = new URL("../", import.meta.url);
const GLUE = new URL("packages/core/rewriter/wasm/out/wasm.js", RAIZ);

// BENCH_WASM aponta para outro `.wasm` — e usar isto NÃO é detalhe. O binário que produção serve
// passou por `wasm-snip` e pelo pipeline de `wasm-opt` (583 KB); o daqui é o build local sem
// otimização (947 KB). São binários diferentes, e a pergunta "o que escapa do wrap?" tem que ser
// respondida sobre o que o usuário carrega, não sobre o que é mais fácil de construir.
// `pathToFileURL(resolve(...))` e não `new URL(x, base)`: no Windows um caminho absoluto do bash do
// git (`/c/Users/...`) vira `file:///c/Users/...`, que o `fs` recusa por não ter a letra do drive.
const WASM = process.env.BENCH_WASM
	? pathToFileURL(resolve(process.env.BENCH_WASM))
	: new URL("packages/core/dist/scramjet.wasm", RAIZ);

const { initSync, Rewriter } = await import(GLUE.href);
const bytes = readFileSync(WASM);
initSync({ module: new WebAssembly.Module(bytes) });
console.log(`wasm: ${WASM.pathname.split("/").slice(-3).join("/")} (${bytes.length} bytes)`);

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

// `destructureRewrites` liga o caminho próprio do rewriter para padrões desestruturados; com ele
// desligado o visitor delega ao `walk` padrão do oxc, que desce nos elementos sozinho.
//
// ⚠ **PRODUÇÃO USA `true`** (`packages/core/src/index.ts`, no `defaultConfig`). O `false` que
// aparece no `Config::test` do Rust e no `bench/rewriter-falha.mjs` é do upstream, e foi o que
// escondeu o buraco do ArrayPattern: os testes exercitavam o caminho que produção NÃO usa, e ali o
// walk padrão cobria tudo. Medir nos DOIS estados é o que separa "o rewriter tem um buraco" de "o
// buraco é o flag" — e aqui a resposta foi a primeira.
function flags(destructure) {
	return {
		sourcemaps: false,
		captureErrors: false,
		scramitize: false,
		disableComputedWrap: false,
		destructureRewrites: destructure,
	};
}

const codec = (url) => url;
const rw = new Rewriter();

const CASOS = [
	["parâmetro simples", "function f(x = location) {}"],
	["param array", "function f([x = location]) {}"],
	["param objeto", "function f({x = location}) {}"],
	["param array, arrow", "const f = ([x = location]) => {};"],
	["param objeto, arrow", "const f = ({x = location}) => {};"],
	["param array, método de objeto", "const o = { m([x = location]) {} };"],
	["param array, método de classe", "class C { m([x = location]) {} }"],
	["param array aninhado", "function f([[x = location]]) {}"],
	["param array, top", "function f([x = top]) {}"],
	["param array, parent", "function f([x = parent]) {}"],
	["destructuring fora de param", "let [x = location] = a;"],
	["corpo da função", "function f() { return location; }"],
	["catch desestruturado", "try {} catch ([e = location]) {}"],
];

function rewrite(fonte, destructure) {
	const out = rw.rewrite_js(
		CONFIG,
		flags(destructure),
		codec,
		fonte,
		"https://exemplo.com/",
		"teste.js",
		false
	);
	// `rewrite_js` devolve `{ js, map, scramtag, errors }`, com `js` em Uint8Array.
	return new TextDecoder().decode(out.js);
}

console.log("Escapa do wrap = `location` aparece cru na saída, sem $wrap.\n");
console.log(`${"caso".padEnd(32)} ${"destructure=false".padEnd(20)} destructure=true`);
console.log("-".repeat(76));

let escapes = 0;
for (const [nome, fonte] of CASOS) {
	const linha = [];
	for (const d of [false, true]) {
		let veredito;
		try {
			const saida = rewrite(fonte, d);
			// ⚠ Só os globais que o rewriter DE FATO embrulha entram no teste. `document` e `window`
			// não são embrulhados em lugar nenhum — nem fora de desestruturação —, porque quem os
			// trata é o runtime por proxy, não o rewriter. Procurar por eles aqui produz um falso
			// positivo, e foi assim que `[x = document.cookie]` entrou na lista de "escapa" sem
			// nunca ter escapado de nada.
			const cru = saida.replace(/\$wrap\(\s*(location|top|parent)\b/g, "");
			veredito = /\b(location|top|parent)\b/.test(cru) ? "ESCAPA" : "ok";
		} catch (e) {
			veredito = "erro: " + String(e?.message ?? e).slice(0, 14);
		}
		linha.push(veredito);
	}
	// O que conta para o veredito é a coluna do flag LIGADO: é o estado de produção.
	if (linha[1] === "ESCAPA") escapes++;
	console.log(`${nome.padEnd(32)} ${linha[0].padEnd(20)} ${linha[1]}`);
}

console.log("-".repeat(76));
console.log(
	`${escapes} caso(s) escapam no estado de PRODUÇÃO (destructureRewrites=true).` +
		(escapes ? "  ← cada um é um script lendo a origem real do servidor." : "")
);
process.exit(escapes ? 1 : 0);
