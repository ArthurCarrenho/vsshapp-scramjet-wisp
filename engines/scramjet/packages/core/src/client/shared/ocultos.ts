import { ScramjetClient } from "@client/index";
import { Reflect_ownKeys, String_startsWith } from "@/shared/snapshot";

const Symbol_keyFor = Symbol.keyFor;

/**
 * vssh fork: os globais do motor (`$scramjet`, `$scramjetController`, `$scramitize` e os
 * `$scramjet$*` que o código reescrito chama) somem das listas de chaves do global e do
 * `Object.prototype`. Eles
 * continuam lá, porque o código reescrito os chama pelo nome, mas `Object.keys(window)`,
 * `Object.getOwnPropertyNames(window)`, `Reflect.ownKeys(window)` e
 * `Object.getOwnPropertyDescriptors(window)` devolvem o que um Chrome sem o motor devolveria, e
 * nenhuma lista de chaves mostra os símbolos do motor. Um desafio anti-robô que enumera o global e
 * acha `$scramjet` nele sabe o que está do outro lado.
 */
export default function (client: ScramjetClient, self: Self) {
	const doMotor = (k: PropertyKey) =>
		typeof k === "string" &&
		(String_startsWith(k, "$scramjet") || k === "$scramitize");

	// Os símbolos do motor são todos do registro global, com chave `scramjet …`
	// (`Symbol.for("scramjet client global")`, a política de Trusted Types). Eles somem das
	// listas de qualquer objeto, porque um site só teria um deles pedindo exatamente esse nome.
	const simboloDoMotor = (k: PropertyKey) => {
		if (typeof k !== "symbol") return false;
		const chave = Symbol_keyFor(k);

		return typeof chave === "string" && String_startsWith(chave, "scramjet ");
	};

	// O `Error.prepareStackTrace` que o `cleanErrors` instala (ver `error.ts`) não existe num
	// Chromium limpo. Ele continua no construtor, porque o V8 o lê de lá, e some das listas de
	// chaves e dos descritores próprios do `Error`.
	const ocultaNoError = client.flagEnabled("cleanErrors");
	// O `Object.prototype` leva os acessores que o código reescrito chama
	// (`$scramjet__location` e os outros, ver `wrap.ts`) e o `$scramjet$setrealmfn`.
	// Uma janela de outro quadro do motor também tem os globais dele.
	const ehJanela = (alvo: any) => {
		try {
			return !!alvo && typeof alvo === "object" && alvo.window === alvo;
		} catch {
			return false;
		}
	};
	const comGlobais = (alvo: unknown) =>
		alvo === self || alvo === self.Object.prototype || ehJanela(alvo);
	const oculta = (alvo: unknown, k: PropertyKey) =>
		simboloDoMotor(k) ||
		(comGlobais(alvo) && doMotor(k)) ||
		(ocultaNoError && alvo === self.Error && k === "prepareStackTrace");
	const temOculta = (alvo: unknown) => comGlobais(alvo) || (ocultaNoError && alvo === self.Error);

	for (const caminho of ["Object.keys", "Object.getOwnPropertyNames"]) {
		client.Proxy(caminho, {
			apply(ctx) {
				const alvo = ctx.args[0];
				if (!temOculta(alvo)) return;
				const chaves = ctx.call() as PropertyKey[];
				ctx.return(chaves.filter((k) => !oculta(alvo, k)));
			},
		});
	}

	// As duas listas que trazem símbolos são filtradas em todo objeto; o filtro só copia a lista
	// quando ela tem o que esconder.
	for (const caminho of ["Reflect.ownKeys", "Object.getOwnPropertySymbols"]) {
		client.Proxy(caminho, {
			apply(ctx) {
				const alvo = ctx.args[0];
				const chaves = ctx.call() as PropertyKey[];
				if (temOculta(alvo) || chaves.some(simboloDoMotor))
					ctx.return(chaves.filter((k) => !oculta(alvo, k)));
			},
		});
	}

	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			const alvo = ctx.args[0];
			const todos = ctx.call() as Record<PropertyKey, PropertyDescriptor>;
			for (const k of Reflect_ownKeys(todos)) if (oculta(alvo, k)) delete todos[k as any];
			ctx.return(todos);
		},
	});

	if (!ocultaNoError) return;

	for (const caminho of ["Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor"]) {
		client.Proxy(caminho, {
			apply(ctx) {
				if (oculta(ctx.args[0], ctx.args[1] as PropertyKey)) ctx.return(undefined);
			},
		});
	}
	client.Proxy("Object.hasOwn", {
		apply(ctx) {
			if (oculta(ctx.args[0], ctx.args[1] as PropertyKey)) ctx.return(false);
		},
	});
	client.Proxy("Reflect.has", {
		apply(ctx) {
			if (ctx.args[0] === self.Error && ctx.args[1] === "prepareStackTrace")
				ctx.return(false);
		},
	});
	client.Proxy("Object.prototype.hasOwnProperty", {
		apply(ctx) {
			if (oculta(ctx.this, ctx.args[0])) ctx.return(false);
		},
	});
}
