// A exceção de certificado por host: aceitar o certificado de um site não abre os outros.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O transporte do motor (libcurl em WASM) tem uma sessão só para todas as abas. A chave global de
// Configurações desliga a verificação TLS nessa sessão inteira: quem a liga para um servidor de
// desenvolvimento autoassinado abre também o banco e o e-mail sem verificação. A exceção por host
// leva o `insecure` para cada pedido, decidido pelo host da URL (`setInsecureHosts` no transporte,
// `aceitarCertificado` no `ScramjetEngine`). A sonda sobe dois sites HTTPS com o mesmo certificado
// autoassinado, `a.cert.teste` e `b.cert.teste`, aceita só o primeiro, e mede pelos dois lados: o
// que a aba recebe, e o que cada servidor viu chegar.
//
// ─── O que reprova ───────────────────────────────────────────────────────────────────────────
//
//   · antes da exceção, um dos dois abre, ou o erro não é o 60 do libcurl (a verificação);
//   · com a exceção de `a`, `a` não abre, ou `b` abre, ou algum pedido HTTP chega a `b`;
//   · `fetch` de dentro da página de `a` alcança `b`;
//   · esquecida a exceção, `a` volta a abrir: uma conexão aberta sem verificação servindo um
//     pedido que exige verificação.
//
// Com um transporte anterior a `setInsecureHosts`, o motor diz que não aceita certificado por
// host, e a sonda para aí, com código 1.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 180000));

// ─── Os dois sites HTTPS ─────────────────────────────────────────────────────────────────────
//
// Um certificado autoassinado com os dois nomes: a verificação falha pela cadeia, e não pelo
// nome, nos dois. A diferença entre eles é só a exceção.
const pasta = mkdtempSync(path.join(tmpdir(), "bancada-cert-"));
execFileSync("openssl", [
	"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
	"-keyout", path.join(pasta, "chave.pem"), "-out", path.join(pasta, "cert.pem"),
	"-subj", "/CN=a.cert.teste", "-addext", "subjectAltName=DNS:a.cert.teste,DNS:b.cert.teste",
], { stdio: "ignore" });

