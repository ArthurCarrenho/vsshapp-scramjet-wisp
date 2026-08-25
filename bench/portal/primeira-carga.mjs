// A primeira carga: quantas vezes o navegador precisaria de um F5?
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O relato que motivou esta bancada: *"às vezes o navegador não funciona de primeira, e precisa
// de um F5; fica carregando infinito, sem log, sem nada."* É um defeito de CORRIDA — ele acontece
// no intervalo entre a página abrir e o service worker do motor assumir —, e por isso não se
// responde olhando o código: responde-se abrindo N vezes e contando.
//
// O que se conta é UMA coisa: a aba pousou sozinha, ou ficou pendurada? Nada de "deu erro" — o
// defeito nunca deu erro, e é justamente por isso que ele custou tanto.
//
// ─── Como ler o resultado ────────────────────────────────────────────────────────────────────
//
// `pendurada` é o defeito. `recuperada` é ele acontecendo e o cão de guarda consertando sozinho —
// que é o que se quer: a pessoa não vê F5 nenhum, e sobra o rastro na bandeja e no log. `direta` é
// a carga que não precisou de nada.
//
//   BENCH_N       quantas cargas (padrão 10)
//   BENCH_CHROME  o binário do Chromium, quando o do playwright não é o que está na máquina
//   BENCH_ALVO    o endereço a abrir (padrão: a página inicial do sítio local)
//   BENCH_ESPERA  o teto de espera por carga, em ms (padrão 20000)

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte();

const N = Number(process.env.BENCH_N || 10);
const ESPERA = Number(process.env.BENCH_ESPERA || 20000);

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const ALVO   = process.env.BENCH_ALVO || `http://site.teste:${sites.porta}/`;

console.log(`sítios em :${sites.porta} · portal em :${portal.porta} · ${N} cargas · alvo ${ALVO}\n`);

const navegador = await abrirNavegador();
const placar = { direta: 0, recuperada: 0, pendurada: 0, erro: 0 };
const detalhes = [];

for (let i = 1; i <= N; i++) {
	// Contexto NOVO a cada volta: é o que reproduz a primeira carga. Reaproveitar o contexto
	// deixaria o service worker já instalado e a corrida — que é o defeito — nunca aconteceria.
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	try {
		await pag.goto(portal.base, { waitUntil: "load" });
		// `init()` e a navegação são pedidos JUNTOS, sem esperar o motor assentar: é assim que o
		// shell de verdade se comporta, e é o intervalo em que o defeito mora.
		const r = await pag.evaluate(async ([alvo, espera]) => {
			const inicio = performance.now();
			const iniciando = window.__bancada.iniciar();
			await iniciando;
			const aba = await window.__bancada.abrir(alvo, espera);
			return {
				...aba,
				ms: Math.round(performance.now() - inicio),
				estadoDoMotor: window.__bancada.estado(),
				atividades: window.__bancada.atividades(),
				log: window.__bancada.log().filter((l) => l[1].includes("[scramjet]")).map((l) => l[1].slice(0, 160)),
			};
		}, [ALVO, ESPERA]);

		const recuperou = r.atividades.some((a) => a[0] === "set" && a[1] === "motor-navegacao");
		const pousou = r.estado === "carregou" && r.marca && r.marca !== "vazou" && !r.gap;

		if (!pousou) { placar.pendurada++; detalhes.push({ i, ...r }); }
		else if (recuperou) { placar.recuperada++; detalhes.push({ i, ...r }); }
		else placar.direta++;

		console.log(`  ${String(i).padStart(2)} · ${pousou ? (recuperou ? "recuperada" : "direta    ") : "PENDURADA "}`
			+ ` · ${String(r.ms).padStart(5)}ms · marca=${r.marca} · motor=${r.estadoDoMotor}`);
	} catch (e) {
		placar.erro++;
		console.log(`  ${String(i).padStart(2)} · ERRO · ${e.message.split("\n")[0]}`);
	}
	await ctx.close();
}

await navegador.close();
await portal.fechar();
await sites.fechar();

console.log("\n=== veredito ===");
console.log(`  diretas     ${placar.direta}/${N}`);
console.log(`  recuperadas ${placar.recuperada}/${N}   (o defeito aconteceu e se consertou sozinho)`);
console.log(`  penduradas  ${placar.pendurada}/${N}   (o defeito aconteceu e a pessoa precisaria de F5)`);
if (placar.erro) console.log(`  erros       ${placar.erro}/${N}`);

for (const d of detalhes) {
	console.log(`\n  carga ${d.i}: estado=${d.estado} marca=${d.marca} gap=${d.gap} motor=${d.estadoDoMotor}`);
	for (const l of d.log) console.log(`    log: ${l}`);
}

// Pendurada é o defeito; recuperada é ele sendo consertado. Só a primeira reprova.
process.exitCode = placar.pendurada > 0 || placar.erro > 0 ? 1 : 0;
