// A internet de mentira: os sítios que a bancada do portal atravessa.
//
// ─── Por que local, e não um site de verdade ─────────────────────────────────────────────────
//
// A bancada irmã (`engines/scramjet/bench/`) mira sites reais, e o README dela registra o preço:
// o player do YouTube se derruba sozinho aos 45 s no headless, o viewport muda a interface, os
// botões moram em shadow DOM. Metade das armadilhas anotadas lá é do ALVO, não do motor — e duas
// hipóteses morreram por causa disso.
//
// Aqui o alvo é escrito para a pergunta. Cada rota abaixo existe porque alguma armadilha
// conhecida precisa de um gatilho determinístico: um recurso de anúncio que se pode exigir que
// FALHE, um `Set-Cookie` de domínio que se pode exigir que volte no subdomínio, um endereço que
// aceita a conexão e nunca responde. Nada disso se pede a um site de verdade.
//
// ⚠ Isto NÃO substitui uma rodada contra a internet. Um sítio local não tem TLS de verdade, não
// tem CDN, não tem o handshake que domina o tempo do WASM — a bancada de transporte já mediu que
// bateria sintética sem TLS INVERTE o sinal sobre número de conexões. O que se mede aqui é
// COMPORTAMENTO da camada do portal, nunca desempenho do transporte.
//
// ─── Como os hosts resolvem ──────────────────────────────────────────────────────────────────
//
// Todo `*.teste` cai em 127.0.0.1 pelo `lookup` injetado no wisp (ver servidor.mjs). A porta vem
// da URL, então os endereços são `http://site.teste:<porta>/…`. Cookie não discrimina porta, então
// a hierarquia `site.teste` × `www.site.teste` continua valendo, que é o ponto do fixture de
// sessão.

import { createServer } from "node:http";

