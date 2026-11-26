import { rewriteJs } from "@rewriters/js";
import { ScramjetClient, ProxyCtx, Proxy } from "@client/index";
import { String } from "@/shared/snapshot";
import { ehConfiavel, embrulhar, exigeConfiavel, podeRodar } from "@/shared/confiavel";

// vssh fork: o `Function` num documento que exige Trusted Types.
//
// O construtor `Function` do Chrome recusa um TrustedScript ("does not accept TrustedString
// arguments"); com Trusted Types exigidos, ele só aceita strings que a política padrão do site
// aprova. O `eval` aceita um TrustedScript. Daí os dois caminhos daqui:
//
// - Strings do site vão ao `Function` nativo uma vez, como sem o motor: a política padrão do site
//   recebe o mesmo código e decide. O código reescrito é compilado pelo `eval` nativo indireto
//   (escopo global, como o do `Function`), embrulhado pela política do motor, para não voltar à
//   do site, que recusaria o código reescrito.
// - Argumentos que já chegam todos como TrustedScript são do próprio motor (o `postMessage` rouba
//   o `Function` de outro quadro para achar o `globalThis` dele). O nativo os recusaria, então o
//   motor monta a fonte como o `Function` monta e segue pelo mesmo `eval`.
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

	// TODO: also check if the function comes from a weird realm. if so we need to completely block it or do something else weird
	// not much point rewriting the javascript if it's executing in the top level

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
		if (construtor) client.RawProxy(construtor.prototype, "constructor", handler);
	}
}
