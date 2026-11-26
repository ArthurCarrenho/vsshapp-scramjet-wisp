import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";
import { comoOriginal } from "@/shared/confiavel";

export default function (client: ScramjetClient) {
	client.Proxy("importScripts", {
		apply(ctx) {
			for (const i in ctx.args) {
				const original = ctx.args[i];
				const url = String(original);
				// vssh fork: um TrustedScriptURL do site volta embrulhado pela política do motor.
				ctx.args[i] = comoOriginal(
					client,
					"TrustedScriptURL",
					original,
					client.rewriteUrl(url)
				);
			}
		},
	});
}
