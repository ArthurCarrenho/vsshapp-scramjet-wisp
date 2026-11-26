// Um alvo aberto pelo motor num Chrome comum, sem CDP e sem flag de automação: o caminho de quem
// usa o navegador. O playwright deixa marcas que um desafio lê (o `navigator.webdriver`, o
// `Runtime.enable` do CDP), e uma rodada por ele não separa o que é do motor do que é da
// automação. Aqui o portal da bancada sobe, o Chrome abre a página dele com `?auto=<alvo>`, e o
// registro de registro-do-desafio.js relata por beacon a cada 3 s.
//
//   ALVO          a página
//   ESPERA        ms com o Chrome aberto (padrão 60000)
//   NETLOG        caminho de um net-log do Chrome, para ler com o mesmo olho de rede-direta.mjs
//   BENCH_CHROME  o binário (padrão google-chrome); numa máquina sem tela, rode sob xvfb-run
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { subirPortal } from "../servidor.mjs";

const ALVO = process.env.ALVO;
if (!ALVO) throw new Error("ALVO é obrigatório");
const ESPERA = Number(process.env.ESPERA || 60000);
const AQUI = path.dirname(fileURLToPath(import.meta.url));

const portal = await subirPortal({ portaSites: 1, apendiceDaApi: "\n" + readFileSync(path.join(AQUI, "registro-do-desafio.js"), "utf8") });
const linhas = [];
const relatos = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { linhas.push(b); res.end(); }); });
await new Promise((ok) => relatos.listen(0, "127.0.0.1", ok));
const relato = `http://127.0.0.1:${relatos.address().port}/r`;
const url = `${portal.base}${portal.base.includes("?") ? "&" : "?"}auto=${encodeURIComponent(ALVO)}&relato=${encodeURIComponent(relato)}`;

const perfil = mkdtempSync(path.join(tmpdir(), "sem-automacao-"));
const chrome = spawn(process.env.BENCH_CHROME || "google-chrome", [
	`--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1366,900",
	...(process.env.NETLOG ? [`--log-net-log=${process.env.NETLOG}`] : []), url,
], { stdio: "ignore" });
await new Promise((ok) => setTimeout(ok, ESPERA));
chrome.kill("SIGTERM");
await new Promise((ok) => setTimeout(ok, 1000));

for (const l of linhas) {
	try {
		const o = JSON.parse(l);
		console.log(o.erro ? `ERRO ${o.erro.slice(0, 300)}` : `${o.s}s ${o.titulo.split(" ; ").join("\n    ")}`);
	} catch { console.log(l.slice(0, 200)); }
}
rmSync(perfil, { recursive: true, force: true });
await portal.fechar();
relatos.close();
process.exit(0);
