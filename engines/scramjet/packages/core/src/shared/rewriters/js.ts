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

// eslint-disable-next-line scramjet-core/no-globals
Error.stackTraceLimit = 50;

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};
function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}

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

function rewriteJsMapeado(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): string | Uint8Array {
	{
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		if (flagEnabled("sourcemaps", context, meta.base)) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag);
			} else {
				// TODO: how do we check instanceof here?
				if (typeof newjs !== "string") {
					newjs = TextDecoder_decode(newjs);
				}
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(newjs)) {
					newjs = newjs.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${newjs}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		return newjs;
	}
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
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
			return rewriteJsMapeado(js, url, context, meta, isModule);
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
