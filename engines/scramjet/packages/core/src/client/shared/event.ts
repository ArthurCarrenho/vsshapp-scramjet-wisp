import { iswindow } from "@client/entry";
import { ScramjetClient } from "@client/index";
import { getOwnPropertyDescriptorHandler } from "@client/helpers";
import {
	Object_defineProperty,
	Reflect_apply,
	Reflect_get,
	Reflect_ownKeys,
	Symbol_for,
} from "@/shared/snapshot";

const realOnEvent = Symbol_for("scramjet original onevent function");

export default function (client: ScramjetClient, self: Self) {
	const handlers = {
		message: {
			_init() {
				if (client.init.shouldBlockMessageEvent?.(this)) {
					return false;
				}

				// vssh fork: a outra metade do `targetOrigin` (ver `postmessage.ts`). O
				// remetente pediu uma origem; a checagem do navegador não pôde ser usada,
				// porque a origem REAL é a do proxy — então ela é feita aqui, onde este
				// cliente sabe a própria origem LÓGICA.
				//
				// Sem isto, um `postMessage(token, "https://conhecido")` era entregue a
				// qualquer janela endereçada: a restrição que o site escreveu justamente
				// para o token não vazar deixava de existir depois da reescrita.
				//
				// ⚠ O que o remetente passa NÃO é uma origem, é uma URL. O `postMessage`
				// nativo aceita qualquer URL absoluta como `targetOrigin` e compara só o
				// COMPONENTE de origem dela — então `"https://a.com/"`, `"https://a.com/x?y"`
				// e `"https://a.com"` são todos o mesmo alvo para o navegador.
				//
				// Comparar texto cru descarta mensagem legítima, e descarta calado. O
				// YouTube caiu exatamente aqui: o botão de fechar o painel de replay do chat
				// manda `postMessage({"yt-hide-live-chat":"*"}, "https://www.youtube.com/")`
				// — com barra final, porque é uma URL. `URL.origin` nunca tem barra, a
				// comparação de string dava diferente, e o painel não fechava. Nada aparecia
				// no console: do lado do site, o clique simplesmente não fazia nada.
				//
				// Normalizar pela URL devolve a semântica do navegador. Quando não dá para
				// interpretar (origem opaca, `"null"`), sobra a comparação literal — que para
				// esses casos é o comportamento certo.
				if (
					iswindow &&
					this.data &&
					typeof this.data === "object" &&
					"$scramjet$targetOrigin" in this.data
				) {
					//
					// A origem é extraída por regex, e NÃO com `new URL(...)`, de propósito:
					// dentro do cliente o construtor `URL` pode estar proxiado, e aí `.origin`
					// volta a origem do PROXY em vez da lógica — a conferência passaria a
					// comparar duas coisas diferentes e descartaria tudo.
					//
					// Duas normalizações, e as DUAS já custaram um site em produção:
					//
					//   caminho    `https://a.com/` -> `https://a.com`     (YouTube)
					//   porta      `https://a.com:443` -> `https://a.com`  (reCAPTCHA)
					//
					// Porta padrão não faz parte da origem: o navegador trata `https://a.com:443` e
					// `https://a.com` como a MESMA, e `URL.origin` nunca emite a porta padrão. O
					// reCAPTCHA endereça com a porta explícita, então a comparação literal
					// descartava o pedido de desafio — a caixinha girava para sempre e a tela de
					// selecionar imagens nunca abria.
					//
					// O que não casar a regex (origem opaca, `"null"`) segue para a comparação
					// literal, que é o comportamento certo nesses casos.
					const alvo = this.data.$scramjet$targetOrigin;
					if (typeof alvo === "string") {
						const casa = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i.exec(alvo);
						let alvoOrigem = alvo;
						if (casa) {
							const esquema = casa[1].toLowerCase();
							let hospedeiro = casa[2].toLowerCase();
							const portaPadrao =
								esquema === "https" ? ":443" : esquema === "http" ? ":80" : null;
							if (portaPadrao && hospedeiro.endsWith(portaPadrao))
								hospedeiro = hospedeiro.slice(0, -portaPadrao.length);
							alvoOrigem = esquema + "://" + hospedeiro;
						}
						if (alvoOrigem !== client.url.origin) {
							return false;
						}
					}
				}

				return true;
			},
			ports() {
				// don't know why i have to do this?
				return this.ports;
			},
			source() {
				if (this.source === null) return null;

				// const scram: ScramjetClient = this.source[SCRAMJETCLIENT];

				// if (scram) return scram.globalProxy;

				return this.source;
			},
			origin() {
				if (!iswindow) return "";
				if (typeof this.data === "object" && "$scramjet$origin" in this.data)
					return this.data.$scramjet$origin;

				return client.url.origin;
			},
			data() {
				if (typeof this.data === "object" && "$scramjet$data" in this.data)
					return this.data.$scramjet$data;

				return this.data;
			},
		},
		hashchange: {
			oldURL() {
				return client.unrewriteUrl(this.oldURL);
			},
			newURL() {
				return client.unrewriteUrl(this.newURL);
			},
		},
		storage: {
			_init() {
				return this.key.startsWith(client.url.host + "@");
			},
			key() {
				return this.key.substring(this.key.indexOf("@") + 1);
			},
			url() {
				return client.unrewriteUrl(this.url);
			},
		},
	};

	function wraplistener(listener: (...args: any) => any) {
		return new Proxy(listener, {
			apply(target, that, args) {
				const realEvent: Event = args[0];

				// we only need to handle events dispatched from the browser
				if (realEvent.isTrusted) {
					const type = realEvent.type;

					if (type in handlers) {
						const handler = handlers[type];

						if (handler._init) {
							// if _init returns false, we skip the event, and it never dispatches to listeners
							if (handler._init.call(realEvent) === false) return;
						}

						args[0] = new Proxy(realEvent, {
							get(target, prop, reciever) {
								const value = Reflect_get(target, prop);
								if (prop in handler) {
									return handler[prop].call(target);
								}

								if (typeof value === "function") {
									return new Proxy(value, {
										apply(target, that, args) {
											if (that === reciever) {
												return Reflect_apply(target, realEvent, args);
											}

											return Reflect_apply(target, that, args);
										},
									});
								}

								return value;
							},
							getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
						});
					}
				}

				if (!self.event) {
					Object_defineProperty(self, "event", {
						get() {
							return args[0];
						},
						configurable: true,
					});
				}

				const rv = Reflect_apply(target, that, args);

				return rv;
			},
			getOwnPropertyDescriptor: getOwnPropertyDescriptorHandler,
		});
	}

	client.Proxy("EventTarget.prototype.addEventListener", {
		apply(ctx) {
			if (typeof ctx.args[1] !== "function") return;

			const origlistener = ctx.args[1];
			const proxylistener = wraplistener(origlistener);

			ctx.args[1] = proxylistener;

			let arr = client.eventcallbacks.get(ctx.this);
			arr ||= [] as any;
			arr.push({
				event: ctx.args[0] as string,
				originalCallback: origlistener,
				proxiedCallback: proxylistener,
			});
			client.eventcallbacks.set(ctx.this, arr);
		},
	});

	client.Proxy("EventTarget.prototype.removeEventListener", {
		apply(ctx) {
			if (typeof ctx.args[1] !== "function") return;

			const arr = client.eventcallbacks.get(ctx.this);
			if (!arr) return;

			const i = arr.findIndex(
				(e) => e.event === ctx.args[0] && e.originalCallback === ctx.args[1]
			);
			if (i === -1) return;

			const r = arr.splice(i, 1);
			client.eventcallbacks.set(ctx.this, arr);

			ctx.args[1] = r[0].proxiedCallback;
		},
	});

	const targets = [
		self.self,
		self.MessagePort.prototype,
		self.BroadcastChannel.prototype,
	] as Array<any>;
	if (iswindow) targets.push(self.HTMLElement.prototype);
	if (self.Worker) targets.push(self.Worker.prototype);

	for (const target of targets) {
		const keys = Reflect_ownKeys(target);

		for (const key of keys) {
			if (
				typeof key === "string" &&
				key.startsWith("on") &&
				handlers[key.slice(2)]
			) {
				const descriptor = client.natives.call(
					"Object.getOwnPropertyDescriptor",
					null,
					target,
					key
				);
				if (!descriptor.get || !descriptor.set || !descriptor.configurable)
					continue;

				// these are the `onmessage`, `onclick`, etc. properties
				client.RawTrap(target, key, {
					get(ctx) {
						if (this[realOnEvent]) return this[realOnEvent];

						return ctx.get();
					},
					set(ctx, value: any) {
						this[realOnEvent] = value;

						if (typeof value !== "function") return ctx.set(value);

						ctx.set(wraplistener(value));
					},
				});
			}
		}
	}
}
