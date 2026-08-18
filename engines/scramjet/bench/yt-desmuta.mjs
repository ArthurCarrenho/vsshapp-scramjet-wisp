// O vídeo do YouTube, mudo e tocando numa aba, DESMUTA quando outra aba é atualizada — e desmuta
// por baixo do player: o ícone continua mudo, o som sai.
//
// Este script mede a distinção que o relato faz, e ela é a coisa toda:
//
//   movie_player.isMuted()  → o que o PLAYER acha  (o ícone)
//   video.muted             → o que a MÍDIA faz    (o som)
//
// Duas coisas precisam ser observadas juntas, porque a segunda explica a primeira:
//
//   1. o `<video>` é o MESMO elemento depois do gatilho, ou o player criou outro? Um <video>
//      recém-criado nasce com muted=false. Se o player troca o elemento e não reaplica o mudo,
//      o ícone (que é estado do player) e o som (que é estado do elemento) divergem — exatamente
//      o sintoma relatado. Por isso cada elemento de mídia ganha um id estável via WeakMap.
//   2. o que acontece com a REDE no instante do gatilho. Requisição de mídia que morre em massa
//      é o que leva o player a refazer o elemento.
//
// A sonda entra por addInitScript, então roda antes do client do scramjet em todo frame.

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const ALVO2 = process.env.BENCH_ALVO2 || "https://example.com/";
const ESPERA = Number(process.env.BENCH_ESPERA || 25000);
const OCIOSO = Number(process.env.BENCH_OCIOSO || 0); // segundos parados antes do gatilho
const CONTROLE = process.env.BENCH_CONTROLE === "1";
const DIRETO = process.env.BENCH_DIRETO === "1";
const LIMITE = Number(process.env.BENCH_LIMITE || 420000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

const SONDA = String.raw`
(() => {
	if (window.__sonda) return;
	window.__sonda = true;
	window.__linha = [];
	const t0 = Date.now();
	const reg = (tipo, extra) => { try { window.__linha.push(Object.assign({ ms: Date.now() - t0, tipo }, extra)); } catch {} };
	window.__reg = reg;

	let seq = 0;
	const ids = new WeakMap();
	window.__idDe = (el) => { if (!ids.has(el)) ids.set(el, ++seq); return ids.get(el); };

	const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
	if (d && d.get && d.set) {
		Object.defineProperty(HTMLMediaElement.prototype, "muted", {
			configurable: true, enumerable: d.enumerable,
			get() { return d.get.call(this); },
			set(v) {
				reg("escreveu:muted", {
					id: window.__idDe(this), valor: !!v,
					pilha: String(new Error().stack || "").split("\n").slice(1, 6).join(" | ").slice(0, 400),
				});
				return d.set.call(this, v);
			},
		});
	}

	for (const m of ["load", "pause", "play"]) {
		const orig = HTMLMediaElement.prototype[m];
		if (typeof orig !== "function") continue;
		HTMLMediaElement.prototype[m] = function (...a) {
			reg("chamou:" + m, {
				id: window.__idDe(this), muted: d.get.call(this),
				pilha: String(new Error().stack || "").split("\n").slice(1, 5).join(" | ").slice(0, 300),
			});
			return orig.apply(this, a);
		};
	}

	const nativo = EventTarget.prototype.addEventListener;
	for (const tipo of ["error","emptied","abort","stalled","loadstart","loadedmetadata","ended","volumechange","canplay","waiting"]) {
		nativo.call(document, tipo, (e) => {
			const el = e.target;
			if (!(el instanceof HTMLMediaElement)) return;
			reg("midia:" + tipo, {
				id: window.__idDe(el), muted: d.get.call(el),
				tempo: Math.round(el.currentTime * 10) / 10,
				erro: el.error ? el.error.code + ":" + String(el.error.message).slice(0, 60) : null,
			});
		}, true);
	}

	window.__estado = () => {
		const p = document.querySelector("#movie_player");
		const midias = [...document.querySelectorAll("video, audio")].map((v) => ({
			id: window.__idDe(v), tag: v.tagName, muted: v.muted, volume: v.volume,
			paused: v.paused, tempo: Math.round(v.currentTime * 10) / 10,
			pronto: v.readyState, rede: v.networkState,
			erro: v.error ? v.error.code : null,
			fonte: String(v.currentSrc || v.src || "").slice(0, 24),
		}));
		return {
			player_isMuted: p && p.isMuted ? p.isMuted() : null,
			player_estado: p && p.getPlayerState ? p.getPlayerState() : null,
			midias,
		};
	};
})();
`;

await esperarServidor(BASE, 15000);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const ctxOpts = {
	userAgent:
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
	viewport: { width: 1600, height: 900 },
	locale: "pt-BR",
};

async function navegar(page, url) {
	// ⚠ O baseline SEM proxy é obrigatório antes de culpar o motor. O player do YouTube num
	// chromium headless pode se derrubar sozinho por motivos que não têm nada a ver com reescrita
	// — e se ele fizer isso nos dois lados, medir só o lado proxiado atribui ao motor um defeito
	// que não é dele. BENCH_DIRETO=1 vai direto ao site, com a mesma sonda e a mesma cronometragem.
	if (DIRETO) {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
		return;
	}
	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector(
		'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
		{ timeout: 20000 }
	);
	await input.fill(url);
	await input.press("Enter");
}

const acharYt = (page) =>
	DIRETO
		? page.mainFrame()
		: page.frames().find((f) => f.url().includes("youtube.com%2Fwatch") || f.url().includes("youtube.com/watch"));

const mostrar = (r, rotulo) => {
	console.log(`  ${rotulo}`);
	console.log(`     player.isMuted=${r.player_isMuted}  player.estado=${r.player_estado}`);
	for (const m of r.midias) {
		console.log(
			`     <${m.tag} #${m.id}>  muted=${m.muted} vol=${m.volume} paused=${m.paused} t=${m.tempo} readyState=${m.pronto} networkState=${m.rede} erro=${m.erro} src=${m.fonte}`
		);
	}
	return r;
};

try {
	const ctx = await browser.newContext(ctxOpts);
	await ctx.addInitScript(SONDA);

	const page1 = await ctx.newPage();
	const falhas1 = [];
	page1.on("requestfailed", (r) =>
		falhas1.push({ t: Date.now(), url: r.url().slice(-70), erro: r.failure()?.errorText })
	);
	page1.on("console", (m) => {
		const s = m.text();
		if (/No frame found|porta de comunica|swrevive|Service Worker error|revive/i.test(s))
			console.log(`  [console aba1] ${s.slice(0, 180)}`);
	});

	console.log(`=== aba 1: ${ALVO} ===`);
	await navegar(page1, ALVO);
	await page1.waitForTimeout(ESPERA);

	let yt = acharYt(page1);
	if (!yt) {
		console.log("não achei o frame do youtube");
		process.exit(1);
	}

	await yt.evaluate(() => document.querySelector("#movie_player")?.playVideo?.());
	await page1.waitForTimeout(5000);
	await yt.evaluate(() => document.querySelector("#movie_player")?.mute?.());
	await page1.waitForTimeout(2000);

	const t0 = mostrar(await yt.evaluate(() => window.__estado()), "depois de mutar pelo player:");
	await yt.evaluate(() => {
		window.__linha = [];
	});
	const marcaFalhas = falhas1.length;

	if (OCIOSO) {
		console.log(`\n=== ${OCIOSO}s parados (para o service worker poder morrer de ocioso) ===`);
		await page1.waitForTimeout(OCIOSO * 1000);
		mostrar(await yt.evaluate(() => window.__estado()), "depois do ócio:");
	}

	// ⚠ O CONTROLE não é opcional. O YouTube atravessando o proxy pode muito bem derrubar o próprio
	// player sozinho, e aí o "gatilho" seria coincidência — a rodada inteira mediria outra coisa.
	// Com BENCH_CONTROLE=1 o script espera exatamente o mesmo tempo SEM abrir nem atualizar a aba 2.
	if (CONTROLE) {
		console.log("\n=== CONTROLE: nenhuma segunda aba; só espera o mesmo tempo ===");
		await page1.waitForTimeout(8000);
		yt = acharYt(page1) || yt;
		mostrar(await yt.evaluate(() => window.__estado()), "no lugar do 'aba 2 abrir':");
		await page1.waitForTimeout(12000);
	} else {
		console.log(`\n=== aba 2 abre: ${ALVO2} ===`);
		const page2 = await ctx.newPage();
		await navegar(page2, ALVO2);
		await page2.waitForTimeout(8000);

		yt = acharYt(page1) || yt;
		mostrar(await yt.evaluate(() => window.__estado()), "depois da aba 2 ABRIR:");

		console.log("\n=== aba 2 ATUALIZA (o gatilho do relato) ===");
		await page2.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
		await page2.waitForTimeout(12000);
	}

	yt = acharYt(page1) || yt;
	const t2 = mostrar(
		await yt.evaluate(() => window.__estado()),
		CONTROLE ? "depois da espera equivalente (SEM gatilho):" : "depois da aba 2 ATUALIZAR:"
	);

	const linha = await yt.evaluate(() => (window.__linha || []).slice(0, 90));
	console.log(`\n  --- linha do tempo da mídia na aba 1 (${linha.length} eventos) ---`);
	for (const e of linha) {
		const extra = [
			e.id !== undefined ? `#${e.id}` : "",
			e.valor !== undefined ? `valor=${e.valor}` : "",
			e.muted !== undefined ? `muted=${e.muted}` : "",
			e.tempo !== undefined ? `t=${e.tempo}` : "",
			e.erro ? `erro=${e.erro}` : "",
		]
			.filter(Boolean)
			.join(" ");
		console.log(`     +${String(e.ms).padStart(6)}ms  ${e.tipo.padEnd(20)} ${extra}`);
		if (e.pilha) console.log(`               ${e.pilha.slice(0, 220)}`);
	}

	const novas = falhas1.slice(marcaFalhas);
	console.log(`\n  --- requisições que falharam na aba 1 depois do mute: ${novas.length} ---`);
	for (const f of novas.slice(0, 15)) console.log(`     ${f.erro}  ...${f.url}`);

	console.log("\n=== veredito ===");
	const antes = t0.midias[0];
	const depois = t2.midias.find((m) => m.tag === "VIDEO") || t2.midias[0];
	const trocou = antes && depois && antes.id !== depois.id;
	const desmutou = antes?.muted === true && depois?.muted === false;
	const divergiu = t2.player_isMuted === true && depois?.muted === false;
	console.log(`  o <video> foi TROCADO por outro elemento: ${trocou ? `SIM (#${antes.id} -> #${depois.id})` : "não"}`);
	console.log(`  vídeo estava mudo e desmutou sozinho:     ${desmutou ? "SIM" : "não"}`);
	console.log(`  player diz mudo mas a mídia não está:     ${divergiu ? "SIM  <-- o sintoma do relato" : "não"}`);
	process.exitCode = desmutou || divergiu ? 1 : 0;
} finally {
	await browser.close();
}
