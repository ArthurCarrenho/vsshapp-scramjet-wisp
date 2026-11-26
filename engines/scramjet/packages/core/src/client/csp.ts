import type { ScramjetClient } from "@client/index";
import { _URL, String } from "@/shared/snapshot";

// vssh fork: as fontes de host da CSP do site, conferidas no cliente.
//
// O navegador só vê a política que o motor entrega, e nela todo host do site virou o `'self'` do
// motor (ver `politicaDeConexao` e `politicaDoMeta` em `fetch/headers.ts`): um pedido a um host que
// o site não lista sai pelo prefixo e passa. Aqui o pedido é conferido contra a política do site,
// a do cabeçalho do documento e a dos `<meta>`, e o que ela recusa vai ao navegador com o endereço
// de verdade. A política do motor recusa esse endereço, porque ele não é o `'self'` dela nem cabe
// num esquema que o site deu, e a recusa sai como a do Chrome: o erro, o aviso no console e o
// `securitypolicyviolation`.

type Diretiva = "connect-src" | "img-src" | "worker-src";

// A diretiva que vale quando a pedida não aparece na política, na ordem do CSP3.
const RECUO: Record<Diretiva, string[]> = {
	"connect-src": ["connect-src", "default-src"],
	"img-src": ["img-src", "default-src"],
	"worker-src": ["worker-src", "child-src", "script-src", "default-src"],
};

const PADRAO: Record<string, number> = {
	"http:": 80,
	"https:": 443,
	"ws:": 80,
	"wss:": 443,
	"ftp:": 21,
};

function politicas(client: ScramjetClient): string[] {
	const saida: string[] = [];
	try {
		const cabecalho = client.initHeaders?.get("content-security-policy");
		if (cabecalho) saida.push(...cabecalho.split(","));
	} catch {}
	try {
		const doc = client.global.document;
		if (doc) {
			const metas = client.natives.call(
				"Document.prototype.querySelectorAll",
				doc,
				'meta[http-equiv="content-security-policy" i]',
			) as NodeListOf<Element>;
			for (let i = 0; i < metas.length; i++) {
				const original =
					client.natives.call(
						"Element.prototype.getAttribute",
						metas[i],
						"scramjet-attr-content",
					) ??
					client.natives.call(
						"Element.prototype.getAttribute",
						metas[i],
						"content",
					);
				if (original) saida.push(String(original));
			}
		}
	} catch {}

	return saida;
}

function fontesDe(politica: string, diretiva: Diretiva): string[] | null {
	const diretivas = new Map<string, string[]>();
	for (const bruta of politica.split(";")) {
		const partes = bruta.trim().split(/\s+/).filter(Boolean);
		if (!partes.length) continue;
		const nome = partes[0].toLowerCase();
		if (!diretivas.has(nome)) diretivas.set(nome, partes.slice(1));
	}
	for (const nome of RECUO[diretiva]) {
		const fontes = diretivas.get(nome);
		if (fontes) return fontes;
	}

	return null;
}

function esquemaCasa(pedido: string, fonte: string) {
	return (
		pedido === fonte ||
		(fonte === "http:" && pedido === "https:") ||
		(fonte === "ws:" && pedido === "wss:")
	);
}

function casaFonte(fonte: string, url: URL, proprio: URL): boolean {
	const f = fonte.toLowerCase();
	if (f.startsWith("'")) {
		if (f !== "'self'") return false;
		if (url.host !== proprio.host) return false;
		const p = url.protocol;

		return (
			p === proprio.protocol ||
			(proprio.protocol === "http:" &&
				(p === "https:" || p === "ws:" || p === "wss:")) ||
			(proprio.protocol === "https:" && p === "wss:")
		);
	}
	if (f === "*")
		return (
			["http:", "https:", "ws:", "wss:", "ftp:"].includes(url.protocol) ||
			url.protocol === proprio.protocol
		);
	if (/^[a-z][a-z0-9+.-]*:$/.test(f)) return esquemaCasa(url.protocol, f);

	const m =
		/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[^:/]+|[^:/]+)(?::(\*|\d+))?(\/.*)?$/.exec(
			f,
		);
	if (!m) return false;
	const [, esquema, host, porta, caminho] = m;
	if (esquema) {
		if (!esquemaCasa(url.protocol, `${esquema}:`)) return false;
	} else if (
		!esquemaCasa(url.protocol, proprio.protocol) &&
		!(proprio.protocol === "https:" && url.protocol === "wss:")
	) {
		return false;
	}
	const h = url.hostname.toLowerCase();
	if (host === "*") {
		// só o host curinga
	} else if (host.startsWith("*.")) {
		if (!h.endsWith(host.slice(1))) return false;
	} else if (h !== host) return false;
	const portaPedida = url.port ? Number(url.port) : PADRAO[url.protocol];
	if (porta === "*") {
		// qualquer porta
	} else if (porta) {
		if (portaPedida !== Number(porta)) return false;
	} else {
		const esperada = PADRAO[esquema ? `${esquema}:` : url.protocol];
		if (portaPedida !== esperada && !(esperada === 80 && portaPedida === 443))
			return false;
	}
	if (caminho) {
		const pedido = decodeURIComponent(url.pathname);
		if (
			caminho.endsWith("/") ? !pedido.startsWith(caminho) : pedido !== caminho
		)
			return false;
	}

	return true;
}

/** Verdadeiro quando a CSP do site recusa `url` em `diretiva`. */
export function cspRecusa(
	client: ScramjetClient,
	diretiva: Diretiva,
	url: string,
): boolean {
	let alvo: URL;
	try {
		alvo = new _URL(url, client.url.href);
	} catch {
		return false;
	}
	// `data:` e `blob:` só cabem numa fonte de esquema; o resto que não sai para a rede não é
	// conferido aqui.
	const local = alvo.protocol === "data:" || alvo.protocol === "blob:";
	if (!local && !/^(https?|wss?|ftp):$/.test(alvo.protocol)) return false;
	const proprio = client.url;
	for (const politica of politicas(client)) {
		const fontes = fontesDe(politica, diretiva);
		if (!fontes) continue;
		const casa = local
			? fontes.some((f) => f.toLowerCase() === alvo.protocol)
			: fontes.some((f) => casaFonte(f, alvo, proprio));
		if (!casa) return true;
	}

	return false;
}

/** O endereço que vai ao navegador: o de verdade quando a CSP do site o recusa. */
export function enderecoDeConexao(
	client: ScramjetClient,
	url: string,
	reescrever: () => string,
): string {
	if (cspRecusa(client, "connect-src", url)) {
		try {
			return new _URL(url, client.url.href).href;
		} catch {}
	}

	return reescrever();
}

const RECUSADO = "~recusado/";

/** Um endereço da origem do motor, fora do prefixo dele, que guarda o endereço do site. */
export function enderecoRecusado(client: ScramjetClient, url: string): string {
	const prefixo = client.context.prefix;

	return `${prefixo.origin}${prefixo.pathname.replace(/\/$/, "")}${RECUSADO}${encodeURIComponent(url)}`;
}

/** O endereço do site guardado em `enderecoRecusado`, ou `null`. */
export function doRecusado(client: ScramjetClient, url: string): string | null {
	const prefixo = client.context.prefix;
	const base = `${prefixo.origin}${prefixo.pathname.replace(/\/$/, "")}${RECUSADO}`;
	if (!url.startsWith(base)) return null;
	try {
		return decodeURIComponent(url.slice(base.length));
	} catch {
		return null;
	}
}
