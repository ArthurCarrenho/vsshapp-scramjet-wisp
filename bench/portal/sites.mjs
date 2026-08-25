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
