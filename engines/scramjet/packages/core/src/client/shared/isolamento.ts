import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { QP } from "@/fetch/parse";
import {
	Math_floor,
	Object_defineProperty,
	Object_entries,
	Object_getOwnPropertyDescriptor,
	Object_hasOwn,
	Object_keys,
	Reflect_apply,
	String,
	_Map,
	_URL,
	_WeakMap,
} from "@/shared/snapshot";

// vssh fork: o isolamento de origem que o site vê é o que ele pediu.
//
// O Chrome isola de outras origens o documento que vem com `Cross-Origin-Opener-Policy:
// same-origin` e um `Cross-Origin-Embedder-Policy`. O site lê o resultado em `crossOriginIsolated`,
// no nome `SharedArrayBuffer` do global, em `performance.measureUserAgentSpecificMemory` e no passo
// do relógio, 5 µs isolado e 100 µs fora. Pelo motor, quem isola de verdade é a página que hospeda
// as abas: quando ela é isolada, todo documento proxiado também é, e um site que não pediu nada
// receberia os quatro sinais de um documento isolado.
//
// Aqui a resposta segue o pedido. Num documento que o navegador isolou e o site não, o global
// responde como o de um documento comum. Num que o site isolou, ele fica como o navegador o
// entrega. Quando a página hospedeira não é isolada, este módulo não instala nada: não há
// `SharedArrayBuffer` para entregar a quem pede.
//
// O que fica com a precisão do documento isolado: o `performance.memory`, os relógios de áudio e
// de vídeo (`AudioContext`, `requestVideoFrameCallback`), e o `postMessage` de uma memória
// compartilhada do WebAssembly, que um documento comum recusa.

const PEDE_COEP = ["require-corp", "credentialless"];
const PASSO_MS = 0.1;

const valor = (cabecalho: string | null | undefined) =>
	String(cabecalho ?? "").split(";")[0].trim().toLowerCase();

/** O Chrome só aceita o COOP e o COEP de uma origem confiável. */
function confiavel(url: URL): boolean {
	if (url.protocol === "https:") return true;
	const h = url.hostname;

	return h === "localhost" || h.endsWith(".localhost") || /^127(\.\d+){3}$/.test(h) || h === "[::1]";
}

/** Se o `allow` do quadro delega o `cross-origin-isolated` ao documento dele. */
function delegado(client: ScramjetClient, self: any): boolean {
	let allow = "";
	try {
		const quadro = client.descriptors.get("window.frameElement", self);
		if (quadro) allow = String(client.natives.call("Element.prototype.getAttribute", quadro, "allow") ?? "");
	} catch {
		return false;
	}

	return allow.split(";").some((regra) => {
		const [nome, ...lista] = regra.trim().split(/\s+/);

		return nome === "cross-origin-isolated" && !lista.includes("'none'");
	});
}

// Os clientes que o navegador isolou de verdade, lidos antes de o acessor ser trocado. Cada realm
// carrega a própria cópia deste módulo, e por isso a decisão de outro documento se pergunta ao
// cliente dele (`client.isolado`), e não a estes mapas.
const isolados = new _WeakMap<ScramjetClient, true>([]);
const decididos = new _WeakMap<ScramjetClient, boolean>([]);

/** Esquece a decisão de `client`: o documento dele trocou, e os cabeçalhos são outros. */
export function esquecerIsolamento(client: ScramjetClient) {
	decididos.delete(client);
}

/**
 * Se o documento ou o worker de `client` é isolado para o site: o que o Chrome responderia em
 * `crossOriginIsolated` para os cabeçalhos que o site mandou. Só vale `true` onde o navegador
 * isolou de verdade.
 */
export function isolamentoDoSite(client: ScramjetClient): boolean {
	const feito = decididos.get(client);
	if (feito !== undefined) return feito;
	const decidido = decidir(client);
	decididos.set(client, decidido);

	return decidido;
}

function decidir(client: ScramjetClient): boolean {
	const self: any = client.global;
	if (!isolados.has(client)) return false;

	// O worker segue quem o criou, que deixa a decisão no endereço dele.
	if (!("window" in self)) {
		try {
			return new _URL(self.location.href).searchParams.get(QP.isolado) === "1";
		} catch {
			return false;
		}
	}

	const de = (janela: any): ScramjetClient | undefined => {
		try {
			return janela && janela !== self ? janela[SCRAMJETCLIENT] : undefined;
		} catch {
			return undefined;
		}
	};
	const acima = de(self.parent);
	const url = client.url;

	// Um documento sem resposta própria (`about:blank`, `srcdoc`, `blob:`, `data:`) herda de quem
	// o criou.
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		const criador = acima ?? de(self.opener);

		return !!criador && criador.isolado === true;
	}

	const coep = PEDE_COEP.includes(valor(client.initHeaders?.get("cross-origin-embedder-policy")));
	if (!coep || !confiavel(url)) return false;
	if (!acima) return valor(client.initHeaders?.get("cross-origin-opener-policy")) === "same-origin";

	// A política de permissões só passa o `cross-origin-isolated` ao quadro da mesma origem do
	// pai, ou ao que o `allow` do elemento nomeia.
	return acima.isolado === true && (url.origin === acima.url.origin || delegado(client, self));
}

