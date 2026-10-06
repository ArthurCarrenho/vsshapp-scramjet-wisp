// HTTP cache plugin for ScramjetFetchHandler.
//
// Service-worker `fetch` ignores the browser's HTTP cache, so without this
// every navigation re-runs the full network fetch even for unchanged
// resources. This plugin caches the **upstream** response (the BareResponse
// as received from the network, BEFORE rewriteResponseHeaders / rewriteBody
// run). On a hit we hand that same untouched response to the pipeline, which
// then re-rewrites with the current Frame's prefix.
//
// Storing pre-rewrite means:
//   - The cache is shared across Frames, Controllers, and page reloads --
//     one Frame's hit serves another Frame's request because the stored
//     bytes contain only the upstream's URLs, not any frame-bound prefix.
//   - Redirect Location / Content-Location and Link headers come out of
//     `rewriteResponseHeaders` correctly on each hit, because that runs
//     on the cache-derived response just like a fresh one.
//   - We don't skip the rewriter on hit; we only skip the network. That's
//     where the win actually is for service-worker proxying.
//
// Implementation aims for RFC 9111 (HTTP caching) compliance for a
// PRIVATE cache (browser-local, single-user):
//
//   - Only GET / HEAD are cached.
//   - Cacheable status codes per RFC 9110 §15.1: 200 203 204 300 301 308
//     404 405 410 414 501. Other statuses pass through. 206 is omitted
//     because the Cache API spec (Service Workers §cache-put) rejects
//     partial responses outright.
//   - `Cache-Control: no-store` and `Vary: *` opt out.
//   - Freshness:
//       1. `Cache-Control: s-maxage` (private cache treats this same as
//          max-age),
//       2. `Cache-Control: max-age`,
//       3. `Expires`,
//       4. heuristic 10% × (Date - Last-Modified) per RFC 9111 §4.2.2.
//   - `Cache-Control: no-cache` / `Pragma: no-cache` / `Cache-Control:
//     immutable` are honoured.
//   - `Vary` is honoured by storing one entry per (URL × selected-headers)
//     pair via the underlying Cache API's built-in matching.
//
// 304 revalidation isn't handled here yet -- stale entries fall through to
// a full refetch. Adding it cleanly requires a hook position that lets us
// substitute the cached body AFTER the network 304 arrives but BEFORE
// `rewriteBody` runs, without going through `rewriteBody` again. That can
// come later.

import {
	BareResponse,
	type ScramjetFetchRequest,
	type ScramjetHeaders,
} from "@mercuryworkshop/scramjet";
import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

export const CACHE_NAME = "scramjet-http-cache-v2";

/** Header recording when this entry entered the cache (ms since epoch). */
const STORED_AT_HEADER = "x-sj-cached-at";

/**
 * Status codes RFC 9110 §15.1 marks as "cacheable by default", minus 206:
 * the Cache API rejects partial responses (cache.put throws TypeError on
 * any non-200/non-OK response with a Content-Range), so storing them is a
 * non-starter regardless of what HTTP allows.
 */
const DEFAULT_CACHEABLE_STATUSES = new Set([
	200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501,
]);

/**
 * Statuses for which the Fetch spec forbids a body. The Response constructor
 * throws TypeError if you pair any of these with a body -- even an empty
 * string or 0-byte buffer.
 */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

interface CacheControlDirectives {
	"no-store"?: boolean;
	"no-cache"?: boolean;
	"must-revalidate"?: boolean;
	"proxy-revalidate"?: boolean;
	private?: boolean;
	public?: boolean;
	"max-age"?: number;
	"s-maxage"?: number;
	"stale-while-revalidate"?: number;
	"stale-if-error"?: number;
	immutable?: boolean;
}

