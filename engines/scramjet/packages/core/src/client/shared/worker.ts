import { ScramjetClient } from "@client/index";
import { comoOriginal } from "@/shared/confiavel";
import { cspRecusa, enderecoRecusado } from "@client/csp";

// vssh fork: a URL reescrita de um worker vai ao navegador com o tipo que a do site teria. Num
// documento que exige Trusted Types, uma string aqui iria à política padrão do site, que não
// conhece a URL do motor; a do Turnstile a troca pelo endereço do próprio quadro, e o worker
// subia com o HTML da página no lugar do código.

export default function (client: ScramjetClient, _self: GlobalThis) {
	// O Chrome confere a origem do endereço antes da política: um worker de outra origem lança o
	// SecurityError na hora. Um da mesma origem que o `worker-src` do site recusa vai ao navegador
	// num endereço que a política do motor recusa (ver `enderecoRecusado`), e falha como no Chrome,
	// pelo evento `error`, com o `securitypolicyviolation` no endereço do site.
	const recusado = (texto: string): string | null => {
		const t = texto.trim();
		let url: URL;
		try {
			url = new URL(t, client.url.href);
		} catch {
			return null;
		}
		const deOrigem =
			url.protocol === "blob:"
				? (() => {
						try {
							return new URL(url.pathname).origin;
						} catch {
							return "null";
						}
					})()
				: url.origin;
		const minha = client.meta.origin.origin;
		if (url.protocol !== "data:" && deOrigem !== minha)
			throw new client.global.DOMException(
				`Failed to construct 'Worker': Script at '${url.href}' cannot be accessed from origin '${minha}'.`,
				"SecurityError",
			);
		if (!cspRecusa(client, "worker-src", t)) return null;

		return enderecoRecusado(client, url.href);
	};

	client.Proxy("Worker", {
		construct(ctx) {
			ctx.args[0] = comoOriginal(
				client,
				"TrustedScriptURL",
				ctx.args[0],
				(texto) =>
					recusado(texto) ??
					client.rewriteUrl(texto, {
						destination: "worker",
						isModule: ctx.args[1]?.type === "module",
					}),
				"Worker constructor",
			);

			const worker = ctx.call();
			// const conn = new BareMuxConnection();

			// (async () => {
			// 	const port = await conn.getInnerPort();
			// 	client.natives.call(
			// 		"Worker.prototype.postMessage",
			// 		worker,
			// 		{
			// 			$scramjet$type: "baremuxinit",
			// 			port,
			// 		},
			// 		[port]
			// 	);
			// })();
		},
	});

	// sharedworkers can only be constructed from window
	client.Proxy("SharedWorker", {
		construct(ctx) {
			const isModule =
				typeof ctx.args[1] === "object" && ctx.args[1]?.type === "module";

			ctx.args[0] = comoOriginal(
				client,
				"TrustedScriptURL",
				ctx.args[0],
				(texto) =>
					client.rewriteUrl(texto, {
						destination: "sharedworker",
						isModule,
					}),
				"SharedWorker constructor",
			);

			if (ctx.args[1] && typeof ctx.args[1] === "string")
				ctx.args[1] = `${client.url.origin}@${ctx.args[1]}`;

			if (ctx.args[1] && typeof ctx.args[1] === "object") {
				if (ctx.args[1].name) {
					ctx.args[1].name = `${client.url.origin}@${ctx.args[1].name}`;
				}
			}

			const worker = ctx.call();
			// const conn = new BareMuxConnection();

			// (async () => {
			// 	const port = await conn.getInnerPort();
			// 	client.natives.call(
			// 		"MessagePort.prototype.postMessage",
			// 		worker.port,
			// 		{
			// 			$scramjet$type: "baremuxinit",
			// 			port,
			// 		},
			// 		[port]
			// 	);
			// })();
		},
	});

	client.Proxy("Worklet.prototype.addModule", {
		apply(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
}
