// A semântica de `addEventListener` continua a da plataforma depois que o motor passou a embrulhar
// também o ouvinte-objeto?
//
// Embrulhar objeto é mais delicado que embrulhar função: um objeto não pode ir para dentro de um
// `Proxy` com armadilha `apply`, então quem vai para a plataforma é uma função que delega — e uma
// função nova por chamada apagaria a identidade que a plataforma usa para deduplicar registro e
// para casar remoção. Este script exercita justamente essas regras, dentro de uma página que
// atravessa o proxy, e compara cada uma com o mesmo código rodando SEM proxy.
//
// ⚠ A suíte do runway não serve para esta comparação nesta máquina: rodando em lote ela devolve
// timeout de 30 s em quase tudo, com a árvore LIMPA, e um mesmo teste passa isolado e falha no lote
// seguinte. Uma medida que muda de resposta entre rodadas não distingue conserto de defeito.

const { chromium, esperarServidor } = await import("./comum.mjs");

const BASE = process.env.BENCH_DEMO || "http://localhost:4141";
const LIMITE = Number(process.env.BENCH_LIMITE || 180000);

const morte = setTimeout(() => {
	console.log(`\n[abortado: estourou ${LIMITE}ms]`);
	process.exit(2);
}, LIMITE);
morte.unref?.();

// Cada caso devolve [descrição, obtido, esperado]. Rodam no MESMO documento, um atrás do outro.
const CASOS = String.raw`
(() => {
	const r = [];
	const conf = (nome, obtido, esperado) => r.push([nome, JSON.stringify(obtido), JSON.stringify(esperado)]);

	// dedup: o mesmo objeto registrado duas vezes é um ouvinte só
	{
		const t = document.createElement("div");
		let n = 0;
		const h = { handleEvent() { n++; } };
		t.addEventListener("x", h);
		t.addEventListener("x", h);
		t.dispatchEvent(new Event("x"));
		conf("objeto registrado 2x dispara 1x", n, 1);
		t.removeEventListener("x", h);
		t.dispatchEvent(new Event("x"));
		conf("objeto removido para de disparar", n, 1);
	}

	// o mesmo, com função — o motor passou a reaproveitar o embrulho também aqui
	{
		const t = document.createElement("div");
		let n = 0;
		const f = () => n++;
		t.addEventListener("x", f);
		t.addEventListener("x", f);
		t.dispatchEvent(new Event("x"));
		conf("função registrada 2x dispara 1x", n, 1);
		t.removeEventListener("x", f);
		t.dispatchEvent(new Event("x"));
		conf("função removida para de disparar", n, 1);
	}

	// late binding: handleEvent é consultado no disparo, não no registro
	{
		const t = document.createElement("div");
		let n = 0;
		const h = {};
		t.addEventListener("x", h);
		t.dispatchEvent(new Event("x"));
		conf("objeto sem handleEvent não dispara nem estoura", n, 0);
		h.handleEvent = () => n++;
		t.dispatchEvent(new Event("x"));
		conf("handleEvent instalado depois passa a valer", n, 1);
		h.handleEvent = "nem função é";
		t.dispatchEvent(new Event("x"));
		conf("handleEvent não-chamável não estoura", n, 1);
	}

	// this dentro de handleEvent é o objeto ouvinte
	{
		const t = document.createElement("div");
		const h = { marca: "meu", vistos: [], handleEvent(e) { this.vistos.push(this.marca + ":" + e.type); } };
		t.addEventListener("x", h);
		t.dispatchEvent(new Event("x"));
		conf("this em handleEvent é o objeto", h.vistos, ["meu:x"]);
	}

	// captura e borbulha são registros distintos, e as duas remoções precisam funcionar
	for (const [rotulo, ouvinte] of [["objeto", null], ["função", null]]) {
		const pai = document.createElement("div");
		const filho = document.createElement("div");
		pai.appendChild(filho);
		document.body.appendChild(pai);
		let n = 0;
		const h = rotulo === "objeto" ? { handleEvent() { n++; } } : () => n++;
		pai.addEventListener("x", h, true);
		pai.addEventListener("x", h, false);
		filho.dispatchEvent(new Event("x", { bubbles: true }));
		conf(rotulo + " nas duas fases dispara 2x", n, 2);
		pai.removeEventListener("x", h, true);
		pai.removeEventListener("x", h, false);
		filho.dispatchEvent(new Event("x", { bubbles: true }));
		conf(rotulo + " sai das duas fases", n, 2);
		pai.remove();
	}

	// once e signal continuam valendo para as duas formas
	{
		const t = document.createElement("div");
		let n = 0;
		t.addEventListener("x", { handleEvent() { n++; } }, { once: true });
		t.dispatchEvent(new Event("x"));
		t.dispatchEvent(new Event("x"));
		conf("objeto com once dispara 1x", n, 1);

		const ac = new AbortController();
		let m = 0;
		t.addEventListener("z", { handleEvent() { m++; } }, { signal: ac.signal });
		t.dispatchEvent(new Event("z"));
		ac.abort();
		t.dispatchEvent(new Event("z"));
		conf("objeto com signal abortado sai", m, 1);
	}

	// ouvinte inválido não pode derrubar o registro
	{
		const t = document.createElement("div");
		let erro = null;
		try {
			t.addEventListener("x", null);
			t.addEventListener("x", undefined);
			t.dispatchEvent(new Event("x"));
		} catch (e) { erro = String(e && e.message || e); }
		conf("ouvinte null/undefined é ignorado sem estourar", erro, null);
	}

	return r;
})();
`;

