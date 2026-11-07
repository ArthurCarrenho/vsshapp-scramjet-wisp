// O Cloudflare Turnstile resolve pelo motor, e entrega o token à página?
//
// Os alvos são as páginas de demonstração do peet.ws, uma por modo do widget: `non-interactive`,
// `invisible` e `managed` (este mostra a caixinha, e a sonda clica nela). O token aparece no
// `<input name="cf-turnstile-response">` que o widget cria; sem token, a sonda lista os códigos
// `Error: NNNNNN` que o widget lançou.
//
// É a única sonda da bancada que sai para a internet de verdade, e o veredito depende do que o
// Cloudflare acha deste IP e deste navegador. Por isso existe a coluna `BENCH_DIRETO=1`, o mesmo
// Chromium sem o motor e pela mesma saída: só conta contra o motor o que passa no direto.
//
// Com `HTTPS_PROXY` no ambiente (uma sandbox sem saída direta), o wisp abre cada conexão por um
// túnel CONNECT nesse proxy, e o transporte do navegador aceita qualquer certificado, porque o
// proxy reabre o TLS com a CA dele. Sem `HTTPS_PROXY`, o wisp sai direto e o TLS é o do site.
//
// Os três defeitos que esta sonda achou, e onde mora cada conserto:
//   - `window.postMessage()` sem argumento era aceito pelo envelope do motor e entregava uma
//     mensagem com `data` indefinido; o iframe do desafio chama assim de propósito e espera o
//     TypeError (`postmessage.ts`), e sem ele termina em 600010;
//   - `URL.revokeObjectURL("")` lançava `Invalid URL` um segundo depois, fora de qualquer `try`
//     (`blob.ts`), e o desafio termina em 300010;
//   - o `<script>` do `api.js` virava objeto do realm do shell (ver `reino-dos-nos.mjs`).

import { createServer } from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 600000));

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.BENCH_BACKEND || path.join(AQUI, "..", "..", "backend");
const DIRETO = process.env.BENCH_DIRETO === "1";
const VOLTAS = Number(process.env.BENCH_VOLTAS || 2);
const MODOS = (process.env.BENCH_MODOS || "non-interactive,invisible,managed").split(",");
const ESPERA = Number(process.env.BENCH_ESPERA || 20000);
const PROXY = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;

// ─── A saída pelo proxy, quando há um ────────────────────────────────────────────────────────
// O `tcp.js` do backend aceita `conectar` injetado e espera um objeto com a forma de um
// `net.Socket`, que emite `connect` quando a conexão está pronta para dados. Aqui ela fica pronta
// depois do `200` do CONNECT.
class Tunel extends EventEmitter {
	constructor(host, porta) {
		super();
		this.s = net.connect(Number(PROXY.port), PROXY.hostname);
		let acumulado = Buffer.alloc(0);
		let aberto = false;
		this.s.on("connect", () => this.s.write(`CONNECT ${host}:${porta} HTTP/1.1\r\nHost: ${host}:${porta}\r\n\r\n`));
		this.s.on("data", (d) => {
			if (aberto) return void this.emit("data", d);
			acumulado = Buffer.concat([acumulado, d]);
			const fim = acumulado.indexOf("\r\n\r\n");
			if (fim < 0) return;
			if (!/^HTTP\/1\.[01] 200/.test(acumulado.toString("latin1", 0, 16))) return void this.s.destroy();
			aberto = true;
			this.emit("connect");
			if (acumulado.length > fim + 4) this.emit("data", acumulado.subarray(fim + 4));
		});
		for (const ev of ["close", "error", "end"]) this.s.on(ev, (x) => this.emit(ev, x));
	}
	setNoDelay(v) { this.s.setNoDelay(v); }
	setTimeout(ms, cb) { this.s.setTimeout(ms, cb); }
	pause() { this.s.pause(); }
	resume() { this.s.resume(); }
	write(d, cb) { return this.s.write(d, cb); }
	end() { this.s.end(); }
	destroy() { this.s.destroy(); }
}

let TCPSocket = null;
if (PROXY && !DIRETO) {
	const { criarSocketTcp } = await import(pathToFileURL(path.join(BACKEND, "tcp.js")).href);
	// Quem resolve o nome e decide o destino é o proxy; a régua de rede do motor tem bancada própria.
	TCPSocket = criarSocketTcp({
		resolver: async (nome) => nome,
		decidir: () => ({ permitido: true }),
		conectar: ({ host, port }) => new Tunel(host, port),
	});
}

const LER = `JSON.stringify({ token: (document.querySelector('input[name=cf-turnstile-response]') || {}).value || '' })`;

async function clicarNaCaixa(pag) {
	for (let i = 0; i < 20; i++) {
		const f = pag.frames().find((x) => decodeURIComponent(x.url()).includes("challenge-platform"));
		const caixa = f && await (await f.frameElement()).boundingBox();
		if (caixa && caixa.width > 50) {
			await pag.mouse.click(caixa.x + 22, caixa.y + caixa.height / 2);
			return true;
		}
		await pag.waitForTimeout(1000);
	}
	return false;
}

const portal = DIRETO ? null : await subirPortal({ portaSites: 1, TCPSocket });
const navegador = await abrirNavegador(DIRETO && PROXY ? { proxy: { server: PROXY.href } } : {});
const resultado = [];
try {
	for (const modo of MODOS) {
		for (let v = 0; v < VOLTAS; v++) {
			const ctx = await navegador.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
			const pag = await ctx.newPage();
			const erros = new Set();
			const anotar = (t) => { for (const m of String(t).matchAll(/Error: (\d{6})/g)) erros.add(m[1]); };
			pag.on("pageerror", (e) => anotar(e.message));
			pag.on("console", (m) => anotar(m.text()));
			const alvo = `https://peet.ws/turnstile-test/${modo}.html`;
			let ler;
			if (DIRETO) {
				await pag.goto(alvo);
				ler = () => pag.evaluate(LER);
			} else {
				await pag.goto(portal.base, { waitUntil: "load" });
				if (PROXY) await pag.evaluate(() => { window.vsshSettings.scramjetIgnoreSelfSigned = true; });
				const aba = await pag.evaluate(async (a) => { await window.__bancada.iniciar(); return window.__bancada.abrir(a, 30000); }, alvo);
				ler = () => pag.evaluate(([id, e]) => window.__bancada.naAba(id, e), [aba.id, LER]);
			}
			if (modo === "managed") { await pag.waitForTimeout(6000); await clicarNaCaixa(pag); }
			let token = "";
			for (let t = 0; t < ESPERA / 1000 && !token; t++) {
				await pag.waitForTimeout(1000);
				try { token = JSON.parse(await ler()).token; } catch { /* a aba ainda está trocando de documento */ }
			}
			resultado.push({ modo, token: !!token, erros: [...erros] });
			console.log(`${modo} #${v + 1}: ${token ? "token" : "sem token"}${erros.size ? `, erros ${[...erros].join(" ")}` : ""}`);
			await ctx.close();
		}
	}
} finally {
	await navegador.close();
	await portal?.fechar();
}

console.log(`\n=== veredito (${DIRETO ? "direto" : "motor"}) ===`);
const sem = resultado.filter((r) => !r.token);
if (sem.length) {
	console.log(`  ✗ ${sem.length} de ${resultado.length} cargas sem token`);
	process.exitCode = 1;
} else console.log(`  ✓ ${resultado.length} de ${resultado.length} cargas com token`);
