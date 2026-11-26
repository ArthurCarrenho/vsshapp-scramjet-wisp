import { ScramjetClient } from "@client/index";
import { semMarcaDeRede, unrewriteLinkHeader } from "./xmlhttprequest";
import { String } from "@/shared/snapshot";
import { unrewriteBlob } from "@rewriters/url";
import { enderecoDeConexao } from "@client/csp";
import { MARCA_DE_REDE } from "@/shared/rede";

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

/**
 * Um `blob:` segue o mesmo caminho: o pedido vai ao navegador com o endereço do blob na origem do
 * motor, onde ele mora. O `connect-src` do site sem `blob:` o recusa como no Chrome, e com
 * `blob:` ou sem CSP o navegador o lê da memória. Devolve `null` para o que não é `blob:`.
 */
export function blobNativo(client: ScramjetClient, url: unknown): string | null {
	const texto = String(url).trim();
	if (!/^blob:/i.test(texto)) return null;
	try {
		return unrewriteBlob(texto, client.context, client.meta);
	} catch {
		return null;
	}
}

// Um `blob:` que não existe: o navegador recusa o pedido como recusaria o revogado.
function blobRevogado(blob: string): string {
	try {
		return "blob:" + new URL(blob.slice(5)).origin + "/00000000-0000-4000-8000-000000000000";
	} catch {
		return blob;
	}
}

export default function (client: ScramjetClient) {
	client.Proxy("fetch", {
		apply(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			if (ehUrlDeDados(ctx.args[0])) return;
			const blob = blobNativo(client, ctx.args[0]);
			if (blob) {
				ctx.args[0] = client.box.blobsRevogados.has(blob) ? blobRevogado(blob) : blob;

				return;
			}
			const url = String(ctx.args[0]);
			ctx.args[0] = enderecoDeConexao(client, url, () =>
				client.rewriteUrl(
					url,
					rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
				)
			);
		},
	});

	client.Proxy("Request", {
		construct(ctx) {
			if (client.box.instanceof(ctx.args[0], "Request")) return;
			if (ehUrlDeDados(ctx.args[0])) return;
			const blob = blobNativo(client, ctx.args[0]);
			if (blob) {
				ctx.args[0] = client.box.blobsRevogados.has(blob) ? blobRevogado(blob) : blob;

				return;
			}
			const url = String(ctx.args[0]);
			ctx.args[0] = enderecoDeConexao(client, url, () =>
				client.rewriteUrl(
					url,
					rewriteUrlOptionsForFetch(ctx.args[1] as RequestInit | undefined)
				)
			);
		},
	});

	client.Trap(["Request.prototype.url", "Response.prototype.url"], {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});

	// vssh fork: os cabeçalhos de uma resposta são o mesmo objeto a cada leitura, e o nativo quando
	// não há o que desfazer: no Chrome `r.headers === r.headers`, e o objeto recusa `append`. Uma
	// cópia sai só quando o `Link` leva endereços do motor ou o `Server-Timing` leva a marca da rede
	// (ver `marcarRede` em `fetch/fetch.ts`).
	const copias = new WeakMap<object, Headers>();
	client.Trap("Response.prototype.headers", {
		get(ctx) {
			const headers = ctx.get() as Headers;
			const guardada = copias.get(ctx.this as object);
			if (guardada) return guardada;
			const link = headers.get("link");
			const tempo = headers.get("server-timing");
			const comLink = !!link && link.includes(client.context.prefix.href);
			const comMarca = !!tempo && tempo.includes(MARCA_DE_REDE);
			if (!comLink && !comMarca) return headers;

			const newHeaders = new Headers();
			for (const [key, value] of headers.entries()) {
				if (key === "link") {
					newHeaders.append(key, unrewriteLinkHeader(value, client.context));
				} else if (key === "server-timing") {
					const limpo = semMarcaDeRede(value);
					if (limpo) newHeaders.append(key, limpo);
				} else {
					newHeaders.append(key, value);
				}
			}
			copias.set(ctx.this as object, newHeaders);

			return newHeaders;
		},
	});
}
