import { ScramjetClient } from "@client/index";
import { unrewriteLinkHeader } from "./xmlhttprequest";
import { String } from "@/shared/snapshot";

/**
 * Capture the page's intended `init.mode` / `init.credentials` and forward
 * them to `rewriteUrl` so they get stamped onto the proxy URL as `sj$mode` /
 * `sj$cred`. The service-side handler reads those back when computing
 * Sec-Fetch-Mode / Sec-Fetch-Storage-Access, since `event.request.mode` and
 * `event.request.credentials` from the SW are derived against the rewritten
 * same-origin URL and don't reflect the page's actual intent.
 */
function rewriteUrlOptionsForFetch(init: RequestInit | undefined) {
	return {
		// `fetch()` and `new Request()` both default mode to "cors" per spec.
		mode: init?.mode ?? "cors",
		credentials: init?.credentials === "include" ? "include" : undefined,
	};
}

/**
 * vssh fork: um `data:` pedido por `fetch`, XHR ou `EventSource` vai ao navegador como está. Ele
 * não sai para a rede, então não há o que proxiar, e só assim o `connect-src` que o motor entrega
 * (ver `politicaDeConexao` em `fetch/headers.ts`) recusa o pedido como o Chrome recusaria. Pela
 * URL reescrita ele seria um pedido à origem do motor, que o `'self'` deixa passar.
 */
export function ehUrlDeDados(url: unknown): boolean {
	return /^\s*data:/i.test(String(url));
}

export default function (client: ScramjetClient) {
	client.Proxy("fetch", {
		apply(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			if (ehUrlDeDados(ctx.args[0])) return;
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(
				url,
				rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
			);
		},
	});

	client.Proxy("Request", {
		construct(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			if (ehUrlDeDados(ctx.args[0])) return;
			const url = String(ctx.args[0]);
			ctx.args[0] = client.rewriteUrl(
				url,
				rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
			);
		},
	});

	client.Trap(["Request.prototype.url", "Response.prototype.url"], {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});

	// TODO: this needs to be only for response objects created from a fetch
	client.Trap("Response.prototype.headers", {
		get(ctx) {
			const headers = ctx.get() as Headers;
			const newHeaders = new Headers();

			for (const [key, value] of headers.entries()) {
				if (key.toLowerCase() === "link") {
					newHeaders.append(key, unrewriteLinkHeader(value, client.context));
				} else {
					newHeaders.append(key, value);
				}
			}

			return newHeaders;
		},
	});
}
