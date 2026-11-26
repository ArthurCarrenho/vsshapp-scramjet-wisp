import type { ScramjetContext } from "@/shared";
import { unrewriteUrl, type URLMeta } from "@rewriters/url";
import { _URL, String_startsWith } from "@/shared/snapshot";

// vssh fork: o `allow` de um iframe de outra origem, no navegador.
//
// Para o navegador todo quadro do motor tem a origem do motor, e um recurso cuja lista padrão é
// `'self'` (câmera, área de transferência, as dicas de cliente de alta entropia) chega liberado a
// um quadro que, para o site, é de terceiro. No Chrome esse quadro só recebe o que o `allow`
// concede. Aqui o `allow` que vai ao navegador nega cada um desses recursos que o do site não
// concede ao endereço do quadro, e o resto da diretiva do site segue com `'src'`, que para o
// navegador é a origem do motor. O `'self'` de uma diretiva do site aponta para a página que
// contém o quadro, que é de outra origem lógica, e por isso nega.

/** Os recursos do Chrome cuja lista padrão é `'self'`. */
const PADRAO_SELF = [
	"accelerometer",
	"camera",
	"captured-surface-control",
	"ch-device-memory",
	"ch-downlink",
	"ch-dpr",
	"ch-ect",
	"ch-prefers-color-scheme",
	"ch-prefers-reduced-motion",
	"ch-prefers-reduced-transparency",
	"ch-rtt",
	"ch-ua-arch",
	"ch-ua-bitness",
	"ch-ua-form-factors",
	"ch-ua-full-version",
	"ch-ua-full-version-list",
	"ch-ua-model",
	"ch-ua-platform-version",
	"ch-ua-wow64",
	"ch-viewport-height",
	"ch-viewport-width",
	"ch-width",
	"clipboard-read",
	"clipboard-write",
	"compute-pressure",
	"cross-origin-isolated",
	"deferred-fetch",
	"digital-credentials-create",
	"digital-credentials-get",
	"display-capture",
	"encrypted-media",
	"fullscreen",
	"geolocation",
	"gyroscope",
	"hid",
	"identity-credentials-get",
	"idle-detection",
	"keyboard-map",
	"language-detector",
	"language-model",
	"local-fonts",
	"local-network",
	"local-network-access",
	"loopback-network",
	"magnetometer",
	"microphone",
	"midi",
	"on-device-speech-recognition",
	"otp-credentials",
	"payment",
	"publickey-credentials-create",
	"publickey-credentials-get",
	"screen-wake-lock",
	"serial",
	"speaker-selection",
	"summarizer",
	"translator",
	"usb",
	"window-management",
];

function origemDoQuadro(
	src: string | undefined,
	context: ScramjetContext,
	meta: URLMeta,
): string | null {
	if (src == null) return null;
	let texto = String(src).trim();
	if (!texto) return null;
	if (String_startsWith(texto, context.prefix.href)) texto = unrewriteUrl(texto, context);
	try {
		const url = new _URL(texto, meta.base);
		if (!/^(https?|wss?|ftp):$/.test(url.protocol)) return null;

		return url.origin;
	} catch {
		return null;
	}
}

/**
 * O `allow` que vai ao navegador para um iframe cujo endereço é `src` (o do site ou o reescrito),
 * ou o próprio `allow` do site quando o quadro tem a origem da página.
 */
export function allowNativo(
	allow: string,
	src: string | undefined,
	context: ScramjetContext,
	meta: URLMeta,
): string {
	const dele = origemDoQuadro(src, context, meta);
	if (!dele || dele === meta.origin.origin) return allow;

	const saida: string[] = [];
	const vistos = new Set<string>();
	for (const bruta of String(allow).split(";")) {
		const partes = bruta.trim().split(/\s+/).filter(Boolean);
		if (!partes.length) continue;
		const recurso = partes[0].toLowerCase();
		if (vistos.has(recurso)) continue;
		vistos.add(recurso);
		const lista = partes.slice(1).map((p) => p.toLowerCase());
		let concede = !lista.length;
		for (const fonte of lista) {
			if (fonte === "*" || fonte === "'src'") concede = true;
			else if (!String_startsWith(fonte, "'")) {
				try {
					if (new _URL(fonte).origin === dele) concede = true;
				} catch {}
			}
		}
		saida.push(concede ? recurso : `${recurso} 'none'`);
	}
	for (const recurso of PADRAO_SELF)
		if (!vistos.has(recurso)) saida.push(`${recurso} 'none'`);

	return saida.join("; ");
}
