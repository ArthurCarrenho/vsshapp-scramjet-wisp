/**
 * Version information for the current Scramjet build.
 * Contains both the semantic version string and the git commit hash for build identification.
 */
export interface ScramjetVersionInfo {
	/** The semantic version */
	version: string;
	/** The git commit hash that this build was created from */
	build: string;
	/** The date of the build */
	date: string;
}

/**
 * Scramjet Feature Flags, configured at build time
 */
export type ScramjetFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	encapsulateWorkers: boolean;
	/**
	 * Neutraliza a View Transitions API na página proxiada: `startViewTransition` roda o
	 * callback e resolve tudo sem transição, e a at-rule `@view-transition` é descartada
	 * na reescrita de CSS (é ela que liga a transição de NAVEGAÇÃO, que não passa por
	 * `startViewTransition`).
	 *
	 * Existe por causa de um crash real do compositor do Chromium: quando dois nós da
	 * effect tree acabam com o mesmo `view_transition_element_resource_id`,
	 * `draw_property_utils::UpdateRenderTarget` estoura
	 * `CHECK(!resource_to_node.contains(...))` e o navegador MATA o renderer
	 * (`STATUS_BREAKPOINT` no Windows, SIGILL / "Error code: 4" no Linux). Num proxy de
	 * reescrita o estrago é maior que num site comum: o documento proxiado é same-origin
	 * com quem o hospeda e divide a MESMA layer tree, então o CHECK derruba a janela do
	 * embedder inteira, não só o frame. Diagnosticado a partir do minidump de um crash em
	 * produção ao abrir o YouTube pelo motor.
	 */
	disableViewTransitions: boolean;
};

export interface ScramjetConfig {
	globals: {
		wrapfn: string;
		wrappropertybase: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		templocid: string;
		tempunusedid: string;
	};
	flags: ScramjetFlags;
	siteFlags: Record<string, Partial<ScramjetFlags>>;
	maskedfiles: string[];
}

/**
 * The config for Scramjet initialization.
 */
export interface ScramjetInitConfig
	extends Omit<ScramjetConfig, "codec" | "flags"> {
	flags: Partial<ScramjetFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;
