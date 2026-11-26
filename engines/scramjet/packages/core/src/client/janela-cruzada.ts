import { SCRAMJETCLIENT } from "@/symbols";
import type { ScramjetClient } from "@client/index";
import { excecaoDoNavegador } from "@client/shared/excecao";
import { _URL, Object_defineProperty, Reflect_apply } from "@/shared/snapshot";
import { POLLUTANT } from "@client/shared/realm";

// vssh fork: a janela de outra origem, como o Chrome a entrega.
//
// Todo quadro do motor mora na origem do motor, então o navegador deixa um quadro ler o
// `document`, o `name` e qualquer global de um pai que, para o site, é de outra origem. Um script
// que confere se está mesmo num quadro de terceiro (ler `parent.location.href` e esperar o
// SecurityError, contar as chaves de `parent`) acha a página inteira do outro lado. Aqui a janela
// de outra origem lógica sai por uma vista com as regras do HTML para um WindowProxy de outra
// origem: as propriedades de `CrossOriginProperties`, os quadros filhos por índice e por nome, e
// o SecurityError do Chrome, com a mesma frase, para todo o resto.

const _Proxy = globalThis.Proxy;
const _WeakMap = globalThis.WeakMap;
const BASE = "$scramjet__";

const ACESSORES = ["window", "self", "location", "closed", "frames", "length", "top", "opener", "parent"];
const METODOS: Record<string, number> = { blur: 0, close: 0, focus: 0, postMessage: 1 };
const NOMES = [...ACESSORES, ...Object.keys(METODOS), "then"];
const SIMBOLOS = [Symbol.toStringTag, Symbol.hasInstance, Symbol.isConcatSpreadable];

const vistasPorCliente = new _WeakMap<ScramjetClient, WeakMap<object, any>>();
const reais = new _WeakMap<object, Window>();

/** A origem que o site vê numa janela do motor, ou `null` quando ela ainda não tem cliente. */
export function origemDe(janela: any): string | null {
	let atual = janela;
	for (let i = 0; i < 32 && atual; i++) {
		let cliente: ScramjetClient | undefined;
		try {
			cliente = atual[SCRAMJETCLIENT];
		} catch {
			return null;
		}
		if (!cliente) return null;
		const href = cliente.url.href;
		if (href !== "about:blank" && href !== "about:srcdoc") return cliente.url.origin;
		let acima: any;
		try {
			acima = atual.parent !== atual ? atual.parent : atual.opener;
		} catch {
			return null;
		}
		if (!acima || acima === atual) return null;
		atual = acima;
	}

	return null;
}

function ehIndice(k: PropertyKey): k is string {
	return typeof k === "string" && /^(0|[1-9]\d*)$/.test(k);
}

function semBase(k: PropertyKey): PropertyKey {
	return typeof k === "string" && k.startsWith(BASE) ? k.slice(BASE.length) : k;
}

/** A janela real atrás de uma vista, ou o próprio valor. */
export function janelaReal<T>(valor: T): T {
	return ((valor && reais.get(valor as any)) as any) ?? valor;
}

/**
 * O que `client` vê ao alcançar `alvo`: a própria janela quando as duas têm a mesma origem
 * lógica, e a vista de outra origem quando não têm.
 */
export function vistaDe<T>(client: ScramjetClient, alvo: T): T {
	if (!alvo || typeof alvo !== "object" || reais.has(alvo as any)) return alvo;
	const minha = origemDe(client.global);
	const dele = origemDe(alvo);
	if (!minha || !dele || minha === dele) return alvo;

	let cache = vistasPorCliente.get(client);
	if (!cache) vistasPorCliente.set(client, (cache = new _WeakMap()));
	let vista = cache.get(alvo as any);
	if (!vista) {
		vista = criarVista(client, alvo as any, minha);
		cache.set(alvo as any, vista);
		reais.set(vista, alvo as any);
	}

	return vista;
}

function nativa(client: ScramjetClient, fn: Function, nome: string, tamanho: number, fonte: string) {
	Object_defineProperty(fn, "name", { value: nome, configurable: true });
	Object_defineProperty(fn, "length", { value: tamanho, configurable: true });
	client.box.fontesDinamicas.set(fn, `function ${fonte}() { [native code] }`);

	return fn;
}

