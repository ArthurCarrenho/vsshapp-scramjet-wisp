import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import { _URL, Object_defineProperty, Reflect_apply } from "@/shared/snapshot";
import { AnyFunction } from "@/types";
import { POLLUTANT } from "./realm";
import { embrulhar } from "@/shared/confiavel";
import { ehVista, origemDe } from "@client/janela-cruzada";

// O `targetOrigin` que o nativo aceita: `*`, `/`, ou uma URL absoluta, pelo mesmo parser de URL.
// O resto ele recusa com SyntaxError.
function origemDeAlvoValida(alvo: string): boolean {
	try {
		new _URL(alvo);
		return true;
	} catch {
		return false;
	}
}

export default function (client: ScramjetClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				// vssh fork: a chamada sem argumento e a com um `targetOrigin` que não é URL vão
				// para o nativo como vieram, e ele lança o erro dele antes de enviar qualquer coisa.
				// O envelope abaixo aceitaria as duas e entregaria uma mensagem que o navegador
				// nunca entrega. O iframe do Turnstile chama `postMessage()` em si mesmo e espera o
				// TypeError; com o envelope, o ouvinte de `message` dele recebe `data` indefinido,
				// lança, e o desafio falha.
				if (ctx.args.length === 0) return;
				// O alvo é lido uma vez só: num objeto de opções, `targetOrigin` pode ser um getter.
				const alvoPedido =
					typeof ctx.args[1] === "string"
						? ctx.args[1]
						: ctx.args[1] && typeof ctx.args[1] === "object"
							? ctx.args[1].targetOrigin
							: undefined;
				if (
					typeof alvoPedido === "string" &&
					alvoPedido !== "*" &&
					alvoPedido !== "/" &&
					!origemDeAlvoValida(alvoPedido)
				)
					return;

				// so we need to send the real origin here, since the recieving window can't possibly know.
				// except, remember that this code is being ran in a different realm than the invoker, so if we ask our `client` it may give us the wrong origin
				// if we were given any object that came from the real realm we can use that to get the real origin
				// and this works in every case EXCEPT for the fact that all three arguments can be strings which are copied instead of cloned
				// so we have to use `$setrealm` which will pollute this with an object from the real realm

				let pollutant;

				if (typeof ctx.args[0] === "object" && ctx.args[0] !== null) {
					pollutant = ctx.args[0]; // try to use the first object we can find because it's more reliable
				} else if (typeof ctx.args[2] === "object" && ctx.args[2] !== null) {
					pollutant = ctx.args[2]; // next try to use transfer
				} else if (
					ctx.this &&
					POLLUTANT in ctx.this &&
					typeof ctx.this[POLLUTANT] === "object" &&
					ctx.this[POLLUTANT] !== null
				) {
					pollutant = ctx.this[POLLUTANT]; // lastly try to use the object from $setrealm
				} else {
					pollutant = {}; // give up
				}

				// and now we can steal Function from the caller's realm
				const {
					constructor: { constructor: Function },
				} = pollutant;

				// vssh fork: os argumentos destas duas funções vão todos como TrustedScript, que o `Function`
				// do motor reconhece como dele (ver `function.ts`). Num documento que exige Trusted Types,
				// uma string aqui iria à política padrão do site, que a recusa, e todo `postMessage` da
				// página morreria com EvalError.
				const codigo = (texto: string) => embrulhar(client, "TrustedScript", texto);

				// invoking stolen function will give us the caller's globalThis, remember scramjet has already proxied it!!!
				const callerGlobalThisProxied: Self = Function(codigo("return globalThis"))();
				const callerClient = callerGlobalThisProxied[SCRAMJETCLIENT];

				// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
				// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
				// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is scramjet's!!!)
				const wrappedPostMessage = Function(codigo("...args"), codigo("this(...args)"));

				// console.log(
				// 	callerClient,
				// 	client,
				// 	callerGlobalThisProxied.document,
				// 	self.document,
				// 	callerClient === client
				// );
				const inherit =
					callerClient.url.href === "about:srcdoc" ||
					callerClient.url.href === "about:blank";
				ctx.args[0] = {
					$scramjet$messagetype: "window",
					$scramjet$origin: inherit
						? callerClient.global.parent[SCRAMJETCLIENT].url.origin
						: callerClient.url.origin,
					$scramjet$data: ctx.args[0],
				};
				// console.error("?", ctx.args);
				// eval("debugger");

				// * origin because obviously
				//
				// vssh fork: o `*` continua sendo necessário — a origem REAL da janela alvo
				// é a do proxy, então a checagem do navegador reprovaria qualquer origem
				// lógica que o site pedisse. O que faltava era não JOGAR FORA o pedido.
				//
				// ⚠ **A restrição do remetente é decisão de segurança dele**, e a mais
				// comum: `postMessage(token, "https://conhecido")` existe justamente para o
				// token NÃO ir a mais ninguém. Reescrevendo para `*` sem reimpor nada, o
				// token passava a ir para qualquer janela que o remetente endereçasse.
				//
				// Então o alvo pedido viaja no envelope e é conferido na RECEPÇÃO, onde o
				// cliente sabe a própria origem lógica — ver `_init` em `event.ts`.
				if (typeof alvoPedido === "string" && alvoPedido !== "*") {
					// `/` quer dizer "a mesma origem de quem manda", e é resolvido aqui, do
					// lado que a conhece.
					ctx.args[0].$scramjet$targetOrigin =
						alvoPedido === "/" ? ctx.args[0].$scramjet$origin : alvoPedido;
				}

				if (typeof ctx.args[1] === "string") ctx.args[1] = "*";
				if (typeof ctx.args[1] === "object") ctx.args[1].targetOrigin = "*";

				ctx.return(wrappedPostMessage.call(ctx.fn, ...ctx.args));
			},
		});

	// vssh fork: um `BroadcastChannel` só alcança a própria origem. Todo documento do motor mora
	// na origem do motor, e o canal de mesmo nome de dois sites seria um só: a mensagem de um
	// chegaria ao outro. O nome que vai ao navegador leva a origem do site na frente, e o `name`
	// que o site lê é o que ele deu.
	const origemDoCanal = () => (iswindow ? origemDe(self) : null) ?? client.url.origin;
	client.Proxy("BroadcastChannel", {
		construct(ctx) {
			const args = ctx.args as unknown[];
			if (args.length === 0) return;
			args[0] = `${origemDoCanal()}@${args[0] as string}`;
		},
	});
	client.Trap("BroadcastChannel.prototype.name", {
		get(ctx) {
			const nome = ctx.get() as string;
			const corte = nome.indexOf("@");

			return corte < 0 ? nome : nome.slice(corte + 1);
		},
	});

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				$scramjet$messagetype: "window",
				// TODO: need to actually look up the broadcastchannel itself in box i think
				$scramjet$origin: client.url.origin,
				$scramjet$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

			ctx.args[0] = {
				$scramjet$messagetype: "worker",
				$scramjet$data: ctx.args[0],
			};
		},
	});
	// vssh fork: o rewriter troca `x.postMessage` por `$wrappostmessage(x).postMessage`, e esta
	// função roda no realm de quem chama. O `postMessage` do alvo é o do realm dele, e com os
	// argumentos todos strings o envelope acima não tem objeto de quem chama para achar o realm:
	// cai no `{}` do próprio envelope e manda a origem do ALVO. O iframe do DataDome manda o cookie
	// aprovado assim, `parent.postMessage(JSON.stringify(...), "*")`; a página o recebia com a
	// origem dela mesma, o `c.js` recusava a origem, e o captcha aprovado voltava ao desafio.
	//
	// O objeto deste realm vai no alvo como o `POLLUTANT` durante a chamada, e sai em seguida: um
	// `postMessage` chamado depois sem passar por aqui não herda o realm de quem chamou antes.
	//
	// A função que a página recebe chama o `postMessage` lido na hora do acesso, e é a mesma a cada
	// leitura do mesmo `postMessage`. A página guarda o original e põe a própria função no lugar
	// (`const orig = w.postMessage; w.postMessage = function () { … orig.apply(this, arguments) }`):
	// uma função que procurasse `w.postMessage` na hora da chamada acharia a da página, que a chama
	// de volta, até a pilha estourar. O receptor é o da chamada, como no nativo: o objeto do acesso
	// em `w.postMessage(…)`, e o que a página passar em `.call` e `.apply`.
	const porOriginal = new WeakMap<AnyFunction, AnyFunction>();
	const alvoDoAcesso = new WeakMap<object, object>();
	const comRealm = (original: AnyFunction): AnyFunction => {
		const feita = porOriginal.get(original);
		if (feita) return feita;
		const nova = {
			postMessage(this: any, ...args: any[]) {
				const alvo = (this != null && alvoDoAcesso.get(this)) || this;
				let marcou = false;
				if (alvo !== null && (typeof alvo === "object" || typeof alvo === "function")) {
					try {
						Object_defineProperty(alvo, POLLUTANT, {
							value: {},
							writable: false,
							configurable: true,
							enumerable: false,
						});
						marcou = true;
					} catch {
						// um alvo que não aceita a propriedade fica com a origem que o envelope achar
					}
				}
				try {
					return Reflect_apply(original, alvo, args);
				} finally {
					if (marcou) {
						try {
							delete alvo[POLLUTANT];
						} catch {
							// idem
						}
					}
				}
			},
		}.postMessage;
		try {
			Object_defineProperty(nova, "length", { value: original.length, configurable: true });
		} catch {}
		client.box.unproxy.set(nova, client.box.unproxy.get(original) ?? original);
		porOriginal.set(original, nova);

		return nova;
	};
	Object_defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			if (ehVista(obj)) return obj;
			if (obj == null) return obj;
			// Uma leitura só: o `postMessage` pode ser um getter da página. Se ela lança, o acesso
			// da página lança igual, no objeto devolvido como veio.
			let original: unknown;
			try {
				original = obj.postMessage;
			} catch {
				return obj;
			}
			if (typeof original !== "function") return obj;
			const acesso = { postMessage: comRealm(original as AnyFunction) };
			alvoDoAcesso.set(acesso, obj);

			return acesso;
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}
