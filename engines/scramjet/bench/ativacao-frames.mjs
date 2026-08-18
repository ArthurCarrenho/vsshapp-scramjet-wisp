// O gesto do usuário numa aba vale como gesto na OUTRA aba?
//
// No portal, cada aba do navegador embutido é um `<iframe>` do MESMO controller, na MESMA página
// (`controller.createFrame(elemento)`). Todos carregam do proxy, então todos têm a MESMA origem
// real — as origens lógicas (youtube.com, exemplo.com) só existem depois da reescrita.
//
// Isso importa porque a ativação de usuário do HTML não é por frame: um gesto marca o documento
// que recebeu o evento E todo documento same-origin da mesma árvore de frames. Num navegador
// normal isso é inofensivo, porque abas de sites diferentes são origens diferentes. Sob o proxy
// deixam de ser, e um clique numa aba passa a valer como gesto em todas as outras.
//
// Quem depende disso: autoplay COM SOM, popup, fullscreen, clipboard. Para um vídeo que está mudo
// à espera de um gesto para reativar o som, é exatamente o gatilho relatado.
//
// ⚠ `navigator.userActivation` NÃO serve de medida aqui: sob automação o chromium já entrega
// `hasBeenActive` e `isActive` verdadeiros em todo frame, mesmo sem clique nenhum e mesmo entre
// origens diferentes — a primeira versão deste script mediu isso e "reproduziu" o vazamento nos
// dois arranjos, que é o mesmo que não medir nada. O que se mede aqui é o EFEITO: com
// `--autoplay-policy=document-user-activation-required`, tocar áudio e ligar um AudioContext só
// funcionam com ativação. Se o frame A consegue tocar som depois de um clique que aconteceu em B,
// o gesto atravessou.

import http from "node:http";

const { chromium } = await import("./comum.mjs");

const PORTA = Number(process.env.BENCH_PORTA || 5233);
const LIMITE = Number(process.env.BENCH_LIMITE || 120000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

// WAV de 0,1 s em silêncio: pequeno o bastante para caber num data: URI e suficiente para que o
// chromium aplique a política de autoplay (um <audio> sem trilha nenhuma seria liberado).
const WAV =
	"data:audio/wav;base64,UklGRiQEAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAEAAA=" +
	"A".repeat(0);

const FILHO = (r) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font:14px sans-serif">
<div id="alvo" style="height:100px;background:#eee">filho ${r}</div>
<script>
window.__rotulo = ${JSON.stringify(r)};
window.__sonda = async () => {
	const out = { rotulo: window.__rotulo, origem: location.origin };
	// 1) áudio com som: a política de autoplay rejeita sem ativação
	try {
		const a = new Audio(${JSON.stringify(WAV)});
		a.volume = 1; a.muted = false;
		await a.play();
		out.tocou = true;
		a.pause();
	} catch (e) {
		out.tocou = false;
		out.erroAudio = String(e && e.name || e);
	}
	// 2) AudioContext: nasce "suspended" sem ativação, "running" com ela
	try {
		const ctx = new (window.AudioContext || window.webkitAudioContext)();
		out.audioContext = ctx.state;
		ctx.close();
	} catch (e) {
		out.audioContext = "erro:" + String(e && e.name || e);
	}
	return out;
};
</script></body></html>`;

const PAI = (a, b) => `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<iframe id="A" src="${a}" style="width:400px;height:120px;border:2px solid #39f"></iframe>
<iframe id="B" src="${b}" style="width:400px;height:120px;border:2px solid #f93"></iframe>
</body></html>`;

const servidor = http.createServer((req, res) => {
	const u = new URL(req.url, "http://x");
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
	if (u.pathname === "/filho") return res.end(FILHO(u.searchParams.get("r") || "?"));
	if (u.pathname === "/pai-diferentes")
		return res.end(PAI(`http://localhost:${PORTA}/filho?r=A`, `http://127.0.0.1:${PORTA}/filho?r=B`));
	return res.end(PAI(`http://localhost:${PORTA}/filho?r=A`, `http://localhost:${PORTA}/filho?r=B`));
});
await new Promise((r) => servidor.listen(PORTA, r));

