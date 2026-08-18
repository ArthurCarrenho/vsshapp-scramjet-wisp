// NOTE: this is the entrypoint for scramjet.bundle.js
// as such it exports everything in scramjet
// the entry point for scramjet.all.js (what most sites wil use) is entry.ts

import "./global.d";
import { atob } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { ScramjetVersionInfo, ScramjetConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: ScramjetVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export const defaultConfig: ScramjetConfig = {
	globals: {
		wrapfn: "$scramjet$wrap",
		wrappropertybase: "$scramjet__",
		wrappropertyfn: "$scramjet$prop",
		cleanrestfn: "$scramjet$clean",
		importfn: "$scramjet$import",
		rewritefn: "$scramjet$rewrite",
		metafn: "$scramjet$meta",
		wrappostmessagefn: "$scramjet$wrappostmessage",
		pushsourcemapfn: "$scramjet$pushsourcemap",
		trysetfn: "$scramjet$tryset",
		templocid: "$scramjet$temploc",
		tempunusedid: "$scramjet$tempunused",
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		// vssh fork: LIGADA. Código anti-bot lê pilha de erro, e sem isto a pilha entrega o
		// ambiente inteiro: host do proxy, prefixo do motor e a URL de destino escapada dentro do
		// caminho. Um único carregamento do reCAPTCHA produz 54 `new Error()` que o próprio widget
		// captura e inspeciona (ver `bench/captcha-erros.mjs`) — cada um deles lia essa assinatura.
		//
		// Medido com `bench/pilha-vaza.mjs`: 3 de 3 formas de um site ler a própria pilha
		// denunciavam o proxy; com a flag ligada, 0 de 3 — a pilha sai igual à de um navegador sem
		// proxy nenhum.
		//
		// ⚠ Ela ficou anos sem efeito: `client.Trap` desiste quando a propriedade não existe, e
		// `Error.prepareStackTrace` NÃO existe no Chromium até alguém defini-la. Ligar a flag antes
		// do conserto em `client/shared/error.ts` não mudava nada.
		cleanErrors: true,
		scramitize: false,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		allowFailedIntercepts: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
		// Ligada por padrão: uma view transition mal formada não degrada o proxy, ela MATA o
		// renderer do embedder (ver ScramjetFlags.disableViewTransitions). Quem quiser as
		// transições de volta num site específico liga pelo siteFlags, ciente do risco.
		disableViewTransitions: true,
	},
	siteFlags: {},
	maskedfiles: [],
};

export const defaultConfigDev: ScramjetConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		// Fica DESLIGADA no devserver de propósito: `debugTrampolines` salva e restaura
		// `Error.prepareStackTrace` em volta de cada trap, e o `set` que o cleanErrors instala
		// ignora justamente esse tipo de escrita — as duas juntas deixariam o trampolim sem o
		// formatador dele. Aqui `debugSourceURL` já faz a pilha apontar para a URL lógica.
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};

declare const REWRITERWASM: string | undefined;
// bundled build will have the wasm binary inlined as a base64 string
if (REWRITERWASM) {
	setWasm(Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
export { BareResponse } from "@mercuryworkshop/proxy-transports";
export * from "./client";
