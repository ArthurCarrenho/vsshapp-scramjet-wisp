import { rewriteBlob, unrewriteBlob } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	// hide the origin from object urls from the page
	client.Proxy("URL.createObjectURL", {
		apply(ctx) {
			const url = ctx.call();
			if (url.startsWith("blob:")) {
				ctx.return(rewriteBlob(url, client.context, client.meta));
			} else {
				ctx.return(url);
			}
		},
	});

	client.Proxy("URL.revokeObjectURL", {
		apply(ctx) {
			// vssh fork: sem argumento, o nativo lança TypeError na hora, e a chamada vai para
			// ele como veio. Com um argumento que não é URL de blob, o nativo não faz nada e não
			// lança; o `unrewriteBlob` faria `new URL()` sobre ele, e o erro sairia do
			// `setTimeout`, um segundo depois, como erro não tratado da página. O iframe do
			// Turnstile revoga uma string vazia, e um erro não tratado ali reprova o desafio.
			if (ctx.args.length === 0) return;
			const recebido = String(ctx.args[0]);
			if (!recebido.startsWith("blob:")) {
				ctx.return(undefined);
				return;
			}
			setTimeout(() => {
				// scramjet rewrites blob urls to pass through the service worker first
				// this is neccesary if rewrites need to be applied to the blob
				// the issue is that if you call revokeObjectURL immediately after using the blob
				// the service worker will not have had time to download the blob
				// for some reason this is not an issue natively
				// simple delay is enough
				// TODO: find a way to make this not necessary
				// Um `blob:` que não se interpreta vai cru, e o nativo o ignora.
				try {
					ctx.args[0] = unrewriteBlob(recebido, client.context, client.meta);
				} catch {
					ctx.args[0] = recebido;
				}
				ctx.call();
			}, 1000);
			ctx.return(undefined);
		},
	});
}
