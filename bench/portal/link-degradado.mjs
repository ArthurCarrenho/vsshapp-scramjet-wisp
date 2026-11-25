// O link degradado: como o motor se comporta quando o caminho até a estação perde pacotes?
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// Num dia em que o link de um sítio perdeu de 25 a 70% dos pacotes por duas horas, o motor
// registrou recuperações, navegações penduradas e reconexões. Esta sonda reproduz o arranjo e
// conta, por nível de perda: quantas navegações assentaram, em quanto tempo, quantas viraram página
// de erro (e com que causa), quantas vezes o motor se recuperou ou recriou a sessão do transporte,
// e quantas vezes uma conexão longa de outra aba (o vídeo, o chat) foi cortada no meio.
//
// ─── Como a perda é feita ────────────────────────────────────────────────────────────────────
//
// O processo se reexecuta num namespace de rede próprio (`unshare -rn`), onde ele é root, e lá o
// `iptables` descarta ao acaso os segmentos TCP das duas pernas: a do navegador ao portal (que em
// produção atravessa o túnel até a estação, com o WebSocket do wisp dentro) e a da estação aos
// sítios. O descarte é por segmento e independente em cada sentido, com `--probability`.
//
// ⚠ O que isto NÃO modela: o atraso de base. No loopback a ida e volta é de microssegundos, então o
// custo de uma perda aqui é o RTO mínimo do Linux (200 ms, dobrando a cada repetição) e não um
// múltiplo de uma ida e volta de verdade. O kernel desta máquina não tem o `netem`, que faria os
// dois. O efeito que importa para o motor, que é o fluxo parar por centenas de milissegundos a
// segundos sem a conexão cair, aparece igual.
//
// O DNS do servidor tem modelo próprio, porque ele sai por UDP e aqui não há resolvedor: cada
// consulta perde a ida ou a volta com a mesma probabilidade, a glibc espera 5 s e tenta de novo
// uma vez, e as consultas passam por `BENCH_VAGAS` vagas (padrão 4), as threads do libuv onde o
// `dns.lookup` do Node roda. `BENCH_DNS=0` desliga o modelo (resolução instantânea).
//
//   BENCH_PERDAS   níveis de perda em %, separados por vírgula (padrão 0,10,25,40)
//   BENCH_N        navegações por nível (padrão 6)
//   BENCH_PAGINA   `pesada` (um host, 40 recursos) ou `muitos-hosts` (13 hosts) (padrão muitos-hosts)
//   BENCH_PRAZO    teto por navegação, em ms (padrão 90000)
//   BENCH_DNS      1 modela o DNS com perda (padrão), 0 resolve na hora
//   BENCH_VAGAS    consultas de DNS ao mesmo tempo (padrão 4)
//   BENCH_JSON     caminho para gravar o resultado em JSON, para comparar antes e depois

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

if (!process.env.BENCH_NETNS) {
	// Reexecuta dentro de um namespace de rede novo, com o loopback de pé.
	const r = spawnSync("unshare", ["-rn", "sh", "-c", 'ip link set lo up && exec "$0" "$@"', process.execPath, fileURLToPath(import.meta.url)], {
		stdio: "inherit",
		env: { ...process.env, BENCH_NETNS: "1" },
	});
	process.exit(r.status ?? 1);
}

const { prazoDeMorte } = await import("../comum.mjs");
const { abrirNavegador } = await import("./navegador.mjs");
const { subirSites } = await import("./sites.mjs");
const { subirPortal, trocarLookup, wisp } = await import("./servidor.mjs");

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.BENCH_BACKEND || path.join(AQUI, "..", "..", "backend");
const { criarSocketTcp } = await import(path.join(BACKEND, "tcp.js"));
let instalarMotivos = null;
try { ({ instalarMotivos } = await import(path.join(BACKEND, "motivos.js"))); } catch { /* backend sem motivos: o de antes */ }

