// O cache de páginas: o que ele guarda, e o que fica fora dele.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O `HttpCachePlugin` guarda a resposta de um GET que o HTTP deixa guardar. Um download, a mídia e
// uma resposta de dezenas de megabytes também são guardáveis pelo HTTP, e guardá-los custa a
// leitura inteira do corpo e a cota da origem do portal. A sonda pede, de dentro de uma aba do
// motor, cinco corpos com `max-age`, confere que cada um chegou inteiro à página, e lê o que entrou
// no CacheStorage da origem.
//
// ─── Como ler o resultado ────────────────────────────────────────────────────────────────────
//
// `pequeno.js` é o controle: ele tem de entrar, senão a sonda mede um cache desligado. Os outros
// quatro têm de ficar de fora. `sem-tamanho.bin` não declara `Content-Length`, e é ele que mede o
// teto que o cache aplica enquanto lê; os outros três o filtro do shell já tira pelo cabeçalho.
//
//   BENCH_CHROME   o binário do Chromium, quando o do playwright não é o que está na máquina
//   BENCH_BACKEND  o backend cujo `vendor/` a bancada serve (o motor montado a medir)

import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte();

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const BASE   = `http://site.teste:${sites.porta}/cache/`;

const CORPOS = [
	{ nome: "pequeno.js", caminho: "pequeno.js", bytes: "window.__pequeno = 1;".length, entra: true },
	{ nome: "grande.bin", caminho: "grande.bin?mb=32", bytes: 32 * 1024 * 1024, entra: false },
	{ nome: "anexo.zip", caminho: "anexo.zip?mb=2", bytes: 2 * 1024 * 1024, entra: false },
	{ nome: "sem-tamanho.bin", caminho: "sem-tamanho.bin?mb=16", bytes: 16 * 1024 * 1024, entra: false },
	{ nome: "video.mp4", caminho: "video.mp4", bytes: 1024 * 1024, entra: false },
];

console.log(`sítios em :${sites.porta} · portal em :${portal.porta}\n`);

const navegador = await abrirNavegador();
const pag = await (await navegador.newContext()).newPage();
let falhas = 0;
try {
	await pag.goto(portal.base, { waitUntil: "load" });
	// A página da bancada nasce com o cache de páginas desligado, para as outras sondas não
	// medirem respostas guardadas; esta liga, e o frame criado depois já nasce com ele.
	await pag.evaluate(() => { window.vsshSettings.scramjetPageCache = true; return window.__bancada.iniciar(); });
	const aba = await pag.evaluate((url) => window.__bancada.abrir(url, 20000), BASE);
	if (aba.estado !== "carregou") throw new Error(`a página de partida não carregou: ${JSON.stringify(aba)}`);

	const recebidos = [];
	for (const c of CORPOS) {
		const r = await pag.evaluate(([id, url]) => window.__bancada.naAba(id,
			`fetch(${JSON.stringify(url)}).then((r) => r.arrayBuffer()).then((b) => b.byteLength, (e) => 'erro: ' + e)`),
			[aba.id, BASE + c.caminho]);
		recebidos.push(r);
	}
	// O cache grava por fora da resposta; dá tempo à última gravação.
	await pag.waitForTimeout(1500);

	const guardados = await pag.evaluate(async () => {
		const cache = await caches.open("scramjet-http-cache-v2");
		return (await cache.keys()).map((k) => decodeURIComponent(new URL(k.url).pathname.slice(1)));
	});
	const uso = await pag.evaluate(async () => (await navigator.storage.estimate()).usage);

	console.log("corpo             chegou inteiro   no cache   esperado");
	CORPOS.forEach((c, i) => {
		const inteiro = recebidos[i] === c.bytes;
		const noCache = guardados.some((g) => g.includes("/cache/" + c.nome));
		const certo = inteiro && noCache === c.entra;
		if (!certo) falhas++;
		console.log(`${c.nome.padEnd(17)} ${String(inteiro ? "sim" : recebidos[i]).padEnd(16)} ${(noCache ? "sim" : "não").padEnd(10)} ${c.entra ? "entra" : "fica fora"}${certo ? "" : "   <-"}`);
	});
	console.log(`\nuso da origem: ${(uso / 1024 / 1024).toFixed(1)} MB`);
} catch (e) {
	console.log("erro na sonda:", e?.message || e);
	falhas = -1;
} finally {
	await navegador.close();
	await portal.fechar();
	await sites.fechar();
}

console.log("\n=== veredito ===");
if (falhas === -1) { console.log("INCONCLUSIVO: a sonda não chegou a medir"); process.exitCode = 2; }
else if (falhas) { console.log(`${falhas} corpo(s) fora do esperado`); process.exitCode = 1; }
else console.log("o pequeno entrou, e os quatro grandes ou de download ficaram de fora, chegando inteiros à página");
