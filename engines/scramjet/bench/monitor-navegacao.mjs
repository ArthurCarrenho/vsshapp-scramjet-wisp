// Observa, ao vivo e sem tocar em nada, o que acontece quando uma aba do navegador embutido navega.
//
// A pergunta que ele responde tem só duas respostas possíveis, e elas pedem consertos diferentes:
//
//   A) a requisição de navegação NUNCA aparece, ou aparece e volta com a SPA do portal
//      → o service worker não está interceptando; o cliente está fora do escopo dele
//
//   B) a requisição aparece e fica PENDENTE para sempre
//      → o service worker interceptou e está esperando o Controller responder numa porta morta
//        (`route()` chama `tab.rpc.call("request", …)`; se ninguém responde, a promessa nunca
//        resolve e a navegação pendura — sem erro, sem timeout, sem nada na tela)
//
// Distinguir as duas exige ter a rede sob observação ANTES do gesto, que é o que este script faz:
// ele fica ligado e imprime cada requisição, com o tempo que ela leva ou o tempo que já está
// pendurada. Quem faz o gesto é a pessoa.

const { chromium } = await import("./comum.mjs");

const CDP = process.env.BENCH_CDP || "http://localhost:9222";
const PADRAO = process.env.BENCH_PADRAO || "vssh-desktop";
const LIMITE = Number(process.env.BENCH_LIMITE || 1800000);

const morte = setTimeout(() => {
	console.log(`\n[fim da vigília]`);
	process.exit(0);
}, LIMITE);
morte.unref?.();

const browser = await chromium.connectOverCDP(CDP);
const paginas = browser.contexts().flatMap((c) => c.pages());
const p = paginas.find((x) => x.url().includes(PADRAO));
if (!p) {
	console.log(`não achei aba casando com "${PADRAO}". abertas:`);
	for (const x of paginas) console.log("   " + x.url().slice(0, 110));
	process.exit(1);
}

const curto = (u) => {
	try {
		u = decodeURIComponent(u);
	} catch {}
	// o que interessa é o alvo lógico, não o prefixo do proxy
	const m = /https?:\/\/[^/]+\/.*?\/~s?j?\/[^/]+\/[^/]+\/(.*)$/.exec(u);
	return (m ? "→ " + m[1] : u).slice(0, 105);
};

const emVoo = new Map();
let n = 0;

p.on("request", (r) => {
	const t = Date.now();
	emVoo.set(r, { t, url: r.url(), tipo: r.resourceType() });
	if (r.resourceType() === "document") console.log(`\n[${++n}] NAVEGAÇÃO iniciada  ${curto(r.url())}`);
});
p.on("response", (r) => {
	const v = emVoo.get(r.request());
	if (!v) return;
	if (v.tipo !== "document") return;
	console.log(`     └ respondeu ${r.status()} em ${Date.now() - v.t}ms   ${r.headers()["content-type"] || ""}`);
	r.text()
		.then((t) => {
			const ehPortal = /VSSH-SSO — Portal|screen-login/i.test(t);
			console.log(
				`       corpo: ${t.length} bytes${ehPortal ? "   *** É A SPA DO PORTAL — o service worker NÃO interceptou ***" : ""}`
			);
		})
		.catch(() => {});
});
p.on("requestfinished", (r) => emVoo.delete(r));
p.on("requestfailed", (r) => {
	const v = emVoo.get(r);
	if (v?.tipo === "document") console.log(`     └ FALHOU: ${r.failure()?.errorText}`);
	emVoo.delete(r);
});
p.on("framenavigated", (f) => {
	if (f.parentFrame()) console.log(`     └ frame agora em: ${curto(f.url())}`);
});

console.log(`monitorando ${p.url().slice(0, 80)}`);
console.log("pode fazer o gesto — cada navegação aparece aqui, com o tempo.\n");

// Denuncia o que está pendurado. É a metade B do diagnóstico: uma navegação que passa de alguns
// segundos sem resposta não está lenta, está esperando alguém que não vai responder.
for (;;) {
	await new Promise((r) => setTimeout(r, 5000));
	const agora = Date.now();
	const velhas = [...emVoo.values()].filter((v) => agora - v.t > 5000);
	if (velhas.length) {
		console.log(`  ── ${velhas.length} requisição(ões) pendurada(s):`);
		for (const v of velhas.slice(0, 8))
			console.log(`     ${String(Math.round((agora - v.t) / 1000)).padStart(4)}s  ${v.tipo.padEnd(9)} ${curto(v.url)}`);
	}
}
