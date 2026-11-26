// O que o site vê do isolamento de origem, pelo motor e num Chrome direto.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O Chrome isola de outras origens o documento que pede: COOP `same-origin` e COEP no cabeçalho.
// O site vê isso em quatro lugares: `crossOriginIsolated`, o nome `SharedArrayBuffer` no global,
// `performance.measureUserAgentSpecificMemory` e o passo do relógio (5 µs isolado, 100 µs fora).
// Pelo motor, quem decide o isolamento de verdade é a página que hospeda as abas. Um shell comum
// não isola ninguém, e o da amostra do portal (`src/utils/isolamento.ts` do vssh-sso) isola todo
// documento proxiado. A resposta ao site tem de seguir o pedido do site, e não o shell.
//
// ─── As três colunas ─────────────────────────────────────────────────────────────────────────
//
//   direto          o Chrome abrindo o site, a referência
//   shell comum     o motor numa página sem isolamento
//   shell isolado   o motor numa página com COOP e COEP `credentialless`, a da amostra
//
// Cada coluna abre dois sites: `site.localhost/medida`, que não pede nada, e
// `isolado.localhost/medida`, que pede. A página mede a si mesma, três quadros (mesma origem,
// outra origem, outra origem com `allow="cross-origin-isolated"`) e dois workers (de URL e de
// `blob:`). Os hosts são `*.localhost` porque o Chrome só isola uma origem confiável.
//
// O veredito cobra a coluna do shell isolado inteira contra a direta, e a do shell comum só no
// site que não pede: sem isolamento de verdade o motor não tem `SharedArrayBuffer` para entregar.

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 180000));

const sites = await subirSites();
const navegador = await abrirNavegador({ args: ["--no-sandbox"] });
const SITES = { "não pede": `http://site.localhost:${sites.porta}/medida`, "pede": `http://isolado.localhost:${sites.porta}/medida` };

const completa = (m) => !!m && Object.keys(m.quadros).length === 3 && !!m.trabalho && !!m.trabalhoDeBlob;

async function direto(alvo) {
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(alvo, { waitUntil: "load" });
	await pag.waitForFunction(() => window.__medida && Object.keys(window.__medida.quadros).length === 3
		&& window.__medida.trabalho && window.__medida.trabalhoDeBlob, null, { timeout: 15000 }).catch(() => {});
	const m = await pag.evaluate(() => window.__medida);
	await ctx.close();
	return m;
}

async function peloMotor(alvo, isolamento) {
	const portal = await subirPortal({ portaSites: sites.porta, isolamento });
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(portal.base, { waitUntil: "load" });
	const m = await pag.evaluate(async (u) => {
		await window.__bancada.iniciar();
		const aba = await window.__bancada.abrir(u, 20000);
		let m = null;
		for (let i = 0; i < 75; i++) {
			m = await window.__bancada.naAba(aba.id, "window.__medida || null");
			if (m && Object.keys(m.quadros).length === 3 && m.trabalho && m.trabalhoDeBlob) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		return { shell: window.crossOriginIsolated, m: m && JSON.parse(JSON.stringify(m)) };
	}, alvo);
	await ctx.close();
	await portal.fechar();
	return m;
}

// O passo do relógio entra no veredito como classe: 5 µs e 100 µs variam com a carga da máquina.
const classe = (r) => r && `${r.isolado ? "isolado" : "comum"} sab=${r.sab}${r.nome ? "" : "(sem nome)"} memoria=${r.memoria} relogio=${r.passo < 50 ? "fino" : "grosso"}`;
const passos = (m) => !m ? "" : `relógio da página: ${m.pagina.passo} µs`;
const linhas = (m) => !m ? {} : {
	"a página": classe(m.pagina),
	"quadro da mesma origem": classe(m.quadros.mesma),
	"quadro de outra origem": classe(m.quadros.outra),
	"quadro de outra origem com allow": classe(m.quadros["outra-com-allow"]),
	"worker": classe(m.trabalho),
	"worker de blob:": classe(m.trabalhoDeBlob),
};

const falhas = [];
for (const [nome, alvo] of Object.entries(SITES)) {
	const ref = await direto(alvo);
	const comum = await peloMotor(alvo, null);
	const isolado = await peloMotor(alvo, "credentialless");
	console.log(`\n=== o site que ${nome} o isolamento ===`);
	console.log(`  ${passos(ref)} direto, ${passos(comum.m).split(": ")[1]} no shell comum, ${passos(isolado.m).split(": ")[1]} no isolado`);
	if (!completa(ref)) falhas.push(`${nome}: a medida direta veio incompleta, a rodada não vale`);
	if (comum.shell !== false) falhas.push("o shell comum saiu isolado, a rodada não vale");
	if (isolado.shell !== true) falhas.push("o shell isolado não ficou isolado, a rodada não vale");
	const [d, c, i] = [linhas(ref), linhas(comum.m), linhas(isolado.m)];
	for (const k of Object.keys(d)) {
		console.log(`  ${k}`);
		console.log(`    direto         ${d[k]}`);
		console.log(`    shell comum    ${c[k] ?? "não respondeu"}${c[k] === d[k] ? "" : "   ≠"}`);
		console.log(`    shell isolado  ${i[k] ?? "não respondeu"}${i[k] === d[k] ? "" : "   ≠"}`);
		if (i[k] !== d[k]) falhas.push(`${nome}, shell isolado, ${k}: ${i[k] ?? "não respondeu"} (direto: ${d[k]})`);
		if (nome === "não pede" && c[k] !== d[k]) falhas.push(`${nome}, shell comum, ${k}: ${c[k] ?? "não respondeu"} (direto: ${d[k]})`);
	}
}

await navegador.close();
await sites.fechar();

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ o site vê o isolamento que pediu: no shell isolado igual ao Chrome, e no comum sem diferença para quem não pede");
process.exit();
