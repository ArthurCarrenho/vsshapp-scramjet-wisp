import { ScramjetClient } from "@client/index";
import { String_startsWith } from "@/shared/snapshot";

/**
 * vssh fork: os globais do motor (`$scramjet`, `$scramjetController`, `$scramitize` e os
 * `$scramjet$*` que o código reescrito chama) somem das listas de chaves do global. Eles
 * continuam lá, porque o código reescrito os chama pelo nome, mas `Object.keys(window)`,
 * `Object.getOwnPropertyNames(window)`, `Reflect.ownKeys(window)` e
 * `Object.getOwnPropertyDescriptors(window)` devolvem o que um Chrome sem o motor devolveria. Um
 * desafio anti-robô que enumera o global e acha `$scramjet` nele sabe o que está do outro lado.
 */
export default function (client: ScramjetClient, self: Self) {
	const doMotor = (k: PropertyKey) =>
		typeof k === "string" &&
		(String_startsWith(k, "$scramjet") || k === "$scramitize");

	// O `Error.prepareStackTrace` que o `cleanErrors` instala (ver `error.ts`) não existe num
	// Chromium limpo. Ele continua no construtor, porque o V8 o lê de lá, e some das listas de
	// chaves e dos descritores próprios do `Error`.
	const ocultaNoError = client.flagEnabled("cleanErrors");
	const oculta = (alvo: unknown, k: PropertyKey) =>
		(alvo === self && doMotor(k)) ||
		(ocultaNoError && alvo === self.Error && k === "prepareStackTrace");
	const temOculta = (alvo: unknown) => alvo === self || (ocultaNoError && alvo === self.Error);

	for (const caminho of [
		"Object.keys",
		"Object.getOwnPropertyNames",
		"Reflect.ownKeys",
	]) {
		client.Proxy(caminho, {
			apply(ctx) {
				const alvo = ctx.args[0];
				if (!temOculta(alvo)) return;
				const chaves = ctx.call() as PropertyKey[];
				ctx.return(chaves.filter((k) => !oculta(alvo, k)));
			},
		});
	}

	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			const alvo = ctx.args[0];
			if (!temOculta(alvo)) return;
			const todos = ctx.call() as Record<PropertyKey, PropertyDescriptor>;
			for (const k of Reflect.ownKeys(todos)) if (oculta(alvo, k)) delete todos[k as any];
			ctx.return(todos);
		},
	});

	if (!ocultaNoError) return;

	for (const caminho of ["Object.getOwnPropertyDescriptor", "Reflect.getOwnPropertyDescriptor"]) {
		client.Proxy(caminho, {
			apply(ctx) {
				if (oculta(ctx.args[0], ctx.args[1])) ctx.return(undefined);
			},
		});
	}
	client.Proxy("Object.hasOwn", {
		apply(ctx) {
			if (oculta(ctx.args[0], ctx.args[1])) ctx.return(false);
		},
	});
	client.Proxy("Object.prototype.hasOwnProperty", {
		apply(ctx) {
			if (oculta(ctx.this, ctx.args[0])) ctx.return(false);
		},
	});
}