const PERDAS = String(process.env.BENCH_PERDAS || "0,10,25,40").split(",").map(Number);
const N = Number(process.env.BENCH_N || 6);
const PAGINA = process.env.BENCH_PAGINA || "muitos-hosts";
const PRAZO = Number(process.env.BENCH_PRAZO || 90000);
const DNS = process.env.BENCH_DNS !== "0";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 60 * 60 * 1000));

// ─── O DNS com perda ─────────────────────────────────────────────────────────────────────────
let perdaAtual = 0;
// O libuv deixa o `getaddrinfo` com metade do pool: duas vagas com o padrão de quatro threads,
// dezesseis com as trinta e duas do `backend/fios.js`. `BENCH_VAGAS` escolhe.
const VAGAS = Number(process.env.BENCH_VAGAS || 4);
let ocupadas = 0;
const fila = [];
const consultas = { total: 0, lentas: 0, falhas: 0 };
async function vaga() {
	if (ocupadas < VAGAS) { ocupadas++; return; }
	await new Promise((ok) => fila.push(ok));
	ocupadas++;
}
function soltar() { ocupadas--; fila.shift()?.(); }
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function lookupComPerda(hostname) {
	if (!/(^|\.)teste$/i.test(hostname)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
	consultas.total++;
	await vaga();
	try {
		const p = perdaAtual / 100;
		const perdeu = () => Math.random() < 1 - (1 - p) ** 2; // a ida ou a volta
		for (let tentativa = 0; tentativa < 2; tentativa++) {
			if (!perdeu()) { await dormir(1); return { address: "127.0.0.1", family: 4 }; }
			consultas.lentas++;
			await dormir(5000);
		}
		consultas.falhas++;
		throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${hostname}`), { code: "EAI_AGAIN" });
	} finally { soltar(); }
}
if (DNS) trocarLookup(lookupComPerda);

// ─── A perda nos segmentos ───────────────────────────────────────────────────────────────────
function aplicarPerda(portas, pct) {
	execFileSync("iptables", ["-F", "INPUT"]);
	if (!pct) return;
	for (const porta of portas) {
		for (const lado of ["--dport", "--sport"]) {
			execFileSync("iptables", ["-A", "INPUT", "-p", "tcp", lado, String(porta),
				"-m", "statistic", "--mode", "random", "--probability", String(pct / 100), "-j", "DROP"]);
		}
	}
}

// ─── O arranjo ───────────────────────────────────────────────────────────────────────────────
const sites = await subirSites();
const TCPSocket = criarSocketTcp({
	resolver: (h) => wisp.options.dns_method(h),
	decidir: () => ({ permitido: true }),   // a régua não é o assunto: o loopback do namespace é todo nosso
});
if (instalarMotivos) instalarMotivos(wisp);
const portal = await subirPortal({ portaSites: sites.porta, TCPSocket });
const portas = [portal.porta, sites.porta];
const marca = PAGINA === "pesada" ? "pesada" : "muitos-hosts";
const alvo = (n) => `http://site.teste:${sites.porta}/${PAGINA}/?n=${n}`;

console.log(`sítios :${sites.porta} · portal :${portal.porta} · ${N} navegações por nível · página ${PAGINA}`
	+ ` · DNS ${DNS ? "com perda" : "instantâneo"} · motivos ${instalarMotivos ? "sim" : "não"}\n`);

const navegador = await abrirNavegador();
const resultado = { pagina: PAGINA, dns: DNS, motivos: !!instalarMotivos, niveis: [] };
let seq = 0;

for (const perda of PERDAS) {
	aplicarPerda(portas, 0);
	perdaAtual = 0;
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(portal.base, { waitUntil: "load" });
	await pag.evaluate(() => window.__bancada.iniciar());
	// A aba de fundo com a conexão longa, aberta com o link limpo.
	const fundo = await pag.evaluate(async (u) => (await window.__bancada.abrir(u, 20000)).id, `http://site.teste:${sites.porta}/fluxo-pagina`);
	const aba = await pag.evaluate(async (u) => (await window.__bancada.abrir(u, 20000)).id, `http://site.teste:${sites.porta}/`);
	await dormir(1500);
	const eventosAntes = await pag.evaluate(() => window.__eventos.length);
	Object.assign(consultas, { total: 0, lentas: 0, falhas: 0 });

	aplicarPerda(portas, perda);
	perdaAtual = perda;
	const navs = [];
	for (let i = 0; i < N; i++) {
		const r = await pag.evaluate(([id, u, m, p]) => window.__bancada.navegarMedindo(id, u, m, p), [aba, alvo(++seq), marca, PRAZO]);
		navs.push(r);
		const causa = r.erro ? ` causa=${r.erro.causa}${r.erro.codigo ? "/" + r.erro.codigo : ""}` : "";
		console.log(`  ${String(perda).padStart(2)}% · ${String(i + 1).padStart(2)} · ${r.desfecho.padEnd(9)} · ${String(r.ms).padStart(6)}ms · documento ${r.primeiro ?? "-"}ms${causa}`);
	}
	const teto = (p, ms, valor) => Promise.race([p, dormir(ms).then(() => valor)]);
	const fluxo = await teto(pag.evaluate((id) => window.__bancada.naAba(id, "window.__fluxo"), fundo), 10000, null);
	const eventos = ((await teto(pag.evaluate(() => window.__eventos), 10000, null)) || []).slice(eventosAntes);
	aplicarPerda(portas, 0);
	perdaAtual = 0;
	await teto(ctx.close(), 15000);

	const contaEventos = {};
	for (const [, nome] of eventos) contaEventos[nome] = (contaEventos[nome] || 0) + 1;
	const oks = navs.filter((n) => n.desfecho === "ok").map((n) => n.ms).sort((a, b) => a - b);
	const quantil = (v, q) => (v.length ? v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))] : null);
	const nivel = {
		perda,
		ok: oks.length, n: navs.length,
		mediana: quantil(oks, 0.5), p90: quantil(oks, 0.9),
		documento: quantil(navs.filter((n) => n.primeiro != null).map((n) => n.primeiro).sort((a, b) => a - b), 0.5),
		desfechos: navs.reduce((a, n) => ((a[n.desfecho] = (a[n.desfecho] || 0) + 1), a), {}),
		causas: navs.filter((n) => n.erro).map((n) => `${n.erro.causa}${n.erro.codigo ? "/" + n.erro.codigo : ""}`),
		eventos: contaEventos,
		fluxo: { bytes: fluxo?.bytes ?? null, quebras: fluxo?.quebras ?? null, erros: (fluxo?.erros || []).slice(0, 3) },
		dns: { ...consultas },
	};
	resultado.niveis.push(nivel);
	if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify(resultado, null, 2));
	console.log(`     → ${nivel.ok}/${nivel.n} ok · mediana ${nivel.mediana}ms · p90 ${nivel.p90}ms · eventos ${JSON.stringify(contaEventos)}`
		+ ` · fluxo cortado ${nivel.fluxo.quebras}x · DNS ${consultas.total} consultas, ${consultas.lentas} lentas, ${consultas.falhas} falhas\n`);
}

await Promise.race([Promise.allSettled([navegador.close(), portal.fechar(), sites.fechar()]), dormir(20000)]);

console.log("=== veredito ===");
console.log("perda  ok    mediana    p90       recuperações  reconexões  penduradas  desistências  fluxo cortado");
for (const n of resultado.niveis) {
	console.log(`${String(n.perda).padStart(3)}%  ${`${n.ok}/${n.n}`.padEnd(5)} ${String(n.mediana ?? "-").padStart(7)}ms ${String(n.p90 ?? "-").padStart(7)}ms`
		+ `   ${String(n.eventos.recover || 0).padStart(6)}       ${String(n.eventos.reconnect || 0).padStart(5)}       ${String(n.eventos.navegacao_pendurada || 0).padStart(5)}`
		+ `       ${String(n.eventos.desistiu || 0).padStart(5)}        ${String(n.fluxo.quebras ?? "-").padStart(5)}`);
}
if (process.env.BENCH_JSON) writeFileSync(process.env.BENCH_JSON, JSON.stringify(resultado, null, 2));
