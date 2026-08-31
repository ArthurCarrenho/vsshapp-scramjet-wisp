// A bancada do PORTAL: o motor real, o transporte real, e a camada do navegador do vssh-sso.
//
// ─── Qual buraco ela fecha ───────────────────────────────────────────────────────────────────
//
// Há três bancadas neste repositório e nenhuma alcança a camada do portal. A de transporte
// (`bench/`) conta conexões TCP; a de reprodução (`engines/scramjet/bench/`) mede o motor contra
// sites reais; o runway prova o motor contra si mesmo. E o README da de reprodução diz, por
// extenso, onde procurar quando nenhuma delas reproduz:
//
//   "a diferença que sobra é a camada do portal — extensões, userscripts, cosmético do adblock e
//    o fluxo de restaurar aba"
//
// O script que chegou mais perto disso, `portal-duas-abas.mjs`, monta o arranjo certo (um
// controller, N frames, um transporte) e **aborta sem veredito**, porque o alvo é o YouTube e o
// player se derruba sozinho no headless. Trocar o alvo por um sítio local é o que faltava para ele
// poder concluir alguma coisa.
//
// ─── O que este processo é ───────────────────────────────────────────────────────────────────
//
// Um portal de mentira que serve as MESMAS coisas que o de verdade, para que o cliente que carrega
// em cima dele seja o de verdade:
//
//   /s/proxy/app/scramjet-wisp/{scram,controller,libcurl,utils}/  ← backend/vendor/*/dist
//   /s/proxy/app/scramjet-wisp/wisp/                              ← o wisp real, com rede.js
//   /s/proxy/vssh-desktop/                                        ← o vssh-client REAL, do disco
//   /api/user/browser/*, /api/apps                                ← dublês em memória
//
// ⚠ **O `vssh-client/` nunca é copiado.** Ele é servido do disco do outro repositório, apontado
// por `VSSH_SSO`. Uma cópia divergiria em silêncio, e a bancada passaria a medir uma versão que
// ninguém roda — que é o defeito que ela existe para achar.

import { createServer } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const AQUI    = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = process.env.BENCH_BACKEND || path.join(AQUI, "..", "..", "backend");
const VSSH_SSO = process.env.VSSH_SSO || path.join(AQUI, "..", "..", "..", "vssh-sso");
const CLIENTE  = path.join(VSSH_SSO, "vssh-client");

if (!existsSync(CLIENTE)) {
	throw new Error(
		`não achei o vssh-client em ${CLIENTE} — aponte VSSH_SSO para o checkout do vssh-sso. `
		+ "A bancada serve o cliente REAL do disco, de propósito: uma cópia divergiria em silêncio.");
}
if (!existsSync(path.join(BACKEND, "node_modules/@mercuryworkshop/wisp-js"))) {
	throw new Error(`o wisp não está instalado — rode \`npm ci\` em ${BACKEND}`);
}

// O wisp e a política de rede vêm do BACKEND deste repositório, por caminho — mesmo idioma do
// `conta-conexoes.mjs`. A bancada mede a política que produção usa, não uma cópia dela.
const { server: wisp, logging } = await import(
	pathToFileURL(path.join(BACKEND, "node_modules/@mercuryworkshop/wisp-js/src/entrypoints/server.mjs")).href);
const { aplicarPolitica } = await import(pathToFileURL(path.join(BACKEND, "rede.js")).href);

logging.set_level(logging.WARN);

// ─── A internet de mentira resolve aqui ──────────────────────────────────────────────────────
//
// `rede.js` aceita `lookup` injetado exatamente para isto, e o cabeçalho dele já diz por quê: as
// opções do wisp merecem estar num lugar que dê para testar sem tocar a rede. Todo `*.teste` cai
// em 127.0.0.1; qualquer outro host resolve normalmente — e como este ambiente não tem saída, um
// host de verdade falha com o erro dele em vez de pendurar, que é o que se quer de uma bancada.
function lookupDaBancada(hostname, opcoes) {
	if (/(^|\.)teste$/i.test(hostname)) {
		return Promise.resolve({ address: "127.0.0.1", family: 4 });
	}
	return import("node:dns/promises").then((dns) => dns.lookup(hostname, opcoes));
}

