// `sampi.net.br` monta dois carrosséis Glide no `$(document).ready`, e dentro do ambiente isso
// quebrava com `Root element must be a existing Html node` seguido de
// `TypeError: Cannot read properties of undefined (reading 'querySelector')`.
//
// Medido antes de vir para cá: num Chromium LIMPO a página não dá erro nenhum — nem com os mesmos
// hosts de anúncio bloqueados. Os dois elementos (`#glideOpiniao`, `#glideOpiniao2`) existem, o
// `#glideOpiniao3` não existe e o `$glide3` nunca é montado. Ou seja: o defeito aparece só com o
// motor no meio, e é isso que este script isola — scramjet local, sem a camada do portal.
//
// O que ele mede, no frame proxiado:
//   • os três `#glideOpiniao*` existem?
//   • `document.querySelector` devolve o mesmo que `getElementById`?
//   • o que o console e os `pageerror` do frame disseram
//
// A pergunta que ele responde é "quem sumiu com o elemento": se os ids existem no HTML servido mas
// `querySelector` não os acha, o problema é no caminho de consulta; se nem existem, é o rewriter
// ou o parse.

import { chromium, esperarServidor, prazoDeMorte } from "./comum.mjs";

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const ALVO = process.env.BENCH_ALVO || "https://sampi.net.br/franca";
const ESPERA = Number(process.env.BENCH_ESPERA || 12000);

prazoDeMorte(Number(process.env.BENCH_LIMITE || 180000));

await esperarServidor(BASE, 20000);
const browser = await chromium.launch();

try {
	const ctx = await browser.newContext({
		viewport: { width: 1400, height: 900 },
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
	});
	const page = await ctx.newPage();

	const falas = [];
	page.on("console", (m) => {
		if (m.type() !== "error" && m.type() !== "warning") return;
		falas.push(`[${m.type()}] ${m.text().slice(0, 220)}`);
	});
	page.on("pageerror", (e) => falas.push(`[pageerror] ${String(e).slice(0, 220)}`));

	await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
	const input = await page.waitForSelector(
		'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
		{ timeout: 20000 }
	);
	await input.fill(ALVO);
	await input.press("Enter");
	await page.waitForTimeout(ESPERA);

	const frame = page.frames().find((f) => f !== page.mainFrame() && /sampi/i.test(f.url()));
	if (!frame) {
		console.log("não achei o frame proxiado. frames:");
		for (const f of page.frames()) console.log("   " + f.url().slice(0, 140));
	} else {
		const r = await frame.evaluate(() => {
			const ids = ["glideOpiniao", "glideOpiniao2", "glideOpiniao3"];
			const porId = {};
			const porSeletor = {};
			for (const id of ids) {
				porId[id] = !!document.getElementById(id);
				porSeletor[id] = !!document.querySelector("#" + id);
			}

			return {
				porId,
				porSeletor,
				// Quantos `.glide` o HTML entregou, para separar "sumiu o id" de "sumiu o bloco".
				blocosGlide: document.querySelectorAll(".glide").length,
				slides: document.querySelectorAll(".glide__slide").length,
				tipoGlide: typeof window.$glide,
				tipoGlide3: typeof window.$glide3,
				// O `mount()` guarda a raiz aqui quando dá certo.
				raizDoGlide: (() => {
					try { return String(window.$glide?._c?.Html?.root?.id ?? ""); } catch { return "?"; }
				})(),
				titulo: document.title.slice(0, 80),
			};
		});
		console.log(`=== ${ALVO} pelo scramjet local ===`);
		console.log(JSON.stringify(r, null, 2));
	}

	console.log(`--- console do navegador (${falas.length}) ---`);
	for (const f of falas) console.log(f);
} finally {
	await browser.close();
}
