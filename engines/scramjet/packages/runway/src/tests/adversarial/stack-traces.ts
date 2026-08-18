import { basicTest } from "../../testcommon.ts";

// Anti-bot code reads stack traces. It is one of the cheapest environment probes there is: create
// an Error, read `.stack`, look at the file names. A single reCAPTCHA load creates 54 of them —
// the widget throws and catches its own errors precisely to inspect the trace.
//
// Under the proxy, every script's real file name is the rewritten URL, so an untreated stack hands
// the site the whole arrangement: the proxy's host, the engine's path prefix, and the destination
// URL percent-escaped inside the path. `cleanErrors` exists to substitute the logical URL back in,
// and it is on by default (see `defaultConfig` in packages/core/src/index.ts).
//
// It also spent a long time doing nothing at all: it was installed through `client.Trap`, which
// gives up when the property does not exist — and `Error.prepareStackTrace` does NOT exist in
// Chromium until something defines it. Turning the flag on changed no behaviour whatsoever. These
// tests fail loudly if that regresses, because nothing else would notice.

export default [
	basicTest({
		name: "stack-trace-nao-vaza-o-proxy",
		js: `
			const pilha = String(new Error("sonda").stack || "");
			assert(pilha.length > 0, "precondição: o erro tem pilha");
			assert(!/\\/~\\/?sj\\//.test(pilha),
				"a pilha não pode carregar o prefixo do motor: " + pilha.slice(0, 240));
			assert(!/https?%3A%2F%2F/i.test(pilha),
				"a pilha não pode carregar a URL de destino escapada: " + pilha.slice(0, 240));
		`,
	}),
	basicTest({
		// O outro lado: limpar a pilha não pode custar a pilha. Ela é remontada a partir dos
		// CallSites, então o formato do v8 é responsabilidade nossa agora — e há código de
		// produção (rastreadores de erro, agrupadores de log) que o parseia linha a linha.
		name: "stack-trace-continua-sendo-pilha",
		js: `
			const linhas = String(new Error("oi").stack).split("\\n");
			assertEqual(linhas[0], "Error: oi", "a primeira linha é 'Nome: mensagem'");
			assert(linhas.length > 1, "a pilha tem quadros além do cabeçalho");
			assert(/^\\s+at /.test(linhas[1]), "os quadros começam com 'at': " + JSON.stringify(linhas[1]));

			// Erro sem mensagem não ganha um ": " pendurado — é assim que o v8 formata.
			assertEqual(String(new Error().stack).split("\\n")[0], "Error", "erro sem mensagem");

			// E o nome vem do erro, não é fixo.
			assertEqual(String(new TypeError("x").stack).split("\\n")[0], "TypeError: x", "TypeError");
		`,
	}),
	basicTest({
		// A pilha tem de continuar APONTANDO para o arquivo certo depois da substituição: trocar a
		// URL do proxy por vazio também zeraria as duas asserções de cima, e passaria.
		name: "stack-trace-aponta-para-o-arquivo-logico",
		js: `
			function fundo() { return new Error("marca").stack; }
			const pilha = String(fundo());
			assert(/\\bfundo\\b/.test(pilha), "o nome da função aparece na pilha: " + pilha.slice(0, 240));
			assert(/:\\d+:\\d+/.test(pilha), "linha e coluna aparecem: " + pilha.slice(0, 240));
			assert(/https?:\\/\\//.test(pilha), "há uma URL de verdade na pilha: " + pilha.slice(0, 240));
		`,
	}),
];
