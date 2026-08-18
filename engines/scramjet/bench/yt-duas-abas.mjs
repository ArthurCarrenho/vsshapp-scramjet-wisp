// Reprodução fiel do arranjo do portal: as abas do navegador embutido NÃO são abas do chromium,
// são `<iframe>` irmãos na mesma página (`controller.createFrame(elemento)`). Testar com duas
// páginas do playwright — como o `yt-desmuta.mjs` faz — mede um arranjo que o usuário não tem:
// abas separadas do chromium não compartilham árvore de frames, e é justamente a árvore que
// carrega quase tudo que uma aba pode fazer com a outra.
//
// Aqui as duas "abas" são irmãs, same-origin entre si (as duas carregam do proxy), e o gatilho é
// literalmente o do relato: recarregar a aba B enquanto a aba A tem vídeo tocando MUDO.
//
// Mede, na aba A e a cada etapa:
//   movie_player.isMuted()  → o que o PLAYER acha  (o ícone)
//   video.muted             → o que a MÍDIA faz    (o som)
// e a linha do tempo de toda escrita em `muted`, com a pilha de quem escreveu.

import http from "node:http";

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const ALVO2 = process.env.BENCH_ALVO2 || "https://example.com/";
const PORTA = Number(process.env.BENCH_PORTA || 5244);
const ESPERA = Number(process.env.BENCH_ESPERA || 30000);
const RODADAS = Number(process.env.BENCH_RODADAS || 3);
const LIMITE = Number(process.env.BENCH_LIMITE || 480000);

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

	let seq = 0;
	const ids = new WeakMap();
	const idDe = (el) => { if (!ids.has(el)) ids.set(el, ++seq); return ids.get(el); };
	window.__idDe = idDe;

	const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
	if (d && d.get && d.set) {
		Object.defineProperty(HTMLMediaElement.prototype, "muted", {
			configurable: true, enumerable: d.enumerable,
			get() { return d.get.call(this); },
			set(v) {
				reg("escreveu:muted", {
					id: idDe(this), valor: !!v, ligado: this.isConnected, pausado: this.paused,
					pilha: String(new Error().stack || "").split("\n").slice(1, 6).join(" | ").slice(0, 320),
				});
				return d.set.call(this, v);
			},
		});
	}

	window.__estado = () => {
		const p = document.querySelector("#movie_player");
		return {
			player_isMuted: p && p.isMuted ? p.isMuted() : null,
			player_estado: p && p.getPlayerState ? p.getPlayerState() : null,
			midias: [...document.querySelectorAll("video, audio")].map((v) => ({
				id: idDe(v), tag: v.tagName, muted: v.muted, volume: v.volume,
				paused: v.paused, tempo: Math.round(v.currentTime * 10) / 10,
			})),
		};
	};
})();
`;

// ⚠ `?goto=` NÃO navega o frame — a demo consome o parâmetro no mount e o frame fica em
// about:blank. As duas abas sobem vazias e são dirigidas pela caixa de endereço de cada uma,
// que é o caminho que funciona (o resto da bancada faz igual).
const TOPO = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>duas abas</title></head>
<body style="margin:0;display:flex;gap:4px">
<iframe id="A" src="${BASE}/" style="width:49%;height:98vh;border:2px solid #39f"></iframe>
<iframe id="B" src="${BASE}/" style="width:49%;height:98vh;border:2px solid #f93"></iframe>
</body></html>`;

const servidor = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	res.end(TOPO);
});
await new Promise((r) => servidor.listen(PORTA, r));

await esperarServidor(BASE, 15000);
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

const acharYt = (page) =>
	page.frames().find((f) => f.url().includes("youtube.com%2Fwatch") || f.url().includes("youtube.com/watch"));

const mostrar = (r, rotulo) => {
	console.log(`  ${rotulo}`);
	console.log(`     player.isMuted=${r.player_isMuted}  player.estado=${r.player_estado}`);
	for (const m of r.midias)
		console.log(`     <${m.tag} #${m.id}> muted=${m.muted} vol=${m.volume} paused=${m.paused} t=${m.tempo}`);
	return r;
};

