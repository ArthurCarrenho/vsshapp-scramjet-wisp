import { type MethodsDefinition, RpcHelper } from "@mercuryworkshop/rpc";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import { deepmerge } from "@fastify/deepmerge";
import {
	CookieJar,
	defaultConfig as scramjetDefaultConfig,
	rewriteUrl,
	ScramjetFetchHandler,
	ScramjetHeaders,
	setWasm,
	Tap,
	type CookieSyncOptions,
	type FetchHooks,
	type ScramjetConfig,
	type ScramjetContext,
	type ScramjetInterface,
	type TrackedHistoryState,
	Plugin,
} from "@mercuryworkshop/scramjet";
import { CONTROLLERFRAME } from "./symbols";
import type {
	FrameInitHooks,
	SerializedCookieSyncEntry,
	TransportToController,
	Controllerbound,
	ControllerToTransport,
	SWbound,
	WebSocketMessage,
	FrameErrorHooks,
} from "./types";
import { assertRuntimeScramjetVersion } from "./version";

export { VERSION } from "./version";
export { assertRuntimeScramjetVersion } from "./version";

export type Config = {
	prefix: string;
	scramjetPath: string;
	injectPath: string;
	wasmPath: string;
	virtualWasmPath: string;
	codec: Record<"encode" | "decode", (input: string) => string>;
};

export const config: Config = {
	prefix: "/~/sj/",
	scramjetPath: "/scramjet/scramjet.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/scramjet/scramjet.wasm",
	virtualWasmPath: "scramjet.wasm.js",
	codec: {
		encode: (url: string) => {
			if (!url) return url;

			return encodeURIComponent(url);
		},
		decode: (url: string) => {
			if (!url) return url;

			return decodeURIComponent(url);
		},
	},
};

const scramjetConfig: Partial<ScramjetConfig> = {
	flags: {
		...scramjetDefaultConfig.flags,
		allowFailedIntercepts: true,
	},
	maskedfiles: ["inject.js", "scramjet.wasm.js"],
};

// vssh fork: distingue FALHA DE TRANSPORTE/REDE (libcurl/wisp: URL morta, host bloqueado, arquivo
// parcial, DNS, timeout, conexão recusada/resetada, stream abortado) de um BUG INTERNO do motor.
// Falha de rede é o comportamento normal da web (o remoto falhou, não o motor) e não deve gerar
// console.error — um navegador de verdade não loga erro de framework nesses casos. Espelha o helper
// homônimo em sw.ts (duplicado de propósito: contextos/bundles distintos, page vs service worker).
function isTransportNetworkError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e ?? "");
	return /error code \d+|Transferred a partial|Failed to fetch|NetworkError|connection|timed?\s?out|refused|reset|closed|abort|ECONN|ENOTFOUND|EOF|stream/i.test(
		msg
	);
}

type PersistedCookieState = {
	updatedAt: number;
	cookies: string;
};

export class ManagedPlugin extends Plugin {
	frame: Frame = null!;
	dependencies: string[] = [];
	constructor(name: string, dependencies: string[]) {
		super(name);
		this.dependencies = dependencies;
	}

	install(frame: Frame): void {
		this.frame = frame;
	}
}

const COOKIE_DB_NAME = "__scramjet_controller";
const COOKIE_STORE_NAME = "state";
const COOKIE_STATE_KEY = "cookies";
const BROADCASTCHANNEL_NAME = "__scramjet_controller_channel";

let cookieDbPromise: Promise<IDBDatabase> | null = null;

function parsePersistedCookieState(
	value: unknown
): PersistedCookieState | null {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof (value as PersistedCookieState).updatedAt !== "number" ||
		!Number.isFinite((value as PersistedCookieState).updatedAt) ||
		typeof (value as PersistedCookieState).cookies !== "string"
	) {
		return null;
	}

	return value as PersistedCookieState;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function openCookieDatabase(): Promise<IDBDatabase> {
	if (cookieDbPromise) {
		return cookieDbPromise;
	}

	cookieDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open(COOKIE_DB_NAME, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(COOKIE_STORE_NAME)) {
				db.createObjectStore(COOKIE_STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Failed to open cookie database"));
	});

	return cookieDbPromise;
}

async function readCookieState(): Promise<PersistedCookieState | null> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readonly");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const value = await requestToPromise(store.get(COOKIE_STATE_KEY));
		await transactionToPromise(transaction);
		return parsePersistedCookieState(value);
	} catch (error) {
		console.error("Failed to read persisted controller cookies:", error);
		return null;
	}
}

