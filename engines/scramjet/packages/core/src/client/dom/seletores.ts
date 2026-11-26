import { ScramjetClient } from "@client/index";
import { Reflect_apply, Reflect_get, _Map, _Set } from "@/shared/snapshot";
import { trocarRapida } from "@client/shared/troca-rapida";

// vssh fork: um seletor de atributo escrito com o valor do site (`[href="/l1"]`, `[src^="/i"]`)
// casava o elemento só pelo valor que está no DOM, o endereço do motor. O motor guarda o que o site
// escreveu em `scramjet-attr-<nome>`, e a comparação passa a valer contra ele; um elemento que o
// motor não reescreveu (sem o atributo guardado) continua comparado pelo próprio atributo.

const GUARDADOS: Set<string> = new (_Set as any)([
	"href",
	"src",
	"srcset",
	"imagesrcset",
	"action",
	"formaction",
	"data",
	"poster",
	"srcdoc",
	"integrity",
	"style",
	"allow",
	"content",
]);
const COMPARACAO = /^\s*([A-Za-z_][\w-]*)\s*(=|~=|\|=|\^=|\$=|\*=)/;

/** O seletor com cada comparação de atributo guardado feita contra o valor do site. */
export function seletorDoSite(seletor: string): string {
	if (seletor.indexOf("[") < 0) return seletor;
	let saida = "";
	let i = 0;
	const n = seletor.length;
	const fimDaString = (j: number) => {
		const q = seletor[j];
		j++;
		while (j < n && seletor[j] !== q) j += seletor[j] === "\\" ? 2 : 1;

		return j + 1;
	};
	while (i < n) {
		const c = seletor[i];
		if (c === "\"" || c === "'") {
			const fim = fimDaString(i);
			saida += seletor.slice(i, fim);
			i = fim;
			continue;
		}
		if (c === "\\") {
			saida += seletor.slice(i, i + 2);
			i += 2;
			continue;
		}
		if (c !== "[") {
			saida += c;
			i++;
			continue;
		}
		let j = i + 1;
		while (j < n && seletor[j] !== "]") {
			if (seletor[j] === "\"" || seletor[j] === "'") j = fimDaString(j);
			else j += seletor[j] === "\\" ? 2 : 1;
		}
		const dentro = seletor.slice(i + 1, j);
		const casa = COMPARACAO.exec(dentro);
		const nome = casa?.[1].toLowerCase();
		if (casa && nome && GUARDADOS.has(nome)) {
			const resto = dentro.slice(dentro.indexOf(casa[1]) + casa[1].length);
			saida += `:is([scramjet-attr-${nome}${resto}],[${dentro}]:not([scramjet-attr-${nome}]))`;
		} else {
			saida += seletor.slice(i, j + 1);
		}
		i = j + 1;
	}

	return saida;
}

export default function (client: ScramjetClient, self: Self) {
	// O seletor passa por aqui a cada `querySelector`, e o comum não tem atributo guardado: ele vai
	// ao nativo depois de um `indexOf` e, com colchete, de uma regex com os nomes de `GUARDADOS`. A
	// tradução fica em cache.
	const CITA = /\[\s*(?:href|src|srcset|imagesrcset|action|formaction|data|poster|srcdoc|integrity|style|allow|content)\s*[~|^$*]?=/i;
	const traduzidos = new _Map<string, string>([]);
	const traduzir = (seletor: unknown): unknown => {
		if (typeof seletor !== "string" || seletor.indexOf("[") < 0 || !CITA.test(seletor)) return seletor;
		let t = traduzidos.get(seletor);
		if (t === undefined) {
			t = seletorDoSite(seletor);
			if (traduzidos.size >= 256) traduzidos.delete(traduzidos.keys().next().value!);
			traduzidos.set(seletor, t);
		}

		return t;
	};
	const metodos: [any, string][] = [
		[self.Document.prototype, "querySelector"],
		[self.Document.prototype, "querySelectorAll"],
		[self.DocumentFragment.prototype, "querySelector"],
		[self.DocumentFragment.prototype, "querySelectorAll"],
		[self.Element.prototype, "querySelector"],
		[self.Element.prototype, "querySelectorAll"],
		[self.Element.prototype, "matches"],
		[self.Element.prototype, "closest"],
		[self.Element.prototype, "webkitMatchesSelector"],
	];
	for (const [proto, nome] of metodos)
		trocarRapida(client, proto, nome, (anterior) =>
			function (this: unknown, ...args: any[]) {
				if (args.length === 0) return Reflect_apply(anterior, this, args);
				const traduzido = traduzir(args[0]);
				if (traduzido === args[0]) return Reflect_apply(anterior, this, args);
				// Um seletor que o navegador recusa recusa com o texto do site, e o erro que a
				// página recebe é o dele.
				try {
					return Reflect_apply(anterior, this, [traduzido, ...args.slice(1)]);
				} catch {
					return Reflect_apply(anterior, this, args);
				}
			},
		);

	// vssh fork: guardar o valor do site é escrever `scramjet-attr-<nome>`, e cada escrita vira um
	// registro do `MutationObserver` que o site não fez. Os registros desses atributos saem, e o
	// `oldValue` do atributo de verdade é o que o site escreveu antes.
	const PREFIXO = "scramjet-attr-";
	const limpar = (registros: MutationRecord[]): MutationRecord[] => {
		let temInterno = false;
		for (const r of registros) if (r.attributeName?.startsWith(PREFIXO)) temInterno = true;
		const antigos = new _Map<string, string | null>([]);
		if (temInterno)
			for (const r of registros)
				if (r.attributeName?.startsWith(PREFIXO))
					antigos.set(r.attributeName.slice(PREFIXO.length), r.oldValue);
		const saida: MutationRecord[] = [];
		for (const r of registros) {
			if (r.attributeName?.startsWith(PREFIXO)) continue;
			const nome = r.attributeName;
			let antigo = r.oldValue;
			if (nome && antigos.has(nome)) antigo = antigos.get(nome)!;
			else if (typeof antigo === "string" && antigo.startsWith(client.context.prefix.href))
				antigo = client.unrewriteUrl(antigo);
			if (antigo === r.oldValue) {
				saida.push(r);
				continue;
			}
			const valor = antigo;
			saida.push(
				new Proxy(r, {
					get(alvo, prop) {
						if (prop === "oldValue") return valor;
						const v = Reflect_get(alvo, prop, alvo);

						return typeof v === "function" ? v.bind(alvo) : v;
					},
				}),
			);
		}

		return saida;
	};
	if (!self.MutationObserver) return;
	client.Proxy("MutationObserver", {
		construct(ctx) {
			const chamada = ctx.args[0];
			if (typeof chamada !== "function") return;
			ctx.args[0] = function (this: unknown, registros: MutationRecord[], observador: MutationObserver) {
				const limpos = limpar(registros);
				if (limpos.length === 0) return;

				return Reflect_apply(chamada, this, [limpos, observador]);
			};
		},
	});
	client.Proxy("MutationObserver.prototype.takeRecords", {
		apply(ctx) {
			ctx.return(limpar(ctx.call() as MutationRecord[]));
		},
	});
}
