// Quando NADA volta: a aba gira, ou alguém acorda?
//
// ─── O defeito que este script existe para observar ──────────────────────────────────────────
//
// *"Às vezes o navegador não funciona de primeira, precisa de um F5. Fica carregando infinito, sem
// log, sem nada."* A causa é estrutural: toda recuperação do `ScramjetEngine` é disparada por algo
// CHEGAR — o `load` do iframe, um documento novo no watcher de `requestAnimationFrame`. Quando
// nada chega, ninguém acorda, e o único gesto que resolve é o F5.
//
// Reproduzir isso com um site de verdade é sorte. Aqui o gatilho é determinístico: a rota `/lento`
// do sítio local ACEITA a conexão e nunca responde. Do ponto de vista do motor é indistinguível de
// um túnel que morreu no meio ou de um RPC que se perdeu — as três produzem o mesmo silêncio.
//
// ─── O que conta como conserto ───────────────────────────────────────────────────────────────
//
// Não é "a página carregou": ela não pode carregar, porque o outro lado não responde. É que o
// silêncio acaba. Quatro coisas, e todas têm de acontecer:
//
//   1. o log nomeia QUAL elo não respondeu (sem isso, "sem log, sem nada" continua valendo);
//   2. a bandeja mostra a condição em curso, para a pessoa não achar que travou;
//   3. `getStatus()` para de dizer `connected` — era ele que fazia as Configurações concordarem
//      com o motor enquanto a aba girava na frente da pessoa;
//   4. esgotadas as tentativas, a aba mostra uma saída em vez de um giro eterno.
//
// ─── A coluna de controle ────────────────────────────────────────────────────────────────────
//
// Um alvo normal tem de produzir ZERO das quatro. Sem essa coluna, o script provaria só que "o
// motor às vezes reclama", que é verdade em toda versão dele.
//
//   BENCH_CHROME  o binário do Chromium
//   BENCH_LIMITE  prazo de morte (o ciclo do cão de guarda leva ~40 s; o padrão daqui é 180 s)

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 180000));

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();

/** Abre uma aba no alvo e devolve tudo que a camada do portal produziu enquanto isso. */
async function rodada(caminho, esperaMs) {
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(portal.base, { waitUntil: "load" });
	const r = await pag.evaluate(async ([alvo, espera]) => {
		await window.__bancada.iniciar();
		const antes = window.__bancada.estado();
		const aba = await window.__bancada.abrir(alvo, espera);
		return {
			...aba,
			antes,
			depois: window.__bancada.estado(),
			// O estado é lido DURANTE a espera também: quando o motor desiste e a aba recebe a
			// página de falha, `getStatus()` já voltou ao normal. Ler só no fim perderia o meio.
			atividades: window.__bancada.atividades(),
			log: window.__bancada.log().map((l) => l[1]).filter((t) => t.includes("[scramjet]")),
			corpo: (() => { try { return document.querySelector("iframe").contentDocument.body.textContent.slice(0, 160); } catch (e) { return "opaco"; } })(),
		};
	}, [`http://site.teste:${sites.porta}${caminho}`, esperaMs]);
	await ctx.close();
	return r;
}

const marcas = (r) => ({
	logDoVigia:    r.log.some((t) => t.includes("nada voltou")),
	logDeDesistir: r.log.some((t) => t.includes("se esgotou")),
	bandeja:       r.atividades.some((a) => a[0] === "set" && a[1] === "motor-navegacao"),
	statusMudou:   r.depois === "recuperando" || r.log.some((t) => t.includes("nada voltou")),
	temSaida:      /Tentar novamente/.test(r.corpo || ""),
});

console.log("→ controle: um alvo que responde");
const bom = await rodada("/", 20000);
const mBom = marcas(bom);
console.log(`   estado=${bom.estado} marca=${bom.marca} motor=${bom.depois}`);
console.log(`   ${JSON.stringify(mBom)}`);

console.log("\n→ o gatilho: um alvo que aceita e nunca responde");
const ruim = await rodada("/lento", 60000);
const mRuim = marcas(ruim);
console.log(`   estado=${ruim.estado} marca=${ruim.marca} motor=${ruim.depois}`);
console.log(`   ${JSON.stringify(mRuim)}`);
for (const t of ruim.log) console.log(`   log: ${t.slice(0, 220)}`);

await navegador.close();
await portal.fechar();
await sites.fechar();

console.log("\n=== veredito ===");
const falhas = [];
if (bom.marca !== "inicio") falhas.push("o alvo de controle não carregou — a rodada inteira não vale");
for (const [k, v] of Object.entries(mBom)) if (v) falhas.push(`o alvo NORMAL disparou "${k}" — o gatilho não é o que se pensa`);
for (const k of ["logDoVigia", "bandeja", "statusMudou"]) {
	if (!mRuim[k]) falhas.push(`o alvo pendurado NÃO produziu "${k}" — o silêncio continua`);
}
if (!mRuim.logDeDesistir) falhas.push('o vigia não registrou que desistiu — desistir calado é o defeito com outro nome');
if (!mRuim.temSaida) falhas.push("a aba vazia ficou sem saída visível — é o giro eterno");

if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ o silêncio acabou: log com diagnóstico, rastro na bandeja, estado honesto e uma saída na tela");
