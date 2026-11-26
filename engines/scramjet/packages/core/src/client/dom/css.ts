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
	_URL, _ProxyNativo } from "@/shared/snapshot";
import { AnyFunction } from "@/types";
import { trocarRapida } from "@client/shared/troca-rapida";
import { QP } from "@/fetch/parse";

// Um valor de CSS só tem o que desfazer quando cita um endereço.
const temEndereco = (v: string) => v.indexOf("url(") >= 0 || v.indexOf("URL(") >= 0 || v.indexOf("@import") >= 0;

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
			if (!v || typeof v !== "string" || !temEndereco(v)) return v;
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
		// Sem endereço do motor no atributo, o valor dele já é o do site, e o guardado sai.
		if (atual === null || !temEndereco(atual)) client.natives.call("Element.prototype.removeAttribute", el, "scramjet-attr-style");
		else
			client.natives.call(
				"Element.prototype.setAttribute",
				el,
				"scramjet-attr-style",
				unrewriteCss(atual, client.context),
			);
	};
	// Um handler só para todas as vistas: o `getComputedStyle` devolve uma declaração nova a cada
	// chamada, e uma vista com handler e mapa próprios custava mais que a leitura.
	const metodosDe = new _WeakMap<object, Map<PropertyKey, AnyFunction>>([]);
	const manipulador: ProxyHandler<CSSStyleDeclaration> = {
		get(target, prop) {
			const value = Reflect_get(target, prop);

			if (typeof value === "function") {
				let metodos = metodosDe.get(target);
				if (!metodos) metodosDe.set(target, (metodos = new _Map<PropertyKey, AnyFunction>([])));
				let metodo = metodos.get(prop);
				if (!metodo || client.box.unproxy.get(metodo) !== value) {
					const nativo = value;
					metodo = new _ProxyNativo(nativo, {
						apply(fn, _that, args) {
							const r = Reflect_apply(fn, target, args);
							if (prop === "setProperty" || prop === "removeProperty") sincronizar(target);

							return r;
						},
					});
					client.box.unproxy.set(metodo, nativo);
					metodos.set(prop, metodo);
				}

				return metodo;
			}

			if (typeof value !== "string" || !value || !temEndereco(value)) return value;
			if (prop in CSSStyleDeclaration.prototype) return value;

			return unrewriteCss(value, client.context, { absoluto: computados.has(target) });
		},
		set(target, prop, value) {
			let ok: boolean;
			if (prop == "cssText" || value == "" || typeof value !== "string" || !temEndereco(value)) {
				ok = Reflect_set(target, prop, value);
			} else {
				ok = Reflect_set(target, prop, rewriteCss(value, client.context, client.meta));
			}
			sincronizar(target);

			return ok;
		},
	};
	const vistaDoEstilo = (style: CSSStyleDeclaration): CSSStyleDeclaration => {
		// A declaração computada é nova a cada chamada, e a vista dela não se guarda.
		if (computados.has(style)) return new _ProxyNativo(style, manipulador);
		const pronta = vistas.get(style);
		if (pronta) return pronta;
		const vista = new _ProxyNativo(style, manipulador);
		vistas.set(style, vista);

		return vista;
	};

	trocarRapida(client, client.global, "getComputedStyle", (anterior) =>
		function (this: unknown, ...args: any[]) {
			const style = Reflect_apply(anterior, this, args) as CSSStyleDeclaration;
			if (!style || typeof style !== "object") return style;
			computados.add(style);

			return vistaDoEstilo(style);
		},
	);
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

	// O valor do Typed OM volta ao site com o texto dele, como o `cssText`.
	client.Proxy("CSSStyleValue.prototype.toString", {
		apply(ctx) {
			const texto = ctx.call();
			ctx.return(typeof texto === "string" && texto.includes("url(") ? unrewriteCss(texto, client.context) : texto);
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
