import { rewriteJs } from "@rewriters/js";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty, String } from "@/shared/snapshot";
import { comoOriginal } from "@/shared/confiavel";
import { registrarCompilacao } from "@client/pilha";

export default function (client: ScramjetClient, self: Self) {
	// used for proxying *direct eval*
	// eval("...") -> eval($scramjet$rewrite("..."))
	Object_defineProperty(self, client.config.globals.rewritefn, {
		value: function (js: any) {
			// if eval is called on anything other than a string, we should just return it unchanged
			// the one exception is TrustedScript, which can just be stringified and rewritten
			const original = js;
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			return comoOriginal(
				client,
				"TrustedScript",
				original,
				(texto) =>
					rewriteJs(texto, "(direct eval proxy)", client.context, client.meta),
				"eval",
			);
		},
		writable: false,
		configurable: false,
	});
}

export function createIndirectEval(client: ScramjetClient) {
	const indirection = client.global.eval;
	const proxy = new Proxy(client.global.eval, {
		apply(_target, _thisArg, args) {
			let js = args[0];
			const original = js;
			// > If the argument of eval() is not a string, eval() returns the argument unchanged
			// the one exception is TrustedScript, which can just be stringified and rewritten
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			const codigo = comoOriginal(
				client,
				"TrustedScript",
				original,
				(texto) =>
					rewriteJs(
						texto,
						"(indirect eval proxy)",
						client.context,
						client.meta,
					) as string,
				"eval",
			);
			registrarCompilacao(client, () => String(codigo));

			return indirection(codigo);
		},
	});
	client.box.unproxy.set(proxy, client.global.eval);

	return proxy;
}
