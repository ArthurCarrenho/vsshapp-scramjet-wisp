import { ScramjetClient } from "@client/index";
import { Array_isArray, String } from "@/shared/snapshot";

// O Cache Storage da origem do motor guarda os caches de todos os sites. O nome de cada cache leva
// a origem do site na frente, e o pedido de cada entrada é o endereço reescrito, o mesmo que o
// service worker atende.
export default function (client: ScramjetClient, _self: Self) {
	const prefixo = () => `${client.url.origin}@`;
	const comPrefixo = (ctx: { args: any[] }) => {
		if (ctx.args.length) ctx.args[0] = prefixo() + ctx.args[0];
	};
	// Um `Request` já nasce com o endereço reescrito (ver `requests/fetch.ts`). Um texto ou um
	// `URL` se resolve contra o endereço do site: sem isto, `cache.add("/app.js")` pedia o
	// arquivo à origem do motor, e a entrada ficava num endereço que nenhum pedido do site casa.
	const pedido = (valor: any) =>
		valor == null || client.box.instanceof(valor, "Request")
			? valor
			: client.rewriteUrl(String(valor));

	for (const metodo of ["open", "has", "delete"])
		client.Proxy(`CacheStorage.prototype.${metodo}`, { apply: comPrefixo });

	client.Proxy("CacheStorage.prototype.keys", {
		apply(ctx) {
			const nomes = ctx.call() as Promise<string[]>;
			const p = prefixo();
			// A página vê os caches dela, com o nome que ela deu.
			ctx.return(
				nomes.then((lista) =>
					lista.filter((n) => n.startsWith(p)).map((n) => n.substring(p.length))
				)
			);
		},
	});

	client.Proxy("CacheStorage.prototype.match", {
		apply(ctx) {
			if (!ctx.args.length) return;
			ctx.args[0] = pedido(ctx.args[0]);
			const opcoes = ctx.args[1];
			if (opcoes && typeof opcoes === "object" && opcoes.cacheName != null)
				ctx.args[1] = { ...opcoes, cacheName: prefixo() + opcoes.cacheName };
		},
	});

	for (const metodo of ["match", "matchAll", "add", "put", "delete", "keys"])
		client.Proxy(`Cache.prototype.${metodo}`, {
			apply(ctx: { args: any[] }) {
				if (ctx.args.length) ctx.args[0] = pedido(ctx.args[0]);
			},
		});

	client.Proxy("Cache.prototype.addAll", {
		apply(ctx) {
			if (Array_isArray(ctx.args[0])) ctx.args[0] = ctx.args[0].map(pedido);
		},
	});
}
