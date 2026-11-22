// O que um site recebe da página: os cabeçalhos pelo motor, ao lado dos de um Chrome direto.
//
// ─── A pergunta ──────────────────────────────────────────────────────────────────────────────
//
// O pedido de uma página proxiada sai do libcurl, na estação, e não da pilha de rede do Chrome.
// O que o Chrome acrescenta depois do service worker (`Accept-Language`, as dicas `Sec-CH-UA*`, o
// `Accept-Encoding` dele) não passa pelo motor, e um desafio anti-robô compara esses cabeçalhos com
// o que o JS da página diz de si. A sonda sobe um site HTTPS que ecoa os cabeçalhos de quatro
// pedidos (o documento, um `fetch`, um POST, uma imagem e um script), abre o site pelo motor e por um Chrome
// sem o motor, e mostra, pedido a pedido, o nome que um mandou e o outro não, e os valores que
// divergem nos cabeçalhos que identificam o navegador.
//
// A mesma sonda lê o certificado do site pelo shell (`certificadoDe`), que é o caminho da folha do
// certificado do painel do site: o transporte lê a cadeia, e o shell a descreve.
//
// ─── O que reprova ───────────────────────────────────────────────────────────────────────────
//
//   · um cabeçalho de identidade (`Origin`, `User-Agent`, `Accept-Language`, `Sec-CH-UA*`, `Sec-Fetch-*`)
//     que o Chrome manda e o motor não, ou com outro valor;
//   · o `certificadoDe` não devolve a cadeia, ou a devolve verificada (o certificado é
//     autoassinado), ou com outro motivo que não `net::ERR_CERT_AUTHORITY_INVALID`.
//
// Os outros nomes (`Accept-Encoding`, `Priority`, `Cache-Control`...) aparecem na tabela e não
// reprovam: a diferença existe, e é para ser lida.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { prazoDeMorte } from "../comum.mjs";
import { abrirNavegador } from "./navegador.mjs";
import { subirSites } from "./sites.mjs";
import { subirPortal } from "./servidor.mjs";

prazoDeMorte(Number(process.env.BENCH_LIMITE || 180000));

const pasta = mkdtempSync(path.join(tmpdir(), "bancada-cab-"));
execFileSync("openssl", [
	"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
	"-keyout", path.join(pasta, "chave.pem"), "-out", path.join(pasta, "cert.pem"),
	"-subj", "/CN=eco.teste/O=Bancada", "-addext", "subjectAltName=DNS:eco.teste",
], { stdio: "ignore" });

