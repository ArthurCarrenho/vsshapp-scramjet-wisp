import { ScramjetClient } from "@client/index";
import { LISTAS_DE_ORIGENS } from "@client/location";

/**
 * vssh fork: os métodos do `DOMStringList` respondem pela lista traduzida quando o objeto é o do
 * `location.ancestorOrigins` do motor (ver `origensAncestrais` em `client/location.ts`). Para
 * qualquer outro `DOMStringList` eles passam ao nativo.
 */
export default function (client: ScramjetClient, self: Self) {
	if (typeof (self as any).DOMStringList !== "function") return;

	client.Trap("DOMStringList.prototype.length", {
		get(ctx) {
			const origens = LISTAS_DE_ORIGENS.get(ctx.this as object);
			return origens ? origens.length : ctx.get();
		},
	});
	client.Proxy("DOMStringList.prototype.item", {
		apply(ctx) {
			const origens = LISTAS_DE_ORIGENS.get(ctx.this as object);
			if (!origens) return;
			const i = Number(ctx.args[0]) >>> 0;
			ctx.return(i < origens.length ? origens[i] : null);
		},
	});
	client.Proxy("DOMStringList.prototype.contains", {
		apply(ctx) {
			const origens = LISTAS_DE_ORIGENS.get(ctx.this as object);
			if (!origens) return;
			ctx.return(origens.includes(String(ctx.args[0])));
		},
	});
}
