// Abas novas a pedido da página: com gesto da pessoa, sem gesto, e em rajada.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O motor entrega ao shell o `window.open`, o link `target=_blank` e o botão do meio de uma página
// proxiada, e cada aba nova sobe um frame do motor na thread do shell. O `open` nativo nunca é
// chamado, então o bloqueador de pop-up do navegador não age; a regra é do motor: a aba nova exige
// um gesto da pessoa e cabe num teto por minuto. A sonda mede as três situações com o mouse de
// verdade do playwright, que é o que dá ativação ao quadro.
//
// ─── O que reprova ───────────────────────────────────────────────────────────────────────────
//
//   · `window.open` sem gesto abre aba, ou não devolve `null`, ou não avisa o shell;
//   · o clique de verdade num link `target=_blank` não abre;
//   · a rajada de um clique passa do teto (10 por minuto, contando o link de antes);
//   · qualquer janela abre no navegador hospedeiro.

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 120000));

const TETO = 10;
const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();
const ctx = await navegador.newContext();
const pag = await ctx.newPage();
const janelasDoHospedeiro = [];
ctx.on("page", (p) => janelasDoHospedeiro.push(p.url()));

const contar = async (id) => {
	const r = await pag.evaluate((aba) => window.__bancada.retornos(aba), id);
	return {
		abertas: r.filter((x) => x[0] === "onOpenTab").length,
		bloqueadas: r.filter((x) => x[0] === "onPopupBloqueado").length,
	};
};
const clicar = async (id, seletor) => {
	const c = await pag.evaluate(([aba, s]) => window.__bancada.centro(aba, s), [id, seletor]);
	if (!c) throw new Error(`não achei ${seletor} na aba`);
	await pag.mouse.click(c.x, c.y);
	await pag.waitForTimeout(300);
};

const falhas = [];
try {
	await pag.goto(portal.base, { waitUntil: "load" });
	const aba = await pag.evaluate(async (alvo) => {
		await window.__bancada.iniciar();
		return window.__bancada.abrir(alvo, 20000);
	}, `http://site.teste:${sites.porta}/popups`);
	if (aba.marca !== "popups") throw new Error(`a página de pop-ups não carregou: ${JSON.stringify(aba)}`);

	// O `evaluate` do playwright roda com `userGesture: true`, e a ativação chega ao quadro de mesma
	// origem. O pedido sem gesto vai pelo CDP com `userGesture: false`, depois de a ativação
	// transitória das chamadas anteriores expirar (5 s no Chromium).
	await pag.waitForTimeout(5500);
	const cdp = await ctx.newCDPSession(pag);
	const sem = await cdp.send("Runtime.evaluate", {
		expression: `window.__bancada.naAba(${JSON.stringify(aba.id)}, "window.__semGesto(50)")`,
		awaitPromise: true, returnByValue: true, userGesture: false,
	});
	const nulos = sem.result.value;
	const semGesto = await contar(aba.id);
	console.log(`sem gesto: 50 window.open, ${nulos} devolveram null, ${semGesto.abertas} abriram, ${semGesto.bloqueadas} avisaram o shell`);
	if (nulos !== 50) falhas.push(`window.open sem gesto devolveu algo diferente de null em ${50 - nulos} chamada(s)`);
	if (semGesto.abertas) falhas.push(`${semGesto.abertas} aba(s) abriram sem gesto`);
	if (semGesto.bloqueadas !== 50) falhas.push(`o shell soube de ${semGesto.bloqueadas} dos 50 bloqueios`);

	await clicar(aba.id, "#novo");
	const link = await contar(aba.id);
	console.log(`clique de verdade no link target=_blank: ${link.abertas} aberta(s)`);
	if (link.abertas !== 1) falhas.push(`o clique de verdade no link abriu ${link.abertas} aba(s), e não 1`);

	await clicar(aba.id, "#rajada");
	const rajada = await contar(aba.id);
	const abertasNaRajada = rajada.abertas - link.abertas;
	const bloqueadasNaRajada = rajada.bloqueadas - semGesto.bloqueadas;
	console.log(`um clique que pede 15 abas: ${abertasNaRajada} abertas, ${bloqueadasNaRajada} bloqueadas (teto de ${TETO} por minuto)`);
	if (rajada.abertas !== TETO) falhas.push(`a rajada levou o total a ${rajada.abertas} abas no minuto, e o teto é ${TETO}`);
	if (abertasNaRajada + bloqueadasNaRajada !== 15) falhas.push("a rajada perdeu pedidos: nem abriu nem avisou");
} catch (e) {
	falhas.push(`a sonda não chegou a medir: ${e?.message || e}`);
} finally {
	if (janelasDoHospedeiro.length) falhas.push(`abriu ${janelasDoHospedeiro.length} janela(s) no navegador hospedeiro`);
	await ctx.close();
	await navegador.close();
	await portal.fechar();
	await sites.fechar();
}

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ sem gesto nada abre e o shell é avisado; com gesto abre, até o teto");
