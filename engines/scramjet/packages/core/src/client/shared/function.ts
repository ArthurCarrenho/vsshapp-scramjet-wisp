import { rewriteJs } from "@rewriters/js";
import { ScramjetClient, ProxyCtx, Proxy } from "@client/index";
import { Math_random, Reflect_apply, String } from "@/shared/snapshot";
import { registrarCompilacao } from "@client/pilha";
import { registrarScript } from "@client/posicoes";
import { ehConfiavel, embrulhar, exigeConfiavel, podeRodar } from "@/shared/confiavel";

// vssh fork: o `Function` do site, compilado pelo `Function` nativo.
//
// O site chama o nativo uma vez, com os argumentos dele, como sem o motor: num documento que exige
// Trusted Types, é a política padrão do site que recebe o código e decide. O texto que esse nativo
// devolve no `toString` dá os parâmetros e o corpo. Os dois passam pelo rewriter juntos, como uma
// função só, e o motor compila o resultado com o mesmo construtor nativo. O Chrome aceita
// TrustedScript em todos os argumentos do `Function` sem consultar a política padrão, então o
// código reescrito vai embrulhado pela política do motor e não volta à do site.
//
// Compilar pelo construtor nativo é o que deixa a pilha igual à do Chrome: o quadro se chama
// `eval`, a linha do corpo é a terceira do script, e a origem que o V8 escreve pode ser trocada
// pela do chamador (ver `client/pilha.ts`). O `toString` da função devolve o texto do nativo.
//
// Argumentos que já chegam todos como TrustedScript são do próprio motor (o `postMessage` rouba
// o `Function` de outro quadro para achar o `globalThis` dele) e seguem o mesmo caminho, com a
// fonte montada como o `Function` a monta.
const CABECA = /^(async )?function(\*)? anonymous\(/;
const MARCA = `\n/*vssh-${Math_random().toString(36).slice(2)}*/`;

function partes(texto: string): [string, string, string] | null {
	const cabeca = CABECA.exec(texto)?.[0];
	if (!cabeca || !texto.endsWith("\n}")) return null;
	const corte = texto.indexOf("\n) {\n", cabeca.length);
	if (corte < 0) return null;

	return [cabeca, texto.slice(cabeca.length, corte), texto.slice(corte + 5, -2)];
}

function compilarNativo(
	client: ScramjetClient,
	ctx: ProxyCtx<any, any>,
	original: string
): Function | null {
	const p = partes(original);
	if (!p) return null;
	const [cabeca, parametros, corpo] = p;

	client.box.mapas.ultimaTag = null;
	const reescrito = rewriteJs(
		`(${cabeca}${parametros}${MARCA}) {\n${corpo}\n})`,
		"(function proxy)",
		client.context,
		client.meta
	);
	if (typeof reescrito !== "string") return null;
	const inicio = `(${cabeca}`;
	const marca = reescrito.indexOf(MARCA);
	if (!reescrito.startsWith(inicio) || marca < 0 || !reescrito.endsWith("\n})")) return null;
	const abre = reescrito.indexOf("{\n", marca + MARCA.length);
	// Entre a marca e a chave só cabe o `)` e o `scramtag` que o rewriter põe em toda função.
	if (abre < 0 || !/^\)\s*(\/\*scramtag [^*]*\*\/\s*)?$/.test(reescrito.slice(marca + MARCA.length, abre)))
		return null;
	const novosParametros = reescrito.slice(inicio.length, marca);
	const novoCorpo = reescrito.slice(abre + 2, -3);

	const args = novosParametros ? [novosParametros, novoCorpo] : [novoCorpo];
	const tipados = exigeConfiavel(client)
		? args.map((a) => embrulhar(client, "TrustedScript", a))
		: args;

	let criada: Function | undefined;
	registrarCompilacao(client, () =>
		criada ? `(${client.natives.call("Function.prototype.toString", criada)})` : ""
	);
	criada = Reflect_apply(ctx.fn, undefined, tipados) as Function;
	client.box.fontesDinamicas.set(criada, original);
	// O script que o V8 compila é `(cabeça parâmetros\n) {\ncorpo\n})`; o corpo começa em outro
	// ponto do texto que o rewriter devolveu.
	const tag = client.box.mapas.ultimaTag;
	if (tag) {
		const ini = 1 + cabeca.length + novosParametros.length + 5;
		const feita = criada;
		registrarScript(
			client,
			() => `(${client.natives.call("Function.prototype.toString", feita)})`,
			{ tag, ini, d: abre + 2 - ini, dl: 0, primeira: -1, col0: 0 },
		);
	}

	return criada;
}

function rewriteFunction<T extends string, U extends "construct" | "apply">(
	ctx: ProxyCtx<T, U>,
	client: ScramjetClient
) {
	const args: unknown[] = ctx.args;
	const internos =
		args.length > 0 && args.every((a) => ehConfiavel(client, a, "TrustedScript"));

	let stringifiedFunction: string;
	if (internos) {
		const textos = args.map((a) => String(a));
		const corpo = textos.pop();
		stringifiedFunction = `function anonymous(${textos.join(",")}\n) {\n${corpo}\n}`;
	} else {
		stringifiedFunction = ctx.call().toString();
	}

	try {
		const criada = compilarNativo(client, ctx, stringifiedFunction);
		if (criada) {
			ctx.return(criada as any);

			return;
		}
	} catch (err) {
		dbg.warn("Function: o construtor nativo recusou o código reescrito", err);
	}

	const content = rewriteJs(
		`return ${stringifiedFunction}`,
		"(function proxy)",
		client.context,
		client.meta
	);

	if (!internos && !exigeConfiavel(client)) {
		ctx.return(ctx.fn(content)());

		return;
	}

	const codigo = embrulhar(client, "TrustedScript", `(function () {\n${content}\n})()`);
	ctx.return(client.natives.call("eval", null, codigo));
}

export default function (client: ScramjetClient, _self: Self) {
	const handler: Proxy = {
		apply(ctx: ProxyCtx) {
			rewriteFunction(ctx, client);
		},
		construct(ctx) {
			rewriteFunction(ctx, client);
		},
	};

	client.Proxy("Function", handler);

	// Os construtores vêm do `eval` do próprio quadro, que pode ser um quadro filho cujo documento
	// herdou a exigência de Trusted Types: o código vai embrulhado, como no resto deste arquivo.
	// Num quadro em sandbox sem `allow-scripts` nenhum código nasce, e ali não há construtor a
	// interceptar.
	if (!podeRodar(client)) return;
	const construtorDe = (codigo: string) => {
		try {
			return client.natives.call(
				"eval",
				null,
				embrulhar(client, "TrustedScript", codigo)
			).constructor;
		} catch {
			return null;
		}
	};
	for (const codigo of [
		"(function () {})",
		"(async function () {})",
		"(function* () {})",
		"(async function* () {})",
	]) {
		const construtor = construtorDe(codigo);
		if (!construtor) continue;
		// O `Function.prototype.constructor` é o próprio `Function` global, como no Chrome:
		// `(function () {}).constructor === Function`.
		if (construtor === client.box.unproxy.get(_self.Function)) {
			const d = Object.getOwnPropertyDescriptor(construtor.prototype, "constructor");
			if (d) Object.defineProperty(construtor.prototype, "constructor", { ...d, value: _self.Function });
			continue;
		}
		client.RawProxy(construtor.prototype, "constructor", handler);
	}
}
