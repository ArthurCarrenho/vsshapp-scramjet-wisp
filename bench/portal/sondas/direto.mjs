// O desafio num Chrome comum, direto, sem CDP: a coluna de referência de sem-automacao.mjs. Os
// pedidos saem do net-log, numa linha do tempo relativa ao primeiro pedido ao alvo, com o mesmo
// desenho das linhas REQ do registro: início, duração, método, status, protocolo, tamanho do corpo
// enviado, `content-length` da resposta e os cookies (nome, hash e tamanho).
//
//   ALVO          a página
//   FILTRO        regex dos endereços que entram (padrão: o alvo, o favicon e o Cloudflare)
//   ESPERA        ms com o Chrome aberto (padrão 30000)
//   EXTRA         argumentos a mais para o Chrome, separados por `|`
//   FIXOS         endereços fixos (ver fixos.mjs)
//   BENCH_CHROME  o binário (padrão google-chrome); numa máquina sem tela, rode sob xvfb-run
//
// Para medir o Chrome com a CPU limitada, rode-o dentro de um escopo do systemd:
//   systemd-run --user --scope -q -p CPUQuota=15% xvfb-run -a node direto.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { argumentosDoChrome } from "./fixos.mjs";

const ALVO = process.env.ALVO;
if (!ALVO) throw new Error("ALVO é obrigatório");
const ESPERA = Number(process.env.ESPERA || 30000);
const FILTRO = new RegExp(process.env.FILTRO || "tandfonline\\.com/(eprint|cdn-cgi|favicon)|challenges\\.cloudflare");
const perfil = mkdtempSync(path.join(tmpdir(), "direto-"));
const log = path.join(perfil, "net.json");
const ev = [];
const args = [`--user-data-dir=${perfil}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--window-size=1366,900", `--log-net-log=${log}`, "--net-log-capture-mode=IncludeSensitive"];
args.push(...argumentosDoChrome());
if (process.env.EXTRA) args.push(...process.env.EXTRA.split("|"));
const chrome = spawn(process.env.BENCH_CHROME || "google-chrome", [...args, ALVO], { stdio: "ignore" });
await new Promise((ok) => setTimeout(ok, ESPERA));
chrome.kill("SIGTERM"); await new Promise((ok) => setTimeout(ok, 3000));
let txt = readFileSync(log, "utf8").trim();
if (!txt.endsWith("]}")) { txt = txt.replace(/,?\s*$/, ""); try { JSON.parse(txt + "]}"); } catch { txt = txt.slice(0, txt.lastIndexOf("\n{")).replace(/,\s*$/, ""); } txt += "]}"; }
const d = JSON.parse(txt);
const tipos = Object.fromEntries(Object.entries(d.constants.logEventTypes).map(([k, v]) => [v, k]));
const desloc = Number(d.constants.timeTickOffset);
const curto = (u) => String(u).replace(/^https?:\/\//, "").replace(/(challenge-platform\/h\/\w\/)([\w-]+\/[\w-]+)\/.*/, "$1$2…").slice(0, 110);
const hsh = (x) => { let h = 2166136261; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 5); };
const fontes = new Map();
for (const e of d.events) {
  const t = tipos[e.type]; const p = e.params || {}; const id = e.source.id;
  if (t === "URL_REQUEST_START_JOB" && p.url) fontes.set(id, { url: p.url, m: p.method, ini: Number(e.time) + desloc });
  const r = fontes.get(id); if (!r) continue;
  if (/SEND_REQUEST_HEADERS/.test(t) && p.headers) {
    const h = (Array.isArray(p.headers) ? p.headers : Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`)).map(String);
    const g = (n) => (h.find((x) => x.toLowerCase().startsWith(n + ":")) || "").slice(n.length + 1).trim();
    r.cl = g("content-length"); r.proto = t.includes("QUIC") ? "h3" : t.includes("HTTP2") ? "h2" : "h1";
    r.ck = g("cookie").split(";").filter(Boolean).map((c) => c.split("=")[0].trim() + "#" + hsh(c.split("=").slice(1).join("=").trim())).join("+");
  }
  if (/READ_RESPONSE_HEADERS/.test(t) && p.headers) {
    const h = p.headers.map(String);
    r.st = (h.find((x) => /^:status|^HTTP\//.test(x)) || "").replace(/^:status: |^HTTP\/[\d.]+ /, "").slice(0, 3);
    r.sc = h.filter((x) => /^set-cookie:/i.test(x)).map((x) => { const c = x.slice(11).trim(); const nome = c.split("=")[0]; const val = c.split(";")[0].split("=").slice(1).join("="); return `${nome}#${hsh(val)}/${val.length}${/partitioned/i.test(c) ? "P" : ""}${/samesite=none/i.test(c) ? "N" : ""}`; }).join("+");
    r.rcl = (h.find((x) => /^content-length:/i.test(x)) || "").slice(15).trim();
    if (FILTRO.test(r.url)) ev.push({ t: Number(e.time) + desloc, l: `REQ ini=@${r.ini} dur=${Number(e.time) + desloc - r.ini}ms ${r.m} ${r.st} ${r.proto || ""} ${curto(r.url)}${r.cl ? " corpo=" + r.cl : ""}${r.rcl ? " cl=" + r.rcl : ""}${r.ck ? " [ck " + r.ck + "]" : ""}${r.sc ? " [sc " + r.sc + "]" : ""}` });
  }
  if (t === "URL_REQUEST_START_JOB" || !/FAILED|REQUEST_ALIVE/.test(t)) continue;
  if (p.net_error && FILTRO.test(r.url) && !r.falhou) { r.falhou = 1; ev.push({ t: Number(e.time) + desloc, l: `REQ ${r.m} ERR ${p.net_error} ${curto(r.url)}` }); }
}
ev.sort((a, b) => a.t - b.t);
const t0 = (ev.find((x) => /REQ ini/.test(x.l)) || ev[0] || { t: 0 }).t;
const base = Number((ev.find((x) => /REQ ini/.test(x.l)) || { l: "@" + t0 }).l.match(/@(\d+)/)[1]);
for (const x of ev) console.log(((x.t - base) / 1000).toFixed(2) + " " + x.l.replace(/ini=@(\d+)/, (m, v) => "ini=" + ((Number(v) - base) / 1000).toFixed(2)));
rmSync(perfil, { recursive: true, force: true });
process.exit(0);
