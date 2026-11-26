import type { ScramjetClient } from "@client/index";
import { unrewriteUrl } from "@rewriters/url";
import { _URL } from "@/shared/snapshot";

// vssh fork: as listas de `featurePolicy` com as origens do site.
//
// O navegador escreve a origem do motor em toda lista que concede um recurso a `'self'` ou a
// `'src'`. A lista do documento troca essa origem pela da página, e a de um iframe pela do
// endereço que o site deu a ele. O `allowsFeature(recurso, origem)` recebe a origem do site e
// pergunta ao navegador pela do motor quando as duas são a mesma.

export default function (client: ScramjetClient, self: typeof window) {
	if (!(self as any).FeaturePolicy) return;
	const doMotor = client.context.prefix.origin;
	const origemDe = new WeakMap<object, string>();

	const origemDaPolitica = (politica: object): string => {
		const conhecida = origemDe.get(politica);
		if (conhecida) return conhecida;

		return client.url.origin;
	};

	client.Trap("HTMLIFrameElement.prototype.featurePolicy", {
		get(ctx) {
			const politica = ctx.get() as object;
			if (!politica) return politica;
			try {
				const src = client.natives.call(
					"Element.prototype.getAttribute",
					ctx.this,
					"src",
				);
				const url = src
					? new _URL(unrewriteUrl(src, client.context), client.url.href)
					: null;
				origemDe.set(
					politica,
					url && /^(https?|wss?|ftp):$/.test(url.protocol)
						? url.origin
						: client.url.origin,
				);
			} catch {}

			return politica;
		},
	});

	client.Proxy("FeaturePolicy.prototype.getAllowlistForFeature", {
		apply(ctx) {
			const lista = ctx.call() as string[];
			const origem = origemDaPolitica(ctx.this as object);
			ctx.return(lista.map((o) => (o === doMotor ? origem : o)));
		},
	});

	client.Proxy("FeaturePolicy.prototype.allowsFeature", {
		apply(ctx) {
			if (ctx.args.length < 2) return;
			try {
				const pedida = new _URL(String(ctx.args[1])).origin;
				if (pedida === origemDaPolitica(ctx.this as object)) ctx.args[1] = doMotor;
				else if (pedida === doMotor) ctx.return(false);
			} catch {}
		},
	});
}
