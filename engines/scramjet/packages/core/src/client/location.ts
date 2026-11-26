import { ScramjetClient } from "@client/index";
import { Tap } from "@/Tap";
import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import {
	Reflect_apply,
	Object_setPrototypeOf,
	_URL,
	Object_defineProperty,
} from "@/shared/snapshot";

export function createLocationProxy(client: ScramjetClient, self: GlobalThis) {
	const Location = iswindow ? self.Location : self.WorkerLocation;
	// location cannot be Proxy()d
	const fakeLocation: any = {};
	Object_setPrototypeOf(fakeLocation, Location.prototype);

	// for some reason it's on the object for Location and on the prototype for WorkerLocation??
	const descriptorSource = iswindow ? self.location : Location.prototype;
	const urlprops = [
		"protocol",
		"hash",
		"host",
		"hostname",
		"href",
		"origin",
		"pathname",
		"port",
		"search",
	];
	for (const prop of urlprops) {
		const native = client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			descriptorSource,
			prop
		);
		if (!native) continue;

		const desc: Partial<PropertyDescriptor> = {
			configurable: false,
			enumerable: true,
		};
		if (native.get) {
			desc.get = new Proxy(native.get, {
				apply() {
					return client.url[prop];
				},
			});
			client.box.unproxy.set(desc.get, native.get);
		}
		if (native.set) {
			desc.set = new Proxy(native.set, {
				apply(target, that, args) {
					if (prop === "href") {
						// special case
						client.url = args[0];

						return;
					}
					if (prop === "hash") {
						self.location.hash = args[0];
						Tap.dispatch(
							client.hooks.lifecycle.navigate,
							{
								type: "hashchange",
							},
							{
								url: client.url.href,
							}
						);

						return;
					}
					const url = new _URL(client.url.href);
					url[prop] = args[0];
					client.url = url;
				},
			});
			client.box.unproxy.set(desc.set, native.set);
		}
		Object_defineProperty(fakeLocation, prop, desc);
	}

	// functions
	fakeLocation.toString = new Proxy(self.location.toString, {
		apply() {
			return client.url.href;
		},
	});

	if (self.location.valueOf)
		fakeLocation.valueOf = new Proxy(self.location.valueOf, {
			apply() {
				return fakeLocation;
			},
		});
	if (self.location.assign)
		fakeLocation.assign = new Proxy(self.location.assign, {
			apply(target, that, args) {
				args[0] = client.rewriteUrl(args[0]);
				Reflect_apply(target, self.location, args);
				Tap.dispatch(
					client.hooks.lifecycle.navigate,
					{
						type: "location",
					},
					{
						url: client.url.href,
					}
				);
			},
		});
	if (self.location.reload)
		fakeLocation.reload = new Proxy(self.location.reload, {
			apply(target, that, args) {
				Reflect_apply(target, self.location, args);
			},
		});
	if (self.location.replace)
		fakeLocation.replace = new Proxy(self.location.replace, {
			apply(target, that, args) {
				args[0] = client.rewriteUrl(args[0]);
				Reflect_apply(target, self.location, args);

				Tap.dispatch(
					client.hooks.lifecycle.navigate,
					{
						type: "location",
					},
					{
						url: client.url.href,
					}
				);
			},
		});

	if (iswindow) {
		const native = client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.location,
			"ancestorOrigins"
		);
		if (native?.get) {
			const get = new Proxy(native.get, {
				apply() {
					return origensAncestrais(client, self);
				},
			});
			client.box.unproxy.set(get, native.get);
			Object_defineProperty(fakeLocation, "ancestorOrigins", {
				get,
				configurable: false,
				enumerable: true,
			});
		}
	}

	// vssh fork: os métodos são do próprio objeto, com o descritor do `Location` do Chrome
	// ([LegacyUnforgeable]), e o `toString` de cada um é o do nativo que ele envolve: um
	// `function () { [native code] }` sem nome denuncia o invólucro.
	for (const nome of ["toString", "valueOf", "assign", "reload", "replace"]) {
		const fn = fakeLocation[nome];
		if (typeof fn !== "function" || !Object.prototype.hasOwnProperty.call(fakeLocation, nome))
			continue;
		const nativo = (self.location as any)[nome];
		if (nativo) client.box.unproxy.set(fn, nativo);
		const d = iswindow
			? client.natives.call("Object.getOwnPropertyDescriptor", null, self.location, nome)
			: null;
		delete fakeLocation[nome];
		Object_defineProperty(fakeLocation, nome, {
			value: fn,
			writable: d ? d.writable : false,
			enumerable: d ? d.enumerable : true,
			configurable: false,
		});
	}
	// O `Symbol.toPrimitive` próprio do `Location`, que no Chrome vale `undefined`.
	if (iswindow) {
		const d = client.natives.call(
			"Object.getOwnPropertyDescriptor",
			null,
			self.location,
			Symbol.toPrimitive
		);
		if (d) Object_defineProperty(fakeLocation, Symbol.toPrimitive, { ...d, configurable: false });
	}

	return fakeLocation;
}

/**
 * vssh fork: o `location.ancestorOrigins` do documento proxiado. O nativo lista as origens do
 * motor e do ambiente, e um widget embutido (o Turnstile) confere por ele em que site está. Esta
 * lista sobe pelos pais enquanto eles forem documentos do motor, com a origem de cada um como a
 * página a enxerga, e para no quadro do motor que hospeda a aba, como o topo de um navegador.
 *
 * O valor continua sendo o `DOMStringList` nativo, atrás de um `Proxy` que responde os índices e o
 * tamanho pela lista traduzida; `item`, `contains` e `length` do protótipo consultam
 * `LISTAS_DE_ORIGENS` (ver `client/dom/ancestororigins.ts`).
 */
export const LISTAS_DE_ORIGENS = new WeakMap<object, string[]>();

function origensAncestrais(client: ScramjetClient, self: GlobalThis) {
	const origens: string[] = [];
	let atual: any = self;
	for (let i = 0; i < 64; i++) {
		let pai: any;
		try {
			pai = atual.parent;
			if (!pai || pai === atual || !pai[SCRAMJETCLIENT]) break;
			origens.push(String(pai.origin));
		} catch {
			break;
		}
		atual = pai;
	}

	const nativa = client.natives.call(
		"Reflect.get",
		null,
		self.location,
		"ancestorOrigins"
	);
	const indice = (p: PropertyKey) =>
		typeof p === "string" && /^(0|[1-9]\d*)$/.test(p) ? Number(p) : -1;
	const lista = new Proxy(nativa, {
		get(alvo, p) {
			const i = indice(p);
			if (i >= 0) return origens[i];
			return Reflect.get(alvo, p, lista);
		},
		has(alvo, p) {
			const i = indice(p);
			if (i >= 0) return i < origens.length;
			return Reflect.has(alvo, p);
		},
		ownKeys() {
			return origens.map((_, i) => String(i));
		},
		getOwnPropertyDescriptor(alvo, p) {
			const i = indice(p);
			if (i >= 0 && i < origens.length)
				return { value: origens[i], writable: false, enumerable: true, configurable: true };
			return undefined;
		},
	});
	LISTAS_DE_ORIGENS.set(lista, origens);

	return lista;
}
