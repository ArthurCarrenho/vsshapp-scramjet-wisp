import { rewriteJs } from "@rewriters/js";
import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";
import { comoOriginal } from "@/shared/confiavel";

export default function (client: ScramjetClient, self: Self) {
	for (const [nome, sink] of [
		["setTimeout", "Window setTimeout"],
		["setInterval", "Window setInterval"],
	]) {
		client.Proxy(nome, {
			apply(ctx) {
				if (typeof ctx.args[0] !== "function") {
					ctx.args[0] = comoOriginal(
						client,
						"TrustedScript",
						ctx.args[0],
						(texto) =>
							rewriteJs(
								texto,
								"(setTimeout string eval)",
								client.context,
								client.meta,
							),
						sink,
					);
				}
			},
		});
	}
}
