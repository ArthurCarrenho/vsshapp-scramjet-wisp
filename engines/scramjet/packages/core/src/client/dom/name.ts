import { ScramjetClient } from "@client/index";
import { Symbol_for } from "@/shared/snapshot";

// O nome que o controller deu ao frame, quando o frame não tinha um (`inject.ts`).
const NOMEGERADO = Symbol_for("scramjet frame generated name");

/**
 * vssh fork: `window.name` começa vazio numa aba de navegador, e o motor batiza o frame dele com
 * um id sorteado (`npidcae3`) para achá-lo depois. A página lê o nome vazio enquanto o nome do
 * contexto for o que o motor deu; um nome que a página ou um `<iframe name>` dela escolheu aparece
 * como veio.
 */
export default function (client: ScramjetClient, self: Self) {
	client.Trap("name", {
		get(ctx) {
			const nome = ctx.get() as string;
			let frame: any = null;
			try {
				frame = client.descriptors.get("window.frameElement", self);
			} catch {
				return nome;
			}

			return frame && frame[NOMEGERADO] === nome ? "" : nome;
		},
		set(ctx, v) {
			ctx.set(v);
		},
	});
}
