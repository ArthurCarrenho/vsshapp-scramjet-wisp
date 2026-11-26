import { ScramjetClient } from "@client/index";

export default function (client: ScramjetClient, self: Self) {
	const gravar = (value: string) => {
		client.context.cookieJar.setCookies(value, client.url);
		client.init.sendSetCookie([
			{
				url: client.url,
				cookie: value,
			},
		]);
	};

	client.Trap("Document.prototype.cookie", {
		get() {
			return client.context.cookieJar.getCookies(client.url, true);
		},
		set(ctx, value: string) {
			gravar(value);
		},
	});

	// ─── cookieStore pelo mesmo jar ───────────────────────────────────────────────────────
	//
	// O `cookieStore` nativo fala com o cookie jar do navegador, que guarda os cookies da
	// origem do motor. Os cookies da página proxiada moram no jar do Scramjet, e por isso cada
	// método nativo é trocado por um que lê e escreve nele, pelo mesmo caminho do
	// `document.cookie`. O objeto, o protótipo e o `toString` dos métodos continuam os do
	// navegador: um Chrome sem `cookieStore` é um Chrome que não existe, e o desafio do
	// Cloudflare grava cookie por ele.
	if (typeof (self as any).CookieStore !== "function") return;

	const lista = (): { name: string; value: string }[] => {
		const texto = client.context.cookieJar.getCookies(client.url, true);
		if (!texto) return [];
		return texto.split("; ").map((par) => {
			const i = par.indexOf("=");
			return i === -1
				? { name: "", value: par }
				: { name: par.slice(0, i), value: par.slice(i + 1) };
		});
	};
	const item = (c: { name: string; value: string }) => ({
		domain: null,
		expires: null,
		name: c.name,
		partitioned: false,
		path: "/",
		sameSite: "lax",
		secure: true,
		value: c.value,
	});
	const filtro = (args: any[]) => {
		const a = args[0];
		if (a === undefined) return null;
		if (typeof a === "object" && a !== null) return a.name ?? null;
		return String(a);
	};
	const ler = (args: any[]) => {
		const nome = filtro(args);
		const todos = lista();
		return nome === null ? todos : todos.filter((c) => c.name === nome);
	};
	const montar = (o: any) => {
		let s = `${o.name ?? ""}=${o.value ?? ""}`;
		if (o.expires !== undefined && o.expires !== null)
			s += `; Expires=${new Date(o.expires).toUTCString()}`;
		if (o.domain) s += `; Domain=${o.domain}`;
		s += `; Path=${o.path ?? "/"}`;
		s += `; SameSite=${o.sameSite ?? "strict"}`;
		s += "; Secure";
		if (o.partitioned) s += "; Partitioned";
		return s;
	};
	const tentar = (ctx: any, fn: () => any) => {
		try {
			ctx.return(Promise.resolve(fn()));
		} catch (e) {
			ctx.return(Promise.reject(e));
		}
	};

	client.Proxy("CookieStore.prototype.get", {
		apply(ctx) {
			tentar(ctx, () => {
				const c = ler(ctx.args)[0];
				return c ? item(c) : null;
			});
		},
	});
	client.Proxy("CookieStore.prototype.getAll", {
		apply(ctx) {
			tentar(ctx, () => ler(ctx.args).map(item));
		},
	});
	client.Proxy("CookieStore.prototype.set", {
		apply(ctx) {
			tentar(ctx, () => {
				const a = ctx.args[0];
				const o =
					typeof a === "object" && a !== null
						? a
						: { name: String(a), value: String(ctx.args[1]) };
				if (ctx.args.length < 1 || (typeof a !== "object" && ctx.args.length < 2))
					throw new TypeError(
						"Failed to execute 'set' on 'CookieStore': 2 arguments required, but only " +
							ctx.args.length +
							" present."
					);
				gravar(montar(o));
				return undefined;
			});
		},
	});
	client.Proxy("CookieStore.prototype.delete", {
		apply(ctx) {
			tentar(ctx, () => {
				const a = ctx.args[0];
				const o = typeof a === "object" && a !== null ? a : { name: String(a) };
				gravar(montar({ ...o, value: "", expires: 0 }));
				return undefined;
			});
		},
	});
}