const divergiu = (r) => {
	const v = r.midias.find((m) => m.tag === "VIDEO");
	return r.player_isMuted === true && v && v.muted === false;
};

try {
	const ctx = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1900, height: 950 },
		locale: "pt-BR",
	});
	await ctx.addInitScript(SONDA);

	const page = await ctx.newPage();
	console.log(`=== duas abas irmãs: A=${ALVO}  B=${ALVO2} ===`);
	await page.goto(`http://localhost:${PORTA}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
	await page.waitForTimeout(8000);

	const aba = async (nome) => (await page.$(`#${nome}`)).contentFrame();
	const dirigir = async (nome, url) => {
		const f = await aba(nome);
		const input = await f.waitForSelector(
			'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
			{ timeout: 25000 }
		);
		await input.fill(url);
		await input.press("Enter");
	};

	await dirigir("A", ALVO);
	await dirigir("B", ALVO2);
	await page.waitForTimeout(ESPERA);

	let yt = acharYt(page);
	if (!yt) {
		console.log("não achei o frame do youtube. frames vistos:");
		for (const f of page.frames()) console.log("   " + f.url().slice(0, 130));
		process.exit(1);
	}

	await yt.evaluate(() => document.querySelector("#movie_player")?.playVideo?.());
	await page.waitForTimeout(5000);
	await yt.evaluate(() => document.querySelector("#movie_player")?.mute?.());
	await page.waitForTimeout(2000);

	mostrar(await yt.evaluate(() => window.__estado()), "aba A depois de mutar pelo player:");
	await yt.evaluate(() => {
		window.__linha = [];
	});

	let pegou = null;
	for (let i = 1; i <= RODADAS && !pegou; i++) {
		console.log(`\n=== rodada ${i}: recarregando a aba B ===`);
		// ⚠ recarregar pela página de cima não dá: ela é cross-origin dos iframes, e
		// `contentWindow.location.reload()` levanta SecurityError. Quem navega o frame é o
		// playwright, que não está sujeito à mesma-origem.
		await (await aba("B")).goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
		await page.waitForTimeout(6000);
		// depois do F5 a aba B volta à home da demo; renavegar reproduz "a aba B estava num site
		// e o usuário atualizou", em vez de "a aba B virou uma página em branco"
		try {
			await dirigir("B", ALVO2);
		} catch {}
		await page.waitForTimeout(10000);

		yt = acharYt(page) || yt;
		// o player pode ter se derrubado sozinho (acontece, e não é o proxy — ver yt-desmuta.mjs
		// com BENCH_DIRETO=1); nesse caso, retoma e remuta antes de julgar a rodada
		const r = mostrar(await yt.evaluate(() => window.__estado()), `aba A depois do reload ${i}:`);
		if (divergiu(r)) pegou = r;
		else if (r.player_estado === -1 || r.midias.every((m) => m.paused)) {
			console.log("     (player parado por conta própria — retomando para a próxima rodada)");
			await yt.evaluate(() => {
				const p = document.querySelector("#movie_player");
				p?.playVideo?.();
				p?.mute?.();
			});
			await page.waitForTimeout(6000);
		}
	}

	const linha = await yt.evaluate(() => (window.__linha || []).slice(0, 60));
	console.log(`\n  --- escritas em muted na aba A durante os reloads (${linha.length}) ---`);
	for (const e of linha) {
		console.log(
			`     +${String(e.ms).padStart(6)}ms  #${e.id} muted:=${e.valor}  noDom=${e.ligado} pausado=${e.pausado}`
		);
		if (e.pilha) console.log(`               ${e.pilha.slice(0, 200)}`);
	}

	console.log("\n=== veredito ===");
	console.log(
		`  player diz mudo mas a mídia não está: ${pegou ? "SIM  <-- o sintoma do relato, reproduzido" : "não"}`
	);
	process.exitCode = pegou ? 1 : 0;
} finally {
	await browser.close();
	servidor.close();
}
