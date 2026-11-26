import { ScramjetClient } from "@client/index";
import { origemDe } from "@client/janela-cruzada";
import {
	Object_keys,
	Reflect_get,
	Reflect_getPrototypeOf,
	Reflect_has,
	Reflect_ownKeys,
	Reflect_set,
	String,
	_URL, _ProxyNativo } from "@/shared/snapshot";

/**
 * O prefixo que separa, no storage da origem do motor, as chaves de cada site: o host da origem
 * que o site vê, mais `@`. Um quadro `about:blank` ou `srcdoc` herda a origem de quem o criou, e
 * usa a partição dela: uma página que lê `iframe.contentWindow.localStorage` acha os próprios
 * dados, e o evento `storage` de uma escrita chega ao quadro que o Chrome avisaria.
 */
export function particaoDoStorage(client: ScramjetClient, self: any): string {
	try {
		const origem = origemDe(self);
		if (origem) return new _URL(origem).host + "@";
	} catch {}

	return client.url.host + "@";
}

export default function (client: ScramjetClient, self: Self) {
	const particao = () => particaoDoStorage(client, self);
	const chavesDe = (target: Storage, p: string) =>
		Object_keys(target).filter((k) => k.startsWith(p));
	// O que o próprio `Storage` tem (os métodos, `length`, o que vem de `Object.prototype`) vence
	// uma chave guardada com o mesmo nome, como no navegador.
	const doPrototipo = (target: Storage, prop: string) =>
		Reflect_has(Reflect_getPrototypeOf(target)!, prop);

	const handler: ProxyHandler<Storage> = {
		get(target, prop) {
			if (typeof prop === "symbol") return Reflect_get(target, prop);
			const p = particao();
			switch (prop) {
				// Sem os argumentos que o navegador exige, a chamada vai a ele como veio, e o
				// TypeError é o dele.
				case "getItem":
					return (...a: any[]) =>
						a.length ? target.getItem(p + a[0]) : (target.getItem as any)();

				case "setItem":
					return (...a: any[]) =>
						a.length > 1
							? target.setItem(p + a[0], a[1])
							: (target.setItem as any)(...a);

				case "removeItem":
					return (...a: any[]) =>
						a.length ? target.removeItem(p + a[0]) : (target.removeItem as any)();

				case "clear":
					return () => {
						for (const k of chavesDe(target, p)) target.removeItem(k);
					};

				case "key":
					return (...a: any[]) => {
						if (!a.length) return (target.key as any)();
						const k = chavesDe(target, p)[a[0] >>> 0];

						return k === undefined ? null : k.substring(p.length);
					};

				case "length":
					return chavesDe(target, p).length;

				default: {
					if (doPrototipo(target, prop)) return Reflect_get(target, prop);
					// Uma chave que não existe lida como propriedade é `undefined`; `null` é a
					// resposta do `getItem`.
					const valor = target.getItem(p + prop);

					return valor === null ? undefined : valor;
				}
			}
		},

		set(target, prop, value) {
			if (typeof prop === "symbol") return Reflect_set(target, prop, value);
			target.setItem(particao() + prop, value);

			return true;
		},

		deleteProperty(target, prop) {
			if (typeof prop === "symbol") return Reflect.deleteProperty(target, prop);
			target.removeItem(particao() + prop);

			return true;
		},

		has(target, prop) {
			if (typeof prop === "symbol") return Reflect_has(target, prop);

			return target.getItem(particao() + prop) !== null || doPrototipo(target, prop);
		},

		ownKeys(target) {
			const p = particao();

			return Reflect_ownKeys(target)
				.filter((f) => typeof f === "string" && f.startsWith(p))
				.map((f) => (f as string).substring(p.length));
		},

		getOwnPropertyDescriptor(target, property) {
			if (typeof property === "symbol") return undefined;
			const valor = target.getItem(particao() + property);
			if (valor === null) return undefined;

			return { value: valor, enumerable: true, configurable: true, writable: true };
		},

		defineProperty(target, property, attributes) {
			if (typeof property === "symbol") return false;
			target.setItem(particao() + property, String(attributes.value));

			return true;
		},
	};

	const localStorageProxy = new _ProxyNativo(self.localStorage, handler);
	const sessionStorageProxy = new _ProxyNativo(self.sessionStorage, handler);

	// vssh fork: os dois continuam acessores do global, como no Chrome, e o getter de cada um se
	// apresenta como o nativo (ver `RawTrap`). Uma propriedade de dado no lugar deles aparece em
	// `Object.getOwnPropertyDescriptor(window, "localStorage")`.
	client.Trap("localStorage", {
		get() {
			return localStorageProxy;
		},
	});
	client.Trap("sessionStorage", {
		get() {
			return sessionStorageProxy;
		},
	});
}
