import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { String, _URL } from "@/shared/snapshot";
import { quadrosCrus } from "@client/pilha";

// vssh fork: o endereço relativo de um `window.open` se resolve pela página de entrada, a que
// começou o script em execução (o "entry settings object" do HTML), e não pela janela dona do
// método. `parent.window.open("x.html")` num quadro abre o `x.html` ao lado do quadro. A página de
// entrada é a do ouvinte de evento em execução, quando há um; fora dele, a do quadro mais antigo da
// pilha, achada pelo documento ou pelo `<script src>` que o carregou. Sem nenhuma das duas, vale a
// dona do método.
function clienteDoArquivo(client: ScramjetClient, arquivo: string): ScramjetClient | null {
	let endereco: string;
	try {
		endereco = client.unrewriteUrl(arquivo);
	} catch {
		return null;
	}
	const janelas = client.box.clients.filter((c) => {
		try {
			return !!(c.global as any).document;
		} catch {
			return false;
		}
	});
	for (const c of janelas) if (c.url.href === endereco) return c;
	for (const c of janelas) {
		try {
			const scripts = client.natives.call(
				"Document.prototype.querySelectorAll",
				(c.global as any).document,
				"script[scramjet-attr-src]",
			) as ArrayLike<Element>;
			for (let i = 0; i < scripts.length; i++) {
				const src = client.natives.call("Element.prototype.getAttribute", scripts[i], "scramjet-attr-src");
				if (src && new _URL(src, c.url.href).href === endereco) return c;
			}
		} catch {}
	}

	return null;
}

function clienteDeEntrada(client: ScramjetClient): ScramjetClient {
	const doOuvinte = client.box.entradas[client.box.entradas.length - 1];
	if (doOuvinte) return doOuvinte;
	const quadros = quadrosCrus(client, 200);
	if (quadros && quadros.length) {
		const ultimo = quadros[quadros.length - 1];
		let arquivo: string | null = null;
		try {
			arquivo = ultimo.getScriptNameOrSourceURL?.() || ultimo.getFileName?.() || null;
		} catch {}
		if (arquivo) {
			const dono = clienteDoArquivo(client, arquivo);
			if (dono) return dono;
		}
	}

	return client;
}

export default function (client: ScramjetClient) {
	client.Proxy("window.open", {
		apply(ctx) {
			// undefined opens an about:blank window, pass through
			if (typeof ctx.args[0] !== "undefined") {
				const url = String(ctx.args[0]);
				// blank also opens an about:blank window
				if (url !== "") {
					// note that null or anything else will *not* open an about:blank window
					const entrada = clienteDeEntrada(client);
					ctx.args[0] = entrada === client ? client.rewriteUrl(url) : client.rewriteUrl(new _URL(url, entrada.meta.base).href);
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