aplicarPolitica(wisp, { lookup: lookupDaBancada, aoFalhar: () => {}, aoRecuar: () => {} });

// ─── Os assets do motor, do vendor ───────────────────────────────────────────────────────────
// Tudo o que o portal serve em nome do app mora sob este prefixo — e é nesta granularidade que
// ele recusa: quando o caminho de `/proxy/app/<id>/` está fechado, está fechado para a raiz e para
// todos os bundles de uma vez. Por isso `statusDosAssets` casa aqui, e não rota a rota.
const PREFIXO_DO_APP = "/s/proxy/app/scramjet-wisp/";

const ROTAS_DO_MOTOR = [
	{ prefixo: "/s/proxy/app/scramjet-wisp/scram/",      dir: "scramjet" },
	{ prefixo: "/s/proxy/app/scramjet-wisp/controller/", dir: "controller" },
	{ prefixo: "/s/proxy/app/scramjet-wisp/libcurl/",    dir: "libcurl-transport" },
	{ prefixo: "/s/proxy/app/scramjet-wisp/utils/",      dir: "utils" },
];

const MIME = {
	".js": "application/javascript", ".mjs": "application/javascript", ".map": "application/json",
	".wasm": "application/wasm", ".json": "application/json", ".html": "text/html; charset=utf-8",
	".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2",
	".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

async function servirArquivo(res, arquivo, raiz) {
	// Nunca sair da raiz — a mesma regra do server.js de produção, e pelo mesmo motivo.
	if (!arquivo.startsWith(raiz + path.sep) && arquivo !== raiz) { res.writeHead(400).end(); return true; }
	try {
		const st = await stat(arquivo);
		if (!st.isFile()) throw new Error("não é arquivo");
		// `no-store` em TUDO, como o backend de verdade: `importScripts()` não revalida o que
		// importa, então com cache um service worker recém-instalado segue rodando o bundle velho.
		res.writeHead(200, {
			"Content-Type": MIME[path.extname(arquivo)] || "application/octet-stream",
			"Cache-Control": "no-store",
		});
		createReadStream(arquivo).pipe(res);
	} catch { res.writeHead(404).end(); }
	return true;
}

// ─── A página da bancada ─────────────────────────────────────────────────────────────────────
//
// Não é o `index.html` do shell: aquele sobe o desktop inteiro. É o mínimo que faz o motor de
// verdade funcionar — e os módulos são carregados **na ordem que o `index.html` real declara**,
// lida dele. Inverter lá quebra a bancada aqui, que é a forma certa de uma ordem ser verificada.
const MODULOS = [
	"js/browser/BrowserEngines.js",
	"js/browser/MatchPattern.js",
	"js/browser/ExtensionRuntime.js",
	"js/browser/ScramjetEngine.js",
];

function ordemDoIndex() {
	const html = readFileSync(path.join(CLIENTE, "index.html"), "utf8");
	const faltando = MODULOS.filter((m) => !html.includes(`src="${m}"`));
	if (faltando.length) throw new Error(`módulos que a bancada carrega sumiram do index.html: ${faltando.join(", ")}`);
	return [...MODULOS].sort((a, b) => html.indexOf(`src="${a}"`) - html.indexOf(`src="${b}"`));
}

function paginaDaBancada(portaSites) {
	const scripts = ordemDoIndex().map((m) => `<script src="/s/proxy/vssh-desktop/${m}"></script>`).join("\n");
	return `<!doctype html><html><head><meta charset="utf-8"><title>bancada do portal</title></head>
<body>
<script>
// ── Os dublês do shell, e SÓ eles ──────────────────────────────────────────────────────────
// O que o ScramjetEngine consulta do resto do shell é pouco e está listado aqui inteiro. Tudo o
// que não estiver nesta lista, ele não precisa — e é bom que a lista seja curta e visível: se ela
// crescer sozinha, o motor ganhou um acoplamento novo que ninguém decidiu.
window.SITES_PORTA = ${portaSites};
window.vsshSettings = { scramjetPageCache: false };
window.AppLauncher = {
  appComCapacidade: async () => ({ id: 'scramjet-wisp' }),
  appPorId:         async () => ({ id: 'scramjet-wisp' }),
  ensureRunning:    async () => ({ url: location.origin + '/s/proxy/app/scramjet-wisp/', ready: true, lastCode: 200 }),
  appsEmCache:      () => [],
};
window.Atividade = {
  _itens: [],
  set(chave, item) { this._itens.push(['set', chave, item]); return true; },
  clear(chave) { this._itens.push(['clear', chave]); return true; },
  declararLocal() {}, soltarLocal() {},
};
// O registro que as sondas leem: erros e avisos com a marca do motor, para separar "o site
// reclamou" de "o motor reclamou" sem depender de ler o console do navegador.
window.__log = [];
for (const nivel of ['warn', 'error']) {
  const orig = console[nivel].bind(console);
  // ⚠ String(objeto) é "[object Object]", e o diagnóstico do motor VIAJA como objeto. A primeira
  // versão desta linha achatava justamente a informação que a sonda existe para ler — a bancada
  // apagando a medida, sem nenhum sinal disso.
  console[nivel] = (...a) => {
    const texto = a.map((x) => {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    }).join(' ');
    window.__log.push([nivel, texto]);
    orig(...a);
  };
}
window.__rejeicoes = [];
addEventListener('unhandledrejection', (e) => window.__rejeicoes.push(String(e.reason)));
</script>
${scripts}
<script src="/s/proxy/vssh-desktop/bancada-api.js"></script>
</body></html>`;
}

/**
 * Sobe o portal de mentira. Devolve `{ base, porta, fechar }`.
 *
 * `statusDosAssets` faz o portal RECUSAR os assets do motor com aquele código, sem corpo — o
 * caminho `/…/proxy/app/scramjet-wisp/…` inteiro, que é a granularidade real do defeito: quem
 * recusa é o portal, e ele não distingue um bundle de outro. Serve para reproduzir o incidente do
 * 403, em que o portal dizia `ready: true` e recusava tudo o que vinha depois. O dublê de
 * `ensureRunning` da página segue dizendo `ready: true` de propósito — foi assim em produção, e é
 * o que faz a sonda medir o caso real em vez de um app parado.
 */
export async function subirPortal({ porta = 0, portaSites, statusDosAssets = null }) {
	const srv = createServer((req, res) => {
		const caminho = decodeURIComponent(req.url.split("?")[0]);

		if (caminho === "/s/proxy/vssh-desktop/" || caminho === "/s/proxy/vssh-desktop") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			return res.end(paginaDaBancada(portaSites));
		}
		if (caminho === "/s/proxy/vssh-desktop/bancada-api.js") {
			res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
			return res.end(readFileSync(path.join(AQUI, "bancada-api.js"), "utf8"));
		}

		if (statusDosAssets && caminho.startsWith(PREFIXO_DO_APP)) {
			// Corpo vazio, como o portal de verdade faz com asset (ver `_ASSET_RE`/`_sendProxyError`
			// em src/proxy.ts): mandar HTML aqui daria ao cliente uma pista que ele não tem em
			// produção, e a sonda mediria uma facilidade inventada pela bancada.
			return void res.writeHead(statusDosAssets, { "Cache-Control": "no-store" }).end();
		}

		// A raiz do app É o healthcheck, e o cliente a consulta antes de registrar o service worker
		// (ver `_conferirBackend` no ScramjetEngine). Sem esta linha ela caía no 404 do fim — que
		// conta como "servindo", então nada quebrava, mas a bancada deixava de exercitar o mesmo
		// caminho que a produção percorre.
		if (caminho === PREFIXO_DO_APP) {
			res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
			return res.end("scramjet-wisp ok");
		}

		const doMotor = ROTAS_DO_MOTOR.find((r) => caminho.startsWith(r.prefixo));
		if (doMotor) {
			const raiz = path.join(BACKEND, "vendor", doMotor.dir, "dist");
			return void servirArquivo(res, path.join(raiz, caminho.slice(doMotor.prefixo.length)), raiz);
		}

		if (caminho.startsWith("/s/proxy/vssh-desktop/")) {
			return void servirArquivo(res, path.join(CLIENTE, caminho.slice("/s/proxy/vssh-desktop/".length)), CLIENTE);
		}

		if (caminho.startsWith("/api/")) return void apiDublê(caminho, req, res);

		res.writeHead(404, { "Content-Type": "text/plain" }).end("não é rota do portal de bancada");
	});

	// O wisp sobe pelo mesmo caminho de produção — `/…/wisp/` casado por sufixo, como o server.js.
	srv.on("upgrade", (req, socket, head) => {
		if (req.url.split("?")[0].endsWith("/wisp/")) wisp.routeRequest(req, socket, head);
		else socket.destroy();
	});

	await new Promise((ok) => srv.listen(porta, "127.0.0.1", ok));
	const p = srv.address().port;
	return {
		porta: p,
		base: `http://127.0.0.1:${p}/s/proxy/vssh-desktop/`,
		cookies: COOKIES,
		fechar: () => new Promise((ok) => srv.close(ok)),
	};
}