function parseCacheControl(value: string | null): CacheControlDirectives {
	const out: CacheControlDirectives = {};
	if (!value) return out;
	for (const raw of value.split(",")) {
		const part = raw.trim();
		if (!part) continue;
		const eq = part.indexOf("=");
		const name = (eq === -1 ? part : part.slice(0, eq))
			.trim()
			.toLowerCase() as keyof CacheControlDirectives;
		if (eq === -1) {
			(out as any)[name] = true;
			continue;
		}
		let v = part.slice(eq + 1).trim();
		if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
		if (
			name === "max-age" ||
			name === "s-maxage" ||
			name === "stale-while-revalidate" ||
			name === "stale-if-error"
		) {
			const n = parseInt(v, 10);
			if (Number.isFinite(n) && n >= 0) (out as any)[name] = n;
		} else {
			(out as any)[name] = true;
		}
	}
	return out;
}

/**
 * RFC 9111 §4.2.1 freshness lifetime calculation, simplified for a private
 * cache (so s-maxage is treated identically to max-age).
 */
function freshnessLifetimeSeconds(
	headers: Headers,
	cc: CacheControlDirectives,
	dateMs: number
): number | null {
	if (cc["s-maxage"] !== undefined) return cc["s-maxage"];
	if (cc["max-age"] !== undefined) return cc["max-age"];

	const expires = headers.get("expires");
	if (expires) {
		const expMs = Date.parse(expires);
		if (Number.isFinite(expMs)) {
			return Math.max(0, (expMs - dateMs) / 1000);
		}
	}

	const lastModified = headers.get("last-modified");
	if (lastModified) {
		const lmMs = Date.parse(lastModified);
		if (Number.isFinite(lmMs) && lmMs <= dateMs) {
			// RFC 9111 §4.2.2 heuristic: 10% of the time since Last-Modified.
			return ((dateMs - lmMs) * 0.1) / 1000;
		}
	}

	return null;
}

/** Current age (seconds) of a stored response per RFC 9111 §4.2.3. */
function currentAgeSeconds(headers: Headers, storedAtMs: number): number {
	const ageHeader = headers.get("age");
	const initialAge = ageHeader ? parseInt(ageHeader, 10) || 0 : 0;
	const residentTime = (Date.now() - storedAtMs) / 1000;
	return initialAge + residentTime;
}

function isCacheableMethod(method: string): boolean {
	return method === "GET" || method === "HEAD";
}

/**
 * Whether a response (status + Cache-Control + Vary) is allowed to be stored.
 * RFC 9110 §15.1 + RFC 9111 §3. `headers` is the upstream's raw response
 * headers, not yet through scramjet's response-header rewriter.
 */
function responseIsStorable(
	status: number,
	headers: Headers,
	method: string
): boolean {
	if (!isCacheableMethod(method)) return false;
	if (!DEFAULT_CACHEABLE_STATUSES.has(status)) return false;

	const cc = parseCacheControl(headers.get("cache-control"));
	if (cc["no-store"]) return false;

	// "Vary: *" means "never reusable".
	const vary = headers.get("vary");
	if (vary && vary.split(",").some((v) => v.trim() === "*")) return false;

	return true;
}

