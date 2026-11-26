import { IncrementalHtmlRewriter, rewriteHtml } from "@rewriters/html";
import { ScramjetClient } from "@client/index";
import { excecaoDoNavegador } from "@client/shared/excecao";
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
		const todosConfiaveis =
			args.length > 0 &&
			args.every((a) => ehConfiavel(client, a, "TrustedHTML"));
		const juntos = args.map((a) => String(a)).join("") + fim;
		// Com TrustedHTML o texto é a junção deles, e a política padrão não é consultada. Uma string
		// vai à política uma vez, e o texto é o que ela devolver.
		const original = todosConfiaveis ? args[0] : juntos;
		ctx.return(
			client.natives.call(
				"Document.prototype.write",
				ctx.this,
				comoOriginal(
					client,
					"TrustedHTML",
					original,
					(texto) => writer.write(todosConfiaveis ? juntos : texto),
					sink,
				),
			),
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
						embrulhar(client, "TrustedHTML", remaining),
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

	// vssh fork: o setter faz as conferências do Chrome na ordem dele. Um documento em sandbox
	// recusa qualquer valor, e quem sabe disso é o setter nativo: num agrupamento por origem, que
	// é o padrão, atribuir ao documento o domínio que ele já tem não muda nada, e só lança em
	// sandbox. Depois vem o sufixo, conferido contra o host do site. Passadas as duas, a
	// atribuição é ignorada, como num agrupamento por origem.
	client.Trap("Document.prototype.domain", {
		get() {
			return client.url.hostname;
		},
		set(ctx, valor) {
			if ((client.global as any).originAgentCluster === true) ctx.set(ctx.get());
			const host = client.url.hostname;
			const pedido = String(valor).toLowerCase();
			if (pedido !== host && !(pedido.includes(".") && host.endsWith(`.${pedido}`))) {
				throw excecaoDoNavegador(
					client,
					`Failed to set the 'domain' property on 'Document': '${String(valor)}' is not a suffix of '${host}'.`,
					"SecurityError"
				);
			}
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
				lastState.refererPolicy,
			);
		},
	});

}
