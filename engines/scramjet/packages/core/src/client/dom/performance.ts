import { ScramjetClient } from "@client/index";
import { Object_getOwnPropertyDescriptor, String, _URL } from "@/shared/snapshot";
import { MARCA_DE_REDE } from "@/shared/rede";

export default function (client: ScramjetClient, _self: Self) {
	client.Trap("PerformanceEntry.prototype.name", {
		get(ctx) {
			// name is going to be a url typically
			const name = String(ctx.get());

			if (name && name.startsWith(client.context.prefix.href)) {
				return client.unrewriteUrl(name);
			}

			return name;
		},
	});

	const filterEntries = (entries: PerformanceEntry[]) => {
		return entries.filter((entry) => {
			const name = String(
				client.descriptors.get("PerformanceEntry.prototype.name", entry)
			);
			for (const file of client.config.maskedfiles) {
				if (name.endsWith(file)) {
					return false;
				}
			}
			// vssh fork: o Chrome não registra um recurso blob: nem data: na linha do tempo. Pelo
			// motor esses endereços viram um pedido sob o prefixo, que o service worker atende, e o
			// registro aparecia para o site (o Worker de blob do Turnstile deixava dois).
			if (entry.entryType === "resource" && name.startsWith(client.context.prefix.href)) {
				let real = "";
				try {
					real = client.unrewriteUrl(name);
				} catch {}
				if (real.startsWith("blob:") || real.startsWith("data:")) return false;
			}

			return true;
		});
	};

	client.Proxy(
		[
			"Performance.prototype.getEntries",
			"Performance.prototype.getEntriesByType",
			"Performance.prototype.getEntriesByName",
			"PerformanceObserverEntryList.prototype.getEntries",
			"PerformanceObserverEntryList.prototype.getEntriesByType",
			"PerformanceObserverEntryList.prototype.getEntriesByName",
		],
		{
			apply(ctx) {
				const entries = ctx.call() as PerformanceEntry[];

				return ctx.return(filterEntries(entries));
			},
		}
	);

	// vssh fork: o registro de um pedido proxiado responde com o pedido de verdade.
	//
	// O navegador mede a resposta do service worker: `transferSize` 0, `deliveryType` "cache",
	// `workerStart` do worker, o tamanho do corpo reescrito e, como todo pedido vai à origem do
	// motor, os detalhes de um recurso de outra origem que o Chrome zeraria. O motor manda na
	// entrada `vssh-rede` do `Server-Timing` o que o servidor disse (ver `marcarRede` em
	// `fetch/fetch.ts`), e cada campo daqui responde com isso. A entrada some do `serverTiming`.
	const R = self.PerformanceResourceTiming?.prototype;
	if (!R) return;
	const nativoServidor = Object_getOwnPropertyDescriptor(R, "serverTiming")?.get;
	const S = self.PerformanceServerTiming?.prototype;
	const nomeDoServidor = S && Object_getOwnPropertyDescriptor(S, "name")?.get;
	const descricaoDoServidor = S && Object_getOwnPropertyDescriptor(S, "description")?.get;

	type Rede = {
		url: URL;
		t: boolean;
		d: number | null;
		e: number | null;
		c: string;
		r: boolean;
		q: boolean;
	};
	const cache = new WeakMap<object, Rede | null>();
	const redeDe = (entrada: any): Rede | null => {
		if (cache.has(entrada)) return cache.get(entrada)!;
		let rede: Rede | null = null;
		try {
			const nome = String(client.descriptors.get("PerformanceEntry.prototype.name", entrada));
			if (nome.startsWith(client.context.prefix.href)) {
				const url = new _URL(client.unrewriteUrl(nome));
				rede = { url, t: true, d: null, e: null, c: "", r: false, q: false };
				for (const st of nativoServidor!.call(entrada) as any[]) {
					if (nomeDoServidor!.call(st) !== MARCA_DE_REDE) continue;
					for (const parte of String(descricaoDoServidor!.call(st)).split(" ")) {
						const v = parte.slice(1);
						if (parte[0] === "t") rede.t = v === "1";
						else if (parte[0] === "d") rede.d = v ? Number(v) : null;
						else if (parte[0] === "e") rede.e = v ? Number(v) : null;
						else if (parte[0] === "c") rede.c = v;
						else if (parte[0] === "r") rede.r = v === "1";
						else if (parte[0] === "q") rede.q = v === "1";
					}
				}
			}
		} catch {}
		cache.set(entrada, rede);

		return rede;
	};
	// Um recurso de outra origem sem `Timing-Allow-Origin` mostra só o início e o fim.
	const fechado = (entrada: any, rede: Rede) =>
		!rede.t &&
		rede.url.origin !== client.url.origin &&
		entrada.entryType === "resource";
	const codificado = (rede: Rede, nativo: number) => {
		if (rede.e !== null) return rede.e;
		if (rede.d !== null) return rede.c ? Math.round(rede.d * 0.34) : rede.d;

		return nativo;
	};

	const campo = (k: string, valor: (entrada: any, rede: Rede, nativo: any) => any) => {
		client.Trap(`PerformanceResourceTiming.prototype.${k}`, {
			get(ctx) {
				const nativo = ctx.get();
				const rede = redeDe(ctx.this);

				return rede ? valor(ctx.this, rede, nativo) : nativo;
			},
		});
	};
	const zeraFechado = (entrada: any, rede: Rede, nativo: number) =>
		fechado(entrada, rede) ? 0 : nativo;

	campo("nextHopProtocol", (entrada, rede) =>
		fechado(entrada, rede)
			? ""
			: rede.url.protocol !== "https:"
				? "http/1.1"
				: rede.q
					? "h3"
					: "h2"
	);
	campo("deliveryType", () => "");
	campo("workerStart", () => 0);
	campo("firstInterimResponseStart", () => 0);
	campo("finalResponseHeadersStart", (entrada, rede, nativo) =>
		fechado(entrada, rede) ? 0 : nativo || entrada.responseStart
	);
	campo("decodedBodySize", (entrada, rede, nativo) =>
		fechado(entrada, rede) ? 0 : (rede.d ?? nativo)
	);
	campo("encodedBodySize", (entrada, rede, nativo) =>
		fechado(entrada, rede) ? 0 : codificado(rede, nativo)
	);
	campo("transferSize", (entrada, rede, nativo) => {
		if (fechado(entrada, rede)) return 0;
		const corpo = codificado(rede, nativo);

		return corpo > 0 ? corpo + 300 : nativo;
	});
	campo("secureConnectionStart", (entrada, rede) => {
		if (fechado(entrada, rede) || rede.url.protocol !== "https:") return 0;

		return entrada.connectStart;
	});
	for (const k of [
		"redirectStart",
		"redirectEnd",
		"domainLookupStart",
		"domainLookupEnd",
		"connectStart",
		"connectEnd",
		"requestStart",
		"responseStart",
	])
		campo(k, zeraFechado);
	campo("serverTiming", (entrada, rede, nativo: any[]) =>
		fechado(entrada, rede)
			? []
			: nativo.filter((st) => nomeDoServidor!.call(st) !== MARCA_DE_REDE)
	);

	// Uma navegação que o `Critical-CH` refez (ver `fetch/dicas.ts`) conta um redirecionamento e
	// marca o instante do recomeço, como no Chrome.
	if (self.PerformanceNavigationTiming) {
		const navegacao = (k: string, valor: (entrada: any, rede: Rede, nativo: any) => any) => {
			client.Trap(`PerformanceNavigationTiming.prototype.${k}`, {
				get(ctx) {
					const nativo = ctx.get();
					const rede = redeDe(ctx.this);

					return rede ? valor(ctx.this, rede, nativo) : nativo;
				},
			});
		};
		navegacao("criticalCHRestart", (entrada, rede, nativo) =>
			rede.r && !nativo ? entrada.fetchStart : nativo
		);
		navegacao("redirectCount", (_e, rede, nativo) => (rede.r ? nativo + 1 : nativo));
	}
	const entradaDaNavegacao = () => {
		try {
			return (self.performance.getEntriesByType("navigation") as any[])[0] ?? null;
		} catch {
			return null;
		}
	};
	if (self.PerformanceNavigation)
		client.Trap("PerformanceNavigation.prototype.redirectCount", {
			get(ctx) {
				const nativo = ctx.get() as number;
				const n = entradaDaNavegacao();
				const rede = n && redeDe(n);

				return rede && rede.r ? nativo + 1 : nativo;
			},
		});
	if (self.PerformanceTiming)
		client.Trap("PerformanceTiming.prototype.secureConnectionStart", {
			get(ctx) {
				const nativo = ctx.get() as number;
				if (nativo || client.url.protocol !== "https:") return nativo;

				return (ctx.this as any).connectStart;
			},
		});

	// O `toJSON` lê os valores internos, sem passar pelos getters: o objeto dele é refeito com eles.
	// O da navegação é outro método, no protótipo dela.
	const refazer = {
		apply(ctx) {
			const json = ctx.call() as Record<string, any>;
			const entrada = ctx.this as any;
			if (!redeDe(entrada)) return;
			for (const k of Object.keys(json)) {
				if (k === "serverTiming") {
					json[k] = (entrada.serverTiming as any[]).map((st) => st.toJSON());
				} else if (k in entrada && typeof json[k] !== "object") {
					json[k] = entrada[k];
				}
			}
			ctx.return(json);
		},
	};
	if (self.PerformanceNavigationTiming)
		client.Proxy("PerformanceNavigationTiming.prototype.toJSON", refazer);
	client.Proxy("PerformanceResourceTiming.prototype.toJSON", refazer);
}
