import { rewriteJs } from "@rewriters/js";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty, String } from "@/shared/snapshot";
import { comoOriginal } from "@/shared/confiavel";
import { registrarCompilacao } from "@client/pilha";
import { registrarScript } from "@client/posicoes";
import { cobrir } from "@client/shared/proto";
import { AnyFunction } from "@/types";

// vssh fork: o começo em branco de uma fonte fica fora do rewriter.
//
// O rewriter lê a fonte inteira, e o custo dele cresce com o tamanho dela: a cópia para o wasm, a
// análise e a cópia de volta. O `eval` nativo atravessa um megabyte de espaços na frente de uma
// expressão curta em 1,5 ms, e com o megabyte indo ao rewriter a mesma chamada leva 15 ms. O
// desafio gerenciado do Cloudflare avalia uma fonte assim duas vezes por segundo (ver
// `bench/portal/desafio-cloudflare.md`). O começo em branco segue ao compilador nativo como veio,
// e o rewriter recebe o resto.
//
// As posições que o mapa da reescrita devolve para uma fonte assim contam a partir do fim do
// começo em branco.
const BRANCO_MINIMO = 4096;
const aparar = Function.prototype.call.bind(globalThis.String.prototype.trimStart) as (
	s: string
) => string;
const fatiar = Function.prototype.call.bind(globalThis.String.prototype.slice) as (
	s: string,
	ini: number,
	fim?: number
) => string;
const repetir = Function.prototype.call.bind(globalThis.String.prototype.repeat) as (
	s: string,
	n: number
) => string;

type Reescrita = {
	/** O que o compilador nativo recebe: texto, ou TrustedScript num documento que o exige. */
	codigo: any;
	/** Quantos caracteres do começo ficaram fora do rewriter. */
	branco: number;
	/** O texto de `codigo`, montado só quando uma pilha precisa do hash dele. */
	fonte: () => string;
};

function reescrever(client: ScramjetClient, original: unknown, nome: string): Reescrita {
	let branco = 0;
	let fonte: (() => string) | null = null;
	const codigo = comoOriginal(
		client,
		"TrustedScript",
		original,
		(texto) => {
			if (texto.length >= BRANCO_MINIMO) {
				const resto = aparar(texto);
				const n = texto.length - resto.length;
				if (n >= BRANCO_MINIMO) {
					const reescrito = rewriteJs(resto, nome, client.context, client.meta) as string;
					const comeco = fatiar(texto, 0, n);
					branco = n;
					// Um começo só de espaços se refaz pelo tamanho, e o registro da compilação
					// guarda a expressão curta no lugar do megabyte.
					fonte =
						comeco === repetir(" ", n)
							? () => repetir(" ", n) + reescrito
							: () => comeco + reescrito;

					return comeco + reescrito;
				}
			}

			return rewriteJs(texto, nome, client.context, client.meta) as string;
		},
		"eval"
	);

	return { codigo, branco, fonte: fonte ?? (() => String(codigo)) };
}

function registrar(client: ScramjetClient, r: Reescrita) {
	const tag = client.box.mapas.ultimaTag;
	if (tag)
		registrarScript(client, r.fonte, {
			tag,
			ini: r.branco,
			d: -r.branco,
			dl: 0,
			primeira: -1,
			col0: 0,
		});
}

export default function (client: ScramjetClient, self: Self) {
	// used for proxying *direct eval*
	// eval("...") -> eval($scramjet$rewrite("..."))
	// O texto de uma função como o navegador o escreve, sem o `toString` que o motor troca.
	const fonteNativa = (fn: unknown): string => {
		try {
			return String(client.natives.call("Function.prototype.toString", fn as AnyFunction));
		} catch {
			return "";
		}
	};
	Object_defineProperty(self, client.config.globals.rewritefn, {
		value: function (js: any, chamado?: unknown) {
			// vssh fork: o reescritor passa o `eval` chamado (`eval($rewrite(x, eval))`). Só uma função
			// nativa compila o texto: o `eval` de um realm, ou um nativo qualquer que o site pôs no
			// lugar. Uma função do site (um parâmetro chamado `eval`, um `window.eval` trocado) recebe
			// o texto que o site passou, e o `eval` indireto do motor reescreve sozinho.
			if (arguments.length > 1) {
				if (chamado === client.indirectEval || client.box.unproxy.has(chamado as any)) return js;
				if (typeof chamado !== "function" || !/\{\s*\[native code\]\s*\}$/.test(fonteNativa(chamado)))
					return js;
			}
			// if eval is called on anything other than a string, we should just return it unchanged
			// the one exception is TrustedScript, which can just be stringified and rewritten
			const original = js;
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			client.box.mapas.ultimaTag = null;
			const r = reescrever(client, original, "(direct eval proxy)");
			registrar(client, r);

			return r.codigo;
		},
		writable: false,
		configurable: false,
	});
}

export function createIndirectEval(client: ScramjetClient) {
	const indirection = client.global.eval;
	const proxy = cobrir(client, client.global.eval, {
		apply(_target, _thisArg, args) {
			let js = args[0];
			const original = js;
			// > If the argument of eval() is not a string, eval() returns the argument unchanged
			// the one exception is TrustedScript, which can just be stringified and rewritten
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			client.box.mapas.ultimaTag = null;
			const r = reescrever(client, original, "(indirect eval proxy)");
			registrarCompilacao(client, r.fonte);
			registrar(client, r);

			return indirection(r.codigo);
		},
	});
	client.box.unproxy.set(proxy, client.global.eval);

	return proxy;
}
