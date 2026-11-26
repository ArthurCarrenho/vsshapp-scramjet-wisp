import { ScramjetClient } from "@client/index";
import { excecaoDoNavegador } from "@client/shared/excecao";
import { Tap } from "@/Tap";
import { String, _URL } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	// vssh fork: o `navigate` diz se a mudança foi `pushState` ou `replaceState`. Quem acompanha a
	// URL (o UrlWatcherPlugin) decide por isso se a pilha do navegador ganha uma entrada ou troca a
	// corrente: um mapa que reescreve a URL a cada arrasto, por `replaceState`, não empilha nada.
	const vigiar = (nome: string, historico: "push" | "replace") => client.Proxy(
		`History.prototype.${nome}`,
		{
			apply(ctx) {
				const relevantclient = client.box.histories.get(ctx.this);
				// Um `this` que não é o `history` de um quadro do motor vai ao navegador como veio,
				// e a recusa é a dele.
				if (!relevantclient) return;
				// O terceiro argumento é opcional, e `null` e `undefined` deixam o endereço como está.
				const url = ctx.args[2] == null ? undefined : String(ctx.args[2]);

				// O endereço novo se resolve contra o do documento e tem de ser da origem dele. O
				// Chrome recusa o resto com um SecurityError, e a página que pede `replaceState`
				// para outro site confere que a recusa veio.
				if (url !== undefined) {
					const atual = relevantclient.url;
					let destino: URL | null = null;
					try {
						destino = new _URL(url, relevantclient.meta.base);
					} catch {}
					if (destino && destino.origin !== atual.origin)
						throw excecaoDoNavegador(
							client,
							`Failed to execute '${nome}' on 'History': A history state object with URL '${destino.href}' cannot be created in a document with origin '${atual.origin}' and URL '${atual.href}'.`,
							"SecurityError"
						);
				}

				if (url !== undefined) ctx.args[2] = relevantclient.rewriteUrl(url);
				ctx.call();
				Tap.dispatch(
					relevantclient.hooks.lifecycle.navigate,
					{
						type: "history",
						historico,
					},
					{
						url: relevantclient.url.href,
					}
				);
			},
		}
	);
	vigiar("pushState", "push");
	vigiar("replaceState", "replace");
}
