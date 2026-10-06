// O que mudou a URL de uma página: `pushState` ou `replaceState`.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O shell decide pela mudança se a pilha de Voltar ganha uma entrada ou troca a corrente, e se o
// histórico grava uma visita. Um mapa que reescreve a URL por `replaceState` a cada arrasto não
// pode virar trinta entradas. O motor sabe qual dos dois a página chamou (o `navigate` do cliente,
// com `historico`), e o `UrlWatcherPlugin` o entrega ao shell em `mudanca.tipo`. A sonda abre a
// página `/spa`, chama `pushState` três vezes e `replaceState` trinta, e conta o que chegou.
//
// ─── O que reprova ───────────────────────────────────────────────────────────────────────────
//
//   · um `pushState` que não chega como `push`, ou um `replaceState` que não chega como `replace`;
//   · uma chamada que não chega ao shell.

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 120000));

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();
const pag = await (await navegador.newContext()).newPage();

const falhas = [];
try {
	await pag.goto(portal.base, { waitUntil: "load" });
	const aba = await pag.evaluate(async (alvo) => {
		await window.__bancada.iniciar();
		return window.__bancada.abrir(alvo, 20000);
	}, `http://site.teste:${sites.porta}/spa`);
	if (aba.marca !== "spa") throw new Error(`a página /spa não carregou: ${JSON.stringify(aba)}`);

	const antes = (await pag.evaluate((id) => window.__bancada.retornos(id), aba.id)).length;
	await pag.evaluate((id) => window.__bancada.naAba(id, `(() => {
		for (let i = 1; i <= 3; i++) window.__navegarSemTrocarDocumento(i);
		for (let i = 1; i <= 30; i++) window.__substituirSemTrocarDocumento(i);
		return true;
	})()`), aba.id);
	await pag.waitForTimeout(300);
	const navs = (await pag.evaluate((id) => window.__bancada.retornos(id), aba.id))
		.slice(antes).filter((r) => r[0] === "onNavigate");

	const push = navs.filter((r) => r[2] === "push").length;
	const replace = navs.filter((r) => r[2] === "replace").length;
	const semTipo = navs.filter((r) => !r[2]).length;
	console.log(`3 pushState e 30 replaceState: ${navs.length} avisos ao shell, ${push} push, ${replace} replace, ${semTipo} sem tipo`);
	console.log(`a última URL avisada: ${navs.at(-1)?.[1]}`);
	if (push !== 3) falhas.push(`${push} pushState chegaram como push, e não 3`);
	if (replace !== 30) falhas.push(`${replace} replaceState chegaram como replace, e não 30`);
	if (!String(navs.at(-1)?.[1] || "").endsWith("/spa/r30")) falhas.push("a última URL avisada não é a do último replaceState");
} catch (e) {
	falhas.push(`a sonda não chegou a medir: ${e?.message || e}`);
} finally {
	await navegador.close();
	await portal.fechar();
	await sites.fechar();
}

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ o shell sabe se a página empilhou ou trocou a URL");
