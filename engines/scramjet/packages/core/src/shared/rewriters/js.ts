import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { discardRewriter, getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import {
	Array_from,
	JSON_stringify,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
} from "../snapshot";

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};
// vssh fork: as flags que vão ao rewriter, calculadas uma vez por configuração e endereço.
const flagsGuardadas = new WeakMap<object, Map<string, Record<string, boolean>>>();

function flagsDe(context: ScramjetContext, meta: URLMeta): Record<string, boolean> {
	let porEndereco = flagsGuardadas.get(context.config);
	if (!porEndereco) flagsGuardadas.set(context.config, (porEndereco = new Map()));
	const href = meta.base.href;
	let flags = porEndereco.get(href);
	if (!flags) {
		flags = {};
		for (const flag of Object_keys(context.config.flags))
			flags[flag] = flagEnabled(flag as any, context, meta.base);
		if (porEndereco.size >= 64) porEndereco.delete(porEndereco.keys().next().value!);
		porEndereco.set(href, flags);
	}

	return flags;
}

function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = flagsDe(context, meta);

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: context.prefix.pathname,
				},
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, meta.base)) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} catch (err) {
		// vssh fork: o lado Rust pode ter ficado no meio de uma reescrita sem conseguir avisar, e
		// esta instância voltaria direto para o pool. Nunca mais entregar — ver `discardRewriter`.
		discardRewriter(rewriter);

		throw err;
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

const CACHE_MAX = 512;
const CACHE_TEXTO_MAX = 64 * 1024;
const cacheDeReescrita = new Map<
	string,
	{ js: string; tag: string; mapa: number[] | null }
>();

function rewriteJsMapeado(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false,
	inicio?: [number, number]
): string | Uint8Array {
	{
		// vssh fork: no cliente, a mesma fonte pedida de novo (o `Function` e o `eval` de um laço)
		// sai da reescrita já feita, com o mesmo mapa e a mesma tag.
		const pushmap = globalThis[context.config.globals.pushsourcemapfn];
		const chave =
			pushmap && typeof js === "string" && js.length <= CACHE_TEXTO_MAX
				? `${isModule ? 1 : 0}\u0000${url}\u0000${meta.base.href}\u0000${meta.origin.href}\u0000${js}`
				: null;
		const guardada = chave !== null ? cacheDeReescrita.get(chave) : undefined;
		if (guardada) {
			if (guardada.mapa) pushmap(guardada.mapa, guardada.tag, -1);

			return guardada.js;
		}

		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;
		let mapa: number[] | null = null;

		if (flagEnabled("sourcemaps", context, meta.base)) {
			if (pushmap) {
				mapa = Array_from(res.map);
				pushmap(mapa, res.tag, -1);
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					newjs = TextDecoder_decode(newjs);
				}
				// vssh fork: a chamada fica na mesma linha do código do site, sem quebra, e leva a
				// linha e a coluna em que o script começa no documento do site. Com ela o cliente
				// devolve a posição da fonte do site a cada quadro da pilha (ver
				// `client/posicoes.ts`).
				const [linha, coluna] = inicio ?? [1, 0];
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}", ${linha}, ${coluna});`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&;${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}${newjs}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		if (chave !== null && typeof newjs === "string") {
			if (cacheDeReescrita.size >= CACHE_MAX)
				cacheDeReescrita.delete(cacheDeReescrita.keys().next().value!);
			cacheDeReescrita.set(chave, { js: newjs, tag: res.tag, mapa });
		}

		return newjs;
	}
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false,
	inicio?: [number, number]
): string | Uint8Array {
	// vssh fork: duas falhas MUITO diferentes chegavam aqui como uma só, e o `allowInvalidJs`
	// deixava as duas passarem devolvendo a fonte intacta.
	//
	// **Fonte inválida é inofensiva de devolver: ela não executa.** O navegador levanta o mesmo
	// SyntaxError com ou sem proxy, e em geral é justamente o que o site quer — o Google avalia
	// `eval("x='")` de propósito, como sonda de ambiente, e espera pegar o throw. Foram nove
	// linhas assim no dump de console de produção, e nenhuma delas era defeito nosso.
	//
	// **Falha NOSSA é o oposto.** Aquele código era válido e ia rodar; devolvê-lo sem reescrita
	// faz ele rodar **sem wrap**, lendo `location`, origem e cookie reais. É a mesma família dos
	// defeitos que quebraram o painel de chat do YouTube e o reCAPTCHA — só que calada, porque o
	// aviso no console era idêntico ao do `x='` inofensivo.
	let erro: any;

	// Duas tentativas, porque a falha mais provável é uma instância travada: a primeira tentativa
	// tira ela do pool (ver `discardRewriter`), então a segunda pega uma limpa e a página nem fica
	// sabendo. Fonte que não parseia sai na hora — na segunda daria exatamente o mesmo.
	for (let tentativa = 0; tentativa < 2; tentativa++) {
		try {
			return rewriteJsMapeado(js, url, context, meta, isModule, inicio);
		} catch (err) {
			erro = err;
			if (err?.scramjetSourceFault === true) break;
		}
	}

	if (erro?.scramjetSourceFault === true) {
		dbg.warn(
			"invalid js, serving unchanged",
			url || "(unknown)",
			erro.message,
			typeof js !== "string" ? TextDecoder_decode(js) : js
		);

		if (flagEnabled("allowInvalidJs", context, meta.base)) {
			return js;
		} else {
			throw erro;
		}
	}

	// O rewriter falhou duas vezes em JS que parseia. Devolver a fonte agora seria executá-la sem
	// wrap, então devolvemos algo que se recusa a rodar: a página perde ESTE script em vez de
	// perder o documento inteiro — jogar o erro daqui derrubaria a reescrita de HTML por completo,
	// porque script inline e atributo de evento também passam por esta função.
	dbg.error(
		"rewriter failed, refusing to serve unrewritten js",
		url || "(unknown)",
		erro?.message ?? erro,
		typeof js !== "string" ? TextDecoder_decode(js) : js
	);

	return `throw new Error(${JSON_stringify(
		`scramjet: recusou rodar javascript sem reescrita de ${url || "(desconhecido)"} — o rewriter falhou: ${erro?.message ?? erro}`
	)});`;
}
