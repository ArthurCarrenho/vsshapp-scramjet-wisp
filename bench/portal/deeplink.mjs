// O que acontece HOJE com cada forma de abrir um link, e com cada esquema.
//
// ─── Esta sonda mede antes de decidir ────────────────────────────────────────────────────────
//
// A leitura do código diz que `mailto:`, `tel:` e `magnet:` não são interceptados pelo motor
// (`ScramjetEngine.js`: *"outros esquemas (mailto:, etc.): não intercepta"*) e que o filtro do
// shell só aceita `http/https/vssh/vsshs`. Junte os dois e a conclusão é que um `mailto:` some
// calado — mas conclusão de leitura não é medida, e o que fazer a respeito depende de o que a
// plataforma faz no lugar. Por isso esta sonda não tem "certo" e "errado" para os esquemas: ela
// tem uma TABELA. O veredito cobre só o que já é contrato.
//
// ─── O que já é contrato, e portanto reprova ─────────────────────────────────────────────────
//
// Nova aba (`target=_blank`, `window.open`) e `window.close()` da própria página TÊM de atravessar
// a fronteira do frame pelos retornos, porque a alternativa é o navegador hospedeiro abrindo uma
// janela fora do ambiente, com o IP de quem lê — que é o defeito que os hooks existem para
// impedir, e está escrito por extenso no fonte.

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 120000));

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();

const ctx = await navegador.newContext();
const pag = await ctx.newPage();
const erros = [];
pag.on("pageerror", (e) => erros.push(String(e.message || e).slice(0, 160)));
// Uma janela do navegador HOSPEDEIRO abrindo é o pior resultado possível: sai do ambiente e leva
// o IP de quem lê. Se acontecer, tem de aparecer no veredito e não num comentário.
const janelasDoHospedeiro = [];
ctx.on("page", (p) => janelasDoHospedeiro.push(p.url()));

await pag.goto(portal.base, { waitUntil: "load" });

const r = await pag.evaluate(async (alvo) => {
	await window.__bancada.iniciar();
	const aba = await window.__bancada.abrir(alvo, 20000);
	const naAba = (js) => window.__bancada.naAba(aba.id, js);

	// Como cada href CHEGA à página depois da reescrita. Um esquema que o motor reescreve vira
	// uma URL do proxy; um que ele deixa passar continua o que era. É a primeira coisa a saber.
	const href = async (id) => ({
		atributo: await naAba(`document.getElementById('${id}').getAttribute('href')`),
		resolvido: await naAba(`document.getElementById('${id}').href`),
	});

	const tabela = {};
	for (const id of ["mailto", "tel", "magnet", "branco", "mesmo"]) tabela[id] = await href(id);

	const cliques = {};
	for (const id of ["mailto", "tel", "magnet"]) {
		cliques[id] = await window.__bancada.clicar(aba.id, "#" + id);
		await new Promise((ok) => setTimeout(ok, 200));
	}
	const antesDoBranco = window.__bancada.retornos(aba.id).length;
	cliques.branco = await window.__bancada.clicar(aba.id, "#branco");

	// `window.open` para alvo de janela nova, e `window.close()` da própria página.
	const abriuComTarget = await naAba("window.__abrirJanela('_blank')");
	const fechouSozinha  = await naAba("window.__fecharSe()");

	return {
		aba, tabela, cliques, antesDoBranco, abriuComTarget, fechouSozinha,
		retornos: window.__bancada.retornos(aba.id),
		log: window.__bancada.log().map((l) => l[1]).filter((t) => t.includes("[scramjet]")),
	};
}, `http://site.teste:${sites.porta}/deeplink`);

await ctx.close();
await navegador.close();
await portal.fechar();
await sites.fechar();

console.log(`aba de /deeplink: ${r.aba.estado} (marca=${r.aba.marca})\n`);
console.log("── como cada href chega à página ───────────────────────────────");
for (const [id, v] of Object.entries(r.tabela)) {
	const reescrito = String(v.resolvido || "").includes("~sj/");
	console.log(`  ${id.padEnd(7)} atributo=${JSON.stringify(v.atributo)}`);
	console.log(`  ${"".padEnd(7)} resolvido=${JSON.stringify(String(v.resolvido).slice(0, 90))} ${reescrito ? "(REESCRITO)" : ""}`);
}

