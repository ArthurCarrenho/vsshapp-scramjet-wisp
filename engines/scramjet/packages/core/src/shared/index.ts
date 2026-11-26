import { ScramjetConfig, ScramjetFlags, ScramjetVersionInfo } from "@/types";
import DomHandler, { Element } from "domhandler";
import { URLMeta } from "@rewriters/url";
import { CookieJar } from "./cookie";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";
import { _RegExp } from "./snapshot";

export * from "./cookie";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./rewriters";

// vssh fork: a expressão de cada `siteFlags` é compilada uma vez. O rewriter consulta todas as
// flags a cada script, e um `Function` num laço pagava uma compilação de regex por flag.
const expressoesDeSite = new Map<string, RegExp>();

export function flagEnabled(
	flag: keyof ScramjetFlags,
	context: ScramjetContext,
	url: URL
): boolean {
	const value = context.config.flags[flag];
	for (const regex in context.config.siteFlags) {
		const partialflags = context.config.siteFlags[regex];
		if (!(flag in partialflags)) continue;
		let re = expressoesDeSite.get(regex);
		if (!re) expressoesDeSite.set(regex, (re = new _RegExp(regex)));
		re.lastIndex = 0;
		if (re.test(url.href)) {
			return partialflags[flag];
		}
	}

	return value;
}
export type ScramjetInterface = {
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;

	getInjectScripts(
		meta: URLMeta,
		handler: DomHandler,
		htmlcontext: HtmlContext,
		script: (src: string) => Element
	): Element[];
	getWorkerInjectScripts?(
		meta: URLMeta,
		isModule: boolean,
		script: (src: string) => string
	): string;
};

export type ScramjetContext = {
	config: ScramjetConfig;
	prefix: URL;
	interface: ScramjetInterface;
	cookieJar: CookieJar;
	hooks?: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
	};
};

export type HtmlRewriterHooks = {
	pre: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
	};
	post: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
		props: {
			setRawHtml?: string;
		};
	};
};
