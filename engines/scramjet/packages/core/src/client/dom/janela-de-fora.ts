import type { ScramjetClient } from "@client/index";
import { janelaReal } from "@client/janela-cruzada";

// vssh fork: o tamanho de fora da janela, como o de uma aba.
//
// Para o site, o quadro de cima do motor é a aba, mas o `outerWidth` e o `outerHeight` que o
// navegador dá são os da janela do ambiente, que tem a barra do navegador embutido, a moldura da
// janela e o resto da área de trabalho em volta do quadro. No Chrome a diferença entre o tamanho
// de fora e o de dentro é só a barra do próprio Chrome. Aqui o tamanho de fora é o de dentro do
// quadro de cima do motor somado à barra da janela do navegador de verdade.

export default function (client: ScramjetClient, self: typeof window) {
	const topoDoSite = (): Window | null => {
		try {
			const topo = janelaReal(client.wrapfn(self.top)) as Window;
			return topo && topo !== self.top ? topo : null;
		} catch {
			return null;
		}
	};

	for (const [nome, dentro] of [
		["outerWidth", "innerWidth"],
		["outerHeight", "innerHeight"],
	] as const) {
		client.Trap(`window.${nome}`, {
			get(ctx) {
				const nativo = ctx.get() as number;
				const topo = topoDoSite();
				if (!topo) return nativo;
				try {
					const real = self.top!;
					const barra = Math.max(0, real[nome] - real[dentro]);

					return topo[dentro] + barra;
				} catch {
					return nativo;
				}
			},
		});
	}
}
