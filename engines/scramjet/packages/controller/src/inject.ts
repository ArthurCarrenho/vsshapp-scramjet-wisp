import type {
	RawHeaders,
	ProxyTransport,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";

import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Config } from ".";
import { CONTROLLERFRAME } from "./symbols";
import type {
	SerializedCookieSyncEntry,
	ControllerToTransport,
	TransportToController,
	WebSocketMessage,
} from "./types";
import {
	CookieJar,
	SCRAMJETCLIENT,
	ScramjetClient,
	setWasm,
	Tap,
	type CookieSyncOptions,
	type ScramjetConfig,
	type ScramjetContext,
	type TrackedHistoryState,
} from "@mercuryworkshop/scramjet";

const MessagePort_postMessage = MessagePort.prototype.postMessage;
const postMessage = (
	port: MessagePort,
	data: any,
	transfer?: Transferable[]
) => {
	MessagePort_postMessage.call(port, data, transfer as any);
};

class RemoteTransport implements ProxyTransport {
	private readyResolve!: () => void;
	private readyPromise: Promise<void> = new Promise((resolve) => {
		this.readyResolve = resolve;
	});

	public ready = false;
	async init() {
		await this.readyPromise;
		this.ready = true;
	}

	private rpc: RpcHelper<ControllerToTransport, TransportToController>;
	constructor(public port: MessagePort) {
		this.rpc = new RpcHelper<ControllerToTransport, TransportToController>(
			{
				ready: async () => {
					this.readyResolve();
				},
			},
			"transport",
			(data, transfer) => {
				postMessage(port, data, transfer);
			}
		);
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
		};
		port.onmessage = (ev) => {
			this.rpc.recieve(ev.data);
		};
		port.start();
	}
	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: Blob | ArrayBuffer | string) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: Blob | ArrayBuffer | string) => void,
		(code: number, reason: string) => void,
	] {
		const channel = new MessageChannel();
		const port = channel.port1;
		console.warn("connecting");
		this.rpc
			.call(
				"connect",
				{
					url: url.href,
					protocols,
					requestHeaders,
					port: channel.port2,
				},
				[channel.port2]
			)
			.then((response) => {
				console.log(response);
				if (response.result === "success") {
					onopen(response.protocol, response.extensions);
				} else {
					onerror(response.error);
				}
			});
		port.onmessage = (ev) => {
			const message = ev.data as WebSocketMessage;
			if (message.type === "data") {
				onmessage(message.data);
			} else if (message.type === "close") {
				onclose(message.code, message.reason);
			}
		};
		port.onmessageerror = (ev) => {
			console.error("onmessageerror (this should never happen!)", ev);
			onerror("Message error in transport port");
		};

		return [
			(data) => {
				postMessage(
					port,
					{
						type: "data",
						data: data,
					},
					data instanceof ArrayBuffer ? [data] : []
				);
			},
			(code) => {
				postMessage(port, {
					type: "close",
					code: code,
				});
			},
		];
	}

	async request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		_signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		return await this.rpc.call("request", {
			remote: remote.href,
			method,
			body,
			headers,
		});
	}

	async sendSetCookie(
		cookies: Array<{ url: URL; cookie: string }>,
		options: CookieSyncOptions = {}
	): Promise<void> {
		await this.rpc.call("sendSetCookie", {
			cookies: cookies.map(({ url, cookie }) => ({
				url: url.href,
				cookie,
			})),
			options,
		});
	}
}

const sw = navigator.serviceWorker.controller;

type Init = {
	config: Config;
	sjconfig: ScramjetConfig;
	prefix: URL;
	cookies: string;
	yieldGetInjectScripts: (
		config: Config,
		sjconfig: ScramjetConfig,
		prefix: URL,
		cookieJar: CookieJar,
		codecEncode: (input: string) => string,
		codecDecode: (input: string) => string
	) => any;
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;
	initHeaders: RawHeaders;
	history: TrackedHistoryState[];
};

