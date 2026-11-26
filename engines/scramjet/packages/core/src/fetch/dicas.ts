import type { ScramjetHeaders } from "@/shared";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

// vssh fork: os Client Hints de alta entropia, como o Chrome os manda.
//
// O Chrome anexa os hints de User-Agent na camada de rede, depois do service worker. O pedido que
// o motor repassa pelo transporte leva só os três que o navegador põe no pedido ao service worker
// (`Sec-CH-UA`, `-Mobile`, `-Platform`). Uma origem que responde a uma navegação de nível de cima
// com `Accept-CH` passa a receber os outros que pediu em toda navegação para ela e em todo pedido
// que um documento dela faz a ela mesma, porque a Permissions Policy de cada hint vale `self` por
// padrão. Uma resposta com `Critical-CH` que nomeia um hint pedido e que não foi enviado faz o
// Chrome refazer a navegação uma vez com ele. Os valores saem do `navigator.userAgentData` do
// próprio navegador, os mesmos que o `getHighEntropyValues` dá à página.
//
// As preferências que o Chrome guarda em disco moram aqui na memória do service worker. Quando ele
// reinicia, a origem que exige um hint o recebe pelo `Critical-CH` da primeira resposta.

type Campo =
	| "architecture"
	| "bitness"
	| "model"
	| "platformVersion"
	| "uaFullVersion"
	| "fullVersionList"
	| "wow64"
	| "formFactors";

// Na ordem em que o Chrome os escreve no pedido, depois de `Sec-CH-UA-Mobile`.
const HINTS: [string, Campo][] = [
	["sec-ch-ua-full-version", "uaFullVersion"],
	["sec-ch-ua-arch", "architecture"],
	["sec-ch-ua-platform-version", "platformVersion"],
	["sec-ch-ua-model", "model"],
	["sec-ch-ua-bitness", "bitness"],
	["sec-ch-ua-wow64", "wow64"],
	["sec-ch-ua-full-version-list", "fullVersionList"],
	["sec-ch-ua-form-factors", "formFactors"],
];
const CONHECIDOS = new Set(HINTS.map(([nome]) => nome));
const ORIGENS_MAX = 256;

const aceitas = new Map<string, Set<string>>();
let valores: Map<string, string> | null = null;
let lendo: Promise<void> | null = null;

const texto = (v: unknown) => `"${String(v ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function formatar(campo: Campo, v: any): string | null {
	if (v === undefined || v === null) return null;
	if (campo === "wow64") return v ? "?1" : "?0";
	if (campo === "fullVersionList") {
		if (!Array.isArray(v)) return null;

		return v.map((b) => `${texto(b.brand)};v=${texto(b.version)}`).join(", ");
	}
	if (campo === "formFactors") {
		if (!Array.isArray(v)) return null;

		return v.map(texto).join(", ");
	}

	return texto(v);
}

/** Lê uma vez os valores de alta entropia do navegador. */
export function prepararDicas(): Promise<void> {
	if (valores) return Promise.resolve();
	if (lendo) return lendo;
	lendo = (async () => {
		const mapa = new Map<string, string>();
		try {
			const dados = (self.navigator as any)?.userAgentData;
			if (dados?.getHighEntropyValues) {
				const v = await dados.getHighEntropyValues(HINTS.map(([, campo]) => campo));
				for (const [nome, campo] of HINTS) {
					const f = formatar(campo, v[campo]);
					if (f !== null) mapa.set(nome, f);
				}
			}
		} catch {}
		valores = mapa;
	})();

	return lendo;
}

function nomes(valor: string | null): string[] {
	if (!valor) return [];

	return valor
		.split(",")
		.map((n) => n.trim().toLowerCase())
		.filter((n) => CONHECIDOS.has(n));
}

function seguro(url: URL) {
	return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * Os hints que este pedido leva: os que a origem dele pediu, numa navegação de nível de cima para
 * ela ou num pedido que um documento da mesma origem faz.
 */
export function aplicarDicas(
	headers: ScramjetHeaders,
	url: URL,
	topo: boolean,
	origemDoCliente: string | null
) {
	if (!valores || !seguro(url)) return;
	const pedidos = aceitas.get(url.origin);
	if (!pedidos || !pedidos.size) return;
	if (!topo && origemDoCliente !== url.origin) return;

	const novos = HINTS.filter(([nome]) => pedidos.has(nome) && valores!.has(nome));
	if (!novos.length) return;

	// Os hints entram logo depois de `Sec-CH-UA-Mobile`, com o `Sec-CH-UA-Platform` entre o
	// `-Arch` e o `-Platform-Version`, na ordem em que o Chrome os escreve.
	const antes = headers.headers as Record<string, string>;
	const plataforma = antes["sec-ch-ua-platform"];
	const depois: Record<string, string> = {};
	let postos = false;
	const por = () => {
		for (const [nome] of novos) {
			if (nome === "sec-ch-ua-platform-version" && plataforma !== undefined)
				depois["sec-ch-ua-platform"] = plataforma;
			depois[nome] = valores!.get(nome)!;
		}
		if (plataforma !== undefined && !("sec-ch-ua-platform" in depois))
			depois["sec-ch-ua-platform"] = plataforma;
		postos = true;
	};
	for (const k in antes) {
		if (CONHECIDOS.has(k) || k === "sec-ch-ua-platform") continue;
		depois[k] = antes[k];
		if (k === "sec-ch-ua-mobile") por();
	}
	if (!postos) por();
	headers.headers = depois;
}

/**
 * Guarda o `Accept-CH` de uma resposta de navegação de nível de cima e diz se o `Critical-CH`
 * dela pede um hint que o pedido não levou e que agora iria.
 */
export function aprenderDicas(
	url: URL,
	enviados: ScramjetHeaders,
	resposta: RawHeaders
): boolean {
	if (!seguro(url)) return false;
	let aceita: string | null = null;
	let critica: string | null = null;
	for (const [k, v] of resposta) {
		const lk = k.toLowerCase();
		if (lk === "accept-ch") aceita = aceita === null ? v : `${aceita}, ${v}`;
		else if (lk === "critical-ch") critica = critica === null ? v : `${critica}, ${v}`;
	}
	if (aceita === null) return false;

	const pedidos = new Set(nomes(aceita));
	aceitas.delete(url.origin);
	if (pedidos.size) {
		if (aceitas.size >= ORIGENS_MAX) aceitas.delete(aceitas.keys().next().value!);
		aceitas.set(url.origin, pedidos);
	}

	return nomes(critica).some(
		(n) => pedidos.has(n) && !enviados.has(n) && !!valores?.has(n)
	);
}
