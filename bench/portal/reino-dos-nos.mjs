// Os elementos da página são objetos do realm da página, ou do shell?
//
// O Chrome guarda um objeto JS por nó, e o realm desse objeto é o de quem o materializou primeiro.
// Um `MutationObserver` do shell sobre o documento da aba recebe os registros no realm da função
// dele, e os nós de `addedNodes` que ele lê ganham ali o objeto. Depois disso a página lê o
// elemento pelos protótipos do shell, onde o Scramjet não instala ganchos: `script.src` e
// `a.href` saem com a URL do proxy, e `getAttribute` devolve o valor reescrito.
//
// O sintoma que trouxe a sonda: o `api.js` do Cloudflare Turnstile procura a própria tag por
// `document.currentScript.src`, compara com `https://challenges.cloudflare.com/…`, e desiste com
// "Could not find Turnstile valid script tag". Era corrida: o vigia do shell liga o observer com o
// documento em "loading", e o `<head>` passava por ele ou não conforme o parser chegasse antes.
//
// A sonda carrega N vezes uma página com um `<script async>` que anota, no instante em que roda, a
// URL que ele vê de si mesmo e se o protótipo do elemento é o desta janela. Sem rede de fora.

import { createServer } from "node:http";
import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 240000));
const VOLTAS = Number(process.env.BENCH_VOLTAS || 12);

const SONDA = `(function () {
  var c = document.currentScript;
  window.__reino = {
    src: c ? String(c.src) : null,
    daPagina: !!c && Object.getPrototypeOf(c) === HTMLScriptElement.prototype,
    estado: document.readyState,
  };
})();`;

const sitio = createServer((req, res) => {
	if (req.url.startsWith("/sonda.js")) {
		res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
		return void res.end(SONDA);
	}
	const porta = sitio.address().port;
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(`<!doctype html><html><head><title>reino</title>
<script src="http://reino.teste:${porta}/sonda.js?v=1" async defer></script></head>
<body data-marca="reino"><p>${"texto ".repeat(200)}</p></body></html>`);
});
await new Promise((ok) => sitio.listen(0, "127.0.0.1", ok));
const portaSitio = sitio.address().port;
const esperado = `http://reino.teste:${portaSitio}/sonda.js?v=1`;

const portal = await subirPortal({ portaSites: portaSitio });
const navegador = await abrirNavegador();
const pag = await (await navegador.newContext()).newPage();

const falhas = [];
let certas = 0;
try {
	await pag.goto(portal.base, { waitUntil: "load" });
	await pag.evaluate(() => window.__bancada.iniciar());
	for (let i = 0; i < VOLTAS; i++) {
		const aba = await pag.evaluate((a) => window.__bancada.abrir(a, 20000), `http://reino.teste:${portaSitio}/?volta=${i}`);
		if (aba.marca !== "reino") { falhas.push(`volta ${i}: a página não carregou (${JSON.stringify(aba)})`); continue; }
		let visto = null;
		for (let t = 0; t < 30 && !visto; t++) {
			visto = await pag.evaluate((id) => window.__bancada.naAba(id, "window.__reino || null"), aba.id);
			if (!visto) await pag.waitForTimeout(100);
		}
		if (!visto) { falhas.push(`volta ${i}: o script não rodou`); continue; }
		const ok = visto.src === esperado && visto.daPagina;
		if (ok) certas++;
		else falhas.push(`volta ${i} (${visto.estado}): src=${String(visto.src).slice(0, 80)} daPagina=${visto.daPagina}`);
	}
	console.log(`${certas} de ${VOLTAS} cargas viram a própria URL num elemento desta janela`);
} catch (e) {
	falhas.push(`a sonda não chegou a medir: ${e?.message || e}`);
} finally {
	await navegador.close();
	await portal.fechar();
	sitio.close();
}

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ todo elemento da página é objeto da página, e o script vê a própria URL");
