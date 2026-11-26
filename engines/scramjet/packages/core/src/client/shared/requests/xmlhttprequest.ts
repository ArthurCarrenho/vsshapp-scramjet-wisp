import { memoriaCompartilhada } from "@client/shared/isolamento";
import { getFlag, ScramjetContext } from "@/shared";
import { rewriteUrl, unrewriteUrl, URLMeta } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { blobNativo, ehUrlDeDados } from "./fetch";
import { enderecoDeConexao } from "@client/csp";
import { MARCA_DE_REDE } from "@/shared/rede";

export default function (client: ScramjetClient, self: Self) {
	let worker;
	// if (self.Worker && flagEnabled("syncxhr", client.url)) {
	// 	worker = client.natives.construct("Worker", config.files.sync);
	// }
	// vssh fork: o que o motor guarda de um pedido fica fora dele. Uma chave no próprio objeto
	// apareceria em `Object.getOwnPropertySymbols(xhr)`, que num Chrome é vazio.
	const argsDe = new WeakMap<object, any[]>();
	const cabecalhosDe = new WeakMap<object, Record<string, string>>();

	client.Proxy("XMLHttpRequest.prototype.open", {
		apply(ctx) {
			if (ctx.args[1] && !ehUrlDeDados(ctx.args[1]))
				ctx.args[1] =
					blobNativo(client, ctx.args[1]) ??
					enderecoDeConexao(client, String(ctx.args[1]), () => client.rewriteUrl(ctx.args[1]));
			if (ctx.args[2] === undefined) ctx.args[2] = true;
			argsDe.set(ctx.this, ctx.args);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.setRequestHeader", {
		apply(ctx) {
			let headers = cabecalhosDe.get(ctx.this);
			if (!headers) cabecalhosDe.set(ctx.this, (headers = {}));
			headers[ctx.args[0]] = ctx.args[1];
		},
	});

	client.Proxy("XMLHttpRequest.prototype.send", {
		apply(ctx) {
			const args = argsDe.get(ctx.this);
			if (!args || args[2]) return;
			// Um `data:` síncrono não sai para a rede: o navegador responde, ou o `connect-src` recusa.
			if (ehUrlDeDados(args[1])) return;

			if (!client.getFlag("syncxhr")) {
				console.warn("ignoring request - sync xhr disabled in flags");

				return ctx.return(undefined);
			}

			// it's a sync request
			// sync xhr to service worker is not supported
			// there's a nice way of polyfilling this though, we can spin on an atomic using sharedarraybuffer. this will maintain the sync behavior

			//@ts-ignore
			const sab = new (memoriaCompartilhada(client.global) as any)(1024, { maxByteLength: 2147483647 });
			const view = new DataView(sab);

			client.natives.call("Worker.prototype.postMessage", worker, {
				sab,
				args,
				headers: cabecalhosDe.get(ctx.this),
				body: ctx.args[0],
			});

			const now = performance.now();
			while (view.getUint8(0) === 0) {
				if (performance.now() - now > 1000) {
					throw new Error("xhr timeout");
				}
				/* spin */
			}

			const status = view.getUint16(1);
			const headersLength = view.getUint32(3);

			const headersab = new Uint8Array(headersLength);
			headersab.set(new Uint8Array(sab.slice(7, 7 + headersLength)));
			const headers = new TextDecoder().decode(headersab);

			const bodyLength = view.getUint32(7 + headersLength);
			const bodyab = new Uint8Array(bodyLength);
			bodyab.set(
				new Uint8Array(
					sab.slice(11 + headersLength, 11 + headersLength + bodyLength)
				)
			);
			const body = new TextDecoder().decode(bodyab);

			// these should be using proxies to not leak scram strings but who cares
			client.RawTrap(ctx.this, "status", {
				get() {
					return status;
				},
			});
			client.RawTrap(ctx.this, "responseText", {
				get() {
					return body;
				},
			});
			client.RawTrap(ctx.this, "response", {
				get() {
					if (ctx.this.responseType === "arraybuffer") return bodyab.buffer;

					return body;
				},
			});
			client.RawTrap(ctx.this, "responseXML", {
				get() {
					const parser = new DOMParser();

					return parser.parseFromString(body, "text/xml");
				},
			});
			client.RawTrap(ctx.this, "getAllResponseHeaders", {
				get() {
					return () => headers;
				},
			});
			client.RawTrap(ctx.this, "getResponseHeader", {
				get() {
					return (header: string) => {
						const re = new RegExp(`^${header}: (.*)$`, "m");
						const match = re.exec(headers);

						return match ? match[1] : null;
					};
				},
			});

			ctx.return(undefined);
		},
	});

	client.Trap("XMLHttpRequest.prototype.responseURL", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get() as string);
		},
	});

	client.Proxy("XMLHttpRequest.prototype.getAllResponseHeaders", {
		apply(ctx) {
			const headerstring = ctx.fn.call(ctx.this) as string;
			if (!headerstring) return headerstring;
			const headers = headerstring.split("\r\n");

			for (const [i, header] of headers.entries()) {
				const nome = header.slice(0, header.indexOf(":")).toLowerCase();
				if (nome === "link") {
					headers[i] = `${header.slice(0, 5)} ${unrewriteLinkHeader(
						header.slice(5).trim(),
						client.context
					)}`;
				} else if (nome === "server-timing" && header.includes(MARCA_DE_REDE)) {
					const limpo = semMarcaDeRede(header.slice(nome.length + 1));
					headers[i] = limpo ? `${header.slice(0, nome.length + 1)} ${limpo}` : "";
				}
			}

			ctx.return(headers.filter((h, i) => h || i === headers.length - 1).join("\r\n"));
		},
	});
	client.Proxy("XMLHttpRequest.prototype.getResponseHeader", {
		apply(ctx) {
			const header = ctx.fn.call(ctx.this, ctx.args[0]) as string | null;
			if (!header) return header;
			// same as setAttribute: the header name is stringified by the platform, so it may
			// arrive as a non-string and .toLowerCase() would throw
			const nome = String(ctx.args[0]).toLowerCase();
			if (nome === "link") {
				ctx.return(unrewriteLinkHeader(header, client.context));
			} else if (nome === "server-timing" && header.includes(MARCA_DE_REDE)) {
				ctx.return(semMarcaDeRede(header) || null);
			}
		},
	});
}

/** O `Server-Timing` sem a entrada que o motor acrescenta (ver `marcarRede` em `fetch/fetch.ts`). */
export function semMarcaDeRede(valor: string): string {
	return valor
		.split(",")
		.filter((parte) => parte.trim().split(";")[0].trim() !== MARCA_DE_REDE)
		.join(",")
		.trim();
}

export function unrewriteLinkHeader(header: string, context: ScramjetContext) {
	return header.replace(
		/<([^>]+)>/gi,
		(_match, p1) => `<${unrewriteUrl(p1, context)}>`
	);
}
