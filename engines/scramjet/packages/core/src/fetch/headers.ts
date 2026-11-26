import {
	rewriteUrl,
	ScramjetContext,
	ScramjetHeaders,
	unrewriteUrl,
	URLMeta,
} from "@/shared";
import { siteRegistravel as registrableDomain } from "@/shared/site";
import {
	ScramjetFetchHandler,
	ScramjetFetchParsed,
	ScramjetFetchRequest,
} from ".";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { _URL, _Set } from "@/shared/snapshot";
import { createReferrerString } from "./util";
import { POLITICA_DO_MOTOR } from "@/shared/confiavel";

/**
 * Headers for security policy features that haven't been emulated yet
 */
const SEC_HEADERS = new _Set([
	"cross-origin-embedder-policy",
	"cross-origin-opener-policy",
	"cross-origin-resource-policy",
	"content-security-policy",
	"content-security-policy-report-only",
	"expect-ct",
	"feature-policy",
	"origin-isolation",
	"strict-transport-security",
	"upgrade-insecure-requests",
	"x-content-type-options",
	"x-download-options",
	"x-frame-options",
	"x-permitted-cross-domain-policies",
	"x-powered-by",
	"x-xss-protection",
	// This needs to be emulated, but for right now it isn't that important of a feature to be worried about
	// https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Clear-Site-Data
	"clear-site-data",
]) as _Set<string>;

/**
 * Headers that are actually URLs that need to be rewritten
 */
const URL_HEADERS = new _Set([
	"location",
	"content-location",
	"referer",
]) as _Set<string>;

function rewriteLinkHeader(
	link: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return link.replace(/<([^>]+)>/gi, (_match, p1) => {
		return `<${rewriteUrl(p1, context, meta)}>`;
	});
}

export async function rewriteResponseHeaders(
	handler: ScramjetFetchHandler,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	rawHeaders: RawHeaders
): Promise<ScramjetHeaders> {
	const headers = ScramjetHeaders.fromRawHeaders(rawHeaders);

	const politica = headers.get("content-security-policy");
	for (const cspHeader of SEC_HEADERS) {
		headers.delete(cspHeader);
	}
	const traduzida = politica
		? politica
				.split(",")
				.map((uma) => politicaDoCabecalho(uma, handler.context.prefix.href))
				.filter(Boolean)
				.join(", ")
		: null;
	const caixa = politica ? caixaDaPolitica(politica) : null;
	const doCabecalho = [traduzida, caixa].filter(Boolean).join("; ");
	if (doCabecalho) headers.set("Content-Security-Policy", doCabecalho);

	for (const urlHeader of URL_HEADERS) {
		if (headers.has(urlHeader)) {
			const url = headers.get(urlHeader)!;
			const rewrittenUrl = rewriteUrl(url, handler.context, parsed.meta);
			headers.set(urlHeader, rewrittenUrl);
		}
	}

	if (headers.has("link")) {
		const link = headers.get("link")!;
		const rewritten = rewriteLinkHeader(link, handler.context, parsed.meta);
		headers.set("link", rewritten);
	}

	if (headers.get("accept") === "text/event-stream") {
		headers.set("content-type", "text/event-stream");
	}

	const permissoes = headers.get("permissions-policy");
	if (permissoes != null) {
		const traduzida = politicaDePermissoes(permissoes);
		if (traduzida) headers.set("permissions-policy", traduzida);
		else headers.delete("permissions-policy");
	}

	// we handle this ourselves
	headers.delete("set-cookie");

	if (
		handler.crossOriginIsolated &&
		[
			"document",
			"iframe",
			"worker",
			"sharedworker",
			"style",
			"script",
		].includes(parsed.destination)
	) {
		headers.set("Cross-Origin-Embedder-Policy", "require-corp");
		headers.set("Cross-Origin-Opener-Policy", "same-origin");
	}

	if (parsed.destination === "document" || parsed.destination === "iframe") {
		headers.set("Referrer-Policy", "unsafe-url");
	}

	return headers;
}

