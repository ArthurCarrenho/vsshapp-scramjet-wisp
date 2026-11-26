import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { ScramjetClient } from "@client/index";
import {
	Reflect_apply,
	Reflect_get,
	Reflect_set,
	String,
	_Map,
	_WeakMap,
	_WeakSet,
	_URL,
} from "@/shared/snapshot";
import { AnyFunction } from "@/types";
import { QP } from "@/fetch/parse";

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
			ctx.return(unrewriteCss(v, client.context, { absoluto: computados.has(ctx.this as object) }));
		},
	});

	// vssh fork: as propriedades de CSS de uma declaração (`style.backgroundImage`) são nomeadas da
	// instância no Chrome, sem acessor no protótipo, e só uma vista por `Proxy` as alcança. A vista
	// serve à declaração de um elemento, à de uma regra (`rule.style`) e à computada
	// (`getComputedStyle`), é a mesma a cada leitura (`el.style === el.style`), e mantém o
	// `scramjet-attr-style` do elemento com o texto do site, que o `getAttribute` e o `outerHTML`
	// devolvem.
	const computados = new _WeakSet<object>([]);
	const vistas = new _WeakMap<object, CSSStyleDeclaration>([]);
	const donoDoEstilo = new _WeakMap<object, Element>([]);
	const sincronizar = (style: object) => {
		const el = donoDoEstilo.get(style);
		if (!el) return;
		const atual = client.natives.call("Element.prototype.getAttribute", el, "style") as string | null;
		if (atual === null) client.natives.call("Element.prototype.removeAttribute", el, "scramjet-attr-style");
		else
			client.natives.call(
				"Element.prototype.setAttribute",
				el,
				"scramjet-attr-style",
				unrewriteCss(atual, client.context),
			);
	};
	const vistaDoEstilo = (style: CSSStyleDeclaration): CSSStyleDeclaration => {
		const pronta = vistas.get(style);
		if (pronta) return pronta;
		const absoluto = computados.has(style);
		const metodos = new _Map<PropertyKey, AnyFunction>([]);
		const vista = new Proxy(style, {
			get(target, prop) {
				const value = Reflect_get(target, prop);

				if (typeof value === "function") {
					let metodo = metodos.get(prop);
					if (!metodo || client.box.unproxy.get(metodo) !== value) {
						const nativo = value;
						metodo = new Proxy(nativo, {
							apply(fn, _that, args) {
								const r = Reflect_apply(fn, style, args);
								if (prop === "setProperty" || prop === "removeProperty") sincronizar(style);

								return r;
							},
						});
						client.box.unproxy.set(metodo, nativo);
						metodos.set(prop, metodo);
					}

					return metodo;
				}

				if (prop in CSSStyleDeclaration.prototype) return value;
				if (!value || typeof value !== "string") return value;

				return unrewriteCss(value, client.context, { absoluto });
			},
			set(target, prop, value) {
				let ok: boolean;
				if (prop == "cssText" || value == "" || typeof value !== "string") {
					ok = Reflect_set(target, prop, value);
				} else {
					ok = Reflect_set(target, prop, rewriteCss(value, client.context, client.meta));
				}
				sincronizar(style);

				return ok;
			},
		});
		vistas.set(style, vista);

		return vista;
	};

	client.Proxy("window.getComputedStyle", {
		apply(ctx) {
			const style = ctx.call() as CSSStyleDeclaration;
			if (!style || typeof style !== "object") return ctx.return(style);
			computados.add(style);
			ctx.return(vistaDoEstilo(style));
		},
	});
	for (const regra of [
		"CSSStyleRule",
		"CSSPageRule",
		"CSSKeyframeRule",
		"CSSFontFaceRule",
		"CSSNestedDeclarations",
	]) {
		if (!(client.global as any)[regra]?.prototype) continue;
		client.Trap(`${regra}.prototype.style`, {
			get(ctx) {
				const style = ctx.get() as CSSStyleDeclaration;

				return style ? vistaDoEstilo(style) : style;
			},
			set(ctx, value) {
				ctx.set(value);
			},
		});
	}

	client.Trap("CSSStyleDeclaration.prototype.cssText", {
		set(ctx, value: string) {
			ctx.set(rewriteCss(value, client.context, client.meta));
			sincronizar(ctx.this as object);
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

	// vssh fork: o endereço de uma folha (`document.styleSheets[i].href`) é o que o navegador pediu,
	// o do motor. A página recebe o do site, absoluto como no Chrome; o de um `@import` é o texto da
	// regra, como o autor o escreveu.
	const doSite = (href: unknown, autor: boolean) => {
		if (typeof href !== "string" || !href.startsWith(client.context.prefix.href)) return href;
		if (autor) {
			try {
				const escrito = new _URL(href).searchParams.get(QP.autor);
				if (escrito !== null) return escrito;
			} catch {}
		}

		return client.unrewriteUrl(href);
	};
	client.Trap("StyleSheet.prototype.href", {
		get(ctx) {
			return doSite(ctx.get(), false) as string;
		},
	});
	client.Trap("CSSImportRule.prototype.href", {
		get(ctx) {
			return doSite(ctx.get(), true) as string;
		},
	});

	client.Proxy("CSSStyleValue.parse", {
		apply(ctx) {
			if (!ctx.args[1]) return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
		},
	});

	for (const dono of ["HTMLElement", "SVGElement", "MathMLElement"]) {
		if (!(client.global as any)[dono]?.prototype) continue;
		client.Trap(`${dono}.prototype.style`, {
			get(ctx) {
				const style = ctx.get() as CSSStyleDeclaration;
				if (!style) return style;
				donoDoEstilo.set(style, ctx.this as Element);

				return vistaDoEstilo(style);
			},
			set(ctx, value: string) {
				// this will actually run the trap for cssText. don't rewrite it here
				ctx.set(value);
			},
		});
	}
}
