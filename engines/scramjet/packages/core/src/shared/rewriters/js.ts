import { flagEnabled, ScramjetContext } from "@/shared";
import { URLMeta } from "@rewriters/url";
import { bytesToBase64 } from "@/shared/util";

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

// vssh fork: o objeto de configuração que vai ao rewriter é sempre o mesmo para os mesmos globais
// e o mesmo prefixo. O lado Rust guarda o que leu do último objeto e não o lê de novo quando
// recebe o mesmo (ver `config_de` em `rewriter/wasm/src/lib.rs`).
const configsGuardadas = new WeakMap<object, Map<string, Record<string, string>>>();

function configDe(context: ScramjetContext): Record<string, string> {
	const globais = context.config.globals as unknown as Record<string, string>;
	let porPrefixo = configsGuardadas.get(globais);
	if (!porPrefixo) configsGuardadas.set(globais, (porPrefixo = new Map()));
	const prefixo = context.prefix.pathname;
	let config = porPrefixo.get(prefixo);
	if (!config) {
		config = { ...globais, prefix: prefixo };
		if (porPrefixo.size >= 16) porPrefixo.delete(porPrefixo.keys().next().value!);
		porPrefixo.set(prefixo, config);
	}

	return config;
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
				configDe(context),
				flagsobj,
				context.interface.codecEncode,
				input,
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				configDe(context),
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
				// vssh fork: o mapa vai em base64. Como literal de array ele tinha centenas de
				// milhares de números num script grande: caro de montar aqui e de analisar na página.
				const mapa64 = bytesToBase64(res.map instanceof Uint8Array ? res.map : Uint8Array.from(res.map));
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}("${mapa64}", "${res.tag}", ${linha}, ${coluna});`;

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

// vssh fork: a reescrita de um script que veio da rede, guardada pelo SHA-256 dos bytes.
//
// O cache HTTP do motor guarda o corpo antes da reescrita, e cada acerto dele reescreve de novo,
// na thread do shell: o bundle que um site serve em todas as páginas dele era percorrido pelo
// rewriter a cada navegação, a uns 40 ms por megabyte. A chave leva o que entra na saída além dos
// bytes: módulo ou não, o prefixo, os globais e as flags. O endereço base entra na saída só pelo
// `import()`, pelo `import.meta` e pelos `import` estáticos de um módulo, e a entrada guarda a
// base só nesses casos; um script clássico sem nenhum dos dois serve qualquer página. O hash é
// criptográfico porque o cache é de todos os sites: um script que colidisse com o de outro site
// rodaria no lugar dele, na origem dele.
const TETO_DA_REDE = 32 * 1024 * 1024;
const guardadosDaRede = new Map<
	string,
	{ js: string | Uint8Array; base: string | null; tamanho: number }
>();
let tamanhoDaRede = 0;
const idsDosGlobais = new WeakMap<object, number>();
let proximoId = 0;

function idDosGlobais(globais: object): number {
	let id = idsDosGlobais.get(globais);
	if (id === undefined) idsDosGlobais.set(globais, (id = proximoId++));

	return id;
}

function hexDe(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);

	return hex;
}

export async function rewriteJsDaRede(
	js: Uint8Array,
	url: string | null,
	context: ScramjetContext,
	meta: URLMeta,
	isModule = false
): Promise<string | Uint8Array> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return rewriteJs(js, url, context, meta, isModule);

	const flags = flagsDe(context, meta);
	let chaveDasFlags = "";
	for (const k of Object_keys(flags)) if (flags[k]) chaveDasFlags += k + ",";
	const chave = `${isModule ? 1 : 0}\u0000${context.prefix.pathname}\u0000${idDosGlobais(context.config.globals)}\u0000${chaveDasFlags}\u0000${hexDe(await subtle.digest("SHA-256", js as Uint8Array<ArrayBuffer>))}`;

	const guardado = guardadosDaRede.get(chave);
	if (guardado && (guardado.base === null || guardado.base === meta.base.href)) {
		guardadosDaRede.delete(chave);
		guardadosDaRede.set(chave, guardado);

		return guardado.js;
	}

	let saida: string | Uint8Array;
	try {
		saida = rewriteJsMapeado(js, url, context, meta, isModule);
	} catch {
		// A falha fica fora do cache e segue o caminho de sempre, com a segunda tentativa e a
		// recusa de rodar o que não se reescreveu.
		return rewriteJs(js, url, context, meta, isModule);
	}

	const tamanho = saida.length;
	if (tamanho <= TETO_DA_REDE / 4) {
		const { importfn, metafn } = context.config.globals;
		const texto = typeof saida === "string" ? saida : null;
		const usaBase =
			isModule ||
			texto === null ||
			texto.includes(importfn + "(") ||
			texto.includes(metafn + "(");
		if (guardado) tamanhoDaRede -= guardado.tamanho;
		guardadosDaRede.delete(chave);
		guardadosDaRede.set(chave, { js: saida, base: usaBase ? meta.base.href : null, tamanho });
		tamanhoDaRede += tamanho;
		while (tamanhoDaRede > TETO_DA_REDE) {
			const [velha, entrada] = guardadosDaRede.entries().next().value!;
			guardadosDaRede.delete(velha);
			tamanhoDaRede -= entrada.tamanho;
		}
	}

	return saida;
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