/**
 * vssh fork: o `connect-src` do site, na parte que sobrevive à troca de origem.
 *
 * A política inteira não pode ir para o navegador: as fontes dela são os hosts do site, e todo
 * pedido da página proxiada sai para a origem do motor. O que se traduz sem perder o sentido são os
 * esquemas. Cada política vira `connect-src 'self'` mais os esquemas que ela permitia (`data:`,
 * `blob:`, `wss:`), e o navegador recusa sozinho o resto, com o erro, o aviso no console e o
 * `securitypolicyviolation` dele. O Turnstile pede `fetch("data:,")` debaixo de um `connect-src`
 * sem `data:` e espera a recusa; quando o pedido volta com sucesso, o desafio não fecha.
 *
 * Quando a política não fala de conexão (nem `connect-src` nem `default-src`), ela não entra.
 * Várias políticas no mesmo cabeçalho, separadas por vírgula, valem cada uma por si, como no
 * navegador.
 */
export function politicaDeConexao(cabecalho: string): string | null {
	const saida: string[] = [];
	for (const politica of cabecalho.split(",")) {
		const diretivas = new Map<string, string[]>();
		for (const bruta of politica.split(";")) {
			const partes = bruta.trim().split(/\s+/).filter(Boolean);
			if (!partes.length) continue;
			const nome = partes[0].toLowerCase();
			if (!diretivas.has(nome)) diretivas.set(nome, partes.slice(1));
		}
		const fontes = diretivas.get("connect-src") ?? diretivas.get("default-src");
		if (!fontes) continue;
		const esquemas = fontes.filter((f) => /^[a-z][a-z0-9+.-]*:$/i.test(f));
		saida.push(["connect-src", "'self'", ...esquemas].join(" "));
	}

	return saida.length ? saida.join(", ") : null;
}

/**
 * vssh fork: o `sandbox` da CSP do site, que um `<meta>` não aplica.
 *
 * O quadro do Turnstile chega com `sandbox allow-same-origin allow-scripts …` no cabeçalho, e o
 * documento dele roda sem modais, sem navegar o topo e sem baixar arquivos. A diretiva vale igual
 * sob o prefixo do motor, desde que deixe o mesmo-origem e os scripts, sem os quais o motor não
 * roda no documento; sem os dois, ela fica de fora.
 */
export function caixaDaPolitica(cabecalho: string): string | null {
	for (const politica of cabecalho.split(",")) {
		for (const bruta of politica.split(";")) {
			const partes = bruta.trim().split(/\s+/).filter(Boolean);
			if (partes[0]?.toLowerCase() !== "sandbox") continue;
			const marcas = partes.slice(1).map((m) => m.toLowerCase());
			if (!marcas.includes("allow-same-origin") || !marcas.includes("allow-scripts")) return null;

			return ["sandbox", ...marcas].join(" ");
		}
	}

	return null;
}

/**
 * vssh fork: a CSP de um `<meta http-equiv>`, traduzida diretiva por diretiva.
 *
 * Uma política de `<meta>` só vale para o que o parser encontra depois dela, e os scripts do motor
 * vêm antes, no começo do `<head>`. Por isso ela pode ir ao navegador quase inteira, ao contrário da
 * do cabeçalho, que valeria também para eles. Palavras-chave, nonces, hashes, esquemas e as
 * diretivas de Trusted Types ficam como o site escreveu. Toda fonte de host, e o `'self'`, vira o
 * `'self'` do motor, porque todo endereço proxiado mora nele; `data:` e `blob:` também ganham o
 * `'self'` fora do `connect-src`, porque o motor os serve pelo prefixo. O `connect-src` segue
 * `politicaDeConexao`. O código do motor compila WebAssembly, e a diretiva que governa os scripts
 * ganha `'wasm-unsafe-eval'` quando o site não deu `'unsafe-eval'`.
 *
 * O que um `<meta>` não aplica (`frame-ancestors`, `sandbox`, relatórios) sai, e o
 * `upgrade-insecure-requests` sai porque reescreveria os endereços do próprio motor.
 *
 * O quadro do Turnstile traz a política dele assim e confere que ela vale: o `eval` recusado, o
 * script e o atributo de evento sem nonce que não rodam.
 */