export function load(init: Init) {
	if (SCRAMJETCLIENT in globalThis) {
		((globalThis as any)[SCRAMJETCLIENT] as ScramjetClient).syncDocumentInit({
			initHeaders: init.initHeaders,
			history: init.history,
			cookies: init.cookies,
		});
		return;
	}
	if (!("WASM" in self)) {
		throw new Error("WASM not found in global scope!");
	}
	const wasm = Uint8Array.from(atob(self.WASM), (c) => c.charCodeAt(0));
	delete (self as any).WASM;
	setWasm(wasm);

	new ExecutionContextWrapper(globalThis, init);
}

function createFrameId() {
	return `${Array(8)
		.fill(0)
		.map(() => Math.floor(Math.random() * 36).toString(36))
		.join("")}`;
}

// vssh fork: **UM ouvinte por documento, não um por contexto de execução.**
//
// Cada `ExecutionContextWrapper` registrava o próprio `addEventListener("message", …)` em
// `navigator.serviceWorker` e nunca o removia. `hookSubcontext` cria um wrapper por realm aninhado
// (todo iframe mesma-origem que a página abrir), então uma página que cria frames em laço acumulava
// ouvintes sem teto — e cada ouvinte mantinha vivo o wrapper inteiro, com o `CookieJar` dele.
//
// E o custo não era só memória: com N ouvintes, CADA lote de cookies do controller era processado N
// vezes e respondido com N acks. O trabalho crescia junto com o vazamento.
//
// Agora o ouvinte é um, e ele distribui para os contextos vivos — que continuam precisando do lote,
// porque cada um tem o próprio jar. O `Set` morre com o documento, junto com tudo que ele guarda.
const contextosDoDocumento = new Set<ExecutionContextWrapper>();
let ouvinteDeCookieInstalado = false;

function instalarOuvinteDeCookie() {
	if (ouvinteDeCookieInstalado) return;
	ouvinteDeCookieInstalado = true;

	navigator.serviceWorker?.addEventListener("message", (event: MessageEvent) => {
		if (
			!event.data?.$controller$setCookie ||
			typeof event.data.$controller$setCookie !== "object"
		) {
			return;
		}

		const payload = event.data.$controller$setCookie as {
			cookies?: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
			id?: string;
		};

		for (const contexto of contextosDoDocumento) {
			try {
				contexto.aplicarLoteDeCookies(payload);
			} catch (e) {
				// Um contexto que falhe não pode impedir os outros de receberem o lote, nem impedir o
				// ack — sem ack, o handler de fetch do SW espera o teto inteiro.
				console.error("Failed to apply cookie batch", e);
			}
		}

		// UM ack, não um por contexto. O resolvedor do lado do SW some no primeiro, então os demais
		// eram trabalho jogado fora.
		if (typeof payload.id === "string") {
			const targetSw = navigator.serviceWorker?.controller ?? sw;
			targetSw?.postMessage({ $sw$setCookieDone: { id: payload.id } });
		}
	});

	// **Sem esta linha o ouvinte acima não recebe nada durante a carga da página** — e é justamente
	// durante a carga que o SW mais precisa do ack.
	//
	// A fila de mensagens do `ServiceWorkerContainer` nasce DESABILITADA e só é liberada por
	// `startMessages()` ou por atribuir `onmessage`; `addEventListener` não libera. Sem liberar, a
	// fila só sai sozinha depois que o documento termina de ser carregado e analisado.
	//
	// O que isso custava: o handler de fetch do SW dá `await` no ack do Set-Cookie com teto de
	// 1000 ms ANTES de devolver a resposta. Todo recurso que setasse cookie durante a carga — o
	// próprio documento, e cada script/CSS do `<head>` — esperava o segundo inteiro e terminava em
	// `timed out waiting for set cookie`. Não era rede lenta: era a resposta parada esperando um ack
	// que não tinha por onde chegar. E `document.cookie = ...` paga a mesma espera, pelo mesmo
	// caminho.
	navigator.serviceWorker?.startMessages?.();
}