const guardados = new _WeakMap<object, Map<string, PropertyDescriptor>>([]);

/**
 * Tira ou devolve os nomes que só um documento isolado tem. O `Window` do `about:blank` inicial de
 * um quadro continua sendo o do documento que carrega nele, e a decisão muda com os cabeçalhos.
 */
export function ajustarNomesDoIsolamento(client: ScramjetClient) {
	const self: any = client.global;
	if (!isolados.has(client)) return;
	const isolado = isolamentoDoSite(client);
	const nomes: [any, string][] = [[self, "SharedArrayBuffer"]];
	if (self.Performance) nomes.push([self.Performance.prototype, "measureUserAgentSpecificMemory"]);

	for (const [alvo, nome] of nomes) {
		let doAlvo = guardados.get(alvo);
		if (!doAlvo) guardados.set(alvo, (doAlvo = new _Map<string, PropertyDescriptor>([])));
		if (isolado) {
			const original = doAlvo.get(nome);
			if (original && !Object_hasOwn(alvo, nome)) Object_defineProperty(alvo, nome, original);
			doAlvo.delete(nome);
		} else if (Object_hasOwn(alvo, nome) && !doAlvo.has(nome)) {
			doAlvo.set(nome, Object_getOwnPropertyDescriptor(alvo, nome)!);
			delete alvo[nome];
		}
	}
}

/** O `SharedArrayBuffer` do realm, também onde o site não o vê. */
export function memoriaCompartilhada(self: any): SharedArrayBufferConstructor | undefined {
	return guardados.get(self)?.get("SharedArrayBuffer")?.value ?? self.SharedArrayBuffer;
}

// Os relógios de alta resolução que o Chrome arredonda para 100 µs fora do isolamento.
const TEMPOS: Record<string, string[]> = {
	Performance: ["timeOrigin"],
	PerformanceEntry: ["startTime", "duration"],
	PerformanceResourceTiming: [
		"workerStart", "redirectStart", "redirectEnd", "fetchStart", "domainLookupStart", "domainLookupEnd",
		"connectStart", "connectEnd", "secureConnectionStart", "requestStart", "responseStart", "responseEnd",
		"firstInterimResponseStart", "finalResponseHeadersStart",
	],
	PerformanceNavigationTiming: [
		"unloadEventStart", "unloadEventEnd", "domInteractive", "domContentLoadedEventStart",
		"domContentLoadedEventEnd", "domComplete", "loadEventStart", "loadEventEnd", "activationStart",
	],
	PerformanceEventTiming: ["processingStart", "processingEnd"],
	LargestContentfulPaint: ["renderTime", "loadTime"],
	Event: ["timeStamp"],
	AnimationTimeline: ["currentTime"],
};

export const order = 10;

export default function (client: ScramjetClient, self: any) {
	let nativo = false;
	try {
		nativo = !!self.crossOriginIsolated;
	} catch {}
	if (!nativo) return;
	isolados.set(client, true);

	client.Trap("crossOriginIsolated", {
		get() {
			return isolamentoDoSite(client);
		},
	});
	ajustarNomesDoIsolamento(client);

	const grosso = (ms: any) =>
		typeof ms === "number" && !isolamentoDoSite(client) ? Math_floor(ms / PASSO_MS) * PASSO_MS : ms;

	client.Proxy(["Performance.prototype.now", "IdleDeadline.prototype.timeRemaining"], {
		apply(ctx) {
			ctx.return(grosso(ctx.call()));
		},
	});
	for (const [classe, campos] of Object_entries(TEMPOS)) {
		const proto = self[classe]?.prototype;
		if (!proto) continue;
		for (const campo of campos) {
			if (!Object_hasOwn(proto, campo)) continue;
			client.RawTrap(proto, campo, {
				get(ctx) {
					return grosso(ctx.get());
				},
			});
		}
	}

	// O `toJSON` de um registro lê os valores internos, sem passar pelos getters.
	const refeito = {
		apply(ctx: any) {
			const json = ctx.call();
			if (!json || typeof json !== "object" || isolamentoDoSite(client)) return;
			for (const k of Object_keys(json)) json[k] = grosso(json[k]);
			ctx.return(json);
		},
	};
	client.Proxy(
		["Performance.prototype.toJSON", "PerformanceEntry.prototype.toJSON", "PerformanceEventTiming.prototype.toJSON", "LargestContentfulPaint.prototype.toJSON"],
		refeito,
	);

	// O horário que o navegador passa à função de cada quadro de animação.
	client.Proxy("requestAnimationFrame", {
		apply(ctx) {
			const fn = ctx.args[0];
			if (typeof fn !== "function") return;
			ctx.args[0] = function (this: unknown, t: number) {
				return Reflect_apply(fn, this, [grosso(t)]);
			};
		},
	});
}