const DIRETIVAS_DE_BUSCA = new Set([
	"default-src",
	"script-src",
	"script-src-elem",
	"script-src-attr",
	"style-src",
	"style-src-elem",
	"style-src-attr",
	"img-src",
	"font-src",
	"media-src",
	"object-src",
	"frame-src",
	"child-src",
	"worker-src",
	"manifest-src",
	"base-uri",
	"form-action",
]);
const DIRETIVAS_COMO_ESTAO = new Set([
	"require-trusted-types-for",
	"trusted-types",
]);

export function politicaDoMeta(valor: string, prefixo?: string): string | null {
	const diretivas = new Map<string, string[]>();
	for (const bruta of valor.split(";")) {
		const partes = bruta.trim().split(/\s+/).filter(Boolean);
		if (!partes.length) continue;
		const nome = partes[0].toLowerCase();
		if (!diretivas.has(nome)) diretivas.set(nome, partes.slice(1));
	}

	const saida: string[] = [];
	for (const [nome, fontes] of diretivas) {
		if (DIRETIVAS_COMO_ESTAO.has(nome)) {
			// a política com que o motor devolve o código reescrito precisa caber na lista do site
			const lista =
				nome === "trusted-types"
					? [
							...fontes.filter((f) => f.toLowerCase() !== "'none'"),
							POLITICA_DO_MOTOR,
							...(fontes.some((f) => f.toLowerCase() === "'allow-duplicates'")
								? []
								: ["'allow-duplicates'"]),
						]
					: fontes;
			saida.push([nome, ...lista].join(" "));
			continue;
		}
		if (!DIRETIVAS_DE_BUSCA.has(nome)) continue;

		const guardadas: string[] = [];
		let proprio = false;
		for (const fonte of fontes) {
			const minuscula = fonte.toLowerCase();
			if (minuscula === "'self'") proprio = true;
			else if (fonte.startsWith("'")) guardadas.push(fonte);
			else if (/^[a-z][a-z0-9+.-]*:$/i.test(fonte)) {
				guardadas.push(fonte);
				proprio = true;
			} else proprio = true;
		}
		// No `worker-src` o `'self'` do motor vale só sob o prefixo dele. O worker que a política do
		// site recusa vai ao navegador num endereço da origem do motor fora do prefixo (ver
		// `client/csp.ts`), e o navegador o recusa como o Chrome: sem exceção, com o evento `error`
		// e o `securitypolicyviolation`.
		if (proprio) guardadas.unshift(nome === "worker-src" && prefixo ? prefixo : "'self'");
		const semNone = guardadas.filter((f) => f.toLowerCase() !== "'none'");
		saida.push([nome, ...(semNone.length ? semNone : ["'none'"])].join(" "));
	}

	const conexao = politicaDeConexao(valor);
	const semConexao = saida.filter((d) => !d.startsWith("connect-src"));
	if (conexao) semConexao.push(conexao);

	// a diretiva que governa os scripts precisa deixar o motor compilar o WebAssembly dele
	const governa = semConexao.findIndex((d) => d.startsWith("script-src "));
	const i =
		governa >= 0 ? governa : semConexao.findIndex((d) => d.startsWith("default-src "));
	if (i >= 0 && !/'unsafe-eval'|'wasm-unsafe-eval'/i.test(semConexao[i])) {
		semConexao[i] = semConexao[i].replace(/ 'none'$/i, "") + " 'wasm-unsafe-eval'";
	}

	return semConexao.length ? semConexao.join("; ") : null;
}

