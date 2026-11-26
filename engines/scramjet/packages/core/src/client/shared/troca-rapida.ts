import { ScramjetClient } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";
import { AnyFunction } from "@/types";

/**
 * Troca `alvo[nome]` por uma função comum que o motor escreve, para os nativos que o site chama
 * em laço (`Reflect.get`, `Reflect.set`, `Object.assign`). O `client.Proxy` monta um contexto a
 * cada chamada, e num `Reflect.get` isso multiplicava o custo por sete. A função nova se apresenta
 * como o nativo: o mesmo `name`, o mesmo `length`, e o `toString` dele pelo `unproxy`.
 */
export function trocarRapida(
	client: ScramjetClient,
	alvo: any,
	nome: string,
	fazer: (nativo: AnyFunction) => AnyFunction
) {
	const nativo = alvo?.[nome];
	if (typeof nativo !== "function") return;
	const nova = fazer(nativo);
	Object_defineProperty(nova, "name", { value: nativo.name, configurable: true });
	Object_defineProperty(nova, "length", { value: nativo.length, configurable: true });
	client.box.unproxy.set(nova, nativo);
	Object_defineProperty(alvo, nome, { value: nova, writable: true, configurable: true, enumerable: false });
}
