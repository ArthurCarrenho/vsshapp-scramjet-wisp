import type { ScramjetClient } from "@client/index";
import { janelaReal } from "@client/janela-cruzada";
import { SCRAMJETCLIENT } from "@/symbols";

// vssh fork: as notificações num quadro de outra origem.
//
// O Chrome não deixa um quadro de terceiro pedir notificação: `Notification.permission` e a
// consulta de `navigator.permissions` respondem `"denied"` nele. Para o navegador todo quadro do
// motor é da mesma origem que o topo, e a resposta seria a do topo.

export default function (client: ScramjetClient, self: typeof window) {
	const deTerceiro = (): boolean => {
		try {
			const topo = janelaReal(client.wrapfn(self.top)) as Window;
			if (!topo || topo === self || topo === self.top) return false;
			if (!(topo as any)[SCRAMJETCLIENT]) return false;

			return topo.origin !== self.origin;
		} catch {
			return false;
		}
	};
	const negadas = new WeakSet<object>();

	client.Proxy("Permissions.prototype.query", {
		apply(ctx) {
			let nome: unknown;
			try {
				nome = (ctx.args[0] as any)?.name;
			} catch {
				return;
			}
			if (nome !== "notifications" || !deTerceiro()) return;
			const p = ctx.call() as Promise<any>;
			ctx.return(
				p.then((status) => {
					negadas.add(status);

					return status;
				})
			);
		},
	});
	client.Trap("PermissionStatus.prototype.state", {
		get(ctx) {
			return negadas.has(ctx.this as object) ? "denied" : ctx.get();
		},
	});
	client.Trap("Notification.permission", {
		get(ctx) {
			return deTerceiro() ? "denied" : ctx.get();
		},
	});
	client.Proxy("Notification.requestPermission", {
		apply(ctx) {
			if (!deTerceiro()) return;
			const cb = ctx.args[0];
			if (typeof cb === "function") self.setTimeout(() => cb("denied"), 0);
			ctx.return(self.Promise.resolve("denied"));
		},
	});
}
