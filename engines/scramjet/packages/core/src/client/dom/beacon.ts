import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";
import { ehUrlDeDados } from "@client/shared/requests/fetch";
import { enderecoDeConexao } from "@client/csp";

export default function (client: ScramjetClient, _self: Self) {
	client.Proxy("Navigator.prototype.sendBeacon", {
		apply(ctx) {
			const url = String(ctx.args[0]);
			// O Chrome recusa um beacon fora de HTTP(S) com o erro dele; reescrito, o `data:` viraria
			// um beacon aceito para a origem do motor.
			if (ehUrlDeDados(url)) return;
			ctx.args[0] = enderecoDeConexao(client, url, () => client.rewriteUrl(url));
		},
	});
}
