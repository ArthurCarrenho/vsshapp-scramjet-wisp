import { iswindow } from "@client/entry";
import { ScramjetClient } from "@client/index";
import { AnyFunction } from "@/types";
import { getOwnPropertyDescriptorHandler } from "@client/helpers";
import {
	_Map,
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
				// vssh fork: ⚠ `key` é `null` num evento de `clear()` — é assim que a especificação
				// diz "a área inteira foi limpa", e não é caso raro: todo fluxo de logout passa por
				// aí. `null.startsWith` levanta TypeError DENTRO do despacho do evento, e o ouvinte
				// do site não roda — some o handler inteiro, não só este evento.
				//
				// Descartar é o certo, e não só o seguro: o storage é particionado por origem
				// lógica, então um `clear()` que veio de fora desta partição não significa "a SUA
				// área foi limpa". Entregar o evento seria afirmar isso.
				if (this.key === null) return false;

				return this.key.startsWith(client.url.host + "@");
			},
			key() {
				if (this.key === null) return null;

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

	// vssh fork: `addEventListener` aceita DUAS formas de ouvinte — uma função, ou um objeto com
	// `handleEvent`. Só a primeira era embrulhada, e o embrulho é quem faz TODO o isolamento de
	// eventos deste arquivo: descartar `storage` de outra origem lógica, tirar o prefixo da
	// partição da chave, conferir o `targetOrigin` que o remetente de `message` pediu, e
	// desembrulhar `origin`/`data` do envelope `$scramjet$`.
	//
	// Sem embrulho, o site recebia o evento CRU. Medido na bancada (`bench/ouvinte-objeto.mjs`):
	// um `storage` escrito por OUTRA origem lógica chegava ao ouvinte-objeto com a chave
	// `"127.0.0.1:5255@yt-player-volume"` — a partição alheia inteira, à vista, junto com o valor.
	// Para `message` o buraco é pior: some justamente a conferência de origem, que existe porque a
	// origem REAL de todo mundo aqui é a do proxy e a checagem do navegador não vale.
	//
	// Escolher a forma de escrever o ouvinte não pode decidir se o isolamento vale ou não. As duas
	// formas são igualmente comuns em código de produção, e a diferença entre elas é sintática.
	//
	// ⚠ O objeto não pode ser embrulhado num `Proxy`: a armadilha `apply` só dispara em função.
	// Quem vai para a plataforma é uma função que delega ao objeto — e ela consulta `handleEvent`
	// na HORA do disparo, não no registro, porque é o que a especificação manda: o site pode
	// instalar ou trocar o método depois de já ter registrado o ouvinte.
	function comoFuncao(listener: any): ((...args: any) => any) | null {
		if (typeof listener === "function") return listener;
		if (typeof listener !== "object" || listener === null) return null;

		return function (ev: Event) {
			const handle = (listener as { handleEvent?: unknown }).handleEvent;
			if (typeof handle !== "function") return;

			// o `this` de `handleEvent` é o próprio objeto ouvinte, não o alvo do evento
			return Reflect_apply(handle as AnyFunction, listener, [ev]);
		};
	}

	// ⚠ `addEventListener("message", h)` — solto, sem receptor — é a forma mais comum de escutar
	// `message`, e nela `ctx.this` é `undefined`. A WebIDL manda tratar `this` nulo ou indefinido
	// como o objeto global, e é por isso que a chamada solta funciona e registra na window.
	//
	// Enquanto o registro era um `Map` isso passava despercebido: `undefined` é chave válida, e
	// todas as chamadas soltas dividiam um balde só. Num `WeakMap` a mesma chave levanta
	// `TypeError: Invalid value used as weak map key` DENTRO do `addEventListener` do site — o
	// site nem chega a registrar o ouvinte. Foi o que derrubou 13 testes de `postmessage`.
	//
	// Normalizar aqui também conserta um defeito que o `Map` escondia: `undefined` e `window` eram
	// chaves DIFERENTES, então registrar solto e remover por `window.removeEventListener` não
	// achava o embrulho para traduzir, e o ouvinte ficava registrado para sempre.
	function alvoDoRegistro(receptor: any): object | AnyFunction | null {
		if (receptor === null || receptor === undefined) return self;
		if (typeof receptor === "object" || typeof receptor === "function")
			return receptor;

		// Primitivo: esta chamada vai levantar "Illegal invocation" na plataforma, que é o certo.
		// Não há registro a fazer, e insistir no `WeakMap` levantaria o erro ERRADO, antes e no
		// lugar daquele que o site deveria ver.
		return null;
	}

	client.Proxy("EventTarget.prototype.addEventListener", {
		apply(ctx) {
			const origlistener = ctx.args[1] as any;
			const alvo = comoFuncao(origlistener);
			if (!alvo) return;

			const alvoRegistro = alvoDoRegistro(ctx.this);
			if (!alvoRegistro) return;

			const tipo = ctx.args[0] as string;

			let porTipo = client.eventcallbacks.get(alvoRegistro);
			if (!porTipo) {
				porTipo = new _Map();
				client.eventcallbacks.set(alvoRegistro, porTipo);
			}
			let porOuvinte = porTipo.get(tipo);
			if (!porOuvinte) {
				porOuvinte = new _Map();
				porTipo.set(tipo, porOuvinte);
			}

			// ⚠ Registrar o mesmo ouvinte duas vezes é operação idempotente na plataforma, e ela
			// decide isso pela IDENTIDADE do que recebeu. Um embrulho novo a cada chamada faz a
			// plataforma enxergar dois ouvintes distintos e disparar duas vezes — que é o defeito
			// que os testes `events-duplicate-listener-*` descrevem. Reaproveitar o embrulho que
			// já existe para este par (evento, ouvinte) devolve a idempotência: a plataforma
			// recebe a mesma função e deduplica sozinha.
			//
			// ⚠ Reaproveitar o embrulho NÃO é o mesmo que pular o registro. A contagem sobe de
			// qualquer jeito, porque é dela que o `removeEventListener` vive: o mesmo ouvinte pode
			// estar registrado na fase de captura E na de borbulha, que são dois registros para a
			// plataforma e pedem duas remoções. Contando uma vez só, a segunda remoção não acharia
			// o que traduzir e o ouvinte ficaria preso para sempre.
			const registro = porOuvinte.get(origlistener);
			if (registro) {
				registro.contagem++;
				ctx.args[1] = registro.proxiedCallback;

				return;
			}

			const proxylistener = wraplistener(alvo) as EventListener;
			ctx.args[1] = proxylistener;
			porOuvinte.set(origlistener, { proxiedCallback: proxylistener, contagem: 1 });
		},
	});

	client.Proxy("EventTarget.prototype.removeEventListener", {
		apply(ctx) {
			// função ou objeto: o que não pode ser ouvinte é o que não é nem um nem outro
			if (typeof ctx.args[1] !== "function" && typeof ctx.args[1] !== "object")
				return;
			if (ctx.args[1] === null) return;

			// ⚠ O ouvinte original é guardado ANTES de `ctx.args[1]` ser trocado: ele é a CHAVE do
			// mapa, e depois da troca `ctx.args[1]` é o embrulho — apagar por ele não removeria
			// nada, e a entrada ficaria de pé para sempre.
			const origlistener = ctx.args[1] as AnyFunction | object;

			// Mesma normalização do registro, pela mesma razão: a remoção precisa cair no balde em
			// que a adição escreveu, e a chamada solta chega aqui com `this` indefinido também.
			const alvoRegistro = alvoDoRegistro(ctx.this);
			if (!alvoRegistro) return;

			const porOuvinte = client.eventcallbacks
				.get(alvoRegistro)
				?.get(ctx.args[0] as string);
			if (!porOuvinte) return;

			const registro = porOuvinte.get(origlistener);
			if (!registro) return;

			// Traduzir SEMPRE, esquecer só na última. Enquanto houver registro de pé — a outra
			// fase, tipicamente — o embrulho precisa continuar sendo encontrável, senão a remoção
			// seguinte chega aqui sem nada para traduzir e passa o ouvinte original adiante: a
			// plataforma não acha, e o que ficou registrado nunca sai.
			ctx.args[1] = registro.proxiedCallback;
			registro.contagem--;
			if (registro.contagem <= 0) porOuvinte.delete(origlistener);
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
