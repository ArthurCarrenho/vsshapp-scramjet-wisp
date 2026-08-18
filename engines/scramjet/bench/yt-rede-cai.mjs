// O que o YouTube faz com o `muted` quando a REDE cai no meio de um vídeo tocando mudo.
//
// A bancada já estabeleceu, medindo, que o player mantém DOIS elementos de mídia e que, ao trocar
// qual deles é o ativo, ele passa por esta sequência exata:
//
//   #1.muted := false      (o elemento que sai — e que já não está no DOM)
//   #2.muted := true       (o elemento que entra)
//   #1.muted := true       (remuta o que saiu)
//
// Ou seja: existe uma janela em que um `<video>` fica DESMUTADO. Nas rodadas anteriores ela foi
// inofensiva porque o elemento que saía estava pausado. Um `<video>` fora do DOM continua tocando
// se ninguém o pausou — e aí o som sai de um elemento que o player não controla mais, enquanto o
// ícone segue o elemento novo, que está mudo. É exatamente "desmutou, mas não no player".
//
// O que dispara a troca é a mídia falhar. No relato isso vem da outra aba recarregando: todas as
// abas do portal dividem UM transporte (`Controller.setTransport` aplica o mesmo a todo frame) com
// teto de conexões, então uma aba que recarrega disputa o pool com o vídeo da outra. Aqui a queda é
// provocada direto, com `setOffline`, que é a versão determinística da mesma pressão.
//
// ⚠ Rodar com BENCH_DIRETO=1 para o baseline sem proxy. Se o YouTube fizer o mesmo dos dois lados,
// o defeito é do player e o motor só muda a frequência com que a rede falha.

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const ESPERA = Number(process.env.BENCH_ESPERA || 25000);
const QUEDA = Number(process.env.BENCH_QUEDA || 12000);
const RODADAS = Number(process.env.BENCH_RODADAS || 3);
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

	let seq = 0;
	const ids = new WeakMap();
	const vivos = new Set();
	const idDe = (el) => { if (!ids.has(el)) { ids.set(el, ++seq); vivos.add(new WeakRef(el)); } return ids.get(el); };
	window.__idDe = idDe;

	const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
	Object.defineProperty(HTMLMediaElement.prototype, "muted", {
		configurable: true, enumerable: d.enumerable,
		get() { return d.get.call(this); },
		set(v) {
			reg("muted:=" + !!v, {
				id: idDe(this), noDom: this.isConnected, pausado: this.paused,
				t: Math.round(this.currentTime * 10) / 10,
				pilha: String(new Error().stack || "").split("\n").slice(1, 5).join(" | ").slice(0, 260),
			});
			return d.set.call(this, v);
		},
	});

	// Todo elemento de mídia que já existiu, esteja ele no DOM ou não. É o ponto do teste: o
	// querySelectorAll só enxerga os que estão no documento, e o que sai do documento tocando é
	// justamente o que pode ficar audível sem que o player saiba.
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

if (!DIRETO) await esperarServidor(BASE, 15000);

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });

const mostrar = (r, rotulo) => {
	console.log(`  ${rotulo}`);
	console.log(`     player.isMuted=${r.player_isMuted}  player.estado=${r.player_estado}`);
	for (const m of r.midias)
		console.log(
			`     <${m.tag} #${m.id}> muted=${m.muted} vol=${m.volume} pausado=${m.pausado} noDom=${m.noDom} t=${m.t}${m.audivel ? "   *** AUDÍVEL ***" : ""}`
		);
	return r;
};

// o sintoma: o player acha que está mudo, e existe um elemento de mídia tocando com som
const sintoma = (r) => r.player_isMuted === true && r.midias.some((m) => m.audivel);

try {
	const ctx = await browser.newContext({
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
		viewport: { width: 1600, height: 900 },
		locale: "pt-BR",
	});
	await ctx.addInitScript(SONDA);
	const page = await ctx.newPage();

	console.log(`=== ${DIRETO ? "SEM proxy" : "atravessando o proxy"}: ${ALVO} ===`);
	if (DIRETO) {
		await page.goto(ALVO, { waitUntil: "domcontentloaded", timeout: 45000 });
	} else {
		await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
		const input = await page.waitForSelector(
			'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
			{ timeout: 20000 }
		);
		await input.fill(ALVO);
		await input.press("Enter");
	}
	await page.waitForTimeout(ESPERA);

	const yt = () =>
		DIRETO
			? page.mainFrame()
			: page.frames().find((f) => f.url().includes("youtube.com%2Fwatch") || f.url().includes("youtube.com/watch"));

	if (!yt()) {
		console.log("não achei o frame do youtube");
		process.exit(1);
	}

	await yt().evaluate(() => document.querySelector("#movie_player")?.playVideo?.());
	await page.waitForTimeout(5000);
	await yt().evaluate(() => document.querySelector("#movie_player")?.mute?.());
	await page.waitForTimeout(2000);
	mostrar(await yt().evaluate(() => window.__todos()), "tocando e mudo:");

	let pegou = null;
	for (let i = 1; i <= RODADAS && !pegou; i++) {
		console.log(`\n=== rodada ${i}: rede cai por ${QUEDA / 1000}s com o vídeo tocando ===`);
		await yt().evaluate(() => {
			const p = document.querySelector("#movie_player");
			p?.playVideo?.();
			p?.mute?.();
		});
		await page.waitForTimeout(3000);

		await ctx.setOffline(true);
		await page.waitForTimeout(QUEDA);
		const durante = mostrar(await yt().evaluate(() => window.__todos()), "com a rede caída:");
		if (sintoma(durante)) pegou = durante;

		await ctx.setOffline(false);
		await page.waitForTimeout(10000);
		const depois = mostrar(await yt().evaluate(() => window.__todos()), "com a rede de volta:");
		if (sintoma(depois)) pegou = depois;
	}

	const linha = await yt().evaluate(() => (window.__linha || []).slice(0, 60));
	console.log(`\n  --- escritas em muted (${linha.length}) ---`);
	for (const e of linha)
		console.log(
			`     +${String(e.ms).padStart(6)}ms  #${e.id} ${e.tipo}  noDom=${e.noDom} pausado=${e.pausado} t=${e.t}\n               ${String(e.pilha).slice(0, 190)}`
		);

	console.log("\n=== veredito ===");
	console.log(
		`  player diz mudo e existe mídia tocando COM som: ${pegou ? "SIM  <-- o sintoma do relato, reproduzido" : "não"}`
	);
	process.exitCode = pegou ? 1 : 0;
} finally {
	await browser.close();
}
