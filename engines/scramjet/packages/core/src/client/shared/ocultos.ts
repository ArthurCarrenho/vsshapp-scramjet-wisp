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

	for (const caminho of [
		"Object.keys",
		"Object.getOwnPropertyNames",
		"Reflect.ownKeys",
	]) {
		client.Proxy(caminho, {
			apply(ctx) {
				if (ctx.args[0] !== self) return;
				const chaves = ctx.call() as PropertyKey[];
				ctx.return(chaves.filter((k) => !doMotor(k)));
			},
		});
	}

	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			if (ctx.args[0] !== self) return;
			const todos = ctx.call() as Record<PropertyKey, PropertyDescriptor>;
			for (const k of Object.keys(todos)) if (doMotor(k)) delete todos[k];
			ctx.return(todos);
		},
	});
}
