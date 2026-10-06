import { ManagedPlugin } from "@mercuryworkshop/scramjet-controller";
import type { Frame } from "@mercuryworkshop/scramjet-controller";

export type UrlWatcherOptions = {};

// vssh fork: o que mudou a URL. `push` e `replace` são o `history` da página, `location` é uma
// atribuição a `location`, `hash` é a troca de fragmento, e `documento` é um documento novo no frame.
export type MudancaDeUrl = { tipo: "documento" | "push" | "replace" | "location" | "hash" };

/**
 * Runs a callback whenever the URL of a Frame changes.
 * Includes hash changes and history.pushState/replaceState.
 * For only true navigation events, use the Frame.hooks.init.post hook.
 */
export class UrlWatcherPlugin extends ManagedPlugin {
	constructor(
		private onUrlChange: (url: string, mudanca: MudancaDeUrl) => void,
		private options: UrlWatcherOptions = {}
	) {
		super("url-watcher", []);
	}

	install(frame: Frame): void {
		this.tap(frame.hooks.init.post, (context) => {
			if (!context.isTopLevel) return;

			this.onUrlChange(context.client.url.href, { tipo: "documento" });

			this.tap(context.client.hooks.lifecycle.navigate, (ctx, props) => {
				const tipo =
					ctx.type === "history" ? (ctx.historico ?? "push")
					: ctx.type === "hashchange" ? "hash"
					: "location";
				this.onUrlChange(props.url, { tipo });
			});

			// TODO: this will probably make it fire twice if it was triggered by location.hash
			context.window.addEventListener(
				"hashchange",
				() => this.onUrlChange(context.client.url.href, { tipo: "hash" }),
				{ capture: true }
			);
		});
	}
}