// vssh fork: junta dois dumps de `CookieJar` (`JSON.stringify` de um `Record<id, Cookie>`,
// onde o id já é `domínio@caminho@nome`) com o nosso vencendo por id. Se qualquer um dos
// dois não for o objeto esperado, devolve o nosso: uma mescla não vale corromper o estado.
function mergeCookieDumps(theirs: string, ours: string): string {
	try {
		const a = JSON.parse(theirs);
		const b = JSON.parse(ours);
		if (!a || typeof a !== "object" || Array.isArray(a)) return ours;
		if (!b || typeof b !== "object" || Array.isArray(b)) return ours;
		return JSON.stringify({ ...a, ...b });
	} catch {
		return ours;
	}
}

async function writeCookieState(
	cookies: string,
	currentUpdatedAt: number
): Promise<{ updatedAt: number; merged: boolean }> {
	try {
		const db = await openCookieDatabase();
		const transaction = db.transaction(COOKIE_STORE_NAME, "readwrite");
		const store = transaction.objectStore(COOKIE_STORE_NAME);
		const existing = parsePersistedCookieState(
			await requestToPromise(store.get(COOKIE_STATE_KEY))
		);
		const updatedAt = Math.max(
			Date.now(),
			currentUpdatedAt + 1,
			(existing?.updatedAt ?? 0) + 1
		);
		// vssh fork: **se alguém gravou depois da nossa leitura, o que está no disco não
		// pode ser simplesmente sobrescrito.** `existing` já estava sendo lido aqui, mas
		// só para calcular o carimbo — os cookies dele iam para o lixo.
		//
		// O caminho normal (`sendSetCookie`) faz ler → aplicar → gravar, e isso basta
		// enquanto ninguém grava no meio. Só que a leitura e a gravação são transações
		// SEPARADAS, então duas abas se intercalam: A lê, B lê, A grava, B grava — e a
		// gravação de B leva junto o estado que A tinha lido, sem os cookies de A. O
		// sintoma é "logei numa aba e a outra me deslogou".
		//
		// Só mesclamos quando o disco está à FRENTE do que lemos; caso contrário o nosso
		// dump já contém tudo, e mesclar aí sim ressuscitaria o que apagamos de
		// propósito. Na mescla o nosso vence por id, que é o lado certo do erro: o
		// cookie que acabou de chegar é o mais novo. O que pode voltar é um cookie que a
		// outra aba tinha e nós apagamos na janela entre as duas gravações — e mesmo esse
		// continua sujeito ao próprio `expires` na leitura.
		const merged = !!existing && existing.updatedAt > currentUpdatedAt;
		const state: PersistedCookieState = {
			updatedAt,
			cookies: merged
				? mergeCookieDumps(existing!.cookies, cookies)
				: cookies,
		};
		store.put(state, COOKIE_STATE_KEY);
		await transactionToPromise(transaction);
		return { updatedAt, merged };
	} catch (error) {
		console.error("Failed to persist controller cookies:", error);
		return { updatedAt: currentUpdatedAt, merged: false };
	}
}

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const deepMerge = deepmerge();

type ControllerInit = {
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	config?: Partial<Config>;
	scramjetConfig?: Partial<ScramjetConfig>;
};

type FrameOptions = {
	plugins: ManagedPlugin[];
};

export class Controller {
	id: string;
	config: Config;
	scramjetConfig: ScramjetConfig;
	prefix: string;
	cookieJar = new CookieJar();
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;
	// vssh fork: `true` só ATÉ o handshake inicial terminar (1º `ready` recebido). Antes disso um
	// `$controller$swrevive` (que o SW dispara ~100ms após ativar, mesmo sem ter morrido) NÃO deve
	// trocar a MessagePort — trocá-la no meio do handshake perderia o `ready` em voo e travaria
	// wait(). Depois do handshake, re-registrar a cada revive é seguro e auto-curativo (o SW
	// deduplica tab por id, e cada setupMessagePort dispara um novo `ready`). Substituiu o antigo
	// `guardServiceWorkerRevive` de timer fixo de 5s, que, se o SW reiniciasse dentro desses 5s,
	// ignorava o revive pra sempre → `tabs` do SW ficava vazio → só F5 do cliente recuperava.
	handshakeComplete = false;

