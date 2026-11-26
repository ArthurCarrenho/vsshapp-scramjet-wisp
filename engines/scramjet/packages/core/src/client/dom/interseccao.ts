import type { ScramjetClient } from "@client/index";
import { janelaReal } from "@client/janela-cruzada";
import { SCRAMJETCLIENT } from "@/symbols";

// vssh fork: o `rootBounds` de um `IntersectionObserver` sem raiz, como o de uma aba.
//
// Sem raiz, a área de referência é a janela de cima. O navegador mede pela janela do ambiente, e o
// `rootBounds` sairia com o tamanho dela. No Chrome ele é a área visível do topo do site, e num
// quadro de outra origem ele é `null`, porque o quadro não pode saber o tamanho de quem o contém.

export default function (client: ScramjetClient, self: typeof window) {
	if (!self.IntersectionObserver || !self.IntersectionObserverEntry) return;
	const semRaiz = new WeakSet<object>();
	const observadoresSemRaiz = new WeakSet<object>();

	const marcar = (entradas: unknown) => {
		if (!Array.isArray(entradas)) return;
		for (const e of entradas) if (e && typeof e === "object") semRaiz.add(e);
	};

	client.Proxy("IntersectionObserver", {
		construct(ctx) {
			const [callback, opcoes] = ctx.args as [unknown, any];
			let raiz: unknown;
			try {
				raiz = opcoes == null ? null : opcoes.root;
			} catch {
				return;
			}
			if (raiz != null || typeof callback !== "function") return;
			ctx.args[0] = function (this: unknown, entradas: unknown, observador: unknown) {
				marcar(entradas);

				return Reflect.apply(callback, this, [entradas, observador]);
			};
			const obs = ctx.call() as IntersectionObserver;
			observadoresSemRaiz.add(obs);
			ctx.return(obs);
		},
	});

	client.Proxy("IntersectionObserver.prototype.takeRecords", {
		apply(ctx) {
			const r = ctx.call();
			if (observadoresSemRaiz.has(ctx.this as object)) marcar(r);
			ctx.return(r);
		},
	});

	const topoDoSite = (): Window | null => {
		try {
			const topo = janelaReal(client.wrapfn(self.top)) as Window;
			return topo && topo !== self.top ? topo : null;
		} catch {
			return null;
		}
	};

	client.Trap("IntersectionObserverEntry.prototype.rootBounds", {
		get(ctx) {
			const nativo = ctx.get();
			if (!nativo || !semRaiz.has(ctx.this as object)) return nativo;
			const topo = topoDoSite();
			if (!topo) return nativo;
			try {
				if (!(topo as any)[SCRAMJETCLIENT] || topo.origin !== self.origin) return null;
				const raiz = topo.document.documentElement;

				return new self.DOMRectReadOnly(0, 0, raiz.clientWidth, raiz.clientHeight);
			} catch {
				return nativo;
			}
		},
	});
}
