// Os cabeçalhos que um Chrome comum manda, lidos do net-log dele. É a coluna de referência para o
// que o motor manda pelo transporte (o registro de sem-automacao.mjs e cabecalhos.mjs).
//
// O Chrome sobe sem CDP e sem flag de automação, com perfil novo, abre ALVO e fecha depois de
// ESPERA ms. Sai uma linha por combinação distinta de método, destino, modo, prioridade, host e
// caminho, e, para os hosts do desafio, a lista dos cabeçalhos em ordem. `cookie` sai só como nome.
//
//   ALVO         a página
//   FILTRO       regex dos hosts que interessam (padrão: tandfonline|cloudflare)
//   ESPERA       ms com o Chrome aberto (padrão 45000)
//   BENCH_CHROME o binário (padrão google-chrome); numa máquina sem tela, rode sob xvfb-run
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ALVO = process.env.ALVO;
if (!ALVO) throw new Error("ALVO é obrigatório");
const FILTRO = new RegExp(process.env.FILTRO || "tandfonline|cloudflare");
const ESPERA = Number(process.env.ESPERA || 45000);

const perfil = mkdtempSync(path.join(tmpdir(), "rede-direta-"));
const log = path.join(perfil, "net.json");
const chrome = spawn(process.env.BENCH_CHROME || "google-chrome", [
	`--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
	"--window-size=1366,900", `--log-net-log=${log}`, "--net-log-capture-mode=IncludeSensitive", ALVO,
], { stdio: "ignore" });
await new Promise((ok) => setTimeout(ok, ESPERA));
chrome.kill("SIGTERM");
await new Promise((ok) => setTimeout(ok, 3000));

// O Chrome morto pelo sinal pode deixar o JSON sem o fecho, e às vezes com um evento pela metade.
let txt = readFileSync(log, "utf8").trim();
if (!txt.endsWith("]}")) {
	txt = txt.replace(/,?\s*$/, "");
	try { JSON.parse(txt + "]}"); } catch { txt = txt.slice(0, txt.lastIndexOf("\n{")).replace(/,\s*$/, ""); }
	txt += "]}";
}
const d = JSON.parse(txt);
const tipos = Object.fromEntries(Object.entries(d.constants.logEventTypes).map(([k, v]) => [v, k]));
const vistos = new Set();
for (const e of d.events) {
	const t = tipos[e.type];
	const p = e.params || {};
	if (!/HTTP_TRANSACTION_(QUIC_|HTTP2_)?SEND_REQUEST_HEADERS/.test(t) || !p.headers) continue;
	const h = Array.isArray(p.headers) ? p.headers.map(String) : Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`);
	const g = (n) => (h.find((x) => x.toLowerCase().startsWith(n + ":")) || "").slice(n.length + 1).trim();
	const host = g(":authority") || (p.line || "").split(" ")[1] || "";
	if (!FILTRO.test(host)) continue;
	const caminho = g(":path").split("?")[0].replace(/(challenge-platform\/h\/\w\/\w+)\/.*/, "$1").slice(0, 70);
	const linha = `${g(":method")} ${g("sec-fetch-dest")} ${g("sec-fetch-mode")} pri=[${g("priority")}] ${host.slice(0, 30)}${caminho} ${t.includes("QUIC") ? "h3" : "h2"}`;
	if (!vistos.has(linha)) { vistos.add(linha); console.log(linha); }
	const chave = "H" + host + caminho + g(":method");
	if (/challenges/.test(host) && !vistos.has(chave)) {
		vistos.add(chave);
		console.log("    ", h.filter((x) => !/^:(path|authority|scheme)/.test(x)).map((x) => /^cookie/i.test(x) ? "cookie" : x.slice(0, 60)).join(" | "));
	}
}
rmSync(perfil, { recursive: true, force: true });
