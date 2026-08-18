// Anexa a sonda de mídia a um navegador JÁ ABERTO, pelo endpoint de depuração remota.
//
// Existe porque o desmute do YouTube relatado por um usuário não reproduz em bancada: nem com abas
// separadas, nem com iframes irmãos, nem forçando queda de rede, nem no arranjo de um controller
// com N frames (ver `yt-desmuta.mjs`, `yt-duas-abas.mjs`, `yt-rede-cai.mjs`, `portal-duas-abas.mjs`).
// O que falta é o ambiente real. Este script não dirige nada — quem reproduz é a pessoa, no portal
// dela, e a sonda só assiste e anota.
//
// O que ela anota, ao vivo:
//   - toda escrita em `video.muted`, com a PILHA de quem escreveu
//   - o estado de TODO elemento de mídia que já existiu, inclusive os que saíram do DOM (um
//     `<video>` órfão continua tocando, e é o candidato a sair audível sem o player saber)
//   - `movie_player.isMuted()` ao lado de `video.muted` — a distinção que o relato faz: o ícone
//     diz mudo, o som sai
//
// COMO USAR
//
// 1. Feche o navegador e abra-o com a porta de depuração e um perfil separado:
//
//      chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\temp\perfil-debug
//      (Edge: msedge.exe, mesmos argumentos)
//
//    ⚠ O `--user-data-dir` NÃO é opcional. Desde o Chrome 136 a depuração remota é recusada no
//    perfil padrão, e o navegador sobe normalmente, sem erro — só sem a porta. É um perfil novo,
//    então vai pedir login no portal de novo.
//
// 2. Abra o portal nesse navegador e chegue até o estado do relato: YouTube tocando, mudo pelo
//    player, e outra aba com algum site.
//
// 3. Rode este script. Ele acha o frame do YouTube sozinho e passa a imprimir.
//
// 4. Só então faça o gesto — atualizar a outra aba. O que aparecer aqui é a resposta.
//
// Se o portal roda num navegador REMOTO (dentro do Xpra, no servidor), traga a porta para cá antes:
//      ssh -L 9222:localhost:9222 <servidor>

const { chromium } = await import("./comum.mjs");

const CDP = process.env.BENCH_CDP || "http://localhost:9222";
const PADRAO_ALVO = process.env.BENCH_PADRAO || "youtube";
const INTERVALO = Number(process.env.BENCH_INTERVALO || 700);
const LIMITE = Number(process.env.BENCH_LIMITE || 1800000); // 30 min de vigília

const morte = setTimeout(() => {
	console.log(`\n[fim da vigília: ${LIMITE / 60000} min]`);
	process.exit(0);
}, LIMITE);
morte.unref?.();

// A sonda é idempotente: pode ser reinjetada em todo frame, a cada varredura, sem duplicar nada.
// Isso importa porque o YouTube troca de frame e cria iframes o tempo todo, e reinjetar é mais
// simples e mais confiável do que tentar acompanhar o ciclo de vida de cada um.
const SONDA = String.raw`
(() => {
	if (window.__sondaVssh) return "ja";
	window.__sondaVssh = true;
	window.__fila = [];
	window.__lidos = 0;
	const t0 = Date.now();
	const reg = (tipo, extra) => { try { window.__fila.push(Object.assign({ ms: Date.now() - t0, tipo }, extra)); } catch {} };

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
				id: idDe(this), noDOM: !this.isConnected, pausado: this.paused,
				t: Math.round(this.currentTime * 10) / 10, vol: this.volume,
				pilha: String(new Error().stack || "").split("\n").slice(1, 7).join(" | "),
			});
			return d.set.call(this, v);
		},
	});

	const vol = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
	Object.defineProperty(HTMLMediaElement.prototype, "volume", {
		configurable: true, enumerable: vol.enumerable,
		get() { return vol.get.call(this); },
		set(v) {
			if (v > 0 && !d.get.call(this)) reg("volume:=" + v, { id: idDe(this), noDOM: !this.isConnected, pausado: this.paused });
			return vol.set.call(this, v);
		},
	});

	for (const m of ["load", "pause", "play"]) {
		const orig = HTMLMediaElement.prototype[m];
		if (typeof orig !== "function") continue;
		HTMLMediaElement.prototype[m] = function (...a) {
			reg("chamou:" + m, { id: idDe(this), muted: d.get.call(this), noDOM: !this.isConnected });
			return orig.apply(this, a);
		};
	}

	const nativo = EventTarget.prototype.addEventListener;
	for (const tipo of ["volumechange", "emptied", "error", "ended", "loadstart", "pause", "play"]) {
		nativo.call(document, tipo, (e) => {
			const el = e.target;
			if (!(el instanceof HTMLMediaElement)) return;
			reg("evento:" + tipo, {
				id: idDe(el), muted: d.get.call(el), pausado: el.paused,
				t: Math.round(el.currentTime * 10) / 10,
			});
		}, true);
	}

	// eventos que atravessam abas — é por onde o YouTube sincroniza volume entre elas
	nativo.call(window, "storage", (e) => {
		reg("storage", { key: String(e.key), novo: String(e.newValue).slice(0, 120) });
	}, true);

	window.__novidades = () => {
		const novos = window.__fila.slice(window.__lidos);
		window.__lidos = window.__fila.length;
		const p = document.querySelector("#movie_player");
		const midias = [];
		for (const ref of vivos) {
			const el = ref.deref();
			if (!el) continue;
			midias.push({
				id: ids.get(el), tag: el.tagName, noDOM: !el.isConnected,
				muted: d.get.call(el), vol: el.volume, pausado: el.paused,
				t: Math.round(el.currentTime * 10) / 10,
				audivel: !d.get.call(el) && !el.paused && el.volume > 0,
			});
		}
		return {
			novos,
			player_isMuted: p && p.isMuted ? p.isMuted() : null,
			player_estado: p && p.getPlayerState ? p.getPlayerState() : null,
			midias,
		};
	};
	return "ok";
})();
`;