	private ready: Promise<void>;
	private readyResolve!: () => void;
	public isReady: boolean = false;
	rpc: RpcHelper<Controllerbound, SWbound>;
	private port: MessagePort | null = null;

	transport: ProxyTransport;
	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<void> | null = null;
	private cookieSyncDirty = true;
	private cookieSyncChannel = new BroadcastChannel(BROADCASTCHANNEL_NAME);

	private wasmAlreadyFetched = false;
	private wasmPayload: string | null = null;
	private onTabChannelMessage: (e: MessageEvent) => void = (e) => {
		this.rpc.recieve(e.data);
	};
	private onCookieSyncMessage = (event: MessageEvent) => {
		const updatedAt =
			typeof event.data === "object" && event.data !== null
				? (event.data as { updatedAt?: unknown }).updatedAt
				: undefined;
		if (typeof updatedAt !== "number" || updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieSyncDirty = true;
		void this.loadSavedCookies();
	};

	private async loadScramjetWasm() {
		if (this.wasmAlreadyFetched) {
			return;
		}

		const resp = await fetch(this.config.wasmPath);
		setWasm(await resp.arrayBuffer());
		this.wasmAlreadyFetched = true;
	}

	private methods: MethodsDefinition<Controllerbound> = {
		ready: async () => {
			this.readyResolve();
			// Handshake inicial concluído — a partir daqui um revive genuíno (SW reiniciado) pode e
			// deve re-registrar a porta. Ver `handshakeComplete` e o handler de $controller$swrevive.
			this.handshakeComplete = true;
		},
		request: async (data) => {
			const path = new URL(data.rawUrl).pathname;
			const frame = this.frames.find((f) => path.startsWith(f.prefix));
			if (!frame) throw new Error("No frame found for request");
			try {
				// doesn't actually *load* every request, but hold up requests until the promise finishes
				await this.loadSavedCookies();

				if (path === frame.prefix + this.config.virtualWasmPath) {
					if (!this.wasmPayload) {
						const resp = await fetch(this.config.wasmPath);
						const buf = await resp.arrayBuffer();
						const b64 = btoa(
							new Uint8Array(buf)
								.reduce(
									(data, byte) => (data.push(String.fromCharCode(byte)), data),
									[] as any
								)
								.join("")
						);

						this.wasmPayload = `self.WASM = '${b64}';`;
					}

					return [
						{
							body: this.wasmPayload,
							status: 200,
							statusText: "OK",
							headers: [["Content-Type", "application/javascript"]],
						},
						[],
					];
				}

				const sjheaders = ScramjetHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					initialHeaders: sjheaders,
					rawClientUrl: data.rawClientUrl
						? new URL(data.rawClientUrl)
						: undefined,
					rawUrl: new URL(data.rawUrl),
					rawReferrer: data.rawReferrer,
					rawDestination: data.destination,
					method: data.method,
					mode: data.mode,
					referrer: data.referrer,
					body: data.body,
					cache: data.cache,
					clientId: data.clientId,
				});

				return [
					{
						body: fetchresponse.body,
						status: fetchresponse.status,
						statusText: fetchresponse.statusText,
						headers: fetchresponse.headers.toRawHeaders(),
					},
					fetchresponse.body instanceof ReadableStream ||
					fetchresponse.body instanceof ArrayBuffer
						? [fetchresponse.body]
						: [],
				];
			} catch (e) {
				const reqcontext: typeof frame.hooks.error.request.context = {
					rawrequest: data,
					error: e,
				};
				const reqprops: typeof frame.hooks.error.request.props = {
					setResponse: undefined,
					suppressError: false,
				};
				await Tap.dispatch(frame.hooks.error.request, reqcontext, reqprops);
				// Falha de transporte/rede (remoto caiu, arquivo parcial, DNS, timeout, host
				// bloqueado por extensão) é o comportamento normal da web, não um bug do motor —
				// não loga. O erro ainda é re-lançado abaixo; o SW o traduz num erro de rede real
				// (Response.error()) pra subrecursos. Só erros INESPERADOS (bug interno) são logados.
				if (!reqprops.suppressError && !isTransportNetworkError(e)) {
					console.error("Error in controller request handler:", e);
				}
				if (reqprops.setResponse) {
					return [reqprops.setResponse, []];
				}
				throw e;
			}
		},
		initRemoteTransport: async (port) => {
			const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
				{
					request: async ({ remote, method, body, headers }) => {
						const response = await this.transport.request(
							new URL(remote),
							method,
							body,
							headers,
							undefined
						);
						return [response, [response.body]];
					},
					sendSetCookie: async ({ cookies, options }) => {
						await this.loadSavedCookies(true);
						if (options?.clear) {
							this.cookieJar.clear();
						}
						this.applyCookieSyncEntries(cookies);
						await this.persistCookies();
						await this.propagateCookieSync(cookies, options);
					},
					connect: async ({ url, protocols, requestHeaders, port }) => {
						let resolve: (arg: TransportToController["connect"][1]) => void;
						const promise = new Promise<TransportToController["connect"][1]>(
							(res) => (resolve = res)
						);
						const [send, close] = this.transport.connect(
							new URL(url),
							protocols,
							requestHeaders,
							(protocol, extensions) => {
								resolve({
									result: "success",
									protocol: protocol,
									extensions: extensions,
								});
							},
							(data) => {
								port.postMessage(
									{
										type: "data",
										data: data,
									} as WebSocketMessage,
									data instanceof ArrayBuffer ? [data] : []
								);
							},
							(close, reason) => {
								port.postMessage({
									type: "close",
									code: close,
									reason: reason,
								} as WebSocketMessage);
							},
							(error) => {
								resolve({
									result: "failure",
									error: error,
								});
							}
						);
						port.onmessageerror = (ev) => {
							console.error(
								"Transport port messageerror (this should never happen!)",
								ev
							);
						};
						port.onmessage = ({ data }: { data: WebSocketMessage }) => {
							if (data.type === "data") {
								send(data.data);
							} else if (data.type === "close") {
								close(data.code, data.reason);
							}
						};

						return [await promise, []];
					},
				},
				"transport",
				(data, transfer) => port.postMessage(data, transfer)
			);
			port.onmessageerror = (ev) => {
				console.error(
					"Transport port messageerror (this should never happen!)",
					ev
				);
			};
			port.onmessage = (e) => {
				rpc.recieve(e.data);
			};
			rpc.call("ready", undefined, []);
		},
	};

	constructor(public init: ControllerInit) {
		assertRuntimeScramjetVersion();
		this.id = makeId();
		this.config = deepMerge(config, init.config || {}) as Config;
		this.scramjetConfig = deepMerge(scramjetConfig, scramjetDefaultConfig);
		this.scramjetConfig = deepMerge(
			this.scramjetConfig,
			init.scramjetConfig || {}
		) as ScramjetConfig;
		this.prefix = this.config.prefix + this.id + "/";
		this.serviceWorkerController = init.serviceworker;

		this.ready = Promise.all([
			new Promise<void>((resolve) => {
				this.readyResolve = resolve;
			}),
			this.loadScramjetWasm(),
			this.loadSavedCookies(true),
		]).then(() => undefined);

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + this.id,
			(data, transfer) => {
				if (!this.port) {
					throw new Error("Port not found");
				}
				this.port.postMessage(data, transfer);
			}
		);
		this.transport = init.transport;

		this.cookieSyncChannel.addEventListener(
			"message",
			this.onCookieSyncMessage
		);
		this.setupMessagePort();

		// vssh fork: **avisar o Service Worker quando esta aba morre de verdade.** O array `tabs`
		// de lá só perdia entrada quando um controller do mesmo id reconectava, então aba fechada
		// ficava registrada para sempre — segurando a MessagePort de um documento que não existe
		// mais, e mantendo o prefixo dela roteável para uma porta que ninguém atende.
		//
		// ⚠ `persisted` separa os dois motivos do `pagehide`, e a diferença é tudo: `false` é a aba
		// indo embora, `true` é o bfcache — e o bfcache VOLTA. Despedir-se no bfcache deixaria uma
		// aba viva sem rota nenhuma ao ser restaurada, que é justamente o travamento que este aviso
		// existe para evitar.
		addEventListener("pagehide", (e) => {
			if (e.persisted) return;

			try {
				this.serviceWorkerController.postMessage({
					$controller$bye: { id: this.id },
				});
			} catch {
				// a aba está fechando: não há a quem reportar, e insistir não muda nada
			}
		});

		navigator.serviceWorker.addEventListener("message", (e) => {
			if (
				e.data?.$controller$setCookie &&
				typeof e.data.$controller$setCookie === "object"
			) {
				const payload = e.data.$controller$setCookie as {
					cookies?: SerializedCookieSyncEntry[];
					options?: CookieSyncOptions;
					id?: string;
				};

				if (payload.options?.clear) {
					this.cookieJar.clear();
				}
				this.applyCookieSyncEntries(payload.cookies);

				if (typeof payload.id === "string") {
					this.serviceWorkerController.postMessage({
						$sw$setCookieDone: {
							id: payload.id,
						},
					});
				}

				return;
			}

			if (e.data.$controller$swrevive) {
				// O SW dispara $controller$swrevive ~100ms após ativar (mesmo sem ter morrido) e a cada
				// vez que o script dele recarrega. Antes do handshake inicial terminar, ignoramos (trocar
				// a porta no meio do handshake perderia o `ready` em voo). Depois, re-registramos: é o
				// que reconquista o roteamento quando o SW reiniciou de fato e perdeu o array `tabs`.
				if (!this.handshakeComplete) {
					return;
				}
				this.setupMessagePort();
			}
		});
	}

	private setupMessagePort() {
		if (this.port) {
			this.port.removeEventListener("message", this.onTabChannelMessage);
			try {
				this.port.close();
			} catch {
				// ignore
			}
			this.port = null;
			// vssh fork: a resposta de qualquer chamada em voo vinha por ESTA porta, e ela acabou de
			// ser fechada — o Service Worker também já tirou a referência dela do array `tabs`. Sem
			// isto a promessa de cada uma nunca resolve NEM rejeita: quem deu `await` fica pendurado
			// para sempre, e a entrada no mapa de callbacks fica junto. Rejeitar aqui transforma um
			// travamento permanente numa falha que o chamador pode tratar e retentar na porta nova.
			this.rpc?.rejectPending(
				"A porta de comunicação com o Service Worker foi substituída antes da resposta chegar."
			);
		}

		const channel = new MessageChannel();
		this.port = channel.port1;
		this.port.addEventListener("message", this.onTabChannelMessage);
		this.port.start();

		this.serviceWorkerController.postMessage(
			{
				$controller$init: {
					prefix: this.prefix,
					id: this.id,
				},
			},
			[channel.port2]
		);
	}

	// TODO: should this be a method on the cookie jar?
	private applyCookieSyncEntries(
		cookies: SerializedCookieSyncEntry[] | undefined
	) {
		if (!Array.isArray(cookies)) {
			return;
		}

		for (const entry of cookies) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			this.cookieJar.setCookies(entry.cookie, new URL(entry.url));
		}
	}

	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	): Promise<void> {
		if (!this.port) {
			return;
		}

		await this.rpc.call("sendSetCookie", {
			cookies,
			options,
		});
	}

	private async loadSavedCookies(force = false): Promise<void> {
		if (!force && !this.cookieSyncDirty) {
			return;
		}

		// vssh fork: **com `force`, uma carga já em voo não serve.** Quem passa `force` é
		// o `sendSetCookie`, e ele o faz para ler o estado MAIS RECENTE antes de escrever
		// o jar inteiro por cima. Uma carga em voo pode ter feito o `readCookieState()`
		// antes de a outra aba gravar — devolvê-la entregava justamente o estado velho
		// que o `force` existe para evitar, e a gravação seguinte apagava o que a outra
		// aba tinha acabado de salvar.
		//
		// Esperar a que está em voo antes de começar a nossa é o mínimo: ela pode estar
		// no meio de um `cookieJar.load()`, e duas cargas concorrentes sobre o mesmo jar
		// se atropelam.
		// O laço (em vez de um `if`) serializa: dois `force` esperando a MESMA carga
		// acordam juntos, e sem ele o segundo dispararia uma leitura concorrente com a
		// que o primeiro acabou de começar.
		while (this.cookieSyncPromise) {
			if (!force) {
				return this.cookieSyncPromise;
			}
			await this.cookieSyncPromise.catch(() => {});
		}

		this.cookieSyncPromise = (async () => {
			const persisted = await readCookieState();
			if (persisted && persisted.updatedAt > this.cookieUpdatedAt) {
				this.cookieJar.load(persisted.cookies);
				this.cookieUpdatedAt = persisted.updatedAt;
			}
			this.cookieSyncDirty = false;
		})().finally(() => {
			this.cookieSyncPromise = null;
		});

		return this.cookieSyncPromise;
	}

	async persistCookies(): Promise<void> {
		const { updatedAt, merged } = await writeCookieState(
			this.cookieJar.dump(),
			this.cookieUpdatedAt
		);
		if (updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieUpdatedAt = updatedAt;
		// vssh fork: houve mescla ⇒ o disco tem cookies de outra aba que este jar não
		// tem, então "sincronizado" seria mentira. Deixar sujo faz a próxima leitura
		// buscá-los, em vez de este jar seguir servindo um estado incompleto.
		this.cookieSyncDirty = merged;
		this.cookieSyncChannel.postMessage({
			updatedAt,
		});
	}

	setTransport(transport: ProxyTransport) {
		this.transport = transport;
		for (const frame of this.frames) {
			frame.controller.transport = transport;
			frame.fetchHandler.client.transport = transport;
		}
	}

	createFrame(element?: HTMLIFrameElement, options: FrameOptions = {}): Frame {
		if (!this.ready) {
			throw new Error(
				"Controller is not ready! Try awaiting controller.wait()"
			);
		}
		element ??= document.createElement("iframe");
		const frame = new Frame(this, element, options);
		this.frames.push(frame);
		return frame;
	}

	async wait(): Promise<void> {
		await this.ready;
	}
}

