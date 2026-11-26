import { rewriteCss } from "@rewriters/css";
import { rewriteHtml, rewriteSrcset } from "@rewriters/html";
import { rewriteUrl, unrewriteBlob, URLMeta } from "@rewriters/url";
import { ScramjetContext } from "@/shared";
import { _URL } from "./snapshot";
import { politicaDoMeta } from "@/fetch/headers";
import { allowNativo } from "@/shared/permissoes";

export const htmlRules: {
	[key: string]: "*" | string[] | ((...any: any[]) => string | null);
	fn: (
		value: string,
		context: ScramjetContext,
		meta: URLMeta,
		attrs?: Record<string, string | undefined>
	) => string | null;
}[] = [
	{
		fn: (value, context, meta) =>
			rewriteUrl(value, context, meta, { navigateType: "location" }),

		// url rewrites
		src: ["embed", "frame", "input", "track"],
		href: ["a", "area", "image"],
		data: ["object"],
		action: ["form"],
		formaction: ["button", "input", "textarea", "submit"],
		poster: ["video"],
		"xlink:href": ["image"],
	},
	{
		// vssh fork: uma imagem `data:` ou `blob:` não sai para a rede, e vai ao navegador como
		// está. Assim o `img-src` do site (ver `politicaDoMeta`) a recusa ou aceita como o Chrome:
		// pelo prefixo ela seria uma imagem da origem do motor, que o `'self'` deixa passar.
		fn: (value, context, meta) => {
			const texto = value.trim();
			if (/^data:/i.test(texto)) return value;
			if (/^blob:/i.test(texto)) return unrewriteBlob(texto, context, meta);
			// O que o `img-src` do site recusa vai com o endereço de verdade, que a política do
			// motor também recusa (ver `client/csp.ts`).
			if (meta.recusaImagem?.(texto)) {
				try {
					return new _URL(texto, meta.base).href;
				} catch {}
			}

			return rewriteUrl(value, context, meta, { navigateType: "location" });
		},
		src: ["img"],
	},
	{
		fn: (value, context, meta, attrs) => {
			const isModule =
				attrs?.type?.toLowerCase() === "module" ||
				attrs?.rel?.toLowerCase() === "modulepreload";

			return rewriteUrl(value, context, meta, {
				isModule,
			});
		},

		src: ["script"],
		href: ["link"],
	},
	{
		fn: (value, context, meta) => {
			const url = rewriteUrl(value, context, meta, {
				topFrame: meta.topFrameName,
				parentFrame: meta.parentFrameName,
				isIframe: "1",
			});

			return url;
		},
		src: ["iframe"],
	},
	{
		// is this a good idea?
		fn: (_value, _context, _meta) => {
			return null;
		},
		sandbox: ["iframe"],
	},
	{
		// vssh fork: os recursos que um quadro de outra origem não recebe sem pedir (ver
		// `shared/permissoes.ts`). A regra vem depois da do `src`, que já guardou o endereço do site.
		fn: (value, context, meta, attrs) =>
			allowNativo(value, attrs?.["scramjet-attr-src"] ?? attrs?.src, context, meta),
		allow: ["iframe"],
	},
	{
		fn: (value, context, meta) => {
			if (value.startsWith("blob:")) {
				// for media elements specifically they must take the original blob
				// because they can't be fetch'd
				return unrewriteBlob(value, context, meta);
			}

			return rewriteUrl(value, context, meta);
		},
		src: ["video", "audio", "source"],
	},
	{
		fn: () => "",

		integrity: ["script", "link"],
	},
	{
		fn: () => null,

		// csp stuff that must be deleted
		//
		// vssh fork: o `nonce` fica. A CSP de um `<meta>` chega ao navegador com os nonces dela
		// (`politicaDoMeta`), e um script sem o nonce dele não rodaria.
		csp: ["iframe"],
		credentialless: ["iframe"],
	},
	{
		fn: (value, context, meta) => rewriteSrcset(value, context, meta),

		// srcset
		srcset: ["img", "source"],
		imagesrcset: ["link"],
	},
	{
		fn: (value, context, meta) =>
			rewriteHtml(
				value,
				context,
				{
					// for srcdoc origin is the origin of the page that the iframe is on. base and path get dropped
					origin: new _URL(meta.origin.origin),
					base: new _URL(meta.origin.origin),
					topFrameName: meta.topFrameName,
					parentFrameName: meta.parentFrameName,
					referrerPolicy: meta.referrerPolicy,
				},
				{
					loadScripts: true,
					inline: true,
					source: meta.origin.href,
					apisource: "set HTMLIFrameElement.prototype.srcdoc",
				}
			),

		// srcdoc
		srcdoc: ["iframe"],
	},
	{
		fn: (value, context, meta) => rewriteCss(value, context, meta),
		style: "*",
	},
	{
		fn: (value, context, meta) => {
			if (value === "_top" || value === "_unfencedTop")
				return meta.topFrameName;
			else if (value === "_parent") return meta.parentFrameName;
			else return value;
		},
		target: ["a", "base"],
	},
	{
		// vssh fork: a CSP de um `<meta http-equiv>` vai ao navegador traduzida por `politicaDoMeta`.
		// O elemento continua no documento, e `getAttribute("content")` e `.content` devolvem a
		// política do site. O quadro do Turnstile traz a CSP dele assim e confere que ela vale; sem
		// ela, o desafio responde `fail`.
		fn: (value, context, _meta, attrs) => {
			if (attrs?.["http-equiv"]?.toLowerCase() !== "content-security-policy")
				return value;

			return politicaDoMeta(value, context.prefix.href) ?? "";
		},
		content: ["meta"],
	},
	{
		// svg elements with an href property
		fn: (value, context, meta) => {
			// #id values are not rewritten
			if (value.startsWith("#")) return value;
			return rewriteUrl(value, context, meta);
		},
		href: [
			"use",
			"textPath",
			"mpath",
			"feImage",
			"animate",
			"animateMotion",
			"animateTransform",
			"set",
			"discard",
			"linearGradient",
			"radialGradient",
			"pattern",
			"filter",
		],
	},
];