// vssh fork: o que não vai ao cache mesmo sendo guardável pelo HTTP. Um download (`attachment`)
// vai ser pedido de novo pelo diálogo de salvar; a mídia é pedida em pedaços e relida pelo próprio
// player; e uma resposta acima do teto ocuparia a cota da origem inteira, que o Chrome despeja de
// uma vez quando o disco aperta (o `localStorage` junto). O tamanho declarado decide aqui; o que
// chega sem `Content-Length` é medido enquanto o cache lê (`guardar`).
function foraDoCache(headers: Headers, tetoBytes: number): boolean {
	if (/attachment/i.test(headers.get("content-disposition") ?? "")) return true;
	if (/^(video|audio)\//i.test(headers.get("content-type") ?? "")) return true;
	const declarado = Number(headers.get("content-length"));
	return Number.isFinite(declarado) && declarado > tetoBytes;
}

/** Build a synthetic cache-key Request keyed by the *underlying* URL. */
function buildCacheKeyRequest(
	parsedUrl: string,
	headers: ScramjetHeaders
): Request {
	const native = new Headers();
	for (const [k, v] of headers.toRawHeaders()) {
		try {
			native.append(k, v);
		} catch {}
	}
	const cacheKeyUrl =
		"https://sj-cache.invalid/" + encodeURIComponent(parsedUrl);
	return new Request(cacheKeyUrl, { method: "GET", headers: native });
}

/** Rebuild a Headers object from the BareResponse's rawHeaders array. */
function nativeHeadersFromRaw(
	raw: ReadonlyArray<readonly [string, string]>
): Headers {
	const h = new Headers();
	for (const [k, v] of raw) {
		try {
			h.append(k, v);
		} catch {
			// some upstream headers (e.g. malformed Set-Cookie) are rejected
			// by the native Headers; just drop them.
		}
	}
	return h;
}

/** Strip our internal bookkeeping from a stored Response's headers. */
function strippedHeadersFromStored(stored: Response): Headers {
	const out = new Headers();
	for (const [k, v] of stored.headers.entries()) {
		if (k.toLowerCase() === STORED_AT_HEADER) continue;
		try {
			out.append(k, v);
		} catch {}
	}
	return out;
}

/**
 * Build a `Response` to put in the Cache API. Tags it with our internal
 * STORED_AT_HEADER so freshness can be computed on later lookups.
 */
function buildStorableResponse(
	body: ArrayBuffer | null,
	status: number,
	statusText: string,
	rawHeaders: ReadonlyArray<readonly [string, string]>
): Response {
	const native = nativeHeadersFromRaw(rawHeaders);
	native.set(STORED_AT_HEADER, String(Date.now()));
	return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
		status,
		statusText,
		headers: native,
	});
}

export interface HttpCachePluginOptions {
	/** Name of the underlying Cache API entry. Defaults to CACHE_NAME. */
	cacheName?: string;
	/** vssh fork: o maior corpo guardado, em bytes. O padrão é 8 MiB. */
	maxEntryBytes?: number;
	/** vssh fork: quantas entradas o cache guarda. Passado disso, saem as guardadas há mais tempo. */
	maxEntries?: number;
}

const TETO_POR_ENTRADA = 8 * 1024 * 1024;
const TETO_DE_ENTRADAS = 400;
// A poda olha a lista de chaves, que custa uma ida ao CacheStorage inteiro; uma a cada N gravações.
const PODA_A_CADA = 25;

/**
 * RFC-9111-ish HTTP cache for ScramjetFetchHandler.
 *
 * One instance can be installed onto multiple Frames -- the WeakMap of
 * "did this request come from cache?" book-keeping is per-instance, not
 * per-Frame, so nothing leaks across installs.
 */
export class HttpCachePlugin extends ManagedPlugin {
	readonly cacheName: string;
	readonly maxEntryBytes: number;
	readonly maxEntries: number;

	private cachePromise: Promise<Cache> | null = null;
	private gravacoesDesdeAPoda = PODA_A_CADA;
	// Marks requests whose `earlyResponse` we sourced from the cache, so the
	// preresponse hook below knows not to re-store them. WeakMap keys are
	// the request objects so entries clean themselves up automatically.
	private cameFromCache = new WeakMap<ScramjetFetchRequest, true>();

	constructor(options: HttpCachePluginOptions = {}) {
		super("scramjet-http-cache", []);
		this.cacheName = options.cacheName ?? CACHE_NAME;
		this.maxEntryBytes = options.maxEntryBytes ?? TETO_POR_ENTRADA;
		this.maxEntries = options.maxEntries ?? TETO_DE_ENTRADAS;
	}