// ─── Os dublês do portal ─────────────────────────────────────────────────────────────────────
//
// Guardam de verdade, em memória, porque a ida e a volta do cookie é uma das coisas medidas: um
// dublê que aceitasse tudo e devolvesse vazio faria a restauração "funcionar" sempre.
//
// ⚠ A consulta por domínio segue a MESMA regra do portal (`utils/dominio-de-cookie.ts`): responde
// pelo HOST, com os domínios que o alcançam. Um dublê com a regra antiga esconderia justamente o
// defeito que a regra nova conserta.
const COOKIES = [];

function dominiosQueAlcancam(host) {
	const nu = String(host || "").trim().toLowerCase().replace(/\.$/, "");
	if (!nu || nu.includes(":") || /^\d+\.\d+\.\d+\.\d+$/.test(nu)) return nu ? [nu] : [];
	const partes = nu.split(".");
	const saida = [];
	for (let i = 0; i <= partes.length - 2; i++) saida.push(partes.slice(i).join("."));
	return saida.length ? saida : [nu];
}

function corpo(req) {
	return new Promise((ok) => {
		let b = "";
		req.on("data", (c) => { b += c; });
		req.on("end", () => { try { ok(JSON.parse(b || "{}")); } catch { ok({}); } });
	});
}

async function apiDublê(caminho, req, res) {
	const json = (v, status = 200) => {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(v));
	};

	if (caminho === "/api/user/browser/cookies" && req.method === "GET") {
		const host = new URL(req.url, "http://x").searchParams.get("domain") || "";
		// `BENCH_PORTAL_ANTIGO=1` devolve o portal à igualdade exata de domínio — a regra que havia
		// antes. É a coluna de controle desta sonda: sem ela, medir o cliente contra o portal NOVO
		// esconde metade do defeito, porque a consulta larga sozinha já resgata o cookie de sessão.
		// Foi o que aconteceu na primeira rodada, e a sonda passou verde contra o cliente antigo.
		const alcance = new Set(process.env.BENCH_PORTAL_ANTIGO === "1" ? [host] : dominiosQueAlcancam(host));
		return json({ cookies: COOKIES.filter((c) => alcance.has(c.domain)) });
	}
	if (caminho === "/api/user/browser/cookies/batch" && req.method === "POST") {
		const { cookies = [], removed = [] } = await corpo(req);
		for (const c of cookies) {
			const i = COOKIES.findIndex((o) => o.domain === c.domain && o.name === c.name && o.path === c.path);
			if (i >= 0) COOKIES[i] = { ...c }; else COOKIES.push({ ...c });
		}
		for (const r of removed) {
			const i = COOKIES.findIndex((o) => o.domain === r.domain && o.name === r.name && o.path === r.path);
			if (i >= 0) COOKIES.splice(i, 1);
		}
		return json({ upserted: cookies.length });
	}
	if (caminho === "/api/user/browser/extensions") return json({ extensions: [] });
	if (caminho === "/api/user/browser/ext-storage") return json({ storage: {} });
	if (caminho === "/api/user/browser/history/batch") return json({ inserted: 0 });
	if (caminho === "/api/apps") return json({ apps: [] });
	return json({}, 200);
}