class ExecutionContextWrapper {
	client!: ScramjetClient;
	cookieJar: CookieJar;
	transport: RemoteTransport;

	constructor(
		public global: typeof globalThis,
		public init: Init
	) {
		const channel = new MessageChannel();
		this.transport = new RemoteTransport(channel.port1);
		sw?.postMessage(
			{
				$sw$initRemoteTransport: {
					port: channel.port2,
					prefix: this.init.prefix.href,
				},
			},
			[channel.port2]
		);

		this.cookieJar = new CookieJar();
		this.cookieJar.load(this.init.cookies);

		contextosDoDocumento.add(this);
		instalarOuvinteDeCookie();

		this.injectScramjet();
	}

	// Aplica um lote de cookies vindo do controller a ESTE jar. Cada contexto de execução tem o
	// seu, então o lote precisa chegar a todos — o que mudou é quem escuta (ver o ouvinte único
	// logo acima da classe).
	aplicarLoteDeCookies(payload: {
		cookies?: SerializedCookieSyncEntry[];
		options?: CookieSyncOptions;
	}) {
		if (payload.options?.clear) {
			this.cookieJar.clear();
		}

		if (!Array.isArray(payload.cookies)) return;
		for (const cookie of payload.cookies) {
			if (typeof cookie?.url !== "string" || typeof cookie.cookie !== "string") {
				continue;
			}
			try {
				this.cookieJar.setCookies(cookie.cookie, new URL(cookie.url));
			} catch {
				console.error("Failed to set cookie", cookie);
			}
		}
	}

	injectScramjet() {
		const frame = this.global.frameElement as HTMLIFrameElement | null;
		if (frame && !frame.name) {
			window.name = frame.name = createFrameId();
		}
		let controllerFrame = frame?.[CONTROLLERFRAME];
		let isTopLevel = true;
		if (!controllerFrame) {
			isTopLevel = false;
			let currentwin = this.global.window;
			while (currentwin.parent !== currentwin) {
				const currentclient = currentwin[SCRAMJETCLIENT];
				if (!currentclient) {
					currentwin = currentwin.parent.window;
					continue;
				}
				const currentFrame = currentclient.descriptors.get(
					"window.frameElement",
					currentwin
				);
				if (currentFrame && currentFrame[CONTROLLERFRAME]) {
					controllerFrame = currentFrame[CONTROLLERFRAME];
					break;
				}
				currentwin = currentwin.parent.window;
			}
		}
		const context: ScramjetContext = {
			config: this.init.sjconfig,
			prefix: this.init.prefix,
			cookieJar: this.cookieJar,
			interface: {
				getInjectScripts: this.init.yieldGetInjectScripts(
					this.init.config,
					this.init.sjconfig,
					this.init.prefix,
					this.cookieJar,
					this.init.codecEncode,
					this.init.codecDecode
				),
				codecEncode: this.init.codecEncode,
				codecDecode: this.init.codecDecode,
			},
		};
		this.client = new ScramjetClient(this.global, {
			context,
			transport: this.transport,
			sendSetCookie: async (cookies, options) => {
				await this.transport.sendSetCookie(cookies, options);
			},
			shouldBlockMessageEvent: () => {
				return false;
			},
			hookSubcontext: (frameself) => {
				const context = new ExecutionContextWrapper(frameself, {
					...this.init,
					cookies: this.cookieJar.dump(),
				});
				return context.client;
			},
			initHeaders: this.init.initHeaders,
			history: this.init.history,
		});
		const frameInitContext = {
			window: this.global.window,
			client: this.client,
			isTopLevel,
		};
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.pre, frameInitContext, {});
		this.client.hook();
		if (controllerFrame)
			Tap.dispatch(controllerFrame.hooks.init.post, frameInitContext, {});
	}
}
