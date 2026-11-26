import { ScramjetClient } from "@client/index";
import { String, String_startsWith } from "@/shared/snapshot";

/**
 * vssh fork: a recusa do `connect-src` (ver `politicaDeConexao` em `fetch/headers.ts`) dispara o
 * `securitypolicyviolation` do navegador, e os endereços dele são os da origem do motor. Cada
 * campo que carrega um endereço volta ao do site. `blockedURI` de um `data:` já vem como o Chrome
 * escreve (`data`), e um valor fora do prefixo do motor passa como está.
 */
export default function (client: ScramjetClient, self: Self) {
	if (typeof (self as any).SecurityPolicyViolationEvent !== "function") return;

	const prefixo = client.context.prefix.href;
	for (const campo of ["documentURI", "blockedURI", "sourceFile", "referrer"]) {
		client.Trap(`SecurityPolicyViolationEvent.prototype.${campo}`, {
			get(ctx) {
				const valor = String(ctx.get());
				return String_startsWith(valor, prefixo)
					? client.unrewriteUrl(valor)
					: valor;
			},
		});
	}
}