/** Marca o corpo para as sondas acharem sem depender de texto de interface. */
const pagina = (marca, corpo) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${marca}</title></head>`
	+ `<body data-marca="${marca}">${corpo}</body></html>`;

const html = (res, corpo, extra = {}) => {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extra });
	res.end(corpo);
};

// Um GIF 1×1 de verdade: o `onerror` de uma `<img>` só prova bloqueio se a versão NÃO bloqueada
// carregaria mesmo. Sem bytes válidos, os dois lados dão `onerror` e o teste mede a si mesmo.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Sobe a internet de mentira. Devolve `{ porta, fechar, pedidos }`.
 *
 * `pedidos` é o registro do que CHEGOU: é o lado do servidor da medida, e é ele que separa "o
 * recurso não carregou" de "o recurso nem foi pedido" — distinção que só o cliente não dá.
 */
export async function subirSites({ porta = 0 } = {}) {
	const pedidos = [];
	// A porta só se conhece depois do listen, e os fixtures precisam dela nas URLs absolutas.
	// Ela é lida no momento do PEDIDO, que é sempre depois — assim o fixture continua legível,
	// com a URL inteira à vista, em vez de montada por concatenação no cliente.
	let P = "0";

	const srv = createServer((req, res) => {
		const host = String(req.headers.host || "").split(":")[0].toLowerCase();
		const u = new URL(req.url, `http://${host}`);
		pedidos.push({ host, caminho: u.pathname, metodo: req.method });

		// ── anuncios.teste — o que o adblock deve derrubar ──────────────────────────────────
		if (host === "anuncios.teste") {
			if (u.pathname === "/pixel.gif") {
				res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" });
				return res.end(GIF);
			}
			res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
			return res.end("window.__anuncioRodou = true;");
		}

		// ── terceiro.teste — a FORMA de um captcha, sem depender de um ──────────────────────
		//
		// Um desafio real é um iframe de outra origem que conversa com a página por postMessage
		// conferindo `targetOrigin`, e que lê o próprio `location.origin` para se identificar. São
		// essas três coisas que a reescrita mexe; o resto do captcha é rede e reputação de IP, que
		// nenhuma bancada local reproduz.
		if (host === "terceiro.teste") {
			return html(res, pagina("quadro-terceiro", `
				<script>
				  const meu = { origem: location.origin, href: location.href, ancestrais: (() => {
				    try { return document.location.ancestorOrigins ? [...document.location.ancestorOrigins] : null; }
				    catch (e) { return 'inacessivel'; }
				  })() };
				  addEventListener('message', (e) => {
				    if (!e.data || e.data.tipo !== 'desafio') return;
				    // A conferência que todo widget de desafio faz, e que decide se ele responde.
				    parent.postMessage({ tipo: 'resposta', meu, deOrigem: e.origin }, e.data.responderPara || '*');
				  });
				  parent.postMessage({ tipo: 'pronto', meu }, '*');
				</script>`));
		}

		// ── site.teste e www.site.teste ─────────────────────────────────────────────────────

		// Sessão: um cookie de DOMÍNIO (vale no subdomínio) e um preso ao host, de propósito.
		if (u.pathname === "/entrar") {
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
				"Set-Cookie": [
					// De domínio: tem de voltar no subdomínio.
					"sid=vale-em-todo-lugar; Domain=.site.teste; Path=/",
					// Preso ao host: NÃO pode voltar no subdomínio.
					"preso=so-neste-host; Path=/",
					// De domínio e HttpOnly: tem de voltar, e tem de continuar invisível ao script.
					"sess=segredo; Domain=.site.teste; Path=/; HttpOnly",
				],
			});
			return res.end(pagina("entrou", "<p>sessão gravada</p>"));
		}

		// O que o servidor RECEBEU de volta — a única leitura honesta de "o cookie voltou", porque
		// `document.cookie` não enxerga HttpOnly e um cookie pode existir sem ser enviado.
		if (u.pathname === "/conta") {
			return html(res, pagina("conta", `<pre id="cookies">${String(req.headers.cookie || "")}</pre>`));
		}

		// Aceita a conexão e nunca responde: o gatilho do giro eterno.
		if (u.pathname === "/lento") return; // nem writeHead — o socket fica aberto

		// O cache de páginas: corpos guardáveis pelo HTTP (`max-age`) que não cabem nele. O tamanho
		// vem da query (`?mb=`), e o corpo é gerado em pedaços, sem morar inteiro na memória daqui.
		const CACHEAVEL = "public, max-age=3600";
		const corpoDe = (mb, extra) => {
			const total = Math.max(1, Number(u.searchParams.get("mb") || mb)) * 1024 * 1024;
			res.writeHead(200, { "Cache-Control": CACHEAVEL, ...extra });
			const pedaco = Buffer.alloc(64 * 1024, 120);
			let enviado = 0;
			const escrever = () => {
				while (enviado < total) {
					const n = Math.min(pedaco.length, total - enviado);
					enviado += n;
					if (!res.write(n === pedaco.length ? pedaco : pedaco.subarray(0, n))) return res.once("drain", escrever);
				}
				res.end();
			};
			escrever();
		};
		if (u.pathname === "/cache/pequeno.js") {
			res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": CACHEAVEL });
			return res.end("window.__pequeno = 1;");
		}
		if (u.pathname === "/cache/grande.bin") {
			const mb = Number(u.searchParams.get("mb") || 32);
			return corpoDe(mb, { "Content-Type": "application/octet-stream", "Content-Length": String(mb * 1024 * 1024) });
		}
		if (u.pathname === "/cache/anexo.zip") {
			const mb = Number(u.searchParams.get("mb") || 2);
			return corpoDe(mb, {
				"Content-Type": "application/zip", "Content-Length": String(mb * 1024 * 1024),
				"Content-Disposition": 'attachment; filename="anexo.zip"',
			});
		}
		// Sem `Content-Length`: o tamanho só se sabe lendo.
		if (u.pathname === "/cache/sem-tamanho.bin") return corpoDe(16, { "Content-Type": "application/octet-stream" });
		if (u.pathname === "/cache/video.mp4") {
			return corpoDe(1, { "Content-Type": "video/mp4", "Content-Length": String(1024 * 1024) });
		}
		if (u.pathname === "/cache/") return html(res, pagina("cache", "<p>pedidos de dentro desta página</p>"));

		// Uma página pesada para a thread do shell: oito scripts de ~250 KB (o tamanho de um bundle
		// de framework, que o rewriter percorre inteiro), trinta imagens e um iframe da mesma origem,
		// que é um segundo documento reescrito. `?n=` muda o número desta página, para cada
		// navegação ser um documento novo e não um que o cache de páginas guardou.
		if (u.pathname === "/pesada/") {
			const n = u.searchParams.get("n") || "0";
			const scripts = Array.from({ length: 8 }, (_, i) => `<script src="/pesada/s${i}.js?n=${n}"></script>`).join("");
			const imagens = Array.from({ length: 30 }, (_, i) => `<img src="/pixel.gif?i=${i}&n=${n}" width="1" height="1">`).join("");
			return html(res, pagina("pesada", `${scripts}${imagens}<iframe src="/pesada/quadro?n=${n}"></iframe>`));
		}
		if (u.pathname === "/pesada/quadro") return html(res, pagina("quadro", "<script>window.__q = 1;</script>"));
		if (/^\/pesada\/s\d\.js$/.test(u.pathname)) {
			const linhas = [];
			for (let i = 0; i < 2500; i++) linhas.push(`function f${i}(a, b) { const o = { x: a + ${i}, y: [b, "${"t".repeat(40)}"] }; return o.x > b ? o.y : location.href; }`);
			res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
			return res.end(linhas.join("\n") + "\nwindow.__s = (window.__s || 0) + 1;");
		}

		if (u.pathname === "/anuncios") {
			return html(res, pagina("anuncios", `
				<img id="anuncio" src="http://anuncios.teste:${P}/pixel.gif"
				     onload="window.__img='onload'" onerror="window.__img='onerror'">
				<img id="proprio" src="/pixel.gif"
				     onload="window.__proprio='onload'" onerror="window.__proprio='onerror'">
				<script>
				  // O carregador que o silenciador do adblock existe para calar: embrulha o
				  // <script> numa Promise cujo onerror REJEITA e não tem .catch(). Um site grande
				  // de verdade faz isso, e cada bloqueio virava uma linha de "Uncaught (in promise)".
				  window.__rejeicoes = [];
				  addEventListener('unhandledrejection', (e) => window.__rejeicoes.push(String(e.reason && e.reason.type || e.reason)));
				  window.__carregar = (src) => new Promise((ok, falhou) => {
				    const s = document.createElement('script');
				    s.src = src; s.onload = ok; s.onerror = falhou;
				    document.head.appendChild(s);
				  });
				  window.__carregar('http://anuncios.teste:${P}/tag.js');
				</script>`));
		}

		if (u.pathname === "/pixel.gif") {
			res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" });
			return res.end(GIF);
		}

		if (u.pathname === "/deeplink") {
			return html(res, pagina("deeplink", `
				<a id="mailto" href="mailto:alguem@exemplo.test?subject=oi">escrever</a>
				<a id="tel" href="tel:+551122223333">ligar</a>
				<a id="magnet" href="magnet:?xt=urn:btih:0123456789abcdef">baixar</a>
				<a id="branco" href="http://site.teste:${P}/conta" target="_blank">outra aba</a>
				<a id="mesmo" href="http://site.teste:${P}/conta">aqui mesmo</a>
				<script>
				  window.__abriu = null;
				  window.__abrirJanela = (alvo) => {
				    try {
				      const w = window.open('http://site.teste:${P}/conta', alvo);
				      // O que os fluxos de OAuth e de pagamento realmente fazem com o retorno.
				      return { tipo: typeof w, nulo: w === null, temFocus: !!(w && w.focus),
				               fechado: w ? w.closed : null, chamouFocus: (() => { try { w.focus(); return true; } catch (e) { return 'erro:' + e.name + ': ' + e.message; } })() };
				    } catch (e) { return 'erro:' + e.name + ': ' + e.message; }
				  };
				  window.__fecharSe = () => { try { window.close(); return 'chamou'; } catch (e) { return 'erro:' + e.name; } };
				</script>`));
		}

		// Pop-ups: um link de aba nova, um botão que abre quinze de uma vez num clique, e uma
		// função que a sonda chama sem clique nenhum.
		if (u.pathname === "/popups") {
			return html(res, pagina("popups", `
				<a id="novo" href="http://site.teste:${P}/conta" target="_blank">nova aba</a>
				<button id="rajada" onclick="for (let i = 0; i < 15; i++) window.open('http://site.teste:${P}/conta?r=' + i, '_blank')">quinze abas</button>
				<script>
				  window.__semGesto = (n) => {
				    let nulos = 0;
				    for (let i = 0; i < n; i++) if (window.open('http://site.teste:${P}/conta?s=' + i, '_blank') === null) nulos++;
				    return nulos;
				  };
				</script>`));
		}

		if (u.pathname === "/terceiro") {
			return html(res, pagina("com-terceiro", `
				<iframe id="quadro" src="http://terceiro.teste:${P}/"></iframe>
				<script>
				  window.__mensagens = [];
				  addEventListener('message', (e) => window.__mensagens.push({ origem: e.origin, dado: e.data }));
				  window.__desafiar = () => document.getElementById('quadro').contentWindow.postMessage(
				    { tipo: 'desafio', responderPara: '*' }, '*');
				</script>`));
		}

		if (u.pathname === "/shadow") {
			return html(res, pagina("shadow", `
				<div id="hospedeiro"></div>
				<script>
				  // O buraco de reescrita já declarado no fork: ShadowRoot.prototype.innerHTML é
				  // descritor PRÓPRIO, e o trap de Element.prototype.innerHTML não o cobre.
				  const raiz = document.getElementById('hospedeiro').attachShadow({ mode: 'open' });
				  raiz.innerHTML = '<a id="dentro" href="http://site.teste:${P}/conta">link no shadow</a>';
				  window.__hrefNoShadow = () => raiz.getElementById('dentro').getAttribute('href');
				</script>`));
		}

		if (u.pathname === "/spa") {
			return html(res, pagina("spa", `
				<script>
				  window.__navegarSemTrocarDocumento = (n) => history.pushState({}, '', '/spa/' + n);
				  window.__substituirSemTrocarDocumento = (n) => history.replaceState({}, '', '/spa/r' + n);
				</script>`));
		}

		return html(res, pagina("inicio", `<p>${host}</p><a href="/conta">conta</a>`));
	});

	await new Promise((ok) => srv.listen(porta, "127.0.0.1", ok));
	P = String(srv.address().port);

	return {
		porta: Number(P),
		pedidos,
		limparPedidos: () => { pedidos.length = 0; },
		fechar: () => new Promise((ok) => srv.close(ok)),
	};
}
