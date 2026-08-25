// A sessão sobrevive à ida e à volta pelo portal?
//
// ─── A pergunta, e por que ela precisa do motor de verdade ───────────────────────────────────
//
// O cookie de sessão de um site é quase sempre de DOMÍNIO (`Set-Cookie: …; Domain=.x.com`), e vale
// no domínio nu e em todo subdomínio. Ele sai do jar do motor, é gravado no portal, e volta pelo
// caminho inverso quando a pessoa navega de novo. Se alguma coisa se perde nesse trajeto, o
// sintoma é "ontem eu logei e hoje pediu de novo" — e não há nada nele que aponte para cookie.
//
// A bancada de unidade prova o trajeto contra um jar DUBLÊ: ela sabe o que o motor manda e o que
// ele remonta, mas não sabe se o jar de verdade aceita o que foi remontado. `Domain=` tem regra de
// aceitação (o jar recusa domínio que não casa o host), `HttpOnly` tem efeito observável, e os
// dois só existem no jar real. É o que esta sonda mede.
//
// ─── Como se lê "o cookie voltou" ────────────────────────────────────────────────────────────
//
// Pelo que o SERVIDOR recebeu, e não por `document.cookie`. Duas razões, e as duas importam aqui:
// `document.cookie` não enxerga `HttpOnly` (então um cookie que voltou certo pareceria perdido), e
// um cookie pode existir no jar e mesmo assim não ser enviado (então um que se perdeu pareceria
// presente). A rota `/conta` do sítio devolve o cabeçalho `Cookie` que chegou nela.
//
// ─── O contexto é NOVO na volta, e é o ponto ─────────────────────────────────────────────────
//
// Reaproveitar a página deixaria o jar em memória com tudo dentro, e a sonda mediria a memória do
// processo em vez da restauração. Um contexto novo nasce com o jar vazio: o que aparecer ali só
// pode ter vindo do portal.

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 120000));

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();
const url = (host, caminho) => `http://${host}:${sites.porta}${caminho}`;

async function comPagina(fn) {
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(portal.base, { waitUntil: "load" });
	try { return await fn(pag); } finally { await ctx.close(); }
}

// ── 1. A ida: entrar no sítio e descarregar o jar no portal ──────────────────────────────────
const guardados = await comPagina(async (pag) => pag.evaluate(async (alvo) => {
	await window.__bancada.iniciar();
	const aba = await window.__bancada.abrir(alvo, 20000);
	await window.__bancada.descarregarCookies();
	return { aba, guardados: await window.__bancada.cookiesGuardados("site.teste") };
}, url("site.teste", "/entrar")));

console.log(`→ ida: a aba de /entrar ${guardados.aba.estado} (marca=${guardados.aba.marca})`);
for (const c of guardados.guardados) {
	console.log(`   guardado: ${c.name} domain=${c.domain} host_only=${!!c.host_only} http_only=${!!c.http_only}`);
}

// ── 2. A volta: contexto NOVO, jar vazio, e uma navegação no SUBDOMÍNIO ──────────────────────
const volta = await comPagina(async (pag) => pag.evaluate(async (alvo) => {
	await window.__bancada.iniciar();
	const aba = await window.__bancada.abrir(alvo, 20000);
	return {
		aba,
		// O que o SERVIDOR recebeu — a leitura honesta.
		recebido: await window.__bancada.naAba(aba.id, "document.getElementById('cookies') && document.getElementById('cookies').textContent"),
		// O que o SCRIPT do site enxerga — onde o HttpOnly tem de continuar invisível.
		visivelAoScript: await window.__bancada.naAba(aba.id, "document.cookie"),
	};
}, url("www.site.teste", "/conta")));

console.log(`\n→ volta em www.site.teste: aba ${volta.aba.estado} (marca=${volta.aba.marca})`);
console.log(`   servidor recebeu: ${JSON.stringify(volta.recebido)}`);
console.log(`   script enxerga:   ${JSON.stringify(volta.visivelAoScript)}`);

// ── 3. E no host de origem, o cookie preso a ele tem de voltar ───────────────────────────────
const noNu = await comPagina(async (pag) => pag.evaluate(async (alvo) => {
	await window.__bancada.iniciar();
	const aba = await window.__bancada.abrir(alvo, 20000);
	return await window.__bancada.naAba(aba.id, "document.getElementById('cookies') && document.getElementById('cookies').textContent");
}, url("site.teste", "/conta")));

console.log(`\n→ volta em site.teste: servidor recebeu ${JSON.stringify(noNu)}`);

await navegador.close();
await portal.fechar();
await sites.fechar();

// ── Veredito ─────────────────────────────────────────────────────────────────────────────────
const porNome = Object.fromEntries(guardados.guardados.map((c) => [c.name, c]));
const rec = String(volta.recebido || "");
const recNu = String(noNu || "");
const vis = String(volta.visivelAoScript || "");
const falhas = [];

if (guardados.aba.marca !== "entrou") falhas.push("a ida não chegou ao /entrar — a rodada não vale");
if (!porNome.sid)   falhas.push("o cookie de domínio não foi guardado no portal");
if (!porNome.sess)  falhas.push("o cookie HttpOnly não foi guardado no portal");
if (porNome.sid && porNome.sid.host_only) falhas.push("o cookie de DOMÍNIO foi guardado como preso ao host");
if (porNome.preso && !porNome.preso.host_only) falhas.push("o cookie preso ao host foi guardado como de domínio");
if (porNome.sess && !porNome.sess.http_only) falhas.push("o HttpOnly se perdeu na ida");

if (volta.aba.marca !== "conta") falhas.push("a volta não chegou ao /conta — a rodada não vale");
if (!/sid=vale-em-todo-lugar/.test(rec)) falhas.push("a SESSÃO não voltou no subdomínio — é o 'ontem eu logei e hoje pediu de novo'");
if (!/sess=segredo/.test(rec))           falhas.push("o cookie HttpOnly não voltou no subdomínio");
if (/preso=/.test(rec))                  falhas.push("o cookie preso ao host VAZOU para o subdomínio");
if (/sess=/.test(vis))                   falhas.push("o HttpOnly voltou LEGÍVEL por document.cookie — a marca do site foi rebaixada");
if (!/sid=/.test(vis))                   falhas.push("nem o cookie comum é visível ao script: a leitura acima não mede nada");
if (!/preso=so-neste-host/.test(recNu))  falhas.push("o cookie preso ao host não voltou nem no host dele");

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ a sessão atravessa inteira: domínio vale no subdomínio, host-only não vaza, HttpOnly volta e continua invisível");
