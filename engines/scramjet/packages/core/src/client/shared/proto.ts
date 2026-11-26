import type { ScramjetClient } from "@client/index";
import { mascarado, quadrosCrus } from "@client/pilha";
import { Reflect_getPrototypeOf, Reflect_setPrototypeOf, _ProxyNativo } from "@/shared/snapshot";

// vssh fork: a função do motor na própria cadeia de protótipos.
//
// Uma função comum recusa um protótipo que a tem na cadeia: `Object.setPrototypeOf(f, f)` e
// `f.__proto__ = f` lançam "Cyclic __proto__ value", e `Reflect.setPrototypeOf(f, f)` devolve
// `false`. O laço do navegador que procura o ciclo para no primeiro Proxy que encontra, e um Proxy
// sem esta armadilha repassa o pedido ao alvo, que o aceita. A chamada que o Chrome recusa passa, e
// é assim que uma página separa a função nativa da função coberta por um Proxy.
//
// A armadilha procura o ciclo com o Proxy e o alvo valendo pela mesma função, e responde a cada
// caminho como a nativa: `false` a quem veio pelo `Reflect`, o TypeError do Chrome aos outros dois.
const PASSOS = 64;

function veioDoReflect(client: ScramjetClient): boolean {
	const quadros = quadrosCrus(client, 8);
	if (!quadros) return false;
	for (const q of quadros) {
		try {
			if (mascarado(client, q.getFileName?.())) continue;

			return q.getFunctionName() === "setPrototypeOf" && q.getTypeName() === "Reflect";
		} catch {
			return false;
		}
	}

	return false;
}

/**
 * A armadilha `setPrototypeOf` de um Proxy que cobre uma função ou um objeto da plataforma.
 * `proxyDe` devolve o próprio Proxy, que só existe depois de o manipulador estar montado.
 */
export function recusarCiclo(client: ScramjetClient, proxyDe: () => object | undefined) {
	const TypeErrorDoSite = client.global.TypeError;

	return function setPrototypeOf(alvo: object, proto: object | null): boolean {
		const proxy = proxyDe();
		let p: any = proto;
		let ciclo = false;
		for (let i = 0; i < PASSOS && p !== null && p !== undefined; i++) {
			if (p === proxy || p === alvo) {
				ciclo = true;
				break;
			}
			try {
				// Outra função do motor na cadeia vale pela nativa que ela cobre.
				p = Reflect_getPrototypeOf(client.box.unproxy.get(p) ?? p);
			} catch {
				break;
			}
		}
		if (!ciclo) return Reflect_setPrototypeOf(alvo, proto);
		if (veioDoReflect(client)) return false;
		throw new TypeErrorDoSite("Cyclic __proto__ value");
	};
}

/** Um Proxy do motor sobre uma função nativa, com a armadilha do protótipo. */
export function cobrir<T extends object>(
	client: ScramjetClient,
	alvo: T,
	manipulador: ProxyHandler<T>
): T {
	let proxy: T | undefined;
	if (!manipulador.setPrototypeOf)
		manipulador.setPrototypeOf = recusarCiclo(client, () => proxy) as any;
	proxy = new _ProxyNativo(alvo, manipulador);

	return proxy;
}
