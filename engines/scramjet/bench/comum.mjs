// Peças que toda a bancada usa.

import { pathToFileURL } from "node:url";

// ── De onde vem o Playwright ──────────────────────────────────────────────────────────────
//
// Nenhum destes repositórios depende de playwright em produção, e não deve: isto é bancada. A
// resolução é, nesta ordem: `BENCH_PLAYWRIGHT` apontando para o `index.js` de uma instalação
// qualquer (é como se roda aqui, reaproveitando a do fork do scramjet), ou a resolução normal de
// módulos, para quem tiver `npm i -D playwright` na pasta.
const mod = process.env.BENCH_PLAYWRIGHT
	? await import(pathToFileURL(process.env.BENCH_PLAYWRIGHT).href)
	: await import("playwright");

export const chromium = mod.chromium ?? mod.default?.chromium;
if (!chromium) {
	throw new Error(
		"não achei o chromium do playwright — aponte BENCH_PLAYWRIGHT para o index.js de uma instalação"
	);
}

/**
 * Espera um servidor atender, em vez de dormir um tempo fixo.
 *
 * ⚠ Isto não é preciosismo. Os runners dormiam 1,5 s antes de falar com o contador, e na primeira
 * execução — sem cache de módulo, importando o wisp e o `rede.js` do backend — isso não bastava: o
 * runner morria com ECONNREFUSED e parecia defeito da bancada. Uma bancada que falha na primeira
 * rodada não é usada duas vezes.
 */
export async function esperarServidor(base, limiteMs = 30000) {
	const fim = Date.now() + limiteMs;
	for (;;) {
		try {
			await fetch(base, { signal: AbortSignal.timeout(2000) });
			return;
		} catch {
			if (Date.now() > fim) throw new Error(`servidor não atendeu em ${limiteMs}ms: ${base}`);
			await new Promise((r) => setTimeout(r, 300));
		}
	}
}

/**
 * Prazo de morte para o processo inteiro. Todo script da bancada dirige um navegador e fala com a
 * rede; qualquer um deles pode pendurar, e pendurar em primeiro plano trava a sessão de quem está
 * depurando. Melhor abortar dizendo que abortou.
 */
export function prazoDeMorte(ms = Number(process.env.BENCH_LIMITE || 300000)) {
	const t = setTimeout(() => {
		console.log(`\n[abortado: estourou ${ms}ms]`);
		process.exit(2);
	}, ms);
	t.unref?.();
	return t;
}
