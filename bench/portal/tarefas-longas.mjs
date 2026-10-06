// As long tasks da thread do shell durante uma navegação pesada.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O transporte (libcurl em WASM), a reescrita e a página proxiada dividem o event loop do shell:
// enquanto uma aba carrega, o ambiente inteiro espera a vez. Levar o `Controller` e o transporte
// para um Worker é uma mudança de desenho do motor, e ela só se justifica com o número na mão.
// A sonda abre uma página pesada (`/pesada/`, oito scripts de ~250 KB, trinta imagens e um iframe)
// e navega por ela N vezes, cada uma num documento novo, somando as long tasks que o documento do
// shell observa (`PerformanceObserver`, tipo `longtask`) do pedido da navegação até 500 ms depois
// do `load`.
//
// ─── Como ler o resultado ────────────────────────────────────────────────────────────────────
//
// Uma long task é um trecho de mais de 50 ms sem devolver a thread: nele, nenhuma janela do
// ambiente responde a clique ou tecla. O que se lê é a mediana por navegação: a soma, a contagem e
// a maior. Não há veredito de passa ou falha; a sonda serve para comparar duas montagens do motor
// (`BENCH_BACKEND`) ou dois shells (`VSSH_SSO`) na mesma máquina.
//
//   BENCH_N        quantas navegações (padrão 6; a primeira, fria, fica fora da mediana)
//   BENCH_CHROME   o binário do Chromium, quando o do playwright não é o que está na máquina
//   BENCH_BACKEND  o backend cujo `vendor/` a bancada serve

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte();

const N = Number(process.env.BENCH_N || 6);
const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const alvo = (i) => `http://site.teste:${sites.porta}/pesada/?n=${i}`;

console.log(`sítios em :${sites.porta} · portal em :${portal.porta} · ${N} navegações\n`);

const navegador = await abrirNavegador();
const pag = await (await navegador.newContext()).newPage();
const medidas = [];
let falhou = false;
try {
	await pag.goto(portal.base, { waitUntil: "load" });
	await pag.evaluate(() => {
		window.__longas = [];
		new PerformanceObserver((lista) => {
			for (const e of lista.getEntries()) window.__longas.push(Math.round(e.duration));
		}).observe({ type: "longtask" });
		return window.__bancada.iniciar();
	});
	let id = null;
	for (let i = 0; i < N; i++) {
		await pag.evaluate(() => { window.__longas.length = 0; });
		const inicio = Date.now();
		const r = id
			? await pag.evaluate(([aba, url]) => window.__bancada.ir(aba, url, 30000), [id, alvo(i)])
			: await pag.evaluate((url) => window.__bancada.abrir(url, 30000), alvo(i));
		id = r.id;
		const ms = Date.now() - inicio;
		await pag.waitForTimeout(500);
		const longas = await pag.evaluate(() => window.__longas.slice());
		const scripts = await pag.evaluate((aba) => window.__bancada.naAba(aba, "window.__s || 0"), id);
		medidas.push({ i, estado: r.estado, ms, scripts, n: longas.length, soma: longas.reduce((a, b) => a + b, 0), maior: Math.max(0, ...longas) });
	}
} catch (e) {
	console.log("erro na sonda:", e?.message || e);
	falhou = true;
} finally {
	await navegador.close();
	await portal.fechar();
	await sites.fechar();
}

console.log("nav  estado     carga ms  scripts  long tasks  soma ms  maior ms");
for (const m of medidas) {
	console.log(`${String(m.i).padEnd(4)} ${m.estado.padEnd(10)} ${String(m.ms).padEnd(9)} ${String(m.scripts).padEnd(8)} ${String(m.n).padEnd(11)} ${String(m.soma).padEnd(8)} ${m.maior}`);
}

const quentes = medidas.slice(1).filter((m) => m.estado === "carregou" && m.scripts === 8);
const mediana = (k) => {
	const v = quentes.map((m) => m[k]).sort((a, b) => a - b);
	return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
};

console.log("\n=== veredito ===");
if (falhou || !quentes.length) {
	console.log("INCONCLUSIVO: nenhuma navegação quente carregou a página inteira");
	process.exitCode = 2;
} else {
	console.log(`mediana de ${quentes.length} navegações: ${mediana("n")} long tasks, ${mediana("soma")} ms somados, a maior com ${mediana("maior")} ms, carga em ${mediana("ms")} ms`);
}
