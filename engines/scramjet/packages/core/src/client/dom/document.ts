import { IncrementalHtmlRewriter, rewriteHtml } from "@rewriters/html";
import { ScramjetClient } from "@client/index";
import { String, _URL } from "@/shared/snapshot";
import { createReferrerString } from "@/fetch/util";
import { comoOriginal, ehConfiavel, embrulhar } from "@/shared/confiavel";

export default function (client: ScramjetClient, _self: Self) {
	function resetDocumentWriter(document: Document) {
		client.box.writeRewriters.delete(document);
	}

	function getDocumentWriter(document: Document) {
		let writer = client.box.writeRewriters.get(document);
		if (!writer) {
			writer = new IncrementalHtmlRewriter(client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "Document.prototype.write",
			});
			client.box.writeRewriters.set(document, writer);
		}

		return writer;
	}

	client.Proxy("Document.prototype.open", {
		apply(ctx) {
			resetDocumentWriter(ctx.this);
		},
	});

	// vssh fork: o HTML reescrito vai ao navegador com o tipo que o do site teria. Num documento
	// que exige Trusted Types, o `write` aceita TrustedHTML, ou uma string que a política padrão do
	// site aprova; o navegador junta os argumentos e consulta a política uma vez, com o sink
	// "Document write" ou "Document writeln".
	function escrever(ctx: any, sink: string, fim: string) {
		const writer = getDocumentWriter(ctx.this);
		const args: unknown[] = ctx.args;
		const original =
			args.length > 0 && args.every((a) => ehConfiavel(client, a, "TrustedHTML"))
				? args[0]
				: args.map((a) => String(a)).join("") + fim;
		const reescrito = writer.write(args.map((a) => String(a)).join("") + fim);
		ctx.return(
			client.natives.call(
				"Document.prototype.write",
				ctx.this,
				comoOriginal(client, "TrustedHTML", original, reescrito, sink)
			)
		);
	}

	client.Proxy("Document.prototype.write", {
		apply(ctx) {
			escrever(ctx, "Document write", "");
		},
	});

	client.Proxy("Document.prototype.writeln", {
		apply(ctx) {
			escrever(ctx, "Document writeln", "\n");
		},
	});

	client.Proxy("Document.prototype.close", {
		apply(ctx) {
			const writer = client.box.writeRewriters.get(ctx.this);
			if (!writer) {
				return;
			}

			try {
				const remaining = writer.end();
				if (remaining) {
					client.natives.call(
						"Document.prototype.write",
						ctx.this,
						embrulhar(client, "TrustedHTML", remaining)
					);
				}
			} finally {
				resetDocumentWriter(ctx.this);
			}
		},
	});

	client.Proxy("Document.prototype.parseHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "Document.prototype.parseHTMLUnsafe",
			});
		},
	});

	client.Trap("Document.prototype.domain", {
		get() {
			return client.url.hostname;
		},
		set() {
			return false;
		},
	});

	client.Trap("Document.prototype.documentURI", {
		get() {
			return client.url.href;
		},
		set() {
			return false;
		},
	});

	client.Trap("Document.prototype.URL", {
		get() {
			return client.url.href;
		},
		set() {
			return false;
		},
	});

	client.Trap("Document.prototype.referrer", {
		get() {
			if (!client.history) return "";
			if (client.history.length < 2) return "";
			const lastState = client.history[client.history.length - 2];
			const referrerURL = new _URL(lastState.url);
			return createReferrerString(
				referrerURL,
				client.url,
				lastState.refererPolicy
			);
		},
	});

	client.Proxy(
		["Document.prototype.querySelector", "Document.prototype.querySelectorAll"],
		{
			apply(ctx) {
				ctx.args[0] = String(ctx.args[0]).replace(
					/((?:^|\s)\b\w+\[(?:src|href|data-href))[\^]?(=['"]?(?:https?[:])?\/\/)/,
					"$1*$2"
				);
			},
		}
	);
}
