// O arranjo REAL do portal: UM `Controller`, VÁRIOS frames.
//
// É a diferença que faltava. `yt-duas-abas.mjs` põe duas abas lado a lado, mas cada uma carrega a
// demo inteira — e cada demo constrói o SEU Controller e o SEU `LibcurlClient`. Duas abas ali não
// dividem nada além do service worker.
//
// No portal não é assim: o navegador embutido cria cada aba com `controller.createFrame(elemento)`
// sobre o MESMO Controller, e `Controller.setTransport` aplica o MESMO transporte a todo frame. As
// abas dividem, então, o cookie jar, o handshake com o service worker e — o que mais importa aqui —
// **um único pool de conexões do libcurl, com teto**. Uma aba que recarrega dispara dezenas de
// requisições nesse pool; a aba do lado, com vídeo tocando, disputa com ela.
//
// Este script monta esse arranjo do zero (sem a demo): serve os bundles, sobe o wisp, cria um
// Controller e DOIS frames irmãos, e então recarrega a aba B enquanto a aba A tem vídeo mudo
// tocando. Mede o que o relato distingue:
//
//   movie_player.isMuted()  → o que o PLAYER acha  (o ícone)
//   video.muted             → o que a MÍDIA faz    (o som)
//
// e, além disso, todo elemento de mídia que já existiu — inclusive os que saíram do DOM, porque um
// `<video>` órfão continua tocando e é o candidato a sair audível sem o player saber.
//
// ⚠ ESTADO: o arranjo NAVEGA (as duas abas carregam os sites), mas o YouTube **não chega a iniciar
// a reprodução** aqui — o player fica em `getPlayerState() === -1` e o script aborta antes de
// julgar, de propósito, porque medir o sintoma com o vídeo parado seria medir outra coisa. O que
// ainda não foi tentado, em ordem de suspeita: passar `scramjetConfig: defaultConfigDev` (a demo
// passa, este script não), e montar os plugins que a demo usa (`HttpCachePlugin`). Enquanto isso
// não estiver resolvido, este script serve para exercitar o arranjo — um controller, N frames, um
// transporte — mas não para dar veredito sobre o desmute.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import("./comum.mjs");
//@ts-expect-error sem typedefs
const { server: wisp } = await import("@mercuryworkshop/wisp-js/server");

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA = Number(process.env.BENCH_PORTA || 5300);
const PORTA_WISP = Number(process.env.BENCH_PORTA_WISP || 5301);
// permite usar um wisp de fora (o do devserver, por exemplo) em vez do que este script sobe
const WISP_URL = process.env.BENCH_WISP_URL || `ws://localhost:${PORTA_WISP}/`;
const ALVO = process.env.BENCH_ALVO || "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const ALVO2 = process.env.BENCH_ALVO2 || "https://example.com/";
const ESPERA = Number(process.env.BENCH_ESPERA || 30000);
const RODADAS = Number(process.env.BENCH_RODADAS || 4);
const LIMITE = Number(process.env.BENCH_LIMITE || 540000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

const ESTATICOS = {
	"/scramjet/": path.join(raiz, "packages/core/dist"),
	"/controller/": path.join(raiz, "packages/controller/dist"),
	"/libcurl/": path.join(raiz, "packages/runway/node_modules/@mercuryworkshop/libcurl-transport/dist"),
};

const TIPOS = {
	".js": "application/javascript",
	".mjs": "application/javascript",
	".wasm": "application/wasm",
	".map": "application/json",
	".html": "text/html; charset=utf-8",
};

const SW = `importScripts("/controller/controller.sw.js");
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
addEventListener("fetch", (e) => {
	if ($scramjetController.shouldRoute(e)) e.respondWith($scramjetController.route(e));
});`;

const PAGINA = `<!doctype html>
<html><head><meta charset="utf-8"><title>portal com duas abas</title>
<script src="/scramjet/scramjet.js"></script>
<script src="/controller/controller.api.js"></script>
<script src="/libcurl/index.js"></script>
</head>
<body style="margin:0;font:13px sans-serif">
<div id="estado">iniciando…</div>
<div style="display:flex;gap:4px">
	<iframe id="abaA" style="width:49vw;height:92vh;border:2px solid #39f"></iframe>
	<iframe id="abaB" style="width:49vw;height:92vh;border:2px solid #f93"></iframe>
</div>
<script>
const estado = document.getElementById("estado");
const { Controller } = $scramjetController;
const LibcurlClient = window.LibcurlTransport.LibcurlClient;
let controller, frameA, frameB;

async function init() {
	const registration = await navigator.serviceWorker.register("/sw.js");
	if (!navigator.serviceWorker.controller) {
		await new Promise((resolve) => {
			if (registration.active) return resolve();
			const sw = registration.installing || registration.waiting;
			if (sw) sw.addEventListener("statechange", () => { if (sw.state === "activated") resolve(); });
		});
		if (!navigator.serviceWorker.controller) {
			await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
		}
	}

	const sw = navigator.serviceWorker.controller ?? registration.active;

	// UM controller e UM transporte para as duas abas — é o ponto do teste
	controller = new Controller({
		serviceworker: sw,
		transport: new LibcurlClient({ wisp: "${WISP_URL}" }),
	});
	window.__controller = controller;
	await controller.ready;

	frameA = controller.createFrame(document.getElementById("abaA"));
	frameB = controller.createFrame(document.getElementById("abaB"));

	// AVISO: o frame precisa de um documento ANTES do primeiro go(). Com o iframe ainda em
	// about:blank a navegação não completa: o service worker manda o clientUrl do cliente que
	// pediu, o motor tenta desreescrevê-lo e loga "unrewriteUrl: unexpected url". O fetch da
	// mesma URL feito pela página de cima devolve 200 normalmente, então é só o caminho de
	// navegação que cai. A demo faz o mesmo: carrega a homepage num data: URL antes de navegar.
	const branco = "data:text/html;base64," + btoa("<html><body>aba</body></html>");
	document.getElementById("abaA").src = branco;
	document.getElementById("abaB").src = branco;
	await new Promise((r) => setTimeout(r, 800));

	window.__irA = (url) => frameA.go(url);
	window.__irB = (url) => frameB.go(url);
	// "atualizar a aba" no portal é o frame navegar de novo para a mesma URL
	window.__recarregarB = (url) => frameB.go(url);
	window.__quantosFrames = () => controller.frames.length;

	estado.textContent = "pronto: 1 controller, " + controller.frames.length + " frames, 1 transporte";
	document.title = "pronto";
}
init().catch((e) => { estado.textContent = "erro: " + e; document.title = "erro"; });
</script></body></html>`;

const servidor = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	const p = url.pathname;

	if (p === "/" || p === "/index.html") {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		return res.end(PAGINA);
	}
	if (p === "/sw.js") {
		res.writeHead(200, { "content-type": "application/javascript", "cache-control": "no-store" });
		return res.end(SW);
	}
	for (const [prefixo, dir] of Object.entries(ESTATICOS)) {
		if (!p.startsWith(prefixo)) continue;
		const arq = path.join(dir, p.slice(prefixo.length));
		if (!arq.startsWith(dir) || !fs.existsSync(arq)) break;
		res.writeHead(200, {
			"content-type": TIPOS[path.extname(arq)] || "application/octet-stream",
			"cache-control": "no-store",
		});
		return fs.createReadStream(arq).pipe(res);
	}
	res.writeHead(404);
	res.end("nao achei " + p);
});
await new Promise((r) => servidor.listen(PORTA, r));