	/**
	 * vssh fork: lê a cópia do corpo que é do cache e a guarda, se couber no teto. Corre por fora da
	 * resposta: a página lê a outra cópia do `tee()` enquanto isto lê esta, e a resposta não espera
	 * o cache. Passou do teto, a leitura é cancelada e nada é guardado.
	 */
	private async guardar(
		chave: Request,
		corpo: ReadableStream<Uint8Array> | null,
		status: number,
		statusText: string,
		rawHeaders: ReadonlyArray<readonly [string, string]>
	): Promise<void> {
		let bytes: ArrayBuffer | null = null;
		if (corpo) {
			const leitor = corpo.getReader();
			const pedacos: Uint8Array[] = [];
			let total = 0;
			for (;;) {
				const { done, value } = await leitor.read();
				if (done) break;
				total += value.byteLength;
				if (total > this.maxEntryBytes) {
					leitor.cancel().catch(() => {});
					return;
				}
				pedacos.push(value);
			}
			const junto = new Uint8Array(total);
			let pos = 0;
			for (const p of pedacos) {
				junto.set(p, pos);
				pos += p.byteLength;
			}
			bytes = junto.buffer;
		}
		const cache = await this.openCache();
		await cache.put(chave, buildStorableResponse(bytes, status, statusText, rawHeaders));
		if (++this.gravacoesDesdeAPoda >= PODA_A_CADA) {
			this.gravacoesDesdeAPoda = 0;
			await this.podar(cache);
		}
	}

	/**
	 * vssh fork: o teto de entradas, e a cota da origem. O CacheStorage devolve as chaves na ordem
	 * em que foram gravadas, e uma regravação vai para o fim; saem as do começo. Com a origem acima
	 * de metade da cota (`navigator.storage.estimate()`), sai a metade mais antiga do cache.
	 */
	private async podar(cache: Cache): Promise<void> {
		const chaves = await cache.keys();
		let excesso = chaves.length - this.maxEntries;
		try {
			const estimativa = await navigator.storage?.estimate?.();
			if (estimativa?.quota && (estimativa.usage ?? 0) > estimativa.quota / 2) {
				excesso = Math.max(excesso, Math.ceil(chaves.length / 2));
			}
		} catch {
			// sem estimativa, vale só o teto de entradas
		}
		for (let i = 0; i < excesso; i++) await cache.delete(chaves[i]);
	}

	/** Lazy-open the underlying Cache. Memoized for the plugin's lifetime. */
	private openCache(): Promise<Cache> {
		if (!this.cachePromise) {
			this.cachePromise = caches.open(this.cacheName);
		}
		return this.cachePromise;
	}