console.log("\n── o que o clique produziu ─────────────────────────────────────");
for (const [id, v] of Object.entries(r.cliques)) console.log(`  ${id.padEnd(7)} ${JSON.stringify(v)}`);

console.log("\n── o que atravessou a fronteira do frame ───────────────────────");
for (const [tipo, valor] of r.retornos) console.log(`  ${tipo}  ${String(valor).slice(0, 90)}`);
console.log(`  window.open('_blank') devolveu: ${JSON.stringify(r.abriuComTarget)}`);
console.log(`  window.close() da própria página: ${r.fechouSozinha}`);
if (r.log.length) { console.log("\n── o motor disse ──"); for (const t of r.log) console.log(`  ${t.slice(0, 160)}`); }
if (erros.length) { console.log("\n── erros no console ──"); for (const e of erros) console.log(`  ${e}`); }

// ── Veredito: só o que já é contrato ────────────────────────────────────────────────────────
const tipos = r.retornos.map((x) => x[0]);
const aberturas = r.retornos.filter((x) => x[0] === "onOpenTab").map((x) => String(x[1]));
const falhas = [];

if (r.aba.marca !== "deeplink") falhas.push("a página de deeplink não carregou — a rodada não vale");
if (aberturas.length < 2) falhas.push(`nova aba não atravessou nas duas formas (target=_blank e window.open): ${JSON.stringify(aberturas)}`);
for (const u of aberturas) if (u.includes("~sj/")) falhas.push(`a URL que saiu para o shell veio REESCRITA (${u.slice(0, 60)}) — o shell abriria o proxy, não o site`);
// Um esquema que o ambiente não abre tem de PRODUZIR alguma coisa. Não precisa ser a abertura —
// não há para onde abrir —, mas o silêncio é indistinguível de um link quebrado do site, e foi
// exatamente o que esta sonda mediu na primeira rodada: clique, `navegou:false`, nada mais.
const esquemas = r.retornos.filter((x) => x[0] === "onEsquemaExterno").map((x) => String(x[1]));
for (const esperado of ["mailto:", "tel:", "magnet:"]) {
	if (!esquemas.some((u) => u.startsWith(esperado)))
		falhas.push(`clicar num link "${esperado}" não produziu NADA — nem abertura, nem aviso, nem log`);
}
if (!tipos.includes("onCloseSelf")) falhas.push("window.close() da própria página não atravessou — a aba fica órfã com a tela de 'pode fechar'");
// `window.open` devolver um punho USÁVEL é contrato, e está escrito no fonte do `_tocoDeJanela`:
// o padrão de OAuth e de pagamento é `const w = open(...); w.focus()`, e quebrar ali é quebrar
// DEPOIS de a aba já ter sido aberta — a pessoa vê uma tela de login que o site já deu por perdida.
const punho = r.abriuComTarget;
if (typeof punho === "string" && punho.startsWith("erro:")) {
	falhas.push(`window.open lançou em vez de devolver um punho: ${punho}`);
} else if (!punho || punho.tipo !== "object" || punho.nulo) {
	falhas.push(`window.open não devolveu um punho utilizável: ${JSON.stringify(punho)}`);
} else if (punho.chamouFocus !== true) {
	falhas.push(`o punho de window.open não sobrevive a um focus(): ${JSON.stringify(punho.chamouFocus)}`);
}
if (janelasDoHospedeiro.length) falhas.push(`abriu ${janelasDoHospedeiro.length} janela(s) no navegador HOSPEDEIRO: ${JSON.stringify(janelasDoHospedeiro)}`);

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ nova aba, auto-fechamento e esquema não abrível atravessam a fronteira, e nada escapou para o navegador hospedeiro");
console.log("\n  (a tabela dos esquemas acima é MEDIDA, não julgada — é ela que decide o que fazer com mailto:/tel:/magnet:)");
