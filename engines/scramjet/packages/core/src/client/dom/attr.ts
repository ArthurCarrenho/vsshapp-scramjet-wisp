import { ScramjetClient } from "@client/index";
import {
	Number,
	Object_keys,
	Reflect_apply,
	Reflect_get,
	Reflect_has,
	Reflect_ownKeys,
	_WeakMap,
} from "@/shared/snapshot";

// O elemento dono de cada `NamedNodeMap`, e da vista dele que o site recebe. O `setNamedItem` e o
// `setNamedItemNS` põem um atributo como o `setAttributeNode`, e o vão fazer pelo elemento.
const donos = new _WeakMap<object, Element>([]);

export default function (client: ScramjetClient) {
	client.Trap("Element.prototype.attributes", {
		get(ctx) {
			const map = ctx.get() as NamedNodeMap;
			donos.set(map, ctx.this as Element);
			const proxy = new Proxy(map, {
				get(target, prop, _receiver) {
					const value = Reflect_get(target, prop);

					if (prop === "length") {
						return Object_keys(proxy).length;
					}

					if (prop === "getNamedItem") {
						return (name: string) => proxy[name];
					}
					// vssh fork: o iterador é o `Array.prototype.values`, que lê `length` e os índices de
					// quem o chama. Chamado sobre este proxy, ele só vê os atributos do site; o invólucro
					// abaixo o chamaria sobre o mapa de verdade, com os atributos do motor junto.
					if (prop === Symbol.iterator) return value;
					if (prop === "item") {
						return (i: number) => proxy[Number(i) >>> 0] ?? null;
					}
					if (prop === "getNamedItemNS") {
						return (namespace: string, name: string) =>
							proxy[`${namespace}:${name}`];
					}

					if (prop in NamedNodeMap.prototype && typeof value === "function") {
						return new Proxy(value, {
							apply(target, that, args) {
								if (that === proxy) {
									return Reflect_apply(target, map, args);
								}

								return Reflect_apply(target, that, args);
							},
						});
					}

					if (
						(typeof prop === "string" || typeof prop === "number") &&
						!isNaN(Number(prop))
					) {
						const position = Object_keys(proxy)[prop];

						return map[position];
					}

					if (!this.has(target, prop)) return undefined;

					return value;
				},
				ownKeys(target) {
					const keys = Reflect_ownKeys(target);

					return keys.filter((key) => this.has(target, key));
				},
				has(target, prop) {
					if (typeof prop === "symbol") return Reflect_has(target, prop);
					if (prop.startsWith("scramjet-attr-")) return false;
					if (map[prop]?.name?.startsWith("scramjet-attr-")) return false;

					return Reflect_has(target, prop);
				},
			});

			donos.set(proxy, ctx.this as Element);

			return proxy;
		},
	});

	// vssh fork: `attributes.setNamedItem(attr)` põe o atributo sem passar pelo `setAttributeNode`, e
	// um `onclick` ou um `src` iria ao elemento como o site o escreveu. Ele vai pelo
	// `setAttributeNode` do elemento, que reescreve o valor, e devolve o mesmo que o nativo.
	client.Proxy(["NamedNodeMap.prototype.setNamedItem", "NamedNodeMap.prototype.setNamedItemNS"], {
		apply(ctx) {
			const dono = donos.get(ctx.this as object);
			if (!dono || !client.box.instanceof(ctx.args[0], "Attr")) return;
			const metodo = `${ctx.fn.name}`.endsWith("NS") ? "setAttributeNodeNS" : "setAttributeNode";
			ctx.return(Reflect_apply(client.global.Element.prototype[metodo], dono, [ctx.args[0]]));
		},
	});

	client.Trap(["Attr.prototype.value", "Attr.prototype.nodeValue"], {
		get(ctx) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.getAttribute(ctx.this.name);
			}

			return ctx.get();
		},
		set(ctx, value) {
			// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
			if (ctx.this?.ownerElement) {
				// eslint-disable-next-line scramjet-core/no-poisoned-ctx-value
				return ctx.this.ownerElement.setAttribute(ctx.this.name, value);
			}

			return ctx.set(value);
		},
	});
}
