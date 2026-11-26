import { ScramjetClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: ScramjetClient, _self: Self) {
	client.Trap("PerformanceEntry.prototype.name", {
		get(ctx) {
			// name is going to be a url typically
			const name = String(ctx.get());

			if (name && name.startsWith(client.context.prefix.href)) {
				return client.unrewriteUrl(name);
			}

			return name;
		},
	});

	const filterEntries = (entries: PerformanceEntry[]) => {
		return entries.filter((entry) => {
			const name = String(
				client.descriptors.get("PerformanceEntry.prototype.name", entry)
			);
			for (const file of client.config.maskedfiles) {
				if (name.endsWith(file)) {
					return false;
				}
			}
			// vssh fork: o Chrome não registra um recurso blob: nem data: na linha do tempo. Pelo
			// motor esses endereços viram um pedido sob o prefixo, que o service worker atende, e o
			// registro aparecia para o site (o Worker de blob do Turnstile deixava dois).
			if (entry.entryType === "resource" && name.startsWith(client.context.prefix.href)) {
				let real = "";
				try {
					real = client.unrewriteUrl(name);
				} catch {}
				if (real.startsWith("blob:") || real.startsWith("data:")) return false;
			}

			return true;
		});
	};

	client.Proxy(
		[
			"Performance.prototype.getEntries",
			"Performance.prototype.getEntriesByType",
			"Performance.prototype.getEntriesByName",
			"PerformanceObserverEntryList.prototype.getEntries",
			"PerformanceObserverEntryList.prototype.getEntriesByType",
			"PerformanceObserverEntryList.prototype.getEntriesByName",
		],
		{
			apply(ctx) {
				const entries = ctx.call() as PerformanceEntry[];

				return ctx.return(filterEntries(entries));
			},
		}
	);
}