	install(frame: Frame): void {
		super.install(frame);

		const hooks = frame.fetchHandler.hooks.fetch;

		// ----- request: cache lookup --------------------------------------
		this.tap(hooks.request, async (ctx, props) => {
			const req = ctx.request;
			if (!isCacheableMethod(req.method)) return;
			const reqCache = req.cache as string;
			// Honour the request's own cache mode where it asks for fresh data.
			if (reqCache === "no-store" || reqCache === "reload") return;
			// Don't undo an earlyResponse another plugin already set.
			if (props.earlyResponse) return;

			const cache = await this.openCache();
			const stored = await cache.match(
				buildCacheKeyRequest(ctx.parsed.url.href, req.initialHeaders)
			);
			if (!stored) {
				return;
			}

			const storedAt = parseInt(
				stored.headers.get(STORED_AT_HEADER) ?? "0",
				10
			);
			const cc = parseCacheControl(stored.headers.get("cache-control"));

			const pragmaNoCache = (stored.headers.get("pragma") ?? "")
				.toLowerCase()
				.includes("no-cache");
			const mustRevalidateBeforeUse =
				cc["no-cache"] === true || pragmaNoCache || reqCache === "no-cache";

			const dateMs = (() => {
				const d = stored.headers.get("date");
				if (d) {
					const v = Date.parse(d);
					if (Number.isFinite(v)) return v;
				}
				return storedAt || Date.now();
			})();

			const lifetime = freshnessLifetimeSeconds(stored.headers, cc, dateMs);
			const age = currentAgeSeconds(stored.headers, storedAt);
			const fresh =
				!mustRevalidateBeforeUse && lifetime !== null && age < lifetime;

			// `immutable` short-circuits the freshness check (RFC 8246)
			// provided the client hasn't asked for a forced revalidation.
			const immutable =
				cc.immutable === true &&
				reqCache !== "no-cache" &&
				reqCache !== "reload";

			if (!fresh && !immutable) {
				// Stale; fall through to the network. (TODO: 304 revalidation.)
				return;
			}

			// Build a BareResponse around the stored bytes/headers and hand
			// it to doNetworkFetch via earlyResponse. The pipeline will then
			// run rewriteResponseHeaders/rewriteBody/etc. as if we'd just
			// fetched it.
			const headers = strippedHeadersFromStored(stored);
			// Recompute Age the consumer sees so it isn't stuck at storage
			// time.
			if (storedAt) {
				headers.set("age", String(Math.floor((Date.now() - storedAt) / 1000)));
			}

			const isNullBody = NULL_BODY_STATUSES.has(stored.status);
			const earlyBody = isNullBody ? null : await stored.arrayBuffer();

			const earlyResponse = BareResponse.fromNativeResponse(
				new Response(earlyBody, {
					status: stored.status,
					statusText: stored.statusText,
					headers,
				})
			);

			this.cameFromCache.set(req, true);
			props.earlyResponse = earlyResponse;
		});

		// ----- preresponse: cache store -----------------------------------
		this.tap(hooks.preresponse, async (ctx, props) => {
			const req = ctx.request;
			// Skip if this body came back via cache.match -- restoring it
			// would just rewrite the same bytes with a fresh STORED_AT_HEADER
			// (resetting the freshness clock).
			if (this.cameFromCache.has(req)) {
				this.cameFromCache.delete(req);
				return;
			}

			if ((req.cache as string) === "no-store") return;
			if (!isCacheableMethod(req.method)) return;

			const original = props.response;
			const headers = nativeHeadersFromRaw(original.rawHeaders);
			if (!responseIsStorable(original.status, headers, req.method)) return;
			if (foraDoCache(headers, this.maxEntryBytes)) return;

			const cacheKey = buildCacheKeyRequest(
				ctx.parsed.url.href,
				req.initialHeaders
			);

			// vssh fork: o corpo se divide em duas cópias (`tee()`), uma para a página e outra para o
			// cache, e a resposta segue sem esperar o cache ler. Ler o corpo inteiro para a memória
			// antes de devolvê-lo fazia de um arquivo grande um ArrayBuffer do mesmo tamanho na thread
			// da página.
			let paraOCache: ReadableStream<Uint8Array> | null = null;
			if (!NULL_BODY_STATUSES.has(original.status) && original.body) {
				const [paraAPagina, copia] = original.body.tee();
				paraOCache = copia;
				const replacement = BareResponse.fromNativeResponse(
					new Response(paraAPagina, {
						status: original.status,
						statusText: original.statusText,
						headers,
					})
				);
				replacement.url = original.url;
				replacement.redirected = original.redirected;
				replacement.rawHeaders = original.rawHeaders;
				props.response = replacement;
			}

			this.guardar(
				cacheKey,
				paraOCache,
				original.status,
				original.statusText,
				original.rawHeaders
			).catch((err) => {
				// Cache.put can fail on opaque or oddly-headered responses;
				// don't let a cache write failure break the actual fetch.
				console.warn("[scramjet-http-cache] cache.put failed:", err);
			});
		});
	}

	/**
	 * Drop every entry in the HTTP cache. Returns whether the underlying
	 * Cache existed and was deleted.
	 */
	async bust(): Promise<boolean> {
		try {
			// Drop the memoized handle too; the next install will re-open
			// against a fresh empty cache.
			this.cachePromise = null;
			return await caches.delete(this.cacheName);
		} catch (err) {
			console.error("[scramjet-http-cache] bust failed:", err);
			return false;
		}
	}
}