// O registro do que chegou, por rodada (`motor` ou `direto`) e por pedido.
const chegou = { motor: {}, direto: {} };
let rodada = "motor";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const eco = (req, res) => {
	const u = new URL(req.url, "https://eco.teste");
	const nome = u.pathname.slice(1) || "documento";
	// O primeiro de cada nome: o `certificadoDe` pede a raiz de novo, pelo transporte cru.
	chegou[rodada][nome] ??= req.headers;
	if (nome === "imagem") { res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" }); return res.end(GIF); }
	if (nome === "script") { res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" }); return res.end("window.__scriptRodou = true;"); }
	if (nome === "fetch" || nome === "post") { res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); return res.end("ok"); }
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
	res.end(`<!doctype html><meta charset="utf-8"><title>eco</title><body data-marca="eco">
		<img src="/imagem"><script src="/script"></script>
		<script>window.__pronto = Promise.all([fetch('/fetch', { cache: 'no-store' }).then((r) => r.text()),
		  fetch('/post', { method: 'POST', body: 'x', cache: 'no-store' }).then((r) => r.text())]);</script></body>`);
};
const tls = createServer({
	key: readFileSync(path.join(pasta, "chave.pem")),
	cert: readFileSync(path.join(pasta, "cert.pem")),
}, eco);
// O lado direto vai ao mesmo eco em `http://localhost`, que o Chrome trata como origem confiável e
// para a qual manda os mesmos `Sec-Fetch-*` e `Sec-CH-UA`: o Chromium da bancada recusa o
// certificado autoassinado mesmo com `--ignore-certificate-errors`.
const claro = createHttpServer(eco);
await new Promise((ok) => claro.listen(0, "127.0.0.1", ok));
await new Promise((ok) => tls.listen(0, "127.0.0.1", ok));
const HOST = `eco.teste:${tls.address().port}`;

const sites = await subirSites();
const portal = await subirPortal({ portaSites: sites.porta });
const navegador = await abrirNavegador();
const falhas = [];

// ── Pelo motor ──────────────────────────────────────────────────────────────────────────────
const pag = await (await navegador.newContext()).newPage();
await pag.goto(portal.base, { waitUntil: "load" });
await pag.evaluate(() => window.__bancada.iniciar());
await pag.evaluate((h) => window.BrowserEngines.get("scramjet-wisp").aceitarCertificado(h), HOST);
const aba = await pag.evaluate((url) => window.__bancada.abrir(url, 20000), `https://${HOST}/`);
await pag.evaluate((id) => window.__bancada.naAba(id, "window.__pronto"), aba.id).catch(() => {});
await pag.waitForTimeout(500);
const identidade = await pag.evaluate(() => ({ ua: navigator.userAgent, linguas: navigator.languages }));
const cert = await pag.evaluate((url) => window.BrowserEngines.get("scramjet-wisp").certificadoDe?.(url) ?? "sem certificadoDe", `https://${HOST}/`);

// ── Direto, sem o motor ─────────────────────────────────────────────────────────────────────
rodada = "direto";
const navDireto = await abrirNavegador({ args: ["--no-proxy-server"] });
const pd2 = await (await navDireto.newContext()).newPage();
await pd2.goto(`http://localhost:${claro.address().port}/`, { waitUntil: "load" });
await pd2.evaluate(() => window.__pronto).catch(() => {});
await pd2.waitForTimeout(500);

// ── A comparação ────────────────────────────────────────────────────────────────────────────
const IDENTIDADE = ["origin", "user-agent", "accept-language", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
	"sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"];
console.log(`navigator.userAgent: ${identidade.ua}`);
console.log(`navigator.languages: ${identidade.linguas.join(", ")}\n`);
for (const pedido of ["documento", "fetch", "post", "imagem", "script"]) {
	const m = chegou.motor[pedido], d = chegou.direto[pedido];
	console.log(`── ${pedido}`);
	if (!m || !d) { console.log(`   não chegou: ${!m ? "pelo motor " : ""}${!d ? "direto" : ""}`); falhas.push(`${pedido} não chegou`); continue; }
	const nomes = [...new Set([...Object.keys(m), ...Object.keys(d)])].filter((n) => n !== "host" && n !== "cookie").sort();
	// O endereço do site difere entre os lados (`https://eco.teste:<porta>` e `http://localhost:<porta>`),
	// e o que se compara em `Origin` e `Referer` é a presença e a forma.
	const site = (v, base) => (v === undefined ? v : String(v).split(base).join("<site>"));
	for (const n of nomes) {
		const vm = site(m[n], `https://${HOST}`), vd = site(d[n], `http://localhost:${claro.address().port}`);
		if (vm === vd) continue;
		const marca = vm === undefined ? "só direto " : vd === undefined ? "só motor  " : "diferente ";
		console.log(`   ${marca} ${n.padEnd(22)} motor=${vm ?? "-"}  direto=${vd ?? "-"}`);
		if (IDENTIDADE.includes(n) && vd !== undefined) falhas.push(`${pedido}: ${n} ${vm === undefined ? "falta pelo motor" : `difere (${vm} × ${vd})`}`);
	}
}

console.log("\n── certificadoDe");
if (!cert || typeof cert !== "object" || !cert.cadeia?.length) {
	console.log(`   ${JSON.stringify(cert)}`);
	falhas.push("certificadoDe não devolveu a cadeia");
} else {
	const f = cert.cadeia[0];
	console.log(`   verificado=${cert.verificado} motivo=${cert.motivo} protocolo=${cert.protocolo} cifra=${cert.cifra}`);
	console.log(`   folha: ${f.assunto.cn} / ${f.assunto.o}, emissor ${f.emissor.cn}, chave ${f.chave}, nomes ${f.nomes.join(" ")}`);
	if (cert.verificado) falhas.push("o certificado autoassinado saiu verificado");
	if (cert.motivo !== "net::ERR_CERT_AUTHORITY_INVALID") falhas.push(`motivo ${cert.motivo}`);
	if (f.assunto.cn !== "eco.teste" || !f.nomes.includes("eco.teste")) falhas.push("a folha não é a do site");
}

console.log("\n=== veredito ===");
if (falhas.length) { for (const f of falhas) console.log(`  · ${f}`); process.exitCode = 1; }
else console.log("  o site recebe do motor os mesmos cabeçalhos de identidade que do Chrome, e o certificado chega ao shell");
await navDireto.close();
await navegador.close();
await portal.fechar?.();
await sites.fechar?.();
tls.close();
claro.close();
