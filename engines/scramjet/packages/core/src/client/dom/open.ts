import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Proxy("window.open", {
		apply(ctx) {
			// undefined opens an about:blank window, pass through
			if (typeof ctx.args[0] !== "undefined") {
				const url = String(ctx.args[0]);
				// blank also opens an about:blank window
				if (url !== "") {
					// note that null or anything else will *not* open an about:blank window
					ctx.args[0] = client.rewriteUrl(url);
				}
			}

			if (typeof ctx.args[1] !== "undefined" && ctx.args[1] !== null) {
				let target = String(ctx.args[1]);

				if (target === "_top" || target === "_unfencedTop") {
					target = client.meta.topFrameName;
				}
				if (target === "_parent") {
					target = client.meta.parentFrameName;
				}

				ctx.args[1] = target;
			}

			const realwin = ctx.call();

			if (!realwin) return ctx.return(realwin);

			if (!(SCRAMJETCLIENT in realwin)) {
				// i don't believe it's possible for a just-opened window to already have scramjet loaded but just in case
				client.init.hookSubcontext(realwin);
			}

			return realwin;
		},
	});

	client.Trap("window.frameElement", {
		get(ctx) {
			const f = ctx.get() as HTMLIFrameElement | null;
			if (!f) return f;

			const win = f.ownerDocument.defaultView;
			const pai = win[SCRAMJETCLIENT] as ScramjetClient | undefined;
			if (!pai) {
				// no, the top frame is outside the sandbox
				return null;
			}
			// vssh fork: o navegador só entrega o elemento do quadro a um documento da mesma origem
			// do pai. Pelo motor os dois moram na origem do proxy, e o quadro do Turnstile, de
			// challenges.cloudflare.com dentro de um site, enxergava o <iframe> do pai.
			try {
				// Um about:blank herda a origem de quem o criou.
				if (client.url.protocol !== "about:" && pai.url.origin !== client.url.origin)
					return null;
			} catch {
				return null;
			}

			return f;
		},
	});
}
