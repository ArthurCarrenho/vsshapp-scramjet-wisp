import { htmlRules } from "@/shared/htmlRules";
import {
	String,
	Reflect_apply,
	TextEncoder_encode,
	Object_keys,
	Object_defineProperty,
	_URL,
	_Map,
	_Set,
} from "@/shared/snapshot";
import { base64Decode, bytesToBase64 } from "@/shared/util";
import { rewriteCss, unrewriteCss } from "@rewriters/css";
import { rewriteHtml, rewriteImportMap, unrewriteHtml } from "@rewriters/html";
import { rewriteJs } from "@rewriters/js";
import { rewriteBlob, unrewriteUrl } from "@rewriters/url";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
import {
	getScriptBlockTypeString,
	isHtmlMimeType,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";
import { ForeignContext } from "@/shared/rewriters/html";
import { comoOriginal } from "@/shared/confiavel";
import { vistaDe } from "@client/janela-cruzada";
import { allowNativo } from "@/shared/permissoes";
import { trocarRapida } from "@client/shared/troca-rapida";
import { QP } from "@/fetch/parse";

export function foreignContextForElement(
	client: ScramjetClient,
	element: Element,
): ForeignContext {
	if (client.box.instanceof(element, "SVGElement")) return "svg";
	if (client.box.instanceof(element, "MathMLElement")) return "math";
	return "html";
}

// NOTE: NOT INCLUSIVE OF THE CURRENT ELEMENT
export function insideForeignContext(
	client: ScramjetClient,
	element: Element | null,
): ForeignContext {
	let current: Element | null = element.parentElement;

	while (current) {
		const context = foreignContextForElement(client, current);
		if (context !== "html") return context;
		// EXPLICITLY an html context, don't go up further
		if (client.box.instanceof(current, "SVGForeignObjectElement"))
			return "html";
		current = current.parentElement;
	}

	return "html";
}

const temEnderecoCss = (v: string) => v.indexOf("url(") >= 0 || v.indexOf("URL(") >= 0 || /@import/i.test(v);

// A regra de `htmlRules` que reescreve o atributo `nome` num elemento `tag`, ou nenhuma.
function regraDoAtributo(nome: string, tag: string) {
	const chave = nome.toLowerCase();

	return htmlRules.find((rule) => {
		const r = rule[chave];
		if (!r || typeof r === "function") return false;

		return r === "*" || r.includes(tag);
	});
}

// O `<script>` de HTML e o de SVG rodam o texto que levam, e o motor reescreve os dois.
function ehScript(client: ScramjetClient, element: unknown): boolean {
	return (
		client.box.instanceof(element, "HTMLScriptElement") ||
		client.box.instanceof(element, "SVGScriptElement")
	);
}

function scriptBlockTypeForElement(
	client: ScramjetClient,
	element: Element,
): string {
	const hasType = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"type",
	) as boolean;
	const hasLanguage = client.natives.call(
		"Element.prototype.hasAttribute",
		element,
		"language",
	) as boolean;
	const type = hasType
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"type",
			) as string | null)
		: null;
	const language = hasLanguage
		? (client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"language",
			) as string | null)
		: null;
	return getScriptBlockTypeString(type, language, hasType, hasLanguage);
}

// TODO: this is pretty bad. really this whole file sucks
function collectAttributeMap(
	client: ScramjetClient,
	element: Element,
	overrideName: string,
	overrideValue: unknown,
) {
	const attrs: Record<string, string | undefined> = {};
	const attrNames =
		client.natives.call("Element.prototype.getAttributeNames", element) ?? [];

	for (const attrName of attrNames) {
		if (String(attrName).startsWith("scramjet-attr")) continue;
		const value = client.natives.call(
			"Element.prototype.getAttribute",
			element,
			attrName,
		);
		attrs[String(attrName).toLowerCase()] =
			typeof value === "string" ? value : undefined;
	}

	attrs[String(overrideName).toLowerCase()] = String(overrideValue);
	return attrs;
}

// O endereço que um elemento guarda, como o site o escreveu. Um `blob:` vai ao navegador com a
// origem do motor (ver `htmlRules.ts`), e volta à página com a origem do site, que é a que o
// `URL.createObjectURL` deu a ela.
function enderecoDoSite(client: ScramjetClient, nativo: string): string {
	if (typeof nativo === "string" && nativo.startsWith("blob:")) {
		try {
			return rewriteBlob(nativo, client.context, client.meta);
		} catch {
			return nativo;
		}
	}

	return unrewriteUrl(nativo, client.context);
}

