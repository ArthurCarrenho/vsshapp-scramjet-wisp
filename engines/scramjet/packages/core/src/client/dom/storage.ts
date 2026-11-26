import { ScramjetClient } from "@client/index";
import { Object_keys, Reflect_get, Reflect_ownKeys } from "@/shared/snapshot";

export default function (client: ScramjetClient, self: Self) {
	const handler: ProxyHandler<Storage> = {
		get(target, prop) {
			switch (prop) {
				case "getItem":
					return (key: string) => {
						return target.getItem(client.url.host + "@" + key);
					};

				case "setItem":
					return (key: string, value: string) => {
						return target.setItem(client.url.host + "@" + key, value);
					};

				case "removeItem":
					return (key: string) => {
						return target.removeItem(client.url.host + "@" + key);
					};

				case "clear":
					return () => {
						for (const key in Object_keys(target)) {
							if (key.startsWith(client.url.host)) {
								target.removeItem(key);
							}
						}
					};

				case "key":
					return (index: number) => {
						const keys = Object_keys(target).filter((key) =>
							key.startsWith(client.url.host)
						);

						return target.getItem(keys[index]);
					};

				case "length":
					return Object_keys(target).filter((key) =>
						key.startsWith(client.url.host)
					).length;

				default:
					if (prop in Object.prototype || typeof prop === "symbol") {
						return Reflect_get(target, prop);
					}

					return target.getItem(client.url.host + "@" + (prop as string));
			}
		},

		set(target, prop, value) {
			target.setItem(client.url.host + "@" + (prop as string), value);

			return true;
		},

		has(target, prop) {
			return target.getItem(client.url.host + "@" + (prop as string)) !== null;
		},

		ownKeys(target) {
			return Reflect_ownKeys(target)
				.filter((f) => typeof f === "string" && f.startsWith(client.url.host))
				.map((f) =>
					typeof f === "string" ? f.substring(client.url.host.length + 1) : f
				);
		},

		getOwnPropertyDescriptor(target, property) {
			// TODO: probably not right
			if (
				target.getItem(client.url.host + "@" + (property as string)) === null
			) {
				return undefined;
			}

			return {
				value: target.getItem(client.url.host + "@" + (property as string)),
				enumerable: true,
				configurable: true,
				writable: true,
			};
		},

		defineProperty(target, property, attributes) {
			target.setItem(
				client.url.host + "@" + (property as string),
				attributes.value
			);

			return true;
		},
	};

	const localStorageProxy = new Proxy(self.localStorage, handler);
	const sessionStorageProxy = new Proxy(self.sessionStorage, handler);

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