export function rewriteRequestHeaders(
	request: ScramjetFetchRequest,
	handler: ScramjetFetchHandler,
	parsed: ScramjetFetchParsed
): ScramjetHeaders {
	const headers = request.initialHeaders.clone();

	// avoid leaking the scramjet referer
	headers.delete("Referer");

	const rawOriginUrl =
		parsed.referrerSourceUrl !== undefined
			? parsed.referrerSourceUrl
			: request.rawClientUrl ||
				(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
	const originUrl =
		rawOriginUrl &&
		rawOriginUrl.pathname.startsWith(handler.context.prefix.pathname)
			? new _URL(unrewriteUrl(rawOriginUrl, handler.context))
			: rawOriginUrl;

	if (
		rawOriginUrl &&
		rawOriginUrl.pathname.startsWith(handler.context.prefix.pathname)
	) {
		// vssh fork: `Origin` como o Fetch o manda (https://fetch.spec.whatwg.org/#append-a-request-origin-header):
		// num pedido CORS a outra origem e num método que não é GET nem HEAD. Uma imagem, um
		// script ou um fetch GET da própria origem saem sem ele no Chrome, e um `Origin` em todo
		// pedido é um sinal de proxy que um desafio anti-robô lê. O WebSocket põe o dele em
		// `client/shared/requests/websocket.ts`.
		const metodoSimples = request.method === "GET" || request.method === "HEAD";
		const corsDeFora =
			computeFetchMode(request, parsed) === "cors" &&
			originUrl.origin !== parsed.url.origin;
		if (!metodoSimples || corsDeFora) headers.set("Origin", originUrl.origin);
		else headers.delete("Origin");

		const referer = createReferrerString(
			originUrl,
			parsed.url,
			parsed.referrerPolicy ?? null
		);
		if (referer) headers.set("Referer", referer);
	}

	const sameSiteContext = computeSameSiteContext(request, parsed, originUrl);
	const cookies = handler.context.cookieJar.getCookies(
		parsed.url,
		false,
		sameSiteContext
	);

	if (cookies.length) {
		headers.set("Cookie", cookies);
	}

	// vssh fork: o Chrome acrescenta `Accept-Language` depois do service worker, e o pedido que sai
	// do transporte iria sem ele. O valor sai dos idiomas do navegador, na forma do Chrome.
	if (!headers.has("accept-language")) {
		const idiomas = acceptLanguage(self.navigator?.languages);
		if (idiomas) headers.set("Accept-Language", idiomas);
	}

	applyFetchMetadataHeaders(headers, request, parsed, handler);

	return headers;
}

/**
 * vssh fork: `Accept-Language` como o Chrome o monta a partir de `navigator.languages`: cada
 * idioma com região seguido do idioma base, quando a lista não o traz, e o peso descendo de 0,1 em
 * 0,1 depois do primeiro (`pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7`).
 */
export function acceptLanguage(idiomas: readonly string[] | undefined): string {
	const lista: string[] = [];
	const todos = (idiomas || []).map((l) => String(l).trim()).filter(Boolean);
	for (let i = 0; i < todos.length; i++) {
		const tag = todos[i];
		if (!lista.includes(tag)) lista.push(tag);
		const base = tag.split("-")[0];
		const outroDoMesmoBase = todos.slice(i + 1).some((l) => l.split("-")[0] === base);
		if (base !== tag && !todos.includes(base) && !outroDoMesmoBase && !lista.includes(base))
			lista.push(base);
	}
	return lista
		.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}`))
		.join(",");
}

/**
 * Compute and attach the Sec-Fetch-* request metadata headers, per
 * https://w3c.github.io/webappsec-fetch-metadata/.
 *
 * Browsers compute these based on the proxy URL space (page → service worker),
 * which is meaningless to the destination. We strip those values and recompute
 * based on the logical (unrewritten) URLs so that the destination sees
 * realistic Sec-Fetch-Site / -Mode / -Dest / -User values.
 *
 * These headers are only attached when the destination URL is a "potentially
 * trustworthy" URL — matching Chrome's behaviour of omitting them when sending
 * to plain http:// non-loopback destinations.
 */
function applyFetchMetadataHeaders(
	headers: ScramjetHeaders,
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	handler: ScramjetFetchHandler
) {
	// Strip browser-attached Sec-Fetch-* (computed from the proxy URL space).
	headers.delete("sec-fetch-site");
	headers.delete("sec-fetch-mode");
	headers.delete("sec-fetch-dest");
	headers.delete("sec-fetch-user");
	headers.delete("sec-fetch-storage-access");

	if (!isPotentiallyTrustworthy(parsed.url)) {
		return;
	}

	// Determine the request initiator's origin. Unlike the Referer header,
	// this never gets stripped by referrer policy: it's the page that actually
	// initiated the chain. Prefer the propagated initiator origin for
	// post-redirect requests; otherwise fall back to rawClientUrl/rawReferrer.
	const initiatorUrl = resolveFetchInitiatorUrl(request, parsed, handler);

	// Sec-Fetch-Site: relationship between request initiator's origin and the URL.
	let site: "none" | "same-origin" | "same-site" | "cross-site";
	if (!initiatorUrl) {
		// No initiator (e.g., user typed URL, or browser-initiated request).
		site = "none";
	} else {
		const immediate = computeFetchSite(initiatorUrl, parsed.url);
		site = parsed.fetchSiteState
			? worstFetchSite(parsed.fetchSiteState, immediate)
			: immediate;
	}
	headers.set("Sec-Fetch-Site", site);

	// Sec-Fetch-Mode: the request's mode. `event.request.mode` from the SW is
	// computed against the proxy URL space (always same-origin to the page) so
	// it's not safe to trust for fetch / Request API calls; we prefer the
	// `sj$mode` value the client-side proxy stamped onto the URL when present
	// and fall back to a destination-based default for everything else.
	headers.set("Sec-Fetch-Mode", computeFetchMode(request, parsed));

	if (parsed.destination === "iframe") {
		if (!parsed.isIframe) {
			// emulate a top-level navigation
			headers.set("Sec-Fetch-Dest", "document");
		} else {
			headers.set("Sec-Fetch-Dest", "iframe");
		}
	} else {
		headers.set("Sec-Fetch-Dest", parsed.destination || "empty");
	}

	// Sec-Fetch-User: sent as "?1" only on user-activated navigation requests
	// (top-level documents, iframes, frames, and embedded objects). The browser
	// already attaches this header to the page→SW request when the navigation
	// originates from a user gesture, so we forward that signal for any
	// navigation destination.
	const isNavigationDestination =
		parsed.destination === "document" ||
		parsed.destination === "iframe" ||
		parsed.destination === "frame" ||
		parsed.destination === "embed" ||
		parsed.destination === "object";
	// vssh fork: a navegação de nível de cima sem iniciador (`Sec-Fetch-Site: none`) é a que a
	// pessoa pediu pela barra de endereço, um favorito ou o recarregar, e o Chrome a marca como
	// ativada por ela. No motor ela nasce de `frame.go()`, sem gesto do lado da página.
	const topoDigitado =
		site === "none" &&
		(parsed.destination === "document" ||
			(parsed.destination === "iframe" && !parsed.isIframe));
	if (
		isNavigationDestination &&
		(request.initialHeaders.get("sec-fetch-user") === "?1" || topoDigitado)
	) {
		headers.set("Sec-Fetch-User", "?1");
	}

	// Sec-Fetch-Storage-Access: per https://privacycg.github.io/storage-access-headers/.
	// Sent on cross-site credentialed requests so the destination knows whether
	// unpartitioned storage access has been granted. We never grant storage
	// access through the proxy, so the value is always "none" when sent.
	//
	// `event.request.credentials` inside a service worker isn't reliable, so we
	// rely on signals propagated from the page (the `sj$cred` URL param set by
	// the client-side fetch proxy) plus destination-based defaults for request
	// types that always include credentials.
	if (site === "cross-site" && requestIncludesCredentials(request, parsed)) {
		headers.set("Sec-Fetch-Storage-Access", "none");
	}
}

/**
 * Whether this request will carry credentials to the destination. Used by
 * Sec-Fetch-Storage-Access. The browser's `event.request.credentials` value
 * can't be trusted in a service worker context, so we reconstruct the answer
 * from:
 *
 * - the `sj$cred` URL parameter, set by the client-side fetch proxy when the
 *   page used `fetch(url, { credentials: "include" })`; and
 * - destination-based defaults: most resource fetches (img, script, style,
 *   link, video, audio, track, document/iframe navigations, etc.) default to
 *   credentials mode "include" unless the page explicitly opts out via a
 *   `crossorigin` attribute we can't observe from here. fetch() / XHR
 *   default to "same-origin", so we treat them as non-credentialed unless
 *   `sj$cred` says otherwise.
 */
function requestIncludesCredentials(
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed
): boolean {
	if (parsed.fetchCredentialsInclude) return true;
	const dest = parsed.destination;
	// fetch(): destination is "" (empty). XHR / report: destination is
	// "report". Both default to credentials="same-origin", so cross-site
	// requests don't include credentials unless the page explicitly opts in.
	if (dest === "" || dest === "report") return false;
	// ES modules (including module scripts and module-typed workers) default
	// to credentials="same-origin", so cross-site fetches do not carry
	// credentials.
	if (parsed.isModule) return false;
	// Other destinations (image, classic-script, style, audio, video, track,
	// font, iframe, frame, document, embed, object, manifest, classic worker,
	// sharedworker, serviceworker, ...) default to credentials="include".
	return true;
}

/**
 * Determine the Sec-Fetch-Mode value for a request.
 *
 * The browser's `event.request.mode` reported in the SW is unsafe to trust
 * for `fetch()` / `new Request()` calls — those compute mode against the
 * request URL's relationship to the page, and scramjet has rewritten the URL
 * to be same-origin to the page, so the SW always sees "same-origin"
 * regardless of the page's actual `init.mode`. For HTML resource fetches
 * (`<script crossorigin>`, `<img crossorigin>`, …) the mode is derived from
 * the element's CORS attribute rather than URL origin, so the SW's reported
 * mode IS reliable there.
 *
 * Resolution order:
 *   1. `parsed.fetchMode` — set by the client-side fetch / Request proxy from
 *      `init.mode` (or fetch's "cors" default). Authoritative for
 *      page-initiated fetch / Request / XHR-style calls.
 *   2. Top-level navigations: always "navigate".
 *   3. Workers: classic → "same-origin", module → "cors".
 *   4. Everything else: trust the SW's `request.mode` (it reflects the
 *      element's CORS attribute), falling back to "no-cors" if it's missing
 *      or implausible (e.g. "same-origin" / "navigate" leaking in from a
 *      proxy-URL computation).
 */
function computeFetchMode(
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed
): string {
	if (parsed.fetchMode) return parsed.fetchMode;
	const dest = parsed.destination;
	if (
		dest === "document" ||
		dest === "iframe" ||
		dest === "frame" ||
		dest === "embed" ||
		dest === "object"
	) {
		return "navigate";
	}
	if (dest === "worker" || dest === "sharedworker") {
		// Classic workers default to same-origin; module workers default to cors.
		return parsed.isModule ? "cors" : "same-origin";
	}
	// HTML element fetches: the browser's `request.mode` here reflects the
	// element's CORS attribute (`<script crossorigin>` ⇒ "cors", plain
	// `<script>` ⇒ "no-cors"), so trust it. Reject "same-origin"/"navigate"
	// since those indicate the value came from URL-origin matching against
	// scramjet's proxy origin and is meaningless to the destination.
	if (request.mode === "cors" || request.mode === "no-cors") {
		return request.mode;
	}
	return "no-cors";
}

/**
 * Resolve the unrewritten URL of the page (or worker) that initiated this
 * request. Used by Sec-Fetch-Site, which always compares against the original
 * initiator regardless of Referer policy.
 */
function resolveFetchInitiatorUrl(
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	handler: ScramjetFetchHandler
): URL | undefined {
	// On any hop after the first, the propagated initiator origin is the
	// authoritative source. rawReferrer may have been replaced with the
	// previous hop's URL, and rawClientUrl is unset for top-level navigations.
	if (parsed.fetchInitiatorOrigin) {
		try {
			return new _URL(parsed.fetchInitiatorOrigin);
		} catch {
			// fall through to the fallbacks below
		}
	}
	const candidate =
		request.rawClientUrl ||
		(request.rawReferrer ? new _URL(request.rawReferrer) : undefined);
	if (!candidate) return undefined;
	if (candidate.pathname.startsWith(handler.context.prefix.pathname)) {
		return new _URL(unrewriteUrl(candidate, handler.context));
	}
	// The candidate URL is outside scramjet's logical space (e.g. the runway
	// harness wrapper page, or a chrome:// page kicking off a navigation).
	// There's no meaningful "initiator" in the proxied site's frame of
	// reference, so treat it as a browser-initiated request — Sec-Fetch-Site
	// will be "none".
	return undefined;
}

/**
 * Whether a URL is "potentially trustworthy" per
 * https://w3c.github.io/webappsec-secure-contexts/#is-url-trustworthy.
 *
 * This is a slimmed-down implementation: HTTPS / WSS, file:, and the common
 * loopback hostnames (localhost, *.localhost, 127.0.0.0/8, ::1) are treated as
 * trustworthy. Everything else (including plain http:// to a real hostname) is
 * not.
 */
function isPotentiallyTrustworthy(url: URL): boolean {
	const protocol = url.protocol;
	if (protocol === "https:" || protocol === "wss:" || protocol === "file:") {
		return true;
	}
	if (protocol !== "http:" && protocol !== "ws:") {
		// data:, blob:, etc. – defer to the caller; treated as not trustworthy
		// for the purpose of attaching Sec-Fetch-* network headers.
		return false;
	}
	return isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "localhost.") return true;
	if (hostname.endsWith(".localhost") || hostname.endsWith(".localhost.")) {
		return true;
	}
	if (hostname === "[::1]" || hostname === "::1") return true;
	// Match 127.0.0.0/8 (any 127.x.y.z address).
	if (/^127\.(?:\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.test(hostname)) {
		return true;
	}
	return false;
}

/**
 * Compute the immediate Sec-Fetch-Site relation between an initiator origin and
 * a destination URL.
 *
 * - "same-origin" if scheme + host + port match exactly.
 * - "same-site" if scheme matches and the registrable domains match.
 * - "cross-site" otherwise.
 */
export function computeFetchSite(
	originUrl: URL,
	destUrl: URL
): "same-origin" | "same-site" | "cross-site" {
	if (
		originUrl.protocol === destUrl.protocol &&
		originUrl.host === destUrl.host
	) {
		return "same-origin";
	}
	if (
		originUrl.protocol === destUrl.protocol &&
		registrableDomain(originUrl.hostname) ===
			registrableDomain(destUrl.hostname)
	) {
		return "same-site";
	}
	return "cross-site";
}

/**
 * Combine two Sec-Fetch-Site classifications, returning the "worst" (least
 * trusted) of the two. Used when propagating state through redirect chains.
 */
export function worstFetchSite(
	a: "none" | "same-origin" | "same-site" | "cross-site",
	b: "none" | "same-origin" | "same-site" | "cross-site"
): "none" | "same-origin" | "same-site" | "cross-site" {
	const order = { "cross-site": 0, "same-site": 1, "same-origin": 2, none: 3 };
	return order[a] <= order[b] ? a : b;
}

/**
 * Compute the SameSite enforcement context for a request.
 *
 * "strict"     – same-site or no known origin (allow all cookies)
 * "lax"        – cross-site top-level GET/HEAD navigation (block Strict)
 * "cross-site" – cross-site subresource or non-safe-method navigation (block Strict+Lax)
 */
function computeSameSiteContext(
	request: ScramjetFetchRequest,
	parsed: ScramjetFetchParsed,
	rawOriginUrl: URL | undefined
): "strict" | "lax" | "cross-site" {
	// If a redirect chain previously passed through a cross-site origin, the
	// final request is always treated as cross-site regardless of its destination.
	if (parsed.crossSiteRedirect) {
		const isNavigation =
			parsed.destination === "document" || parsed.destination === "iframe";
		const isSafeMethod = request.method === "GET" || request.method === "HEAD";
		return isNavigation && isSafeMethod ? "lax" : "cross-site";
	}

	if (!rawOriginUrl) return "strict";

	const originSite = registrableDomain(rawOriginUrl.hostname);
	const targetSite = registrableDomain(parsed.url.hostname);

	// Same site → no SameSite restrictions
	if (originSite === targetSite) return "strict";

	// Cross-site request: check if it's a navigational GET/HEAD (lax) or subresource/POST (cross-site)
	const isNavigation =
		parsed.destination === "document" || parsed.destination === "iframe";
	const isSafeMethod = request.method === "GET" || request.method === "HEAD";

	if (isNavigation && isSafeMethod) return "lax";
	return "cross-site";
}

// vssh fork: a implementação local saiu para `@/shared/site` (`siteRegistravel`), que conhece
// sufixo multi-rótulo. Havia DUAS cópias deste `slice(-2)` — a outra em `fetch.ts` —, e as
// duas tratavam `folha.com.br` e `uol.com.br` como o MESMO site. Daí `computeSameSiteContext`
// respondia "same-site" para sites sem relação, o `CookieJar` deixava de filtrar por
// `SameSite`, e o jar é ÚNICO para todas as origens proxiadas.

/**
 * vssh fork: o `Permissions-Policy` do site, com as listas na origem do motor.
 *
 * `*` e `()` valem igual dos dois lados. Para o navegador a página e todos os quadros dela têm a
 * origem do motor, e uma lista com `self` vira `(self)`: os quadros de outra origem lógica já
 * chegam sem os recursos de lista `'self'` pelo `allow` (ver `shared/permissoes.ts`). Uma lista só
 * com origens de terceiros nega o recurso à página, que é o que ela pede para a página.
 */
export function politicaDePermissoes(valor: string): string {
	const saida: string[] = [];
	for (const bruto of valor.split(",")) {
		const m = /^\s*([a-z0-9-]+)\s*=\s*(.*?)\s*$/i.exec(bruto);
		if (!m) continue;
		const [, recurso, lista] = m;
		if (lista === "*") saida.push(`${recurso}=*`);
		else if (/^\(.*\)$/.test(lista)) {
			const itens = lista.slice(1, -1).trim().split(/\s+/).filter(Boolean);
			if (itens.includes("*")) saida.push(`${recurso}=*`);
			else if (itens.includes("self")) saida.push(`${recurso}=(self)`);
			else saida.push(`${recurso}=()`);
		} else if (lista === "self") saida.push(`${recurso}=(self)`);
	}

	return saida.join(", ");
}

// As diretivas de busca que o `default-src` governa e que não tocam os scripts do motor.
const SEM_SCRIPT = [
	"style-src",
	"img-src",
	"font-src",
	"media-src",
	"object-src",
	"frame-src",
	"child-src",
	"manifest-src",
	"connect-src",
];

/**
 * vssh fork: a CSP do cabeçalho do site, na parte que não alcança os scripts do motor.
 *
 * Os scripts que o motor põe no começo do documento rodam antes de qualquer `<meta>`, e uma
 * política de cabeçalho os governa desde o primeiro byte; por isso o `script-src` do cabeçalho
 * fica com o cliente (ver `client/csp.ts`). O resto vai ao navegador como o `<meta>` vai
 * (`politicaDoMeta`), com o `default-src` escrito em cada diretiva que ele governaria. Com duas
 * políticas de pé, uma no cabeçalho e outra no `<meta>`, o navegador recusa pelas duas e dispara um
 * `securitypolicyviolation` por política, como no Chrome.
 */
export function politicaDoCabecalho(valor: string, prefixo: string): string | null {
	const diretivas = new Map<string, string[]>();
	for (const bruta of valor.split(";")) {
		const partes = bruta.trim().split(/\s+/).filter(Boolean);
		if (!partes.length) continue;
		const nome = partes[0].toLowerCase();
		if (!diretivas.has(nome)) diretivas.set(nome, partes.slice(1));
	}
	const padrao = diretivas.get("default-src");
	const script = diretivas.get("script-src");
	if (!diretivas.has("worker-src")) {
		const recuo = diretivas.get("child-src") ?? script ?? padrao;
		if (recuo) diretivas.set("worker-src", recuo);
	}
	if (padrao)
		for (const nome of SEM_SCRIPT) if (!diretivas.has(nome)) diretivas.set(nome, padrao);
	for (const nome of ["default-src", "script-src", "script-src-elem", "script-src-attr"])
		diretivas.delete(nome);
	const texto = [...diretivas].map(([n, f]) => [n, ...f].join(" ")).join("; ");

	return texto ? politicaDoMeta(texto, prefixo) : null;
}
