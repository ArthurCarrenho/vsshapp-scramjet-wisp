import { ScramjetClient } from "@client/index";
import { excecaoDoNavegador } from "@client/shared/excecao";
import { String, _URL } from "@/shared/snapshot";

/**
 * vssh fork: a Navigation API do Chrome, com os endereços do site.
 *
 * O objeto `navigation` e as classes dele são os nativos, e o navegador continua cuidando da
 * pilha do quadro. O que se traduz é o endereço: cada URL que a API devolve passa pela
 * desreescrita, e cada URL que a página entrega a `navigate` passa pela reescrita, como num
 * `location.assign`. Uma navegação para outro site não pode ser interceptada (`canIntercept` é
 * falso e `intercept` recusa, como no Chrome), mesmo que, pelo motor, as duas URLs estejam na
 * mesma origem.
 */
export default function (client: ScramjetClient, self: Self) {
	if (typeof (self as any).Navigation !== "function") return;

	const desreescrever = (url: unknown) =>
		url === null || url === undefined || url === ""
			? url
			: client.unrewriteUrl(String(url));

	client.Proxy("Navigation.prototype.navigate", {
		apply(ctx) {
			if (ctx.args.length > 0) ctx.args[0] = client.rewriteUrl(String(ctx.args[0]));
		},
	});

	for (const alvo of [
		"NavigationHistoryEntry.prototype.url",
		"NavigationDestination.prototype.url",
	]) {
		client.Trap(alvo, {
			get(ctx) {
				return desreescrever(ctx.get());
			},
		});
	}

	const mesmaOrigem = (evento: any) => {
		try {
			const destino = new _URL(String(evento.destination.url));

			return destino.origin === client.url.origin;
		} catch {
			return false;
		}
	};

	client.Trap("NavigateEvent.prototype.canIntercept", {
		get(ctx) {
			return Boolean(ctx.get()) && mesmaOrigem(ctx.this);
		},
	});
	client.Proxy("NavigateEvent.prototype.intercept", {
		apply(ctx) {
			if (mesmaOrigem(ctx.this)) return;
			const destino = String((ctx.this as any).destination.url);
			throw excecaoDoNavegador(
				client,
				`Failed to execute 'intercept' on 'NavigateEvent': A navigation with URL '${destino}' cannot be intercepted by in a window with origin '${client.url.origin}'.`,
				"SecurityError"
			);
		},
	});
}
