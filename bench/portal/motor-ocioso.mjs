// A navegação depois de uma pausa: quanto ela custa, conforme o que envelheceu na pausa.
//
// A mesma aba navega duas vezes, com uma pausa no meio. Na rodada de controle nada muda durante a
// pausa. Nas outras, uma peça cai, e a segunda navegação tem de perceber isso e se refazer:
//
//   sw     o Chrome encerra o service worker do motor parado há ~30 s, e o próximo pedido o sobe
//          vazio, sem nenhum controller registrado. Toda pausa mais longa que isso o produz.
//   motor  o supervisor encerra o motor por ociosidade (`aoFechar: "ocioso:15m"`). As conexões do
//          wisp caem, o portal recusa o app com 409 enquanto ele está parado, e o `ensureRunning`
//          o sobe de volta em `BENCH_SUBIDA_MS`.
//   wisp   o WebSocket do wisp fecha com o motor de pé, como um proxy no caminho derrubando a
//          conexão ociosa.
//   mudo   o WebSocket do wisp fica mudo sem fechar (um NAT ou um balanceador que esqueceu o par).
//   site   nada cai, e a segunda navegação vai a uma porta fechada. É o contraponto de `motor`: as
//          duas falham na conexão, e aqui a aba tem de terminar no erro do site (o wisp entrega a
//          recusa como `rede/52`), sem ninguém subir o motor.
//
// O veredito compara cada caso com o controle. O que sobra depois de descontar o controle e o
// prazo próprio do caso é o custo de perceber a queda, e passa de 3 s só quando alguém espera um
// prazo vencer à toa. O prazo próprio do `motor` é a subida. O do `mudo` é uma volta do cão de
// guarda do shell (`_VIGIA_MS`, 12 s) mais a sonda de saída do reconnect() (1,5 s): um WebSocket
// mudo não emite sinal nenhum, e só um prazo o percebe.
//
//   BENCH_CHROME     o binário do Chromium
//   BENCH_SUBIDA_MS  quanto o motor leva para subir de novo (padrão 800)
//   BENCH_CASOS      os casos, separados por vírgula (padrão sw,motor,wisp,mudo,site)
//   BENCH_LIMITE     prazo de morte (padrão 300 s)

import net from "node:net";
import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 300000));

const SUBIDA_MS = Number(process.env.BENCH_SUBIDA_MS || 800);
const SOBRA_MS = 3000;
const PRAZO_DO_CASO = { motor: SUBIDA_MS, mudo: 12000 + 1500 };
const CASOS = {
	sw: "o service worker do motor é encerrado",
	motor: `o motor cai por ociosidade e leva ${SUBIDA_MS} ms para subir`,
	wisp: "o WebSocket do wisp fecha, com o motor de pé",
	mudo: "o WebSocket do wisp fica mudo, sem fechar",
	site: "o site recusa a conexão, com o motor de pé",
};
const pedidos = (process.env.BENCH_CASOS || Object.keys(CASOS).join(",")).split(",").map((c) => c.trim()).filter(Boolean);
for (const c of pedidos) if (!CASOS[c]) throw new Error(`caso desconhecido: ${c} (os casos são ${Object.keys(CASOS).join(", ")})`);

// Uma porta em que ninguém escuta: aberta pelo sistema e fechada em seguida.
const portaFechada = await new Promise((ok) => {
	const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
});

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta, motorParavel: true, subidaMs: SUBIDA_MS });
const navegador = await abrirNavegador();

