import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient) {
	client.Proxy("IDBFactory.prototype.open", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	// vssh fork: o `deleteDatabase` apaga o banco do site, que mora com o mesmo prefixo do `open`,
	// e o `databases` lista só os bancos do site, com o nome que o site deu. Sem isso a lista
	// trazia os bancos do motor (`__scramjet_controller`) e os de todos os outros sites abertos
	// pelo proxy, cada um com a origem na frente.
	client.Proxy("IDBFactory.prototype.deleteDatabase", {
		apply(ctx) {
			ctx.args[0] = `${client.url.origin}@${ctx.args[0]}`;
		},
	});

	client.Proxy("IDBFactory.prototype.databases", {
		apply(ctx) {
			const prefixo = `${client.url.origin}@`;
			const lista: Promise<IDBDatabaseInfo[]> = ctx.call();
			ctx.return(
				lista.then((bancos) =>
					bancos
						.filter((b) => typeof b.name === "string" && b.name.startsWith(prefixo))
						.map((b) => ({ name: b.name.slice(prefixo.length), version: b.version }))
				)
			);
		},
	});

	client.Trap("IDBDatabase.prototype.name", {
		get(ctx) {
			const name = String(ctx.get());

			return name.substring(name.indexOf("@") + 1);
		},
	});
}