export default function (client: ScramjetClient, self: typeof window) {
	const attrObject = {
		nonce: [self.HTMLElement],
		integrity: [self.HTMLScriptElement, self.HTMLLinkElement],
		csp: [self.HTMLIFrameElement],
		credentialless: [self.HTMLIFrameElement],
		src: [
			self.HTMLImageElement,
			self.HTMLMediaElement,
			self.HTMLIFrameElement,
			self.HTMLFrameElement,
			self.HTMLEmbedElement,
			self.HTMLScriptElement,
			self.HTMLSourceElement,
			self.HTMLTrackElement,
			self.HTMLInputElement,
		],
		href: [self.HTMLAnchorElement, self.HTMLLinkElement, self.HTMLAreaElement, self.HTMLBaseElement],
		data: [self.HTMLObjectElement],
		action: [self.HTMLFormElement],
		formaction: [self.HTMLButtonElement, self.HTMLInputElement],
		srcdoc: [self.HTMLIFrameElement],
		poster: [self.HTMLVideoElement],
		imagesrcset: [self.HTMLLinkElement],
		content: [self.HTMLMetaElement],
		allow: [self.HTMLIFrameElement],
	};

	const urlinterfaces = [
		self.HTMLAnchorElement.prototype,
		self.HTMLAreaElement.prototype,
	];
	const originalhrefs = [
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAnchorElement.prototype,
			"href",
		),
		client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.HTMLAreaElement.prototype,
			"href",
		),
	];

	const attrs = Object_keys(attrObject);

	// A propriedade do atributo `formaction` se chama `formAction`. Sem a troca dela, a página que
	// escreve `botao.formAction = "/enviar"` deixa no atributo o endereço cru, e o formulário vai
	// para a origem do motor.
	const propriedadeDe: Record<string, string> = { formaction: "formAction" };

	for (const attr of attrs) {
		for (const element of attrObject[attr]) {
			if (!element) continue;
			const propriedade = propriedadeDe[attr] ?? attr;
			const descriptor = client.natives.call(
				"Object.getOwnPropertyDescriptor",
				null,
				element.prototype,
				propriedade,
			);
			// O atributo sem propriedade no Chrome (`imagesrcset`, que é `imageSrcset`) não ganha
			// uma.
			if (!descriptor) continue;
			const acessores = {
				get() {
					// O `<base>` guarda o endereço do site no atributo, e o navegador o resolveria
					// contra o endereço do motor.
					if (attr === "href" && element === self.HTMLBaseElement) {
						const cru = this.getAttribute("href");
						if (cru === null) return "";
						try {
							return new _URL(cru, client.url).href;
						} catch {
							return cru;
						}
					}
					if (["src", "data", "href", "action", "formaction", "poster"].includes(attr)) {
						return enderecoDoSite(client, descriptor.get.call(this));
					}
					// O `content` de um `<meta>` só muda numa CSP, e o do site está no atributo guardado.
					if (attr === "content" || attr === "allow" || attr === "integrity") {
						return this.getAttribute(attr) ?? "";
					}

					return descriptor.get.call(this);
				},
				set(value: any) {
					return this.setAttribute(attr, value);
				},
			};
			// vssh fork: o getter e o setter se apresentam como os nativos que eles substituem: o
			// `toString` sai do nativo (pelo `unproxy`, que o `Function.prototype.toString` do motor
			// consulta), e `name` e `length` são copiados. Sem isso, ler
			// `Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href").get` devolvia o
			// corpo deste arquivo minificado.
			for (const [novo, nativo] of [
				[acessores.get, descriptor?.get],
				[acessores.set, descriptor?.set],
			] as const) {
				if (typeof nativo !== "function") continue;
				client.box.unproxy.set(novo, nativo);
				Object_defineProperty(novo, "name", {
					value: nativo.name,
					configurable: true,
				});
				Object_defineProperty(novo, "length", {
					value: nativo.length,
					configurable: true,
				});
			}
			Object_defineProperty(element.prototype, propriedade, {
				get: acessores.get,
				set: acessores.set,
			});
		}
	}

	client.Trap("HTMLImageElement.prototype.currentSrc", {
		get(ctx) {
			const currentSrc = ctx.get() as string;
			if (!currentSrc) return currentSrc;
			return enderecoDoSite(client, currentSrc);
		},
	});

	// note that href is not here
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		for (const i in urlinterfaces) {
			const target = urlinterfaces[i];
			const desc = originalhrefs[i];
			client.RawTrap(target, prop, {
				get(ctx) {
					const href = desc.get.call(ctx.this);
					if (!href) return href;

					const url = new URL(unrewriteUrl(href, client.context));

					return url[prop];
				},
				// vssh fork: o setter nativo mexeria no endereço do motor (o `search` dele leva os
				// parâmetros do motor). O componente muda no endereço do site, e o `href` inteiro
				// volta pelo setter que o reescreve.
				set(ctx, valor) {
					if (prop === "origin") return;
					const href = desc.get.call(ctx.this);
					if (!href) return;
					let url: URL;
					try {
						url = new _URL(unrewriteUrl(href, client.context));
					} catch {
						return;
					}
					(url as any)[prop] = valor;
					(ctx.this as HTMLAnchorElement).href = url.href;
				},
			});
		}
	}

	client.Trap("Node.prototype.baseURI", {
		get(ctx) {
			const nativo = ctx.get() as string;
			const node = ctx.this as Node;
			const doc = client.box.instanceof(node, "Document")
				? (node as Document)
				: node.ownerDocument;
			// vssh fork: o nó de outro documento tem a base dele: a de um quadro do motor é o endereço
			// daquele site, e a de um documento inerte (`parseHTMLUnsafe`) é `about:blank`.
			if (doc && doc !== self.document) {
				let dono: ScramjetClient | undefined;
				try {
					dono = (doc as any)[SCRAMJETCLIENT];
				} catch {}
				if (!dono)
					return typeof nativo === "string" && nativo.startsWith(client.context.prefix.href)
						? client.unrewriteUrl(nativo)
						: nativo;
			}
			const base = doc?.querySelector("base[href]") as HTMLBaseElement | null;

			if (base) {
				const href = base.getAttribute("href") || base.href;
				if (href) return new URL(href, client.url.href).href;
			}

			return client.url.href;
		},
		set() {
			return false;
		},
	});

	client.Proxy("Element.prototype.getAttribute", {
		apply(ctx) {
			const [name] = ctx.args;

			if (name.startsWith("scramjet-attr")) {
				return ctx.return(null);
			}

			if (
				client.natives.call(
					"Element.prototype.hasAttribute",
					ctx.this,
					`scramjet-attr-${name}`,
				)
			) {
				const attrib = ctx.fn.call(ctx.this, `scramjet-attr-${name}`);
				if (attrib === null) return ctx.return("");

				return ctx.return(attrib);
			}
		},
	});

	client.Proxy("Element.prototype.getAttributeNames", {
		apply(ctx) {
			const attrNames = ctx.call() as string[];
			const cleaned = attrNames.filter(
				(attr) => !attr.startsWith("scramjet-attr"),
			);

			ctx.return(cleaned);
		},
	});

	client.Proxy("Element.prototype.getAttributeNode", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith("scramjet-attr"))
				return ctx.return(null);
		},
	});

	client.Proxy("Element.prototype.hasAttribute", {
		apply(ctx) {
			if (String(ctx.args[0]).startsWith("scramjet-attr"))
				return ctx.return(false);
		},
	});

	client.Proxy("Element.prototype.setAttribute", {
		apply(ctx) {
			// O navegador recusa a chamada sem os dois argumentos ou num `this` que não é elemento.
			// Ela vai a ele como veio, e o erro que a página recebe é o do Chrome.
			if (ctx.args.length < 2 || !client.box.instanceof(ctx.this, "Element")) return;
			let [name, value] = ctx.args;
			const tagName = ctx.this.tagName.toLowerCase();

			// setAttribute() stringifies its arguments, so callers are free to pass a non-string
			// name (e.g. setAttribute(123, "x")). Coerce it the same way the DOM does, otherwise
			// name.toLowerCase() below throws and takes the whole page down.
			name = String(name);
			ctx.args[0] = name;
			if (value != null) value = String(value);
			ctx.args[1] = value;

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(tagName);
			});

			if (ruleList) {
				const ret = ruleList.fn(
					value,
					client.context,
					client.meta,
					ruleList.fn.length > 3 ? collectAttributeMap(client, ctx.this, name, value) : undefined,
				);
				if (ret == null) {
					client.natives.call(
						"Element.prototype.removeAttribute",
						ctx.this,
						name,
					);
					ctx.fn.call(ctx.this, `scramjet-attr-${name}`, value);
					ctx.return(undefined);

					return;
				}
				ctx.args[1] = ret;
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`, value);
				// O `allow` que vai ao navegador depende do endereço do quadro, e é refeito antes de
				// o `src` novo navegar.
				if (tagName === "iframe" && name.toLowerCase() === "src") {
					const allow = client.natives.call(
						"Element.prototype.getAttribute",
						ctx.this,
						"scramjet-attr-allow",
					);
					if (allow != null)
						ctx.fn.call(
							ctx.this,
							"allow",
							allowNativo(allow, ret, client.context, client.meta),
						);
				}
			}
		},
	});

	client.Proxy(["Element.prototype.setAttributeNode", "Element.prototype.setAttributeNodeNS"], {
		apply(ctx) {
			// O que não é um `Attr` vai ao navegador, que recusa com o erro dele.
			if (!client.box.instanceof(ctx.args[0], "Attr") || !client.box.instanceof(ctx.this, "Element"))
				return;
			const attr = ctx.args[0];
			const name = attr.name;
			const value = attr.value;
			const tagName = ctx.this.tagName.toLowerCase();

			const ruleList = htmlRules.find((rule) => {
				const r = rule[name.toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false;

				return r.includes(tagName);
			});

			if (ruleList) {
				const ret = ruleList.fn(
					value,
					client.context,
					client.meta,
					ruleList.fn.length > 3 ? collectAttributeMap(client, ctx.this, name, value) : undefined,
				);

				if (ret == null) {
					client.natives.call(
						"Element.prototype.removeAttribute",
						ctx.this,
						name,
					);
					client.natives.call(
						"Element.prototype.setAttribute",
						ctx.this,
						`scramjet-attr-${name}`,
						value,
					);
					ctx.return(null);

					return;
				}

				attr.value = ret;
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					`scramjet-attr-${name}`,
					value,
				);
			}
		},
	});

	client.Proxy("Element.prototype.setAttributeNS", {
		apply(ctx) {
			// TODO: this could leak by like calling stringify twice or some dumb shit lol
			const name = String(ctx.args[1]);
			const value = String(ctx.args[2]);

			const ruleList = htmlRules.find((rule) => {
				const r = rule[String(name).toLowerCase()];
				if (!r) return false;
				if (r === "*") return true;
				if (typeof r === "function") return false; // this can't happen but ts

				return r.includes(ctx.this.tagName.toLowerCase());
			});

			if (ruleList) {
				ctx.args[2] = ruleList.fn(
					value,
					client.context,
					client.meta,
					ruleList.fn.length > 3 ? collectAttributeMap(client, ctx.this, name, value) : undefined,
				);
				client.natives.call(
					"Element.prototype.setAttribute",
					ctx.this,
					`scramjet-attr-${ctx.args[1]}`,
					value,
				);
			}
		},
	});

	// this is separate from the regular href handlers because it returns an SVGAnimatedString
	client.Trap("SVGAnimatedString.prototype.baseVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href || !href.startsWith(client.context.prefix.href)) return href;
			try {
				const escrito = new _URL(href).searchParams.get(QP.autor);
				if (escrito !== null) return escrito;
			} catch {}

			return unrewriteUrl(href, client.context);
		},
		set(ctx, val: string) {
			const texto = String(val);
			// Um `#id` aponta para dentro do documento e vai como está, como na regra do atributo.
			if (texto.startsWith("#")) return ctx.set(texto);
			ctx.set(client.rewriteUrl(texto, /^[a-z][a-z0-9+.-]*:/i.test(texto) ? undefined : { autor: texto }));
		},
	});
	client.Trap("SVGAnimatedString.prototype.animVal", {
		get(ctx) {
			const href = ctx.get() as string;
			if (!href) return href;

			return unrewriteUrl(href, client.context);
		},
		// it has no setter
	});

	client.Proxy("Element.prototype.removeAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(undefined);
			if (
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`);
			}
		},
	});

	client.Proxy("Element.prototype.toggleAttribute", {
		apply(ctx) {
			const name = String(ctx.args[0]);
			if (name.startsWith("scramjet-attr")) return ctx.return(false);
			if (
				client.natives.call("Element.prototype.hasAttribute", ctx.this, name)
			) {
				ctx.fn.call(ctx.this, `scramjet-attr-${ctx.args[0]}`);
			}
		},
	});

	client.Trap("Element.prototype.innerHTML", {
		set(ctx, value: string) {
			// null specifically becomes "" and not "null". undefined does not
			if (value === null) return;
			const scriptBlockType = ehScript(client, ctx.this)
				? scriptBlockTypeForElement(client, ctx.this)
				: null;
			const reescrever = (html: string) => {
				if (
					ehScript(client, ctx.this) &&
					isScriptType(scriptBlockType)
				) {
					client.natives.call(
						"Element.prototype.setAttribute",
						ctx.this,
						"scramjet-attr-script-source-src",
						bytesToBase64(TextEncoder_encode(html)),
					);

					return rewriteJs(
						html,
						"(anonymous script element)",
						client.context,
						client.meta,
						isModuleScriptType(scriptBlockType),
					) as string;
				}
				if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
					return rewriteCss(html, client.context, client.meta);
				}
				try {
					return rewriteHtml(html, client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						apisource: "set Element.prototype.innerHTML",
						foreignContext: foreignContextForElement(client, ctx.this),
					});
				} catch {
					return html;
				}
			};

			ctx.set(
				comoOriginal(
					client,
					ehScript(client, ctx.this)
						? "TrustedScript"
						: "TrustedHTML",
					value,
					reescrever,
					ehScript(client, ctx.this)
						? "HTMLScriptElement innerHTML"
						: "Element innerHTML",
				),
			);
		},
		get(ctx) {
			if (ehScript(client, ctx.this)) {
				const scriptSource = client.natives.call(
					"Element.prototype.getAttribute",
					ctx.this,
					"scramjet-attr-script-source-src",
				);

				if (scriptSource) {
					return base64Decode(scriptSource);
				}

				return ctx.get();
			}
			if (client.box.instanceof(ctx.this, "HTMLStyleElement")) {
				return ctx.get();
			}

			return htmlDoSite(ctx.this as Node, false);
		},
	});

	const rewriteTextForElement = (element: Element, value: string) => {
		const scriptBlockType = ehScript(client, element)
			? scriptBlockTypeForElement(client, element)
			: null;

		// vssh fork: um import map inserido por script tem os endereços do site, e o navegador os
		// resolveria contra a origem do motor.
		if (
			client.box.instanceof(element, "HTMLScriptElement") &&
			String(scriptBlockType).toLowerCase() === "importmap"
		) {
			client.natives.call(
				"Element.prototype.setAttribute",
				element,
				"scramjet-attr-script-source-src",
				bytesToBase64(TextEncoder_encode(value)),
			);

			return rewriteImportMap(value, client.context, client.meta);
		}
		if (
			ehScript(client, element) &&
			isScriptType(scriptBlockType)
		) {
			const newval: string = rewriteJs(
				value,
				"(anonymous script element)",
				client.context,
				client.meta,
				isModuleScriptType(scriptBlockType),
			) as string;
			client.natives.call(
				"Element.prototype.setAttribute",
				element,
				"scramjet-attr-script-source-src",
				bytesToBase64(TextEncoder_encode(value)),
			);

			return newval;
		} else if (client.box.instanceof(element, "HTMLStyleElement")) {
			return rewriteCss(value, client.context, client.meta);
		} else {
			return value;
		}
	};
	const getTextForElement = (element: Element, text: string) => {
		if (ehScript(client, element)) {
			const scriptSource = client.natives.call(
				"Element.prototype.getAttribute",
				element,
				"scramjet-attr-script-source-src",
			);
			if (scriptSource) return base64Decode(scriptSource);
			return text;
		}
		if (client.box.instanceof(element, "HTMLStyleElement")) {
			return unrewriteCss(text, client.context);
		}
		if (element && client.box.instanceof(element, "Element")) {
			return comScriptsOriginais(element, text);
		}
		return text;
	};

	// O `textContent` de um elemento junta o texto dos scripts que ele contém, e o de cada script
	// reescrito volta ao original, na ordem do documento.
	const comScriptsOriginais = (element: Element, text: string) => {
		let scripts: ArrayLike<Element>;
		try {
			scripts = client.natives.call(
				"Element.prototype.querySelectorAll",
				element,
				"script[scramjet-attr-script-source-src]",
			);
		} catch {
			return text;
		}
		if (!scripts || scripts.length === 0) return text;
		let saida = "";
		let cursor = 0;
		for (let i = 0; i < scripts.length; i++) {
			const script = scripts[i];
			const reescrito = client.descriptors.get(
				"Node.prototype.textContent",
				script,
			) as string;
			if (!reescrito) continue;
			const onde = text.indexOf(reescrito, cursor);
			if (onde < 0) continue;
			const fonte = client.natives.call(
				"Element.prototype.getAttribute",
				script,
				"scramjet-attr-script-source-src",
			);
			saida += text.slice(cursor, onde) + base64Decode(fonte);
			cursor = onde + reescrito.length;
		}

		return saida + text.slice(cursor);
	};

	// textContent/nodeValue live on Node, so they also fire for a Text node that is a *child* of a
	// <script>/<style> (e.g. `styleChild.textContent = css`). Rewriting must key off that child's
	// PARENT element, not the text node itself — otherwise injected JS/CSS escapes unrewritten.
	const textTargetOf = (node: any) => {
		if (client.box.instanceof(node, "Text"))
			return client.descriptors.get("Node.prototype.parentElement", node);
		return node;
	};

	client.Trap(
		["Node.prototype.textContent", "HTMLScriptElement.prototype.textContent"],
		{
			set(ctx, value) {
				return ctx.set(
					comoOriginal(
						client,
						"TrustedScript",
						value,
						(texto) => rewriteTextForElement(textTargetOf(ctx.this), texto),
						ehScript(client, ctx.this)
							? "HTMLScriptElement textContent"
							: undefined,
					),
				);
			},
			get(ctx) {
				return getTextForElement(textTargetOf(ctx.this), ctx.get());
			},
		},
	);
	client.Trap(
		[
			"HTMLElement.prototype.innerText",
			"HTMLScriptElement.prototype.innerText",
		],
		{
			set(ctx, value: string) {
				return ctx.set(
					comoOriginal(
						client,
						"TrustedScript",
						value,
						(texto) => rewriteTextForElement(ctx.this, texto),
						ehScript(client, ctx.this)
							? "HTMLScriptElement innerText"
							: undefined,
					),
				);
			},
			get(ctx) {
				return getTextForElement(ctx.this, ctx.get());
			},
		},
	);

	client.Trap("Element.prototype.outerHTML", {
		set(ctx, value: string) {
			ctx.set(
				comoOriginal(
					client,
					"TrustedHTML",
					value,
					(html) =>
						rewriteHtml(html, client.context, client.meta, {
							loadScripts: false,
							inline: true,
							source: client.url.href,
							apisource: "set Element.prototype.outerHTML",
							foreignContext: insideForeignContext(client, ctx.this),
						}),
					"Element outerHTML",
				),
			);
		},
		get(ctx) {
			return htmlDoSite(ctx.this as Node, true);
		},
	});

	client.Proxy("Element.prototype.setHTMLUnsafe", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "set Element.prototype.setHTMLUnsafe",
				foreignContext: foreignContextForElement(client, ctx.this),
			});
		},
	});

	// vssh fork: o `innerHTML` e o `setHTMLUnsafe` de um shadow root são outros acessores, do
	// `ShadowRoot`, e o HTML que o site põe ali passa pelo mesmo reescritor do `Element`.
	const htmlDoShadow = (html: string, apisource: string) =>
		rewriteHtml(html, client.context, client.meta, {
			loadScripts: false,
			inline: true,
			source: client.url.href,
			apisource,
		});
	client.Trap("ShadowRoot.prototype.innerHTML", {
		set(ctx, value: string) {
			if (value === null) return ctx.set("");
			ctx.set(
				comoOriginal(
					client,
					"TrustedHTML",
					value,
					(html) => htmlDoShadow(html, "set ShadowRoot.prototype.innerHTML"),
					"ShadowRoot innerHTML",
				),
			);
		},
		get(ctx) {
			// Um shadow root não se copia: os filhos vão para o conteúdo de um `<template>`, que o
			// navegador serializa como o `innerHTML` do shadow root.
			const modelo = client.natives.call("Document.prototype.createElement", self.document, "template") as HTMLTemplateElement;
			const conteudo = modelo.content;
			const filhos = (ctx.this as ShadowRoot).childNodes;
			for (let i = 0; i < filhos.length; i++)
				client.natives.call(
					"Node.prototype.appendChild",
					conteudo,
					client.natives.call("Node.prototype.cloneNode", filhos[i], true),
				);
			restaurarCopia(conteudo);

			return client.descriptors.store["Element.prototype.innerHTML"].get.call(modelo);
		},
	});
	client.Proxy("ShadowRoot.prototype.setHTMLUnsafe", {
		apply(ctx) {
			ctx.args[0] = htmlDoShadow(String(ctx.args[0]), "ShadowRoot.prototype.setHTMLUnsafe");
		},
	});
	client.Proxy("ShadowRoot.prototype.getHTML", {
		apply(ctx) {
			ctx.return(unrewriteHtml(ctx.call()));
		},
	});

	// vssh fork: o `XMLSerializer` escreve os atributos como estão no elemento: o endereço do motor e
	// os `scramjet-attr-` junto. Ele serializa uma cópia, com o que o site escreveu de volta no lugar,
	// e o nó do site fica como está. Exportar um gráfico com `serializeToString(svg)` é o caso comum.
	// O tipo e o nome de um nó pelos acessores nativos, sem `instanceof`: a cópia anda por todos os
	// elementos dela.
	const tipoDoNo = Object.getOwnPropertyDescriptor(self.Node.prototype, "nodeType")!.get!;
	const nomeLocal = Object.getOwnPropertyDescriptor(self.Element.prototype, "localName")!.get!;
	const conteudoDoModelo = Object.getOwnPropertyDescriptor(self.HTMLTemplateElement.prototype, "content")!.get!;
	const restaurarCopia = (raiz: Node) => {
		const tipo = tipoDoNo.call(raiz);
		const elementos: Element[] = [];
		if (tipo === 1) elementos.push(raiz as Element);
		if (tipo === 1 || tipo === 9 || tipo === 11) {
			const todos = client.natives.call(
				tipo === 1
					? "Element.prototype.querySelectorAll"
					: tipo === 9
						? "Document.prototype.querySelectorAll"
						: "DocumentFragment.prototype.querySelectorAll",
				raiz as Element,
				"*",
			) as ArrayLike<Element>;
			for (let i = 0; i < todos.length; i++) elementos.push(todos[i]);
		}
		const textoNativo = client.descriptors.store["Node.prototype.textContent"];
		for (const el of elementos) {
			const local = nomeLocal.call(el);
			// O conteúdo de um `<template>` é outro fragmento, fora do `querySelectorAll`.
			if (local === "template" && client.box.instanceof(el, "HTMLTemplateElement")) restaurarCopia(conteudoDoModelo.call(el));
			// O CSS de um `<style>` volta com os endereços do site.
			if (local === "style") {
				const texto = textoNativo?.get?.call(el);
				if (typeof texto === "string" && (texto.includes("url(") || /@import/i.test(texto)))
					textoNativo?.set?.call(el, unrewriteCss(texto, client.context));
			}
			const nomes = client.natives.call("Element.prototype.getAttributeNames", el) as string[];
			for (const nome of nomes) {
				if (!nome.startsWith("scramjet-attr-")) continue;
				const valor = client.natives.call("Element.prototype.getAttribute", el, nome) as string;
				const original = nome.slice("scramjet-attr-".length);
				if (original === "script-source-src") {
					// O texto vai pelo setter nativo, sem a reescrita que o do motor faria de novo.
					textoNativo?.set?.call(el, base64Decode(valor));
				} else {
					client.natives.call("Element.prototype.setAttribute", el, original, valor);
				}
				client.natives.call("Element.prototype.removeAttribute", el, nome);
			}
		}
	};
	// O texto serializado com o que o site escreveu de volta. O serializador do navegador escreve
	// cada atributo como ` nome="valor"`, com `&` e `"` escapados, e o original guardado em
	// `scramjet-attr-<nome>` está escapado do mesmo jeito: o valor muda de lugar sem reescape. O
	// texto de um `<script>` e de um `<style>` sai sem escape, até o fechamento dele. Devolve `null`
	// para o texto que este caminho não lê com segurança, e quem chama usa a cópia.
	const TAG = /<!--[\s\S]*?-->|<(script|style)\b((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)\s*>([\s\S]*?)<\/\1>|<([A-Za-z][^\s/>]*)((?:\s+[^\s"'>/=]+(?:="[^"]*")?)*)(\s*\/?)>/g;
	const ATRIBUTO = /\s+([^\s"'>/=]+)(?:="([^"]*)")?/g;
	const atributosDoSite = (texto: string): [string, string | null] => {
		const lista: [string, string | undefined][] = [];
		const guardados = new _Map<string, string>([]);
		let fonte: string | null = null;
		ATRIBUTO.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = ATRIBUTO.exec(texto))) {
			if (m[1].startsWith("scramjet-attr-")) guardados.set(m[1].slice(14), m[2] ?? "");
			lista.push([m[1], m[2]]);
		}
		if (guardados.size === 0) return [texto, null];
		const presentes: Set<string> = new (_Set as any)(lista.map((a) => a[0]));
		let saida = "";
		for (const [nome, valor] of lista) {
			if (nome.startsWith("scramjet-attr-")) {
				const original = nome.slice(14);
				if (original === "script-source-src") {
					fonte = valor ?? "";
					continue;
				}
				// Um atributo que a regra tirou do elemento volta no lugar do guardado.
				if (!presentes.has(original)) saida += ` ${original}="${valor ?? ""}"`;
				continue;
			}
			const doSite = guardados.has(nome) ? guardados.get(nome)! : valor;
			saida += doSite === undefined ? ` ${nome}` : ` ${nome}="${doSite}"`;
		}

		return [saida, fonte];
	};
	const desfazerSerializado = (html: string): string | null => {
		try {
			return html.replace(TAG, (tudo, bruto, attrsBruto, conteudo, tag, attrs, fim) => {
				if (bruto) {
					const [novos, fonte] = atributosDoSite(attrsBruto ?? "");
					let texto = conteudo as string;
					if (fonte !== null) texto = base64Decode(fonte);
					else if (bruto.toLowerCase() === "style" && temEnderecoCss(texto)) texto = unrewriteCss(texto, client.context);

					return `<${bruto}${novos}>${texto}</${bruto}>`;
				}
				if (!tag || !attrs || attrs.indexOf("scramjet-attr-") < 0) return tudo;

				return `<${tag}${atributosDoSite(attrs)[0]}${fim}>`;
			});
		} catch {
			return null;
		}
	};

	// vssh fork: o `innerHTML` e o `outerHTML` lidos são os do navegador, sobre uma cópia com o que
	// o site escreveu de volta no lugar. Reserializar pelo analisador do motor mudava a forma do
	// texto: dentro de um `<svg>`, `<path/>` no lugar do `<path></path>` que o Chrome escreve.
	const htmlDoSite = (no: Node, externo: boolean): string => {
		const nome0 = externo ? "Element.prototype.outerHTML" : "Element.prototype.innerHTML";
		const nativo = client.descriptors.store[nome0].get.call(no) as string;
		// O caso comum sai aqui: um texto sem atributo guardado e sem endereço do motor não mudaria
		// na cópia.
		if (nativo.indexOf("scramjet-attr-") < 0 && nativo.indexOf(client.context.prefix.href) < 0) return nativo;
		const desfeito = desfazerSerializado(nativo);
		if (desfeito !== null) return desfeito;
		const copia = client.natives.call("Node.prototype.cloneNode", no, true) as Node;
		restaurarCopia(copia);
		const nome = externo ? "Element.prototype.outerHTML" : "Element.prototype.innerHTML";

		return client.descriptors.store[nome].get.call(copia);
	};

	if (self.XMLSerializer)
		client.Proxy("XMLSerializer.prototype.serializeToString", {
			apply(ctx) {
				const no = ctx.args[0];
				if (!client.box.instanceof(no, "Node")) return;
				const copia = client.natives.call("Node.prototype.cloneNode", no, true) as Node;
				restaurarCopia(copia);
				ctx.args[0] = copia;
			},
		});

	client.Proxy("Element.prototype.getHTML", {
		apply(ctx) {
			ctx.return(unrewriteHtml(ctx.call()));
		},
	});

	client.Proxy("Element.prototype.insertAdjacentHTML", {
		apply(ctx) {
			ctx.args[1] = comoOriginal(
				client,
				"TrustedHTML",
				ctx.args[1],
				(html) =>
					rewriteHtml(html, client.context, client.meta, {
						loadScripts: false,
						inline: true,
						source: client.url.href,
						apisource: "set Element.prototype.insertAdjacentHTML",
						foreignContext: foreignContextForElement(client, ctx.this),
					}),
				"Element insertAdjacentHTML",
			);
		},
	});

	// vssh fork: um elemento de outro documento (o de `DOMParser`, de `Document.parseHTMLUnsafe`,
	// da resposta de um XHR) chega à página com os atributos como o site os escreveu, porque o motor
	// só reescreve o que entra no documento dele. Um `<img onerror>` assim rodaria o código sem
	// reescrita no momento em que o elemento entra. A árvore é reescrita quando é inserida, como o
	// `setAttribute` faria com cada atributo; o que já tem a marca `scramjet-attr-` fica como está.
	const donoDoNo = Object.getOwnPropertyDescriptor(self.Node.prototype, "ownerDocument")!.get!;
	const nomeDaTag = Object.getOwnPropertyDescriptor(self.Element.prototype, "tagName")!.get!;
	const reescreverAtributos = (el: Element) => {
		const nomes = client.natives.call("Element.prototype.getAttributeNames", el) as string[];
		if (!nomes || nomes.length === 0) return;
		const tag = String(nomeDaTag.call(el)).toLowerCase();
		for (const nome of nomes) {
			if (nome.startsWith("scramjet-attr-") || nomes.includes(`scramjet-attr-${nome}`)) continue;
			const regra = regraDoAtributo(nome, tag);
			if (!regra) continue;
			const valor = client.natives.call("Element.prototype.getAttribute", el, nome) as string;
			const novo = regra.fn(valor, client.context, client.meta, regra.fn.length > 3 ? collectAttributeMap(client, el, nome, valor) : undefined);
			if (novo == null) client.natives.call("Element.prototype.removeAttribute", el, nome);
			else client.natives.call("Element.prototype.setAttribute", el, nome, novo);
			client.natives.call("Element.prototype.setAttribute", el, `scramjet-attr-${nome}`, valor);
		}
	};
	const reescreverArvore = (no: unknown, mesmoDocumento = false) => {
		// O caso comum sai primeiro, sem `instanceof`: um nó deste documento, ou o que não é nó.
		if (!mesmoDocumento) {
			try {
				if (donoDoNo.call(no) === self.document) return;
			} catch {
				return;
			}
		}
		const elemento = client.box.instanceof(no, "Element");
		if (!elemento && !client.box.instanceof(no, "DocumentFragment")) return;
		if (elemento) reescreverAtributos(no as Element);
		const todos = client.natives.call(
			elemento ? "Element.prototype.querySelectorAll" : "DocumentFragment.prototype.querySelectorAll",
			no as Element,
			"*",
		) as ArrayLike<Element>;
		for (let i = 0; i < todos.length; i++) reescreverAtributos(todos[i]);
	};
	// O resultado de uma transformação XSLT nasce no documento pedido, com os atributos que a folha
	// escreveu. O Chrome tirou o XSLT na versão 155; nas anteriores, o `XSLTProcessor` existe.
	client.Proxy(["XSLTProcessor.prototype.transformToFragment", "XSLTProcessor.prototype.transformToDocument"], {
		apply(ctx) {
			const resultado = ctx.call();
			const raiz = client.box.instanceof(resultado, "Document")
				? client.descriptors.get("Document.prototype.documentElement", resultado) ??
					(resultado as Document).documentElement
				: resultado;
			if (raiz) reescreverArvore(raiz, true);
			ctx.return(resultado);
		},
	});
	// A cópia que `importNode` faz já é deste documento, e leva os atributos do original.
	client.Proxy("Document.prototype.importNode", {
		apply(ctx) {
			const deFora = client.box.instanceof(ctx.args[0], "Node") && donoDoNo.call(ctx.args[0]) !== self.document;
			const copia = ctx.call();
			if (deFora) reescreverArvore(copia, true);
			ctx.return(copia);
		},
	});

	// Text nodes inserted into <style>/<script> (e.g.
	// style.appendChild(document.createTextNode(css)) — the pattern used by
	// webfont loaders and jQuery) previously escaped rewriting entirely, so
	// url()/@font-face went straight to the origin and failed on CORS.
	const rewriteInsertedNodes = (parent: Node, args: any[], limit: number) => {
		if (
			!client.box.instanceof(parent, "HTMLStyleElement") &&
			!ehScript(client, parent)
		)
			return;

		const rewriteTextNode = (node: Text) => {
			if (!node.data) return;
			// a node already living in a style/script has rewritten data; moving
			// it must not rewrite a second time
			const currentParent = client.descriptors.get(
				"Node.prototype.parentElement",
				node,
			);
			if (
				client.box.instanceof(currentParent, "HTMLStyleElement") ||
				ehScript(client, currentParent)
			)
				return;
			node.data = rewriteTextForElement(parent as Element, String(node.data));
		};

		for (let i = 0; i < limit && i < args.length; i++) {
			const node = args[i];
			if (typeof node === "string") {
				args[i] = rewriteTextForElement(parent as Element, node);
			} else if (client.box.instanceof(node, "Text")) {
				rewriteTextNode(node);
			} else if (client.box.instanceof(node, "DocumentFragment")) {
				const children = node.childNodes;
				for (let j = 0; j < children.length; j++) {
					const child = children[j];
					if (client.box.instanceof(child, "Text")) rewriteTextNode(child);
				}
			}
		}
	};

	client.Proxy(
		[
			"Node.prototype.appendChild",
			"Node.prototype.insertBefore",
			"Node.prototype.replaceChild",
		],
		{
			apply(ctx) {
				// only the first argument is the inserted node
				rewriteInsertedNodes(ctx.this, ctx.args, 1);
			},
		},
	);

	client.Proxy(
		[
			"Element.prototype.append",
			"Element.prototype.prepend",
			"Element.prototype.replaceChildren",
		],
		{
			apply(ctx) {
				rewriteInsertedNodes(ctx.this, ctx.args, ctx.args.length);
			},
		},
	);

	// A árvore de outro documento é reescrita ao entrar. A troca é uma função comum, por cima do
	// que o motor já pôs nesses métodos: inserir um nó é caminho quente, e uma segunda camada de
	// `client.Proxy` custava mais 400 ns por inserção.
	const inserir: [any, string, boolean][] = [
		[self.Node.prototype, "appendChild", true],
		[self.Node.prototype, "insertBefore", true],
		[self.Node.prototype, "replaceChild", true],
		[self.Document.prototype, "adoptNode", true],
		[self.Element.prototype, "append", false],
		[self.Element.prototype, "prepend", false],
		[self.Element.prototype, "replaceChildren", false],
		[self.Element.prototype, "before", false],
		[self.Element.prototype, "after", false],
		[self.Element.prototype, "replaceWith", false],
		[self.Document.prototype, "append", false],
		[self.Document.prototype, "prepend", false],
		[self.Document.prototype, "replaceChildren", false],
		[self.DocumentFragment.prototype, "append", false],
		[self.DocumentFragment.prototype, "prepend", false],
		[self.DocumentFragment.prototype, "replaceChildren", false],
		[self.CharacterData.prototype, "before", false],
		[self.CharacterData.prototype, "after", false],
		[self.CharacterData.prototype, "replaceWith", false],
	];
	for (const [proto, nome, umSo] of inserir)
		trocarRapida(client, proto, nome, (anterior) =>
			umSo
				? function (this: unknown, ...args: any[]) {
						reescreverArvore(args[0]);

						return Reflect_apply(anterior, this, args);
					}
				: function (this: unknown, ...args: any[]) {
						for (let i = 0; i < args.length; i++) reescreverArvore(args[i]);

						return Reflect_apply(anterior, this, args);
					},
		);
	trocarRapida(client, self.Element.prototype, "insertAdjacentElement", (anterior) =>
		function (this: unknown, ...args: any[]) {
			reescreverArvore(args[1]);

			return Reflect_apply(anterior, this, args);
		},
	);

	client.Proxy("Element.prototype.insertAdjacentText", {
		apply(ctx) {
			const where = String(ctx.args[0]).toLowerCase();
			// only afterbegin/beforeend insert into ctx.this itself
			if (where !== "afterbegin" && where !== "beforeend") return;
			if (
				client.box.instanceof(ctx.this, "HTMLStyleElement") ||
				ehScript(client, ctx.this)
			) {
				ctx.args[1] = rewriteTextForElement(ctx.this, String(ctx.args[1]));
			}
		},
	});

	client.Trap(["CharacterData.prototype.data", "Node.prototype.nodeValue"], {
		set(ctx, value) {
			if (!client.box.instanceof(ctx.this, "Text")) return ctx.set(value);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			return ctx.set(rewriteTextForElement(parent, String(value)));
		},
		get(ctx) {
			const value = ctx.get();
			if (typeof value !== "string" || !value) return value;
			if (!client.box.instanceof(ctx.this, "Text")) return value;
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			return getTextForElement(parent, value);
		},
	});

	// jQuery's DOMEval injects code via script.text
	client.Trap("HTMLScriptElement.prototype.text", {
		set(ctx, value) {
			ctx.set(
				comoOriginal(
					client,
					"TrustedScript",
					value,
					(texto) => rewriteTextForElement(ctx.this, texto),
					"HTMLScriptElement text",
				),
			);
		},
		get(ctx) {
			return getTextForElement(ctx.this, ctx.get());
		},
	});

	client.Proxy("Audio", {
		construct(ctx) {
			if (ctx.args[0]) ctx.args[0] = client.rewriteUrl(ctx.args[0]);
		},
	});
	client.Proxy("Text.prototype.appendData", {
		apply(ctx) {
			const text = String(ctx.args[0]);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			ctx.args[0] = rewriteTextForElement(parent, text);
		},
	});

	client.Proxy("Text.prototype.insertData", {
		apply(ctx) {
			const text = String(ctx.args[1]);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			ctx.args[1] = rewriteTextForElement(parent, text);
		},
	});

	client.Proxy("Text.prototype.replaceData", {
		apply(ctx) {
			const text = String(ctx.args[2]);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			ctx.args[2] = rewriteTextForElement(parent, text);
		},
	});

	client.Trap("Text.prototype.wholeText", {
		get(ctx) {
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			return getTextForElement(parent, ctx.get());
		},
		set(ctx, v) {
			const text = String(v);
			const parent = client.descriptors.get(
				"Node.prototype.parentElement",
				ctx.this,
			);
			return ctx.set(rewriteTextForElement(parent, text));
		},
	});

	client.Proxy("HTMLAnchorElement.prototype.toString", {
		apply(ctx) {
			const href = ctx.call();
			if (!href) return href;
			return ctx.return(unrewriteUrl(href, client.context));
		},
	});

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentWindow",
			"HTMLFrameElement.prototype.contentWindow",
			"HTMLObjectElement.prototype.contentWindow",
			"HTMLEmbedElement.prototype.contentWindow",
		],
		{
			get(ctx) {
				const realwin = ctx.get() as Window;
				if (!realwin) return realwin;

				try {
					if (!(SCRAMJETCLIENT in realwin)) {
						// hook the iframe before the client can start to steal globals out of it
						client.init.hookSubcontext(realwin, ctx.this);
					}
				} catch {
					// cross-origin iframe, can't do anything here
					return realwin;
				}

				return vistaDe(client, realwin);
			},
		},
	);

	client.Trap(
		[
			"HTMLIFrameElement.prototype.contentDocument",
			"HTMLFrameElement.prototype.contentDocument",
			"HTMLObjectElement.prototype.contentDocument",
			"HTMLEmbedElement.prototype.contentDocument",
		],
		{
			get(ctx) {
				const realwin = client.descriptors.get(
					`${ctx.this.constructor.name}.prototype.contentWindow`,
					ctx.this,
				);
				if (!realwin) return realwin;

				if (!(SCRAMJETCLIENT in realwin)) {
					client.init.hookSubcontext(realwin, ctx.this);
				}
				// o documento de um quadro de outra origem é `null`, como no Chrome
				if (vistaDe(client, realwin) !== realwin) return null;

				return realwin.document;
			},
		},
	);

	client.Proxy(
		[
			"HTMLIFrameElement.prototype.getSVGDocument",
			"HTMLObjectElement.prototype.getSVGDocument",
			"HTMLEmbedElement.prototype.getSVGDocument",
		],
		{
			apply(ctx) {
				const doc = ctx.call();
				if (doc) {
					// we trap the contentDocument, this is really the scramjet version
					return ctx.return(ctx.this.contentDocument);
				}
			},
		},
	);

	client.Proxy("DOMParser.prototype.parseFromString", {
		apply(ctx) {
			const html = String(ctx.args[0]);
			const mime = String(ctx.args[1]);
			// TODO: what do we do if it's xml/svg?
			if (!isHtmlMimeType(mime)) return;
			ctx.args[0] = rewriteHtml(html, client.context, client.meta, {
				loadScripts: false,
				inline: true,
				source: client.url.href,
				apisource: "DOMParser.prototype.parseFromString",
			});
		},
	});
}