async function rodada(caso) {
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(portal.base, { waitUntil: "load" });
	const primeira = await pag.evaluate(async (alvo) => {
		await window.__bancada.iniciar();
		return window.__bancada.abrir(alvo, 30000);
	}, `http://site.teste:${sites.porta}/`);

	await new Promise((r) => setTimeout(r, 3000));
	const subidasAntes = portal.motor.subidas;
	const garantiasAntes = portal.motor.garantias;
	const logAntes = await pag.evaluate(() => window.__bancada.log().length);
	if (caso === "sw") {
		const cdp = await ctx.newCDPSession(pag);
		await cdp.send("ServiceWorker.enable");
		await cdp.send("ServiceWorker.stopAllWorkers");
		await cdp.detach();
	}
	else if (caso === "motor") portal.pararMotor();
	else if (caso === "wisp") portal.derrubarWisp();
	else if (caso === "mudo") portal.silenciarWisp();

	const t0 = Date.now();
	const alvo = caso === "site" ? `http://site.teste:${portaFechada}/` : `http://site.teste:${sites.porta}/conta`;
	await pag.evaluate(([id, url]) => { window.__bancada.ir(id, url, 60000); }, [primeira.id, alvo]);
	// O primeiro `load` pode ser uma página de falha. A aba é vigiada até o site chegar (ou o prazo
	// acabar), e cada documento diferente que passou por ela fica anotado com o instante. No caso
	// `site` não há site para chegar: a vigia dura 4 s, e vale o último documento.
	const passagens = [];
	let ms = null;
	for (let fim = Date.now() + (caso === "site" ? 4000 : 60000); Date.now() < fim;) {
		const v = await pag.evaluate((id) => {
			const o = window.__bancada.olhar(id);
			let causa = null;
			try {
				const el = document.querySelector("iframe").contentDocument.getElementById("vssh-erro-de-navegacao");
				if (el) { const d = JSON.parse(el.textContent); causa = `${d.causa}/${d.codigo}`; }
			} catch (e) { causa = "opaco"; }
			return { marca: o.marca, titulo: o.titulo, causa, motor: window.__bancada.estado() };
		}, primeira.id);
		const chave = JSON.stringify(v);
		if (passagens.at(-1)?.chave !== chave) passagens.push({ chave, em: Date.now() - t0, ...v });
		if (v.marca === "conta") { ms = Date.now() - t0; break; }
		await new Promise((r) => setTimeout(r, 100));
	}
	const log = await pag.evaluate((n) => window.__bancada.log().slice(n).map((l) => l[1])
		.filter((t) => t.includes("[scramjet]")), logAntes);
	await ctx.close();
	if (caso === "site") {
		const ultimo = passagens.at(-1);
		ms = /^(recusa|rede|tempo)\//.test(ultimo?.causa || "") ? ultimo.em : null;
	}
	return {
		primeira: primeira.marca, chegou: ms !== null, ms, passagens, log,
		subidas: portal.motor.subidas - subidasAntes, garantias: portal.motor.garantias - garantiasAntes,
	};
}

function mostrar(r) {
	console.log(`   ${r.primeira} → ${r.chegou ? `${r.passagens.at(-1).titulo} em ${r.ms} ms` : "a segunda página não chegou"}`);
	for (const p of r.passagens) console.log(`   +${p.em} ms: marca=${p.marca} título=${JSON.stringify(p.titulo)} causa=${p.causa} motor=${p.motor}`);
	for (const t of r.log) console.log(`   log: ${t.slice(0, 220)}`);
}

console.log("→ controle: nada muda durante a pausa");
const controle = await rodada(null);
mostrar(controle);

const resultados = {};
for (const caso of pedidos) {
	console.log(`\n→ ${caso}: ${CASOS[caso]}`);
	resultados[caso] = await rodada(caso);
	mostrar(resultados[caso]);
}

await navegador.close();
await portal.fechar();
await sites.fechar();

console.log("\n=== veredito ===");
if (controle.primeira !== "inicio" || !controle.chegou) {
	console.log("  ✗ o controle não navegou as duas páginas, e a rodada inteira não vale");
	process.exit(1);
}
let falhou = false;
for (const [caso, r] of Object.entries(resultados)) {
	const prazo = PRAZO_DO_CASO[caso] || 0;
	const problemas = [];
	if (r.primeira !== "inicio") problemas.push("a primeira página não carregou");
	if (!r.chegou) problemas.push(`a segunda página não chegou (passou por ${r.passagens.map((p) => p.titulo || p.marca).join(", ")})`);
	if (caso === "motor" && r.subidas < 1) problemas.push("ninguém subiu o motor de volta");
	if (caso === "site" && r.garantias > 0) problemas.push(`o motor foi garantido ${r.garantias} vez(es) por um erro do site`);
	const sobra = r.chegou ? r.ms - controle.ms - prazo : null;
	if (sobra !== null && sobra > SOBRA_MS) problemas.push(`perceber a queda custou ${sobra} ms`);
	if (problemas.length) {
		falhou = true;
		console.log(`  ✗ ${caso}: ${problemas.join("; ")}`);
	} else {
		console.log(`  ✓ ${caso}: ${r.ms} ms, ${sobra} ms além do controle${prazo ? ` e do prazo do caso (${prazo} ms)` : ""}`);
	}
}
if (falhou) process.exitCode = 1;