function base64Encode(text: string) {
	return btoa(
		new TextEncoder()
			.encode(text)
			.reduce(
				(data, byte) => (data.push(String.fromCharCode(byte)), data),
				[] as any
			)
			.join("")
	);
}

function yieldGetInjectScripts(
	config: Config,
	sjconfig: ScramjetConfig,
	prefix: URL,
	cookieJar: CookieJar,
	codecEncode: (input: string) => string,
	codecDecode: (input: string) => string
) {
	const getInjectScripts: ScramjetInterface["getInjectScripts"] = (
		meta,
		handler,
		htmlcontext,
		script
	) => {
		function base64Encode(text: string) {
			return btoa(
				new TextEncoder()
					.encode(text)
					.reduce(
						(data, byte) => (data.push(String.fromCharCode(byte)), data),
						[] as any
					)
					.join("")
			);
		}
		return [
			script(config.scramjetPath),
			script(prefix.href + config.virtualWasmPath),
			script(config.injectPath),
			script(
				"data:text/javascript;charset=utf-8;base64," +
					base64Encode(`
					document.querySelectorAll("script[scramjet-injected]").forEach(script => script.remove());
					$scramjetController.load({
						config: ${JSON.stringify(config)},
						sjconfig: ${JSON.stringify(sjconfig)},
						prefix: new URL("${prefix.href}"),
						cookies: ${JSON.stringify(cookieJar.dump())},
						yieldGetInjectScripts: ${yieldGetInjectScripts.toString()},
						codecEncode: ${codecEncode.toString()},
						codecDecode: ${codecDecode.toString()},
						initHeaders: ${JSON.stringify(htmlcontext.headers ?? [])},
						history: ${JSON.stringify(htmlcontext.history ?? [])},
					})
				`)
			),
		];
	};
	return getInjectScripts;
}