// ⚠ O playwright injeta `--autoplay-policy=no-user-gesture-required` nos args PADRÃO dele. Passar
// a política restritiva em `args` não adianta: a permissiva continua na linha de comando e o
// autoplay é liberado em todo frame — foi o que fez a rodada anterior devolver `tocou=true` em
// todos os quadrantes. É preciso remover o argumento padrão por nome, não só acrescentar o nosso.
const browser = await chromium.launch({
	ignoreDefaultArgs: ["--autoplay-policy=no-user-gesture-required"],
	args: ["--autoplay-policy=document-user-activation-required"],
});

const medir = async (page) => {
	const out = {};
	for (const nome of ["A", "B"]) {
		const f = await (await page.$(`#${nome}`)).contentFrame();
		out[nome] = await f.evaluate(() => window.__sonda());
	}
	return out;
};

const linha = (m) => `tocou=${m.tocou}${m.erroAudio ? `(${m.erroAudio})` : ""} audioContext=${m.audioContext}`;

const rodar = async (ctx, caminho, rotulo) => {
	const page = await ctx.newPage();
	await page.goto(`http://localhost:${PORTA}${caminho}`, { waitUntil: "load", timeout: 20000 });
	await page.waitForTimeout(500);

	const antes = await medir(page);
	console.log(`\n=== ${rotulo} ===`);
	console.log(`  A em ${antes.A.origem}   B em ${antes.B.origem}`);
	console.log(`  antes de qualquer clique:   A: ${linha(antes.A)}`);
	console.log(`                              B: ${linha(antes.B)}`);

	// clique real de ponteiro DENTRO do frame B (element.click() não conta como gesto do usuário)
	const caixa = await (await page.$("#B")).boundingBox();
	await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2);
	await page.mouse.down();
	await page.mouse.up();
	await page.waitForTimeout(300);

	const depois = await medir(page);
	console.log(`  depois do clique SÓ EM B:   A: ${linha(depois.A)}`);
	console.log(`                              B: ${linha(depois.B)}`);
	await page.close();
	return { antes, depois };
};

try {
	const ctx = await browser.newContext({ viewport: { width: 900, height: 400 } });

	const dif = await rodar(ctx, "/pai-diferentes", "ORIGENS DIFERENTES (navegador normal: cada aba é um site)");
	const mes = await rodar(ctx, "/pai-mesma", "MESMA ORIGEM (o que o proxy produz: toda aba é o mesmo site)");

	const ganhou = (r) => !r.antes.A.tocou && r.depois.A.tocou;
	console.log("\n=== veredito ===");
	console.log(`  origens diferentes: o clique em B deu som ao A? ${ganhou(dif) ? "SIM" : "não  <- isolado, correto"}`);
	console.log(`  MESMA origem:       o clique em B deu som ao A? ${ganhou(mes) ? "SIM  <- o gesto vazou para a outra aba" : "não"}`);
	const vaza = !ganhou(dif) && ganhou(mes);
	// ⚠ INCONCLUSIVO não é o mesmo que "está tudo certo". Se as duas linhas acima derem "não", o
	// mais provável NÃO é que o gesto não atravessa — é que este chromium liberou autoplay nos dois
	// arranjos e a medida não chegou a testar nada. É o que acontece em headless até hoje: mesmo
	// removendo o `--autoplay-policy` permissivo dos args padrão, `a.play()` resolve em todo frame.
	// Para valer, este script precisa primeiro mostrar `tocou=false` no A antes do clique.
	const mediuAlgo = !dif.antes.A.tocou || !mes.antes.A.tocou;
	console.log(
		`\n  ${
			vaza
				? "O colapso de origem que o proxy faz transfere gesto do usuário entre abas."
				: mediuAlgo
					? "Os dois arranjos se comportam igual — o gesto NÃO atravessou."
					: "INCONCLUSIVO: este navegador liberou som sem gesto nenhum, então a política de autoplay não chegou a ser exercida. Nada aqui pode ser lido como ausência do vazamento."
		}`
	);
	process.exitCode = vaza || !mediuAlgo ? 1 : 0;
} finally {
	await browser.close();
	servidor.close();
}