console.log(`conectando em ${CDP} …`);
let browser;
try {
	browser = await chromium.connectOverCDP(CDP);
} catch (e) {
	console.log(`\nnão consegui conectar: ${String(e.message || e).slice(0, 200)}`);
	console.log(`
Confira, nesta ordem:
  1. o navegador foi aberto com --remote-debugging-port=9222 E --user-data-dir apontando para uma
     pasta NOVA? Sem o user-data-dir separado o Chrome ignora a porta e sobe normalmente.
  2. http://localhost:9222/json/version responde no navegador?
  3. se o portal roda num navegador remoto, o túnel está de pé?
     ssh -L 9222:localhost:9222 <servidor>`);
	process.exit(1);
}

const contextos = browser.contexts();
const paginas = contextos.flatMap((c) => c.pages());
console.log(`conectado. ${paginas.length} aba(s) aberta(s):`);
for (const [i, p] of paginas.entries()) console.log(`  [${i}] ${p.url().slice(0, 110)}`);

// Injeta em todo frame de toda aba: o alvo pode estar em qualquer uma, e reinjetar é barato.
const injetar = async () => {
	let n = 0;
	for (const c of browser.contexts()) {
		for (const p of c.pages()) {
			for (const f of p.frames()) {
				try {
					if ((await f.evaluate(SONDA)) === "ok") n++;
				} catch {
					// frame morto, cross-origin sem acesso, ou navegando: nada a fazer
				}
			}
		}
	}
	return n;
};

const novas = await injetar();
console.log(`\nsonda instalada (${novas} frame(s) novos).`);
console.log(`vigiando frames que casem com "${PADRAO_ALVO}". Faça o gesto quando quiser — Ctrl+C encerra.\n`);

const rotulo = (f) => {
	const u = f.url();
	try {
		return decodeURIComponent(u).replace(/^.*?(https?:\/\/)/, "$1").slice(0, 60);
	} catch {
		return u.slice(0, 60);
	}
};

let ultimoResumo = "";
for (;;) {
	await injetar();

	for (const c of browser.contexts()) {
		for (const p of c.pages()) {
			for (const f of p.frames()) {
				const u = decodeURIComponent(f.url() || "");
				if (!u.includes(PADRAO_ALVO)) continue;

				let r;
				try {
					r = await f.evaluate(() => window.__novidades && window.__novidades());
				} catch {
					continue;
				}
				if (!r) continue;

				for (const e of r.novos) {
					const extra = [
						e.id !== undefined ? `#${e.id}` : "",
						e.noDOM ? "FORA-DO-DOM" : "",
						e.pausado !== undefined ? `pausado=${e.pausado}` : "",
						e.t !== undefined ? `t=${e.t}` : "",
						e.key !== undefined ? `key=${e.key}` : "",
						e.novo !== undefined ? `novo=${e.novo}` : "",
					].filter(Boolean).join(" ");
					console.log(`[${rotulo(f)}] +${e.ms}ms  ${e.tipo}  ${extra}`);
					if (e.pilha) console.log(`        ${e.pilha.slice(0, 300)}`);
				}

				// O sintoma: o player acha que está mudo e existe mídia tocando com som.
				const audivel = r.midias.find((m) => m.audivel);
				const resumo = `${r.player_isMuted}|${r.midias.map((m) => `${m.id}:${m.muted}:${m.pausado}:${m.noDOM}`).join(",")}`;
				if (resumo !== ultimoResumo) {
					ultimoResumo = resumo;
					console.log(
						`        estado: player.isMuted=${r.player_isMuted} estado=${r.player_estado} | ` +
							r.midias.map((m) => `#${m.id}${m.noDOM ? "(órfão)" : ""} muted=${m.muted} pausado=${m.pausado}`).join("  ")
					);
				}
				if (r.player_isMuted === true && audivel) {
					console.log(`\n>>> SINTOMA: o player diz MUDO e o <${audivel.tag} #${audivel.id}>${audivel.noDOM ? " (FORA DO DOM)" : ""} está tocando COM SOM (vol=${audivel.vol}, t=${audivel.t}).\n`);
				}
			}
		}
	}

	await new Promise((r) => setTimeout(r, INTERVALO));
}