function navegar(client: ScramjetClient, alvo: any, url: unknown, trocar: boolean) {
	const destino = new _URL(String(url), client.url.href).href;
	const deles: ScramjetClient = alvo[SCRAMJETCLIENT];
	if (trocar) deles.locationProxy.replace(destino);
	else deles.locationProxy.href = destino;
}

function criarVista(client: ScramjetClient, alvo: any, minha: string) {
	const bloqueio = `Blocked a frame with origin "${minha}" from accessing a cross-origin frame.`;
	const erro = (msg: string) => excecaoDoNavegador(client, msg, "SecurityError");
	const lendo = (k: PropertyKey, de = "Window") =>
		typeof k === "symbol"
			? erro(`Failed to read a named property from '${de}': ${bloqueio}`)
			: ehIndice(k)
				? erro(`Failed to read an indexed property [${k}] from '${de}': ${bloqueio}`)
				: erro(`Failed to read a named property '${k}' from '${de}': ${bloqueio}`);

	let vista: any;
	let vistaDoLocal: any;

	const funcoes: Record<string, Function> = {};
	for (const nome of Object.keys(METODOS)) {
		const fn =
			nome === "postMessage"
				? function (this: any, ...args: any[]) {
						// O envelope do `postMessage` do alvo acha a origem de quem chama por um objeto
						// do realm dele; com só strings nos argumentos, ele lê o `POLLUTANT` do alvo.
						const doRealm = {};
						let marcou = false;
						try {
							Object_defineProperty(alvo, POLLUTANT, {
								value: doRealm,
								writable: false,
								configurable: true,
								enumerable: false,
							});
							marcou = true;
						} catch {}
						try {
							return Reflect_apply(alvo.postMessage, alvo, args);
						} finally {
							if (marcou) {
								try {
									delete alvo[POLLUTANT];
								} catch {}
							}
						}
					}
				: function () {
						return Reflect_apply(alvo[nome], alvo, []);
					};
		funcoes[nome] = nativa(client, fn, nome, METODOS[nome], nome);
	}
	const leitores: Record<string, Function> = {};
	for (const nome of ACESSORES)
		leitores[nome] = nativa(
			client,
			function () {
				return valorDe(nome);
			},
			`get ${nome}`,
			0,
			`get ${nome}`,
		);
	const escreveLocal = nativa(
		client,
		function (v: unknown) {
			navegar(client, alvo, v, false);
		},
		"set location",
		1,
		"set location",
	);

	function filho(k: PropertyKey): any {
		let n = 0;
		try {
			n = alvo.length;
		} catch {}
		if (ehIndice(k)) return Number(k) < n ? alvo[k] : undefined;
		if (typeof k !== "string") return undefined;
		for (let i = 0; i < n; i++) {
			try {
				const f = alvo[i];
				if (f && f.name === k) return f;
			} catch {}
		}

		return undefined;
	}

	function valorDe(nome: string): any {
		switch (nome) {
			case "window":
			case "self":
			case "frames":
				return vista;
			case "location":
				return vistaDoLocal;
			case "closed":
				return alvo.closed;
			case "length":
				return alvo.length;
			case "top":
			case "parent":
			case "opener": {
				const v = alvo[nome];
				if (v === alvo) return vista;
				const dono: ScramjetClient | undefined = alvo[SCRAMJETCLIENT];
				return dono ? vistaDe(client, dono.wrapfn(v)) : vistaDe(client, v);
			}
		}
	}

	function descritor(k: PropertyKey): PropertyDescriptor | undefined {
		if (SIMBOLOS.includes(k as symbol) || k === "then")
			return { value: undefined, writable: false, enumerable: false, configurable: true };
		if (typeof k === "string" && Object.hasOwn(METODOS, k))
			return { value: funcoes[k], writable: false, enumerable: false, configurable: true };
		if (k === "location")
			return { get: leitores.location as any, set: escreveLocal as any, enumerable: false, configurable: true };
		if (typeof k === "string" && ACESSORES.includes(k))
			return { get: leitores[k] as any, set: undefined, enumerable: false, configurable: true };
		const f = filho(k);
		if (f) return { value: vistaDe(client, f), writable: false, enumerable: ehIndice(k), configurable: true };

		return undefined;
	}

	vista = new _Proxy(Object.create(null), {
		get(_t, chave) {
			const k = semBase(chave);
			if (SIMBOLOS.includes(k as symbol) || k === "then") return undefined;
			if (typeof k === "string" && Object.hasOwn(METODOS, k)) return funcoes[k];
			if (typeof k === "string" && ACESSORES.includes(k)) return valorDe(k);
			const f = filho(k);
			if (f) return vistaDe(client, f);
			throw lendo(k);
		},
		set(_t, chave, v) {
			const k = semBase(chave);
			if (k === "location") {
				navegar(client, alvo, v, false);
				return true;
			}
			throw erro(
				typeof k === "symbol"
					? `Failed to set a named property on 'Window': ${bloqueio}`
					: `Failed to set a named property '${k}' on 'Window': ${bloqueio}`,
			);
		},
		has(_t, chave) {
			const k = semBase(chave);
			if (descritor(k)) return true;
			throw erro(bloqueio);
		},
		getOwnPropertyDescriptor(_t, chave) {
			const d = descritor(semBase(chave));
			if (d) return d;
			throw lendo(chave);
		},
		ownKeys() {
			const chaves: (string | symbol)[] = [];
			let n = 0;
			try {
				n = alvo.length;
			} catch {}
			for (let i = 0; i < n; i++) chaves.push(String(i));

			return [...chaves, ...NOMES, ...SIMBOLOS];
		},
		defineProperty() {
			throw erro(bloqueio);
		},
		deleteProperty() {
			throw erro(bloqueio);
		},
		getPrototypeOf() {
			return null;
		},
		setPrototypeOf() {
			return false;
		},
		isExtensible() {
			return true;
		},
		preventExtensions() {
			return false;
		},
	});

	const troca = nativa(
		client,
		function (url: unknown) {
			navegar(client, alvo, url, true);
		},
		"replace",
		1,
		"replace",
	);
	const escreveHref = nativa(
		client,
		function (v: unknown) {
			navegar(client, alvo, v, false);
		},
		"set href",
		1,
		"set href",
	);
	const descritorDoLocal = (k: PropertyKey): PropertyDescriptor | undefined => {
		if (SIMBOLOS.includes(k as symbol) || k === "then")
			return { value: undefined, writable: false, enumerable: false, configurable: true };
		if (k === "replace") return { value: troca, writable: false, enumerable: false, configurable: true };
		if (k === "href") return { get: undefined, set: escreveHref as any, enumerable: false, configurable: true };

		return undefined;
	};
	vistaDoLocal = new _Proxy(Object.create(null), {
		get(_t, chave) {
			const k = semBase(chave);
			if (SIMBOLOS.includes(k as symbol) || k === "then") return undefined;
			if (k === "replace") return troca;
			throw lendo(k, "Location");
		},
		set(_t, chave, v) {
			const k = semBase(chave);
			if (k === "href") {
				navegar(client, alvo, v, false);
				return true;
			}
			throw erro(
				typeof k === "symbol"
					? `Failed to set a named property on 'Location': ${bloqueio}`
					: `Failed to set a named property '${k}' on 'Location': ${bloqueio}`,
			);
		},
		has(_t, chave) {
			if (descritorDoLocal(semBase(chave))) return true;
			throw erro(bloqueio);
		},
		getOwnPropertyDescriptor(_t, chave) {
			const d = descritorDoLocal(semBase(chave));
			if (d) return d;
			throw lendo(chave, "Location");
		},
		ownKeys() {
			return ["href", "replace", "then", ...SIMBOLOS];
		},
		defineProperty() {
			throw erro(bloqueio);
		},
		deleteProperty() {
			throw erro(bloqueio);
		},
		getPrototypeOf() {
			return null;
		},
		setPrototypeOf() {
			return false;
		},
		isExtensible() {
			return true;
		},
		preventExtensions() {
			return false;
		},
	});

	return vista;
}

/** Verdadeiro quando `valor` é uma vista de outra origem. */
export function ehVista(valor: unknown): boolean {
	return !!valor && typeof valor === "object" && reais.has(valor as any);
}
