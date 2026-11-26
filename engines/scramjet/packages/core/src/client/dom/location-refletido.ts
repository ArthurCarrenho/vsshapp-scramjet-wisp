import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";
import { Object_getOwnPropertyDescriptor, Object_hasOwn, Reflect_apply, Reflect_ownKeys } from "@/shared/snapshot";
import { trocarRapida } from "@client/shared/troca-rapida";

// vssh fork: `window.location` e `document.location` são propriedades próprias e fixas (o
// [LegacyUnforgeable] do WebIDL), e o motor não troca o setter delas. O reescritor leva a
// atribuição escrita no código (`location = x`) ao `location` do site, mas `Reflect.set(window,
// "location", x)` e `Object.assign(window, { location: x })` chegam ao nativo: a página navegava de
// verdade, e um `javascript:` rodava sem reescrita. Os dois passam a ir ao `location` do site.

function clienteDoAlvo(client: ScramjetClient, alvo: unknown): ScramjetClient | null {
	if (!alvo || typeof alvo !== "object") return null;
	if (!client.box.instanceof(alvo, "Window") && !client.box.instanceof(alvo, "Document")) return null;
	try {
		return (alvo as any)[SCRAMJETCLIENT] ?? null;
	} catch {
		return null;
	}
}

export default function (client: ScramjetClient, _self: Self) {
	trocarRapida(client, client.global.Reflect, "set", (nativo) => ({
		set(...args: any[]) {
			if (args[1] === "location") {
				const dono = clienteDoAlvo(client, args[0]);
				if (dono) {
					dono.locationProxy.href = args[2];

					return true;
				}
			}

			return Reflect_apply(nativo, undefined, args);
		},
	}).set);

	trocarRapida(client, client.global.Object, "assign", (nativo) => ({
		assign(...args: any[]) {
			// O caso comum sai primeiro: nenhuma fonte com `location` própria e enumerável.
			let temLocation = false;
			for (let i = 1; i < args.length; i++) {
				const f = args[i];
				if (f === null || (typeof f !== "object" && typeof f !== "function")) continue;
				if (!Object_hasOwn(f, "location")) continue;
				if (Object_getOwnPropertyDescriptor(f, "location")?.enumerable) temLocation = true;
			}
			if (!temLocation) return Reflect_apply(nativo, undefined, args);
			const alvo = args[0];
			const fontes = args.slice(1);
			const dono = clienteDoAlvo(client, alvo);
			if (!dono) return Reflect_apply(nativo, undefined, args);
			// A cópia segue a ordem do nativo: cada fonte, cada chave própria e enumerável.
			for (const fonte of fontes) {
				// Um texto copia os caracteres pelos índices; os outros primitivos não têm o que copiar.
				const de: any = typeof fonte === "string" ? [...fonte] : fonte;
				if (de === null || (typeof de !== "object" && typeof de !== "function")) continue;
				for (const chave of Reflect_ownKeys(de)) {
					const d = Object_getOwnPropertyDescriptor(de, chave);
					if (!d || !d.enumerable) continue;
					if (chave === "location") dono.locationProxy.href = de[chave];
					else alvo[chave] = de[chave];
				}
			}

			return alvo;
		},
	}).assign);
}