export class Frame {
	id: string;
	prefix: string;
	fetchHandler: ScramjetFetchHandler;
	hooks: {
		fetch: FetchHooks;
		init: FrameInitHooks;
		error: FrameErrorHooks;
	};

	get context(): ScramjetContext {
		return {
			config: this.controller.scramjetConfig,
			prefix: new URL(this.prefix, location.href),
			cookieJar: this.controller.cookieJar,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					this.controller.config,
					this.controller.scramjetConfig,
					new URL(this.prefix, location.href),
					this.controller.cookieJar,
					this.controller.config.codec.encode,
					this.controller.config.codec.decode
				),
				getWorkerInjectScripts: (meta, type, script) => {
					let str = "";

					str += script(this.controller.config.scramjetPath);
					str += script(this.prefix + this.controller.config.virtualWasmPath);
					str += script(
						"data:text/javascript;charset=utf-8;base64," +
							base64Encode(`
					(()=>{
						const { ScramjetClient, CookieJar, setWasm } = $scramjet;

						setWasm(Uint8Array.from(atob(self.WASM), (c) => c.charCodeAt(0)));
						delete self.WASM;

						const sjconfig = ${JSON.stringify(this.controller.scramjetConfig)};
						const prefix = new URL("${this.prefix}", location.href);

						const context = {
							config: sjconfig,
							prefix,
							interface: {
								codecEncode: ${this.controller.config.codec.encode.toString()},
								codecDecode: ${this.controller.config.codec.decode.toString()},
							},
						};

						const client = new ScramjetClient(globalThis, {
							context,
							transport: null,
						});

						client.hook();
					})();
					`)
					);

					return str;
				},
				codecEncode: this.controller.config.codec.encode,
				codecDecode: this.controller.config.codec.decode,
			},
		};
	}

	public plugins: ManagedPlugin[] = [];
	constructor(
		public controller: Controller,
		public element: HTMLIFrameElement,
		public options: FrameOptions = {}
	) {
		this.id = makeId();
		this.prefix = this.controller.prefix + this.id + "/";

		this.fetchHandler = new ScramjetFetchHandler({
			crossOriginIsolated: self.crossOriginIsolated,
			context: this.context,
			transport: controller.transport,
			async sendSetCookie(cookies, options) {
				await controller.persistCookies();
				await controller.propagateCookieSync(
					cookies.map(({ url, cookie }) => ({
						url: url.href,
						cookie,
					})),
					options
				);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
		};

		element[CONTROLLERFRAME] = this;

		this.plugins = options.plugins ?? [];
		for (const plugin of this.plugins) {
			for (const dependency of plugin.dependencies) {
				const dependencyPlugin = this.plugins.find(
					(p) => p.name === dependency
				);
				if (!dependencyPlugin) {
					throw new Error(
						`Dependency ${dependency} not found for plugin ${plugin.name}`
					);
				}
			}
			plugin.install(this);
		}
	}

	getPlugin<T extends ManagedPlugin>(name: string): T {
		const plugin = this.plugins.find((p) => p.name === name) as T;
		if (!plugin) {
			throw new Error(`Plugin ${name} not found`);
		}
		return plugin;
	}

	back() {
		this.element.contentWindow?.history.back();
	}

	forward() {
		this.element.contentWindow?.history.forward();
	}

	reload() {
		this.element.contentWindow?.location.reload();
	}

	// vssh fork: um documento SEM service worker controlando nunca vai funcionar, e falhava calado.
	//
	// O controlador de um documento é fixado no instante em que ele nasce: quem carrega antes de o
	// service worker estar ativo fica sem controlador PARA SEMPRE — não existe recuperação, só
	// recarregar. Isso acontece de verdade quando o portal restaura as abas da sessão anterior e
	// navega os frames antes de o registro terminar.
	//
	// E o modo de falha é o pior possível: sem ninguém para interceptar, o `src` reescrito vira uma
	// requisição de verdade para o próprio servidor do portal, que não tem rota para o prefixo do
	// proxy e responde o catch-all — **200 OK com a SPA do portal inteira**. A aba do usuário exibe
	// a tela de login do portal dentro dela e parece estar "carregando para sempre". Nada no
	// console, nada de erro, e `getStatus()` do motor continua dizendo "connected".
	//
	// Medido ao vivo numa sessão real: duas abas, o MESMO controller, o mesmo prefixo — a que
	// nasceu antes do service worker mostrava o portal por dentro (`document.title` =
	// "VSSH-SSO — Portal de Acesso Remoto") e não estava na lista de clientes controlados; a aberta
	// depois carregou o site em 1,3 s.
	//
	// Avisar não conserta a corrida — quem tem de esperar o controlador é quem navega o frame —
	// mas troca uma tela parada e muda por uma linha que diz o que houve e o que fazer.
	private avisouSemControlador = false;

	go(url: string) {
		if (
			typeof navigator !== "undefined" &&
			navigator.serviceWorker &&
			!navigator.serviceWorker.controller &&
			!this.avisouSemControlador
		) {
			this.avisouSemControlador = true;
			console.error(
				"[scramjet] Este documento não é controlado por um service worker, então NADA será " +
					"reescrito: a navegação vai sair para o servidor real e a aba vai exibir o que ele " +
					"responder (no portal, a própria SPA, com 200). Um documento que nasce sem " +
					"controlador não passa a ser controlado depois — é preciso recarregá-lo. Espere " +
					"`navigator.serviceWorker.controller` existir antes de navegar o frame.",
				{ url, prefixo: this.prefix }
			);
		}

		const encoded = rewriteUrl(url, this.context, {
			//@ts-expect-error
			origin: new URL(location.href),
			//@ts-expect-error
			base: new URL(location.href),
		});
		this.element.src = encoded;
	}
}
