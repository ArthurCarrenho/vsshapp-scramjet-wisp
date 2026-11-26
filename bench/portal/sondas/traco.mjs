// O traço das chamadas de API de uma página, no Chrome direto e pelo motor, pelo playwright.
//
// As sondas de `js/` perguntam o que alguém pensou em perguntar. O traço registra o que o código
// do site pergunta: `traco-gancho.js` embrulha os métodos e os acessores das interfaces da
// plataforma, acima do motor, e anota cada chamada com os argumentos e o que voltou. O mesmo
// desafio roda nos dois lados, e `compara-traco.py` mostra as chamadas iguais com resposta
// diferente. Foi assim que o `replaceState` para outra origem apareceu (ver desafio-cloudflare.md).
//
// O veredito do desafio não vale aqui: a automação marca a página, e os embrulhos são visíveis.
// O que se compara é o que cada chamada devolve.
//
//   ALVO     a página
//   SAIDA    o JSON com as linhas distintas de cada quadro (padrão traco.json)
//   ESPERA   ms em cada coluna (padrão 9000)
//   COLUNAS  "direto,motor" (o padrão), ou uma só
//   FIXOS    endereços fixos (ver fixos.mjs)
//   HEADED=1 com janela (sob xvfb-run numa máquina sem tela), que é como o desafio roda inteiro
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { abrirNavegador } from "../navegador.mjs";
import { subirPortal, trocarLookup } from "../servidor.mjs";
import { argumentosDoChrome, lookupComFixos } from "./fixos.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ALVO = process.env.ALVO;
if (!ALVO) throw new Error("ALVO é obrigatório");
const ESPERA = Number(process.env.ESPERA || 9000);
const COLUNAS = (process.env.COLUNAS || "direto,motor").split(",");
const GANCHO = readFileSync(path.join(AQUI, "traco-gancho.js"), "utf8");
const hostDoAlvo = new URL(ALVO).host;

const nav = await abrirNavegador({ args: ["--no-sandbox", ...argumentosDoChrome()] });
const saida = {};
let portal;
// O tipo de um quadro pela URL dele, sem o prefixo do motor: `desafio` é o do Turnstile, `site` é
// qualquer documento do host do alvo.
const tipoDe = (u) => {
	let d = u;
	try { d = decodeURIComponent(decodeURIComponent(u)); } catch {}
	const m = d.match(/\/~sj\/[^/]+\/[^/]+\/(.*)/);
	if (m) d = m[1];
	if (/^https:\/\/challenges\.cloudflare\.com\/cdn-cgi/.test(d)) return "desafio";
	try { if (new URL(d).host === hostDoAlvo) return "site"; } catch {}
	return "outro:" + d.slice(0, 50);
};
for (const c of COLUNAS) {
	const ctx = await nav.newContext({ viewport: { width: 1280, height: 900 } });
	await ctx.addInitScript(GANCHO.replace("__MODO__", c));
	const page = await ctx.newPage();
	const quadros = new Map();
	page.on("console", (m) => {
		const t = m.text();
		if (!t.startsWith("__TR__")) return;
		try {
			const o = JSON.parse(t.slice(6));
			let q = quadros.get(o.id);
			if (!q) quadros.set(o.id, (q = { tipo: tipoDe(o.u), linhas: [], total: 0 }));
			q.total = o.total;
			for (const l of o.linhas) q.linhas.push(l);
		} catch {}
	});
	if (c === "direto") page.goto(ALVO).catch(() => {});
	else {
		trocarLookup(lookupComFixos);
		portal = await subirPortal({ portaSites: 1 });
		await page.goto(portal.base, { waitUntil: "load" });
		page.evaluate(async (u) => { await window.__bancada.iniciar(); return window.__bancada.abrir(u, 30000); }, ALVO).catch(() => {});
	}
	await page.waitForTimeout(ESPERA);
	saida[c] = [...quadros.values()];
	console.log(c, saida[c].map((q) => `${q.tipo} distintas=${q.linhas.length} chamadas=${q.total}`).join(" | "));
	await ctx.close();
}
writeFileSync(process.env.SAIDA || "traco.json", JSON.stringify(saida));
await nav.close();
if (portal) await portal.fechar();
process.exit(0);
