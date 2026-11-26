import { ScramjetClient } from "@client/index";
import { Object_defineProperty, Object_setPrototypeOf, Reflect_apply, Reflect_construct, _Map, _ProxyNativo } from "@/shared/snapshot";

// vssh fork: o reescritor troca `p.location` por `p.$sj_location` (o prefixo é o `wrappropertybase`),
// e as armadilhas de um `Proxy` do site recebiam essa chave. O Vue, o MobX e o immer rastreiam a
// dependência pela chave da armadilha, e um objeto reativo com um campo `location` deixava de se
// atualizar. As armadilhas que recebem uma chave passam a receber o nome que o site escreveu. O que
// a armadilha `get` devolve passa pelo `wrapfn`: um `Proxy` em volta de `window` não entrega o
// `location` real.

const NOMES = ["location", "top", "parent", "eval", "prepareStackTrace"];
const ARMADILHAS = ["get", "set", "has", "deleteProperty", "getOwnPropertyDescriptor", "defineProperty"];

export default function (client: ScramjetClient, _self: Self) {
	const base = client.config.globals.wrappropertybase;
	const reais = new _Map<string, string>([]);
	for (const nome of NOMES) reais.set(base + nome, nome);

	const embrulhar = (handler: any) => {
		if (!handler || typeof handler !== "object") return handler;
		let precisa = false;
		for (const t of ARMADILHAS) if (typeof handler[t] === "function") precisa = true;
		if (!precisa) return handler;
		// Um objeto novo com o original como protótipo: as armadilhas que o site não deu, e as que
		// ele puser depois no original, continuam valendo.
		const novo = Object_setPrototypeOf({}, handler);
		for (const t of ARMADILHAS) {
			const original = handler[t];
			if (typeof original !== "function") continue;
			novo[t] = function (this: unknown, ...args: any[]) {
				const chave = args[1];
				const real = typeof chave === "string" && chave.charCodeAt(0) === 36 ? reais.get(chave) : undefined;
				if (real === undefined) return Reflect_apply(original, handler, args);
				args[1] = real;
				const r = Reflect_apply(original, handler, args);

				return t === "get" ? client.wrapfn(r) : r;
			};
		}

		return novo;
	};

	// Um `Proxy` leve em volta do construtor, sem o contexto que o `client.Proxy` monta a cada
	// chamada: o Vue cria um `Proxy` por objeto reativo.
	const nativo = (client.global as any).Proxy;
	const construtor = new _ProxyNativo(nativo, {
		construct(alvo, args, novoAlvo) {
			if (args.length > 1) args[1] = embrulhar(args[1]);

			return Reflect_construct(alvo, args, novoAlvo);
		},
	});
	client.box.unproxy.set(construtor, nativo);
	Object_defineProperty(client.global, "Proxy", { value: construtor, writable: true, configurable: true, enumerable: false });
	client.Proxy("Proxy.revocable", {
		apply(ctx) {
			ctx.args[1] = embrulhar(ctx.args[1]);
		},
	});
}
