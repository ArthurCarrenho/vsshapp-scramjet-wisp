import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { ScramjetClient } from "@client/index";
import {
	Reflect_apply,
	Reflect_get,
	Reflect_set,
	String,
} from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Proxy("CSSStyleDeclaration.prototype.setProperty", {
		apply(ctx) {
			if (!ctx.args[1]) return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
		},
	});

	client.Proxy("CSSStyleDeclaration.prototype.getPropertyValue", {
		apply(ctx) {
			const v = ctx.call();
			if (!v) return v;
			ctx.return(unrewriteCss(v, client.context));
		},
	});

	client.Trap("CSSStyleDeclaration.prototype.cssText", {
		set(ctx, value: string) {
			ctx.set(rewriteCss(value, client.context, client.meta));
		},
		get(ctx) {
			return unrewriteCss(ctx.get(), client.context);
		},
	});

	// Uma regra que o rewriter DESCARTA inteira (hoje só `@view-transition`, ver
	// rewriters/css.ts) não pode chegar aqui como string vazia: `insertRule("")` lança
	// SyntaxError, e um site que insere a regra sem try/catch quebraria — trocar o crash do
	// navegador por uma exceção na página não seria conserto. `@media not all{}` nunca casa,
	// não lança, e mantém o índice devolvido válido, que é o que um `deleteRule()` posterior usa.
	const NOOP_RULE = "@media not all{}";
	client.Proxy("CSSStyleSheet.prototype.insertRule", {
		apply(ctx) {
			const rewritten = rewriteCss(ctx.args[0], client.context, client.meta);
			ctx.args[0] =
				rewritten.trim() === "" && String(ctx.args[0]).trim() !== ""
					? NOOP_RULE
					: rewritten;
		},
	});

	client.Proxy("CSSStyleSheet.prototype.replace", {
		apply(ctx) {
			ctx.args[0] = rewriteCss(ctx.args[0], client.context, client.meta);
		},
	});

	client.Proxy("CSSStyleSheet.prototype.replaceSync", {
		apply(ctx) {
			ctx.args[0] = rewriteCss(ctx.args[0], client.context, client.meta);
		},
	});

	client.Trap("CSSRule.prototype.cssText", {
		set(ctx, value: string) {
			ctx.set(rewriteCss(value, client.context, client.meta));
		},
		get(ctx) {
			return unrewriteCss(ctx.get(), client.context);
		},
	});

	client.Proxy("CSSStyleValue.parse", {
		apply(ctx) {
			if (!ctx.args[1]) return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
		},
	});

	client.Trap("HTMLElement.prototype.style", {
		get(ctx) {
			// unfortunate and dumb hack. we have to trap every property of this
			// since the prototype chain is fucked

			const style = ctx.get() as CSSStyleDeclaration;

			return new Proxy(style, {
				get(target, prop) {
					const value = Reflect_get(target, prop);

					if (typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								return Reflect_apply(target, style, args);
							},
						});
					}

					if (prop in CSSStyleDeclaration.prototype) return value;
					if (!value) return value;

					return unrewriteCss(value, client.context);
				},
				set(target, prop, value) {
					if (prop == "cssText" || value == "" || typeof value !== "string") {
						return Reflect_set(target, prop, value);
					}

					return Reflect_set(
						target,
						prop,
						rewriteCss(value, client.context, client.meta)
					);
				},
			});
		},
		set(ctx, value: string) {
			// this will actually run the trap for cssText. don't rewrite it here
			ctx.set(value);
		},
	});
}
