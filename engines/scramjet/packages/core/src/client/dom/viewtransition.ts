import { ScramjetClient } from "@client/index";
import { Promise_resolve, _Set } from "@/shared/snapshot";

// View Transitions desligadas na página proxiada — ver ScramjetFlags.disableViewTransitions
// para o porquê (crash do compositor do Chromium que mata o renderer do EMBEDDER, não só o
// frame proxiado). Este módulo cobre a metade same-document da API; a metade de NAVEGAÇÃO
// (`@view-transition { navigation: auto }`) não passa por aqui e é descartada no rewriter de
// CSS (shared/rewriters/css.ts) — as duas juntas é que fecham a superfície.
//
// A escolha de emular SUCESSO (e não "skipped") é deliberada. Quando o próprio navegador pula
// uma transição, `ready` REJEITA com AbortError; um site que faz `await t.ready` sem catch
// simplesmente para de executar dali pra frente, e aí o remédio quebraria a página tão bem
// quanto o crash. Resolvendo tudo, o pior caso é o site animar pseudo-elementos
// `::view-transition-*` que não existem — inofensivo.
export const enabled = (client: ScramjetClient) =>
	client.flagEnabled("disableViewTransitions");

type ViewTransitionArg =
	| (() => any)
	| { update?: () => any; types?: Iterable<string> | null }
	| undefined;

export default function (client: ScramjetClient, _self: Self) {
	// RawProxy sai fora sozinho se a propriedade não existir, então navegadores sem a API
	// (ou com ela atrás de flag) não precisam de guarda aqui.
	client.Proxy("Document.prototype.startViewTransition", {
		apply(ctx) {
			const arg = ctx.args[0] as ViewTransitionArg;
			const update = typeof arg === "function" ? arg : arg?.update;
			const types = typeof arg === "function" ? null : arg?.types;

			// O navegador não chama o update callback de forma síncrona (ele captura o estado
			// antigo primeiro e roda o callback numa atualização de rendering posterior).
			// Rodar num microtask preserva essa ordem: quem chamou continua vendo o DOM
			// antigo até devolver o controle.
			const updateCallbackDone = Promise_resolve().then(() =>
				typeof update === "function" ? update.call(ctx.this) : undefined
			);
			// `ready`/`finished` só podem settlar DEPOIS do update, senão um site que faz
			// cleanup no `finished` desfaz o próprio render.
			const ready = updateCallbackDone.then(() => undefined);
			const finished = updateCallbackDone.then(() => undefined);

			ctx.return({
				updateCallbackDone,
				ready,
				finished,
				// Sem transição em voo não há nada para pular; existe porque sites chamam.
				skipTransition() {},
				types: new _Set(types || []),
			} as unknown as ReturnType<Document["startViewTransition"]>);
		},
	});
}
