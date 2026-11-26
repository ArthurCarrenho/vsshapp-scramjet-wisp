import { flagEnabled, ScramjetContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { URLMeta } from "@rewriters/url";
import { TextDecoder_decode } from "@/shared/snapshot";
import { base64Encode } from "@/shared/util";

const partesDe = (u: URL) => ({ href: u.href, origin: u.origin, host: u.host, hostname: u.hostname, protocol: u.protocol });

export function rewriteWorkers(
	js: string | Uint8Array,
	url: string,
	context: ScramjetContext,
	meta: URLMeta,
	isModule: boolean
) {
	const script = (script: string) => {
		if (isModule) {
			return `import "${script}"\n`;
		}
		return `importScripts("${script}");\n`;
	};
	const b64 = (script: string) =>
		`data:text/javascript;charset=utf-8;base64,${base64Encode(script)}`;
	let str = context.interface.getWorkerInjectScripts(meta, isModule, script);

	const encapsula = flagEnabled("encapsulateWorkers", context, meta.origin);
	// vssh fork: o código de um worker de módulo encapsulado é importado de um endereço `data:`,
	// e o `import` estático que o reescritor escreve como caminho (`/prefixo/...`) não resolve
	// contra ele. Para esse caso o prefixo vai com a origem, e os imports saem com o endereço
	// inteiro.
	const deModulo =
		isModule && encapsula
			? { ...context, prefix: { ...partesDe(context.prefix), pathname: context.prefix.href } as URL }
			: context;
	let rewritten = rewriteJs(js, url, deModulo, meta, isModule);
	if (typeof rewritten !== "string") {
		rewritten = TextDecoder_decode(rewritten);
	}

	if (encapsula) {
		// TODO: check if there's already a sourceURL/sourcemap before appending another?
		rewritten += `//# sourceURL=${url}`;
		str += script(b64(rewritten as string));
	} else {
		str += rewritten;
	}
	return str;
}