const browser = await chromium.launch();

const rodar = async (ctx, viaProxy) => {
	const page = await ctx.newPage();
	const erros = [];
	page.on("pageerror", (e) => erros.push(String(e).slice(0, 150)));

	let alvo;
	if (viaProxy) {
		await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });
		const input = await page.waitForSelector(
			'input[type="text"], input:not([type]), input[type="url"], input[type="search"]',
			{ timeout: 20000 }
		);
		await input.fill("https://example.com/");
		await input.press("Enter");
		await page.waitForTimeout(9000);
		alvo = page.frames().find((f) => f !== page.mainFrame() && f.url().includes("example.com"));
		if (!alvo) {
			console.log("não achei o frame proxiado. frames:");
			for (const f of page.frames()) console.log("   " + f.url().slice(0, 120));
			process.exit(1);
		}
	} else {
		await page.goto("https://example.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
		alvo = page.mainFrame();
	}

	const r = await alvo.evaluate(CASOS);
	await page.close();
	return { r, erros };
};

try {
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });

	await esperarServidor(BASE, 15000);
	const semProxy = await rodar(ctx, false);
	const comProxy = await rodar(ctx, true);

	console.log("caso                                              sem proxy   com proxy");
	console.log("─".repeat(78));
	let ruins = 0;
	for (let i = 0; i < comProxy.r.length; i++) {
		const [nome, obtidoProxy, esperado] = comProxy.r[i];
		const obtidoBare = semProxy.r[i] ? semProxy.r[i][1] : "?";
		const okBare = obtidoBare === esperado;
		const okProxy = obtidoProxy === esperado;
		if (!okProxy) ruins++;
		console.log(
			`${nome.padEnd(48)}  ${(okBare ? "ok" : obtidoBare).padEnd(10)}  ${okProxy ? "ok" : `${obtidoProxy} (esperado ${esperado})`}`
		);
	}
	if (comProxy.erros.length) {
		console.log("\n  erros de página no lado proxiado:");
		for (const e of comProxy.erros) console.log("     " + e);
	}
	console.log(
		`\n${ruins === 0 ? "Todas as regras da plataforma se mantêm atravessando o proxy." : `${ruins} caso(s) divergem da plataforma.`}`
	);
	process.exitCode = ruins === 0 ? 0 : 1;
} finally {
	await browser.close();
}
