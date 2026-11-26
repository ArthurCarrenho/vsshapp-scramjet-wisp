import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { Object_defineProperty, Reflect_apply, _Map, _WeakMap } from "@/shared/snapshot";
import { AnyFunction } from "@/types";
import { trocarRapida } from "@client/shared/troca-rapida";

// vssh fork: o `eval`, o `top`, o `parent` e o `location` de uma janela lidos por reflexão.
//
// O reescritor troca a leitura escrita no código (`window.eval`, `top`, `obj["location"]`) pela
// versão do site, mas `Reflect.get(window, "eval")`, `Object.getOwnPropertyDescriptor(window,
// "eval").value` e o `get` do descritor de `top` chegam ao nativo. O `eval` nativo chamado assim
// compila o texto sem reescrita, e o `top` nativo é a janela do shell. Os dois passam pelo `wrapfn`
// da janela dona, como a leitura escrita.

const NOMES = ["eval", "top", "parent", "location"];

function donoDe(alvo: unknown): ScramjetClient | null {
	if (!alvo || typeof alvo !== "object") return null;
	try {
		return (alvo as any)[SCRAMJETCLIENT] ?? null;
	} catch {
		return null;
	}
}

export default function (client: ScramjetClient, _self: Self) {
	// O `get` de cada acessor nativo, envolvido uma vez por dono, para o descritor devolver sempre o
	// mesmo.
	const leitores = new _WeakMap<object, Map<string, AnyFunction>>([]);
	const leitorDe = (dono: ScramjetClient, nome: string, nativo: AnyFunction) => {
		let porNome = leitores.get(dono);
		if (!porNome) leitores.set(dono, (porNome = new _Map<string, AnyFunction>([])));
		let leitor = porNome.get(nome);
		if (!leitor) {
			leitor = {
				get() {
					return dono.wrapfn(Reflect_apply(nativo, this, []));
				},
			}.get as AnyFunction;
			Object_defineProperty(leitor, "name", { value: nativo.name, configurable: true });
			client.box.unproxy.set(leitor, nativo);
			porNome.set(nome, leitor);
		}

		return leitor;
	};
	const descritor = (alvo: unknown, nome: unknown, d: PropertyDescriptor | undefined): PropertyDescriptor | undefined => {
		if (!d || typeof nome !== "string" || !NOMES.includes(nome)) return d;
		const dono = donoDe(alvo);
		if (!dono) return d;
		if ("value" in d) return { ...d, value: dono.wrapfn(d.value) };
		if (typeof d.get === "function") return { ...d, get: leitorDe(dono, nome, d.get) as () => any };

		return d;
	};

	trocarRapida(client, client.global.Reflect, "get", (nativo) => ({
		get(...args: any[]) {
			const valor = Reflect_apply(nativo, undefined, args);
			const chave = args[1];
			if (chave !== "eval" && chave !== "top" && chave !== "parent" && chave !== "location") return valor;
			const dono = donoDe(args[0]);

			return dono ? dono.wrapfn(valor) : valor;
		},
	}).get);
	for (const caminho of ["Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor"]) {
		client.Proxy(caminho, {
			apply(ctx) {
				ctx.return(descritor(ctx.args[0], ctx.args[1], ctx.call() as PropertyDescriptor | undefined));
			},
		});
	}
	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			const todos = ctx.call() as Record<string, PropertyDescriptor>;
			if (!donoDe(ctx.args[0])) return;
			for (const nome of NOMES) if (nome in todos) todos[nome] = descritor(ctx.args[0], nome, todos[nome])!;
			ctx.return(todos);
		},
	});
}
