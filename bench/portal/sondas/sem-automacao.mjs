// Um alvo aberto pelo motor num Chrome comum, sem CDP e sem flag de automação: o caminho de quem
// usa o navegador. O playwright deixa marcas que um desafio lê (o `navigator.webdriver`, o
// `Runtime.enable` do CDP), e uma rodada por ele não separa o que é do motor do que é da
// automação. Aqui o portal da bancada sobe, o Chrome abre a página dele com `?auto=<alvo>`, e o
// registro de registro-do-desafio.js relata por beacon a cada 2 s. É esta sonda que dá o veredito:
// `"event":"complete"` e `NAV push form=true` quando o desafio passa, `"event":"fail"` e
// `NAV reload` quando reprova.
//
//   ALVO          a página
//   ESPERA        ms com o Chrome aberto (padrão 45000)
//   CONSOLE=1     acrescenta o console do Chrome, lido do stderr dele, com as repetições contadas
//   EXTRA         argumentos a mais para o Chrome, separados por `|`
//   LARG          largura máxima de cada linha do registro (padrão 420)
//   FIXOS         endereços fixos (ver fixos.mjs)
//   BENCH_CHROME  o binário (padrão google-chrome); numa máquina sem tela, rode sob xvfb-run
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { subirPortal, trocarLookup } from "../servidor.mjs";
import { lookupComFixos } from "./fixos.mjs";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ALVO = process.env.ALVO;
if (!ALVO) throw new Error("ALVO é obrigatório");
const ESPERA = Number(process.env.ESPERA || 45000);

trocarLookup(lookupComFixos);
const portal = await subirPortal({ portaSites: 1, apendiceDaApi: "\n" + readFileSync(path.join(AQUI, "registro-do-desafio.js"), "utf8") });
const linhas = [];
const relatos = createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { linhas.push(b); res.end(); }); });
await new Promise((ok) => relatos.listen(0, "127.0.0.1", ok));
const relato = `http://127.0.0.1:${relatos.address().port}/r`;
const url = `${portal.base}?auto=${encodeURIComponent(ALVO)}&relato=${encodeURIComponent(relato)}${process.env.LARG ? "&larg=" + process.env.LARG : ""}`;
const perfil = mkdtempSync(path.join(tmpdir(), "sem-automacao-"));
const logc = path.join(perfil, "console.log");
const chrome = spawn(process.env.BENCH_CHROME || "google-chrome", [
  `--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1366,900",
  "--enable-logging=stderr", "--log-level=0", ...(process.env.EXTRA ? process.env.EXTRA.split("|") : []), url,
], { stdio: ["ignore", "ignore", openSync(logc, "w")] });
await new Promise((ok) => setTimeout(ok, ESPERA));
chrome.kill("SIGTERM");
await new Promise((ok) => setTimeout(ok, 1000));
let ultimo = "";
for (const l of linhas) {
  try { const o = JSON.parse(l); if (o.erro) { console.log("ERRO " + o.erro.slice(0, 400)); continue; }
    const cab = `— título=${JSON.stringify(o.titulo)} foco=${o.foco} vis=${o.vis}`; if (cab !== ultimo) { console.log(cab); ultimo = cab; }
    for (const x of o.linhas) console.log(x);
  } catch { console.log(l.slice(0, 200)); }
}
if (process.env.CONSOLE === "1") {
  console.log("=== console do Chrome ===");
  const vistos = new Map();
  for (const l of readFileSync(logc, "utf8").split("\n")) {
    const m = l.match(/CONSOLE[^\]]*\] "(.*)", source: (.*)$/); if (!m) continue;
    let fonte = m[2]; try { fonte = decodeURIComponent(fonte); } catch {}
    const k = m[1].slice(0, 300) + " @" + fonte.split("/scram/").pop().replace(/(challenge-platform\/h\/\w\/)([\w-]+\/[\w-]+)\/.*?(\(\d+\))?$/, "$1$2…$3").slice(0, 120);
    vistos.set(k, (vistos.get(k) || 0) + 1);
  }
  for (const [k, n] of vistos) console.log(`${n}x ${k}`);
}
rmSync(perfil, { recursive: true, force: true });
await portal.fechar(); relatos.close();
process.exit(0);