let servidorWisp = null;
if (!process.env.BENCH_WISP_URL) {
	servidorWisp = http.createServer((req, res) => {
		res.writeHead(200);
		res.end("wisp");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	servidorWisp.on("upgrade", (req, socket, head) => wisp.routeRequest(req, socket, head));
	await new Promise((r) => servidorWisp.listen(PORTA_WISP, r));
}
console.log(`  wisp: ${WISP_URL}`);

const SONDA = String.raw`
(() => {
	if (window.__sonda) return;
	window.__sonda = true;
	window.__linha = [];
	const t0 = Date.now();
	const reg = (tipo, extra) => { try { window.__linha.push(Object.assign({ ms: Date.now() - t0, tipo }, extra)); } catch {} };

	let seq = 0;
	const ids = new WeakMap();
	const vivos = [];
	const idDe = (el) => { if (!ids.has(el)) { ids.set(el, ++seq); vivos.push(new WeakRef(el)); } return ids.get(el); };

	const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
	Object.defineProperty(HTMLMediaElement.prototype, "muted", {
		configurable: true, enumerable: d.enumerable,
		get() { return d.get.call(this); },
		set(v) {
			reg("muted:=" + !!v, {
				id: idDe(this), noDom: this.isConnected, pausado: this.paused,
				t: Math.round(this.currentTime * 10) / 10,
				pilha: String(new Error().stack || "").split("\n").slice(1, 5).join(" | ").slice(0, 220),
			});
			return d.set.call(this, v);
		},
	});

	window.__todos = () => {
		const p = document.querySelector("#movie_player");
		const lista = [];
		for (const ref of vivos) {
			const el = ref.deref();
			if (!el) continue;
			lista.push({
				id: ids.get(el), tag: el.tagName, noDom: el.isConnected,
				muted: d.get.call(el), volume: el.volume, pausado: el.paused,
				t: Math.round(el.currentTime * 10) / 10,
				audivel: !d.get.call(el) && !el.paused && el.volume > 0,
			});
		}
		return {
			player_isMuted: p && p.isMuted ? p.isMuted() : null,
			player_estado: p && p.getPlayerState ? p.getPlayerState() : null,
			midias: lista.sort((a, b) => a.id - b.id),
		};
	};
})();
`;

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

const mostrar = (r, rotulo) => {
	console.log(`  ${rotulo}`);
	console.log(`     player.isMuted=${r.player_isMuted}  player.estado=${r.player_estado}`);
	for (const m of r.midias)
		console.log(
			`     <${m.tag} #${m.id}> muted=${m.muted} vol=${m.volume} pausado=${m.pausado} noDOM=${!m.noDom} t=${m.t}${m.audivel ? "   *** AUDÍVEL ***" : ""}`
		);
	return r;
};

const sintoma = (r) => r.player_isMuted === true && r.midias.some((m) => m.audivel);

try {
	const ctx = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1900, height: 950 },
		locale: "pt-BR",
	});
	await ctx.addInitScript(SONDA);

	const page = await ctx.newPage();
	page.on("console", (m) => {
		if (process.env.BENCH_VERBOSO) return console.log(`  [console] ${m.text().slice(0, 200)}`);
		const s = m.text();
		if (/No frame found|porta de comunica|Service Worker error|erro:/i.test(s)) console.log(`  [console] ${s.slice(0, 170)}`);
	});
	page.on("pageerror", (e) => console.log(`  [pageerror] ${String(e).slice(0, 200)}`));
	page.on("requestfailed", (r) => {
		if (process.env.BENCH_VERBOSO) console.log(`  [falhou] ${r.failure()?.errorText}  ${r.url().slice(0, 110)}`);
	});

	console.log(`=== portal sintético: 1 controller, 2 frames, 1 transporte ===`);
	await page.goto(`http://localhost:${PORTA}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForFunction(() => document.title === "pronto" || document.title === "erro", { timeout: 60000 });
	console.log("  " + (await page.$eval("#estado", (e) => e.textContent)));

	await page.evaluate((u) => window.__irA(u), ALVO);
	await page.evaluate((u) => window.__irB(u), ALVO2);
	await page.waitForTimeout(ESPERA);

	const yt = () =>
		page.frames().find((f) => f.url().includes("youtube.com%2Fwatch") || f.url().includes("youtube.com/watch"));
	if (!yt()) {
		console.log("não achei o frame do youtube. frames:");
		for (const f of page.frames()) console.log("   " + f.url().slice(0, 130));
		console.log("  src dos iframes:");
		for (const id of ["abaA", "abaB"])
			console.log(`   #${id}: ` + (await page.$eval("#" + id, (e) => e.getAttribute("src") || "<sem src>")).slice(0, 150));
		process.exit(1);
	}

	// Esperar ATIVAMENTE o vídeo entrar em reprodução. Sem isto a rodada mede um player que nunca
	// tocou: o relato é sobre um vídeo TOCANDO mudo, e um <video> pausado nunca vai sair audível,
	// então julgar o sintoma antes disso é julgar outra coisa.
	const tocando = async (limiteMs) => {
		const fim = Date.now() + limiteMs;
		while (Date.now() < fim) {
			await yt().evaluate(() => document.querySelector("#movie_player")?.playVideo?.());
			await page.waitForTimeout(2500);
			const r = await yt().evaluate(() => window.__todos());
			if (r.midias.some((m) => !m.pausado && m.t > 0)) return true;
		}
		return false;
	};

	if (!(await tocando(90000))) {
		console.log("  o vídeo não chegou a tocar — a rodada não mede o sintoma; abortando");
		mostrar(await yt().evaluate(() => window.__todos()), "estado final:");
		process.exit(1);
	}
	// o usuário mutou PELO PLAYER — foi o que ele confirmou
	await yt().evaluate(() => document.querySelector("#movie_player")?.mute?.());
	await page.waitForTimeout(2000);
	mostrar(await yt().evaluate(() => window.__todos()), "aba A: tocando e mudo pelo player");
	await yt().evaluate(() => { window.__linha = []; });

	let pegou = null;
	for (let i = 1; i <= RODADAS && !pegou; i++) {
		console.log(`\n=== rodada ${i}: atualizando a aba B (mesmo controller, mesmo transporte) ===`);
		await page.evaluate((u) => window.__recarregarB(u), ALVO2);
		await page.waitForTimeout(9000);

		const r = mostrar(await yt().evaluate(() => window.__todos()), `aba A depois da rodada ${i}:`);
		if (sintoma(r)) pegou = r;
		else if (r.player_estado === -1 || r.midias.every((m) => m.pausado)) {
			console.log("     (player parado por conta própria — retomando; ver BENCH_DIRETO no yt-desmuta.mjs)");
			await tocando(30000);
			await yt().evaluate(() => document.querySelector("#movie_player")?.mute?.());
			await page.waitForTimeout(2000);
		}
	}

	const linha = await yt().evaluate(() => (window.__linha || []).slice(0, 70));
	console.log(`\n  --- escritas em muted na aba A (${linha.length}) ---`);
	for (const e of linha)
		console.log(
			`     +${String(e.ms).padStart(6)}ms  #${e.id} ${e.tipo}  noDOM=${!e.noDom} pausado=${e.pausado} t=${e.t}\n               ${String(e.pilha).slice(0, 180)}`
		);

	console.log("\n=== veredito ===");
	console.log(
		`  player diz mudo e existe mídia tocando COM som: ${pegou ? "SIM  <-- o sintoma do relato, reproduzido" : "não"}`
	);
	process.exitCode = pegou ? 1 : 0;
} finally {
	await browser.close();
	servidor.close();
	servidorWisp?.close();
}