const chegaram = { a: 0, b: 0 };
const tls = createServer({
	key: readFileSync(path.join(pasta, "chave.pem")),
	cert: readFileSync(path.join(pasta, "cert.pem")),
}, (req, res) => {
	const nome = String(req.headers.host || "").split(".")[0];
	if (nome in chegaram) chegaram[nome]++;
	const u = new URL(req.url, "https://x");
	if (u.pathname === "/ping") {
		res.writeHead(200, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
		return res.end(nome);
	}
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(`<!doctype html><meta charset="utf-8"><title>${nome}</title><body data-marca="certificado-${nome}">${nome}</body>`);
});
await new Promise((ok) => tls.listen(0, "127.0.0.1", ok));
const PT = tls.address().port;
const A = `a.cert.teste:${PT}`;
const B = `b.cert.teste:${PT}`;

const sites  = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();
const pag = await (await navegador.newContext()).newPage();

const falhas = [];
let semCapacidade = false;
try {
	await pag.goto(portal.base, { waitUntil: "load" });
	await pag.evaluate(() => window.__bancada.iniciar());

	// O erro marcado que o controller devolve (`vssh-erro-de-navegacao`), ou a marca do site.
	const ver = (id) => pag.evaluate(async (aba) => {
		const o = window.__bancada.olhar(aba);
		const erro = await window.__bancada.naAba(aba,
			"JSON.parse(document.getElementById('vssh-erro-de-navegacao')?.textContent || 'null')");
		return { marca: o.marca, causa: erro?.causa ?? null, codigo: erro?.codigo ?? null };
	}, id);
	const abrir = async (host, id) => {
		const r = id
			? await pag.evaluate(([aba, url]) => window.__bancada.ir(aba, url, 20000), [id, `https://${host}/`])
			: await pag.evaluate((url) => window.__bancada.abrir(url, 20000), `https://${host}/`);
		return { id: r.id, ...(await ver(r.id)) };
	};
	const linha = (rotulo, r) => console.log(`${rotulo.padEnd(34)} ${(r.marca || "-").padEnd(15)} ${String(r.causa ?? "-").padEnd(6)} ${r.codigo ?? "-"}`);

	console.log(`${"".padEnd(34)} ${"marca".padEnd(15)} ${"causa".padEnd(6)} código`);
	const a0 = await abrir(A);
	const b0 = await abrir(B);
	linha("a, sem exceção", a0);
	linha("b, sem exceção", b0);
	for (const [n, r] of [["a", a0], ["b", b0]]) {
		if (r.marca === `certificado-${n}`) falhas.push(`${n} abriu sem exceção, com o certificado autoassinado`);
		else if (r.codigo !== 60) falhas.push(`${n} falhou com o código ${r.codigo}, e não com o 60 da verificação`);
	}

	const capaz = await pag.evaluate(() => window.BrowserEngines.get("scramjet-wisp").aceitaCertificadoPorHost?.() ?? null);
	if (!capaz) {
		semCapacidade = true;
		throw new Error(capaz === null
			? "o shell não tem aceitaCertificadoPorHost (shell anterior à exceção por host)"
			: "o transporte não tem setInsecureHosts (transporte anterior à exceção por host)");
	}

	chegaram.a = chegaram.b = 0;
	await pag.evaluate((h) => window.BrowserEngines.get("scramjet-wisp").aceitarCertificado(h), A);
	const a1 = await abrir(A, a0.id);
	const b1 = await abrir(B, b0.id);
	linha("a, com a exceção de a", a1);
	linha("b, com a exceção de a", b1);
	if (a1.marca !== "certificado-a") falhas.push(`a não abriu com a exceção: ${JSON.stringify(a1)}`);
	if (b1.marca === "certificado-b") falhas.push("b abriu com a exceção de a");
	else if (b1.codigo !== 60) falhas.push(`b falhou com o código ${b1.codigo}, e não com o 60`);

	// De dentro da página de `a`: vinte pedidos ao próprio host e vinte a `b`.
	const contagem = await pag.evaluate(([aba, a, b]) => window.__bancada.naAba(aba, `(async () => {
		const um = (u) => fetch(u, { cache: 'no-store' }).then((r) => r.ok, () => false);
		const vinte = (h) => Promise.all(Array.from({ length: 20 }, (_, i) => um('https://' + h + '/ping?i=' + i)));
		const [doA, doB] = await Promise.all([vinte(${JSON.stringify(a)}), vinte(${JSON.stringify(b)})]);
		return { a: doA.filter(Boolean).length, b: doB.filter(Boolean).length };
	})()`), [a1.id, A, B]);
	console.log(`\nfetch de dentro de a: ${contagem.a}/20 em a, ${contagem.b}/20 em b`);
	console.log(`pedidos HTTP que chegaram: ${chegaram.a} em a, ${chegaram.b} em b`);
	if (contagem.a !== 20) falhas.push(`${20 - contagem.a} fetch(es) da página de a ao próprio host falharam`);
	if (contagem.b) falhas.push(`${contagem.b} fetch(es) da página de a chegaram a b`);
	if (chegaram.b) falhas.push(`${chegaram.b} pedido(s) HTTP chegaram a b, que não tem exceção`);

	const semVerificacao = await pag.evaluate(([a, b]) => {
		const m = window.BrowserEngines.get("scramjet-wisp");
		return [m.certificadoSemVerificacao(`https://${a}/`), m.certificadoSemVerificacao(`https://${b}/`)];
	}, [A, B]);
	console.log(`certificadoSemVerificacao: a = ${semVerificacao[0]}, b = ${semVerificacao[1]}`);
	if (semVerificacao[0] !== "host" || semVerificacao[1] !== null) falhas.push(`o motor relata ${JSON.stringify(semVerificacao)}, e não ["host", null]`);

	// Esquecida a exceção, as conexões que o transporte abriu sem verificação para `a` continuam no
	// pool. Um pedido que exige verificação não pode sair por elas.
	await pag.evaluate((h) => window.BrowserEngines.get("scramjet-wisp").esquecerCertificado(h), A);
	const a2 = await abrir(A, a1.id);
	console.log();
	linha("a, com a exceção esquecida", a2);
	if (a2.marca === "certificado-a") falhas.push("a abriu depois de a exceção ser esquecida");
} catch (e) {
	falhas.push(`a sonda não chegou ao fim: ${e?.message || e}`);
} finally {
	await navegador.close();
	await portal.fechar();
	await sites.fechar();
	await new Promise((ok) => tls.close(ok));
	rmSync(pasta, { recursive: true, force: true });
}

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  ✗ ${f}`); process.exitCode = 1; }
else console.log("  ✓ a exceção de a abre só a, e esquecê-la volta a exigir o certificado");
if (semCapacidade) console.log("  (controle: sem a capacidade, a sonda não chega à exceção)");
