import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";
import { blobNativo, ehUrlDeDados } from "./fetch";
import { enderecoDeConexao } from "@client/csp";

export default function (client: ScramjetClient) {
	client.Proxy("EventSource", {
		construct(ctx) {
			const url = String(ctx.args[0]);
			if (ehUrlDeDados(url)) return;
			ctx.args[0] =
				blobNativo(client, url) ?? enderecoDeConexao(client, url, () => client.rewriteUrl(url));
		},
	});

	client.Trap("EventSource.prototype.url", {
		get(ctx) {
			return client.unrewriteUrl(ctx.get());
		},
	});
}
