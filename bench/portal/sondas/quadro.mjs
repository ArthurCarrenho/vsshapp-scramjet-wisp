// Uma sonda dentro de um quadro, num Chrome direto e pelo motor, e as duas respostas lado a lado.
//
//   ALVO     a página que se abre nas duas colunas
//   PROBE    o arquivo com a expressão que se avalia no quadro (uma das de js/)
//   SAIDA    onde o JSON `{ direto, motor }` é escrito
//   QUADRO   regex sobre a URL decodificada que escolhe o quadro; sem ela, o do Turnstile
//   PRONTO   `cf` (o padrão) espera o `_cf_chl_opt` do desafio; `ja4` espera o corpo do
//            tls.peet.ws com a impressão TLS; `load` só espera o `readyState`
//   MODO     `raw` avalia pelo playwright (no mundo da página, sem o motor reescrever a sonda);
//            `script` a injeta como `<script>` com o nonce da página, e o motor a reescreve como
//            reescreveria o código do site; `fn` passa pelo `Function` da página. O padrão é
//            `raw` no direto e `script` no motor, com `raw` de reserva quando o script falha
//   ATRASO   ms de espera entre o quadro ficar pronto e a sonda rodar
//   PERFIL=1 grava um perfil de CPU do CDP no motor enquanto a sonda roda, e põe as 30 funções
//            com mais amostras próprias em `motor.top`; a coluna direta fica de fora
//
// Cada avaliação tem 4 s de prazo. O quadro do desafio se recarrega sozinho, e uma sonda mais
// longa que isso morre com ele: escreva-as para caber.
import { readFileSync, writeFileSync } from "node:fs";
import { abrirNavegador } from "../navegador.mjs";
import { subirPortal } from "../servidor.mjs";

const ALVO = process.env.ALVO;
const PROBE = readFileSync(process.env.PROBE, "utf8");
const SAIDA = process.env.SAIDA || "quadro.json";
const PERFIL = process.env.PERFIL === "1";
const PRONTO = process.env.PRONTO || "cf";
if (!ALVO) throw new Error("ALVO é obrigatório");

const decodificada = (u) => { try { return decodeURIComponent(decodeURIComponent(u)); } catch { return u; } };
const reQuadro = process.env.QUADRO ? new RegExp(process.env.QUADRO) : /challenges\.cloudflare\.com.*turnstile/i;
const ehAlvo = (u) => reQuadro.test(decodificada(u));

// Roda no quadro. `vssh-desktop/` no caminho é o próprio shell, que casa a regex pela query.
const estaPronto = {
	cf: () => document.readyState === "complete" && !!window._cf_chl_opt && !/vssh-desktop\/$/.test(location.pathname),
	ja4: () => document.readyState === "complete" && !!document.body && /ja4/.test(document.body.innerText) && !/vssh-desktop\/$/.test(location.pathname),
	load: () => document.readyState === "complete" && !/vssh-desktop\/$/.test(location.pathname),
}[PRONTO];

function injetar(src) {
	return new Promise((ok) => {
		try {
			const s = document.createElement("script");
			const nonce = [...document.scripts].map((x) => x.nonce).find(Boolean);
			if (nonce) s.nonce = nonce;
			s.textContent = "window.__fpP=" + src + ".then(r=>window.__fpR=r,e=>window.__fpR={erro:String(e&&e.stack||e)})";
			document.body.appendChild(s);
		} catch (e) { ok({ erro: "inj " + e }); return; }
		let n = 0;
		const t = setInterval(() => { if (window.__fpR || ++n > 40) { clearInterval(t); ok(window.__fpR || { erro: "sem resultado" }); } }, 50);
	});
}

const prazo = (ms, valor) => new Promise((ok) => setTimeout(() => ok(valor), ms));

async function noQuadro(page, modo, antes) {
	for (let i = 0; i < 80; i++) {
		for (const f of page.frames()) {
			if (!ehAlvo(f.url())) continue;
			try {
				if (!(await Promise.race([f.evaluate(estaPronto), prazo(800, false)]))) continue;
				await page.waitForTimeout(Number(process.env.ATRASO || 0));
				if (antes) await antes();
				const r = await Promise.race([
					modo === "script" ? f.evaluate(injetar, PROBE)
						: modo === "fn" ? f.evaluate((src) => Function("return " + src)(), PROBE)
						: f.evaluate(PROBE),
					prazo(4000, null),
				]);
				if (r) return { url: f.url().slice(0, 200), r };
			} catch { /* o quadro se recarregou no meio: tenta o próximo */ }
		}
		await page.waitForTimeout(150);
	}
	return null;
}

const nav = await abrirNavegador({ args: ["--no-sandbox"] });
const viewport = { width: 1280, height: 900 };

let direto = null;
if (!PERFIL) {
	const p1 = await (await nav.newContext({ viewport })).newPage();
	p1.goto(ALVO).catch(() => {});
	direto = await noQuadro(p1, process.env.MODO || "raw");
}

const c2 = await nav.newContext({ viewport });
const p2 = await c2.newPage();
const portal = await subirPortal({ portaSites: 1 });
await p2.goto(portal.base, { waitUntil: "load" });
p2.evaluate(async (u) => { await window.__bancada.iniciar(); return window.__bancada.abrir(u, 30000); }, ALVO).catch(() => {});

let motor;
if (PERFIL) {
	const cdp = await c2.newCDPSession(p2);
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 50 });
	const achado = await noQuadro(p2, "raw", () => cdp.send("Profiler.start"));
	const { profile } = await cdp.send("Profiler.stop");
	const porNo = new Map(profile.nodes.map((n) => [n.id, n]));
	const amostras = new Map();
	for (const s of profile.samples) amostras.set(s, (amostras.get(s) || 0) + 1);
	const proprio = new Map();
	for (const [id, c] of amostras) {
		const f = porNo.get(id).callFrame;
		const k = `${f.functionName || "(anon)"} ${String(f.url).split("/").pop().slice(0, 40)}:${f.lineNumber}:${f.columnNumber}`;
		proprio.set(k, (proprio.get(k) || 0) + c);
	}
	const total = profile.samples.length;
	motor = { r: achado && achado.r, top: [...proprio].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, c]) => `${(100 * c / total).toFixed(1)}% ${k}`) };
} else {
	motor = await noQuadro(p2, process.env.MODO || "script");
	if (!motor || motor.r.erro) motor = { script: motor, ...((await noQuadro(p2, "raw")) || {}), cru: true };
}

writeFileSync(SAIDA, JSON.stringify({ direto, motor }));
console.log("direto", !!direto, "motor", !!motor, motor && motor.cru ? "(cru)" : "");
await nav.close();
await portal.fechar();
process.exit(0);
