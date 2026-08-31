// O portal recusa os assets do motor: o cliente diz o CÓDIGO, ou volta a adivinhar?
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// De uma sessão real, o console inteiro que o usuário tinha para trabalhar:
//
//   reg.update() falhou (backend fora?): TypeError: Failed to update a ServiceWorker …
//   Failed to load resource: the server responded with a status of 403 ()
//   [scramjet] preaquecimento falhou: Error: Falha ao carregar …/scram/scramjet.js
//   [TabManager] Motor 'scramjet-wisp' indisponível: Error: Falha ao carregar …
//
// Quatro mensagens, um defeito — e a mensagem NOSSA (as três com marca) não trazia o 403. Ele
// aparecia só na linha que o navegador imprime sozinho, sem dizer de quem é. E a primeira delas
// acusava o backend, que estava de pé: quem recusava era o caminho público.
//
// O que se mede aqui é isso, e só isso: com o portal recusando, o motor **nomeia o status** e
// **não acusa o backend**. Não é sobre o motor funcionar sob recusa — ele não pode funcionar.
//
// ─── Como ler o resultado ────────────────────────────────────────────────────────────────────
//
// **controle** é o mesmo arranjo sem o gatilho: o portal serve os assets e o motor sobe. Ele é o
// que separa "a mensagem apareceu porque o portal recusou" de "esta bancada não sobe motor
// nenhum" — sem ele, uma bancada quebrada passaria verde pelo motivo errado.
//
//   BENCH_STATUS  o código com que o portal recusa (padrão 403)
//   BENCH_CHROME  o binário do Chromium, quando o do playwright não é o que está na máquina

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte();

const STATUS = Number(process.env.BENCH_STATUS || 403);

const sites = await subirSites();
const navegador = await abrirNavegador();

// Uma rodada = um portal novo, um contexto novo. O contexto TEM de ser novo: um service worker do
// motor deixado de pé pela rodada anterior atenderia a chamada sem tocar na rede, e a sonda mediria
// a memória do processo em vez do caminho.
async function rodada(statusDosAssets) {
	const portal = await subirPortal({ portaSites: sites.porta, statusDosAssets });
	const ctx = await navegador.newContext();
	const pag = await ctx.newPage();
	await pag.goto(portal.base, { waitUntil: "load" });

	const r = await pag.evaluate(async () => {
		let subiu = false;
		let erro = null;
		try {
			await window.__bancada.iniciar();
			subiu = true;
		} catch (e) {
			// A mensagem é a medida. `String(e)` e não `e.message` porque é assim que ela chega ao
			// console e ao diálogo — o que se quer saber é o que a PESSOA leria.
			erro = String(e);
		}
		return {
			subiu,
			erro,
			// Só as linhas do motor: "o site reclamou" e "o motor reclamou" são coisas diferentes, e
			// a linha que o navegador imprime sozinha ("Failed to load resource…") não é nossa e não
			// conta a favor de ninguém.
			log: window.__bancada.log().map((l) => l[1]).filter((t) => t.includes("[scramjet]")),
		};
	});

	await ctx.close();
	await portal.fechar();
	return r;
}

// O que se procura no que o motor disse — a mensagem do erro e as linhas de log, juntas, porque a
// pessoa lê as duas coisas no mesmo lugar.
const marcas = (r, status) => {
	const tudo = [r.erro || "", ...r.log].join("\n");
	return {
		dizOStatus:     tudo.includes(String(status)),
		dizOEndereco:   tudo.includes("/s/proxy/app/scramjet-wisp/"),
		acusaOBackend:  /backend fora/i.test(tudo),
		tudo,
	};
};

console.log(`→ controle: o portal serve os assets`);
const bom = await rodada(null);
const mBom = marcas(bom, STATUS);
console.log(`   subiu=${bom.subiu} erro=${bom.erro ?? "—"}`);

console.log(`\n→ o gatilho: o portal recusa /proxy/app/scramjet-wisp/ com ${STATUS}`);
const ruim = await rodada(STATUS);
const mRuim = marcas(ruim, STATUS);
console.log(`   subiu=${ruim.subiu} erro=${ruim.erro ?? "—"}`);
for (const t of ruim.log) console.log(`   log: ${t.slice(0, 220)}`);

await navegador.close();
await sites.fechar();

console.log("\n=== veredito ===");
const falhas = [];

// O controle primeiro: sem ele nada do resto significa alguma coisa.
if (!bom.subiu) falhas.push(`o motor não subiu NEM sem o gatilho (${bom.erro}) — a rodada inteira não vale`);
if (mBom.dizOStatus) falhas.push(`a rodada de controle já mencionava "${STATUS}" — a marca não é do gatilho`);

if (ruim.subiu) falhas.push("o motor disse ter subido com o portal recusando tudo — isso é um 200 mentiroso");
if (!mRuim.dizOStatus) falhas.push(`o motor falhou sem dizer o status (${STATUS}) — é a mensagem cega do incidente, de volta`);
if (!mRuim.dizOEndereco) falhas.push("a mensagem não diz QUAL endereço recusou — sem isso não dá para sondar nada");
if (mRuim.acusaOBackend) falhas.push('o motor acusou "backend fora" — o backend estava de pé; quem recusou foi o caminho');

if (falhas.length) {
	for (const f of falhas) console.log(`  ✗ ${f}`);
	console.log(`\n  o que o motor disse:\n${mRuim.tudo.split("\n").map((l) => "    " + l).join("\n")}`);
	process.exitCode = 1;
} else {
	console.log(`  ✓ a recusa do portal chega ao console com o número (${STATUS}) e o endereço, e sem acusar o backend`);
}
