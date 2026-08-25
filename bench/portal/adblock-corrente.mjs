// A corrente do adblock, elo por elo, com o motor de verdade.
//
// ─── A corrente ──────────────────────────────────────────────────────────────────────────────
//
//   extensão declara um filtro   → ExtensionRuntime.setRequestFilter
//   o motor pergunta             → hook fetch.intercept do frame, síncrono, antes de sair
//   marca a resposta             → 204 com o header sentinela `x-vssh-blocked`
//   o service worker converte    → Response.error(), um erro de rede DE VERDADE
//   a página reage               → <img> dispara onerror, o fetch rejeita
//
// Cinco elos, cada um num arquivo diferente, e nenhum lugar onde eles fossem medidos LIGADOS. A
// unidade prova o filtro; `tests/browser/motor-sw.test.js` prova o service worker contra um
// controller dublê. Só aqui a corrente inteira atravessa o motor real e o transporte real.
//
// ─── Por que o 204 e não um 200 vazio ────────────────────────────────────────────────────────
//
// Está escrito no `scram-sw.js`, e a sonda mede a consequência: com uma resposta de "sucesso"
// vazia, o código do anúncio conclui que carregou, espera o timeout dele (~20 s) e re-tenta em
// cima do proxy. O bloqueio tem de FALHAR para o site desistir.
//
// ─── As duas metades, e por que as duas ──────────────────────────────────────────────────────
//
// Um `onerror` sozinho não prova bloqueio: prova que algo falhou, e "o motor está fora do ar" tem
// a mesma cara. É a irmã NÃO bloqueada, carregando na mesma página, que separa as duas. E a prova
// mais dura não vem do cliente: é o servidor do sítio nunca ter recebido o pedido.

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 120000));

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();
const ALVO = `http://site.teste:${sites.porta}/anuncios`;

// O que uma extensão de bloqueio faz, reduzido ao osso. `api.network.setRequestFilter` é a mesma
// superfície que o adblock de verdade usa; o que muda é o tamanho da lista.
const EXTENSAO = `
  api.network.setRequestFilter((req) => /anuncios\\.teste/.test(req.url));
  api.page.injectCSS('#anuncio { display: none !important; }');
`;

async function rodada({ comExtensao }) {
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	// Rejeição não tratada chega como `pageerror` no Chromium — e é ela que o silenciador do
	// adblock existe para calar. Só que ele tem de calar o que NÓS causamos, e nada além.
	const erros = [];
	pag.on("pageerror", (e) => erros.push(String(e.message || e).slice(0, 200)));
	await pag.goto(portal.base, { waitUntil: "load" });

	sites.limparPedidos();
	const r = await pag.evaluate(async ([alvo, fonte, ligar]) => {
		await window.__bancada.iniciar();
		if (ligar) await window.__bancada.extensao("adblock-de-bancada", fonte);
		const aba = await window.__bancada.abrir(alvo, 20000);
		await new Promise((ok) => setTimeout(ok, 1200)); // as <img> resolvem depois do load
		return {
			aba,
			anuncio:     await window.__bancada.naAba(aba.id, "window.__img"),
			proprio:     await window.__bancada.naAba(aba.id, "window.__proprio"),
			scriptRodou: await window.__bancada.naAba(aba.id, "!!window.__anuncioRodou"),
			cosmetico:   await window.__bancada.naAba(aba.id, "!!document.getElementById('__vssh_ext_css')"),
			id: aba.id,
		};
	}, [ALVO, EXTENSAO, comExtensao]);

	// O contraponto do silenciador: um script que falha por 404 do PRÓPRIO sítio não é coisa
	// nossa, e tem de continuar gritando. É a fronteira que separa "calar o barulho que causei"
	// de "calar erro de script", que é o passo natural de quem for simplificar isto depois.
	const antesDo404 = erros.length;
	await pag.evaluate(async ([id]) => {
		try { await window.__bancada.naAba(id, "window.__carregar('/naoexiste.js')"); } catch (e) { /* esperado */ }
		await new Promise((ok) => setTimeout(ok, 600));
	}, [r.id]);

	const pedidosDeAnuncio = sites.pedidos.filter((p) => p.host === "anuncios.teste");
	await ctx.close();
	return { ...r, erros, errosDo404: erros.length - antesDo404, pedidosDeAnuncio };
}

console.log("→ controle: a mesma página SEM a extensão");
const semExt = await rodada({ comExtensao: false });
console.log(`   img do anúncio=${semExt.anuncio} · img própria=${semExt.proprio} · script rodou=${semExt.scriptRodou}`
	+ ` · o sítio recebeu ${semExt.pedidosDeAnuncio.length} pedido(s) de anúncio`);

console.log("\n→ com a extensão de bloqueio");
const comExt = await rodada({ comExtensao: true });
console.log(`   img do anúncio=${comExt.anuncio} · img própria=${comExt.proprio} · script rodou=${comExt.scriptRodou}`
	+ ` · cosmético aplicado=${comExt.cosmetico} · o sítio recebeu ${comExt.pedidosDeAnuncio.length} pedido(s) de anúncio`);
console.log(`   erros no console: ${comExt.erros.length} (dos quais ${comExt.errosDo404} depois do 404 proposital)`);
for (const e of comExt.erros) console.log(`     ${e}`);

await navegador.close();
await portal.fechar();
await sites.fechar();

const falhas = [];
// O controle primeiro: sem ele, tudo abaixo poderia estar medindo um motor fora do ar.
if (semExt.anuncio !== "onload") falhas.push("SEM extensão o anúncio já não carregava — o gatilho não é o bloqueio");
if (!semExt.scriptRodou)         falhas.push("SEM extensão o script do anúncio não rodou — idem");
if (!semExt.pedidosDeAnuncio.length) falhas.push("SEM extensão o sítio nem recebeu o pedido — a rodada não vale");

if (comExt.anuncio !== "onerror") falhas.push("o recurso bloqueado NÃO falhou — com um sucesso vazio o anúncio re-tenta em cima do proxy");
if (comExt.proprio !== "onload")  falhas.push("a imagem não bloqueada também falhou — o bloqueio pegou a página inteira");
if (comExt.scriptRodou)           falhas.push("o script do anúncio rodou mesmo bloqueado");
if (comExt.pedidosDeAnuncio.length) falhas.push("o pedido do anúncio CHEGOU ao sítio — o bloqueio é cosmético, não de rede");
if (!comExt.cosmetico)            falhas.push("a folha cosmética da extensão não foi aplicada ao frame");
if (comExt.errosDo404 < 1)        falhas.push("o 404 do próprio sítio foi engolido — o silenciador escorregou de 'o que bloqueamos' para 'erro de script'");

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ a corrente fecha: o pedido nem sai, o recurso falha de verdade, a irmã carrega, e o erro que não é nosso continua aparecendo");
