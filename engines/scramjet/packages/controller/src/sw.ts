/// <reference lib="WebWorker" />
/// <reference types="@types/serviceworker" />
import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Controllerbound, SWbound } from "./types";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

// vssh fork: friendly HTML error page rendered when route() throws (network/libcurl
// failure, or an internal error like "No frame found for request"). Upstream returned
// plain text ("Internal Service Worker Error: ...", status 500) with no way to customize
// it. Self-contained HTML (inline CSS — the SW has no access to the page's DOM/CSSOM),
// theme-aware, with libcurl error codes mapped to human-readable Portuguese messages.
function renderErrorPage(error: Error): string {
	const message = error?.message || "Erro desconhecido";
	const codeMatch = /error code (\d+)/i.exec(message);
	const code = codeMatch ? parseInt(codeMatch[1], 10) : null;

	// libcurl error codes (CURLE_*) that surface most often through the wisp transport.
	const messages: Record<number, { title: string; detail: string }> = {
		6: {
			title: "Não foi possível resolver o endereço",
			detail: "O nome do servidor não pôde ser encontrado (DNS). Verifique se o endereço está correto.",
		},
		7: {
			title: "Não foi possível conectar ao servidor",
			detail: "A conexão foi recusada. O servidor pode estar fora do ar ou a porta pode estar errada.",
		},
		28: {
			title: "Tempo esgotado",
			detail: "O servidor demorou demais para responder.",
		},
		52: {
			title: "O servidor não respondeu nada",
			detail: "A conexão foi aberta mas fechada sem resposta. O serviço pode ter caído no meio da requisição.",
		},
		56: {
			title: "Falha ao receber dados",
			detail: "A conexão foi interrompida durante o recebimento da resposta.",
		},
		60: {
			title: "Certificado de segurança inválido",
			detail: "O certificado TLS deste site não pôde ser validado (por exemplo, um certificado autoassinado). É possível permitir certificados inválidos nas configurações do navegador, se você confia neste destino.",
		},
	};

	const friendly = code !== null ? messages[code] : undefined;
	const title = friendly?.title ?? "Não foi possível carregar a página";
	const detail =
		friendly?.detail ??
		"Ocorreu um erro ao processar a requisição através do motor de navegação.";

	const esc = (s: string) =>
		s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f7; color: #1d1d1f; padding: 24px;
  }
  .card {
    max-width: 480px; width: 100%; text-align: center;
    background: #fff; border-radius: 16px; padding: 40px 32px;
    box-shadow: 0 2px 24px rgba(0,0,0,.08);
  }
  .icon { font-size: 48px; line-height: 1; margin-bottom: 16px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; margin: 0 0 8px; color: #515154; }
  .code {
    margin-top: 20px; font-size: 12px; color: #86868b;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    word-break: break-word;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1d1d1f; color: #f5f5f7; }
    .card { background: #2c2c2e; box-shadow: 0 2px 24px rgba(0,0,0,.4); }
    p { color: #a1a1a6; }
    .code { color: #6e6e73; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${esc(title)}</h1>
    <p>${esc(detail)}</p>
    <div class="code">${esc(message)}</div>
  </div>
</body>
</html>`;
}

// vssh fork: distingue FALHA DE TRANSPORTE/REDE (libcurl/wisp: URL morta, host bloqueado, arquivo
// parcial, DNS, timeout, conexão recusada/resetada, stream abortado) de um BUG INTERNO do motor.
// Falha de rede é o comportamento normal da web — não deve poluir o console. Só bug inesperado
// merece log.
//
// ⚠ **A regra anterior casava PALAVRA SOLTA, e as palavras eram comuns demais:** `connection`,
// `closed`, `abort`, `stream`, `reset`, `refused`, `EOF`. Qualquer bug cuja mensagem contivesse
// uma delas passava por "falha de rede" e sumia do console.
//
// Não é hipótese: o caso mais caro deste stack é `connection.streams is not iterable`, o
// `TypeError` que crashava o processo do wisp na primeira conexão. Ele casa DUAS das palavras. E
// `/EOF/i` casa dentro de `typeof`, que aparece em mensagem de erro de motor a toda hora.
//
// Isto atrapalha depurar todo o resto: procurar um bug com um console que aprendeu a escondê-lo é
// procurar no escuro. As regras abaixo casam FRASE, não palavra, e olham o tipo do erro quando ele
// carrega essa informação.
function isTransportNetworkError(e: unknown): boolean {
	// `AbortError` e `NetworkError` são nomes de DOMException, não texto de mensagem — quando o erro
	// os carrega, o nome é evidência melhor que qualquer regex sobre a mensagem.
	const nome = (e as { name?: unknown })?.name;
	if (nome === "AbortError" || nome === "NetworkError" || nome === "TimeoutError") {
		return true;
	}

	const msg = e instanceof Error ? e.message : String(e ?? "");
	return (
		// libcurl-transport: as duas formas que ele lança de verdade.
		/Request failed with error code \d+|Request failed because redirects were disallowed/i.test(msg) ||
		/error code \d+/i.test(msg) ||
		/Transferred a partial/i.test(msg) ||
		// Rede, pelo vocabulário do próprio navegador.
		/Failed to fetch|NetworkError|Load failed|The operation was aborted/i.test(msg) ||
		// `errno` do lado do servidor — com fronteira de palavra, senão `EOF` casa `typeof`.
		/\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|EOF)\b/.test(msg) ||
		// Frases, não palavras soltas: "connection reset" é rede; "connection" sozinho é qualquer coisa.
		/(connection|socket|stream)\s+(closed|reset|refused|aborted|failed|lost|ended)/i.test(msg) ||
		/(closed|reset|refused|aborted) by (peer|remote|host)/i.test(msg) ||
		/\btimed?\s?out\b/i.test(msg) ||
		/host (blocked|not allowed)/i.test(msg)
	);
}

// vssh fork: condição de CICLO DE VIDA, não bug e não rede — o frame que iniciou a requisição já
// não existe quando ela chega ao controller.
//
// Acontece o tempo todo e é normal: uma aba fecha (ou navega) e os beacons que a página já tinha
// disparado continuam a caminho. O YouTube sozinho manda `stats/qoe` e `stats/watchtime` no
// `pagehide`, e os dois chegam depois do frame morrer.
//
// Isto precisa existir por causa do log que passou a sair no caminho de subrecurso: sem separar,
// fechar uma aba de vídeo enche o console de "Service Worker error" — e um console cheio de erro
// normal é tão ruim quanto um console que esconde erro de verdade. Era o defeito que o
// classificador acabou de consertar, chegando pela outra ponta.

// A aba avisou que estava fechando e nós rejeitamos o que estava em voo. É a MESMA condição de
// ciclo de vida da de baixo, chegando pelo outro lado: lá o frame já tinha morrido quando a
// requisição chegou ao controller, aqui a requisição já estava no controller quando a aba morreu.
// Um beacon de `pagehide` cai ora num caso, ora no outro, dependendo de quem correu mais.
const ABA_FECHADA = "A aba que atendia esta requisição foi fechada.";

function isFrameGoneError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e ?? "");
	if (msg.includes(ABA_FECHADA)) return true;

	return /No frame found for request|Port not found/i.test(msg);
}

const cookieResolvers: Record<string, (value: void) => void> = {};
addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (e.data.$sw$setCookieDone && typeof e.data.$sw$setCookieDone == "object") {
		const done = e.data.$sw$setCookieDone;

		const resolver = cookieResolvers[done.id];
		if (resolver) {
			resolver();
			delete cookieResolvers[done.id];
		}
	}

	if (
		e.data.$sw$initRemoteTransport &&
		typeof e.data.$sw$initRemoteTransport == "object"
	) {
		const { port, prefix } = e.data.$sw$initRemoteTransport;

		const relevantcontroller = tabs.find((tab) =>
			new URL(prefix).pathname.startsWith(tab.prefix)
		);
		if (!relevantcontroller) {
			console.error("No relevant controller found for transport init");
			return;
		}
		relevantcontroller.rpc.call("initRemoteTransport", port, [port]);
	}
});

class ControllerReference {
	rpc: RpcHelper<SWbound, Controllerbound>;

	constructor(
		public prefix: string,
		public id: string,
		port: MessagePort
	) {
		this.rpc = new RpcHelper(
			{
				sendSetCookie: async ({ cookies, options }) => {
					const clients = await self.clients.matchAll();
					const ids: string[] = [];
					const promises: Promise<string>[] = [];

					// Navigation fetches (document/iframe) deliver cookies via the inject
					// script's embedded cookieJar dump — the destination page doesn't have
					// inject.ts loaded yet to ack, so awaiting would deadlock. Broadcast
					// so any already-loaded clients can update their jars, but don't wait.
					const isNavigation =
						options?.destination === "document" ||
						options?.destination === "iframe";

					for (const client of clients) {
						const id = makeId();
						ids.push(id);
						client.postMessage({
							$controller$setCookie: {
								cookies,
								options,
								id,
							},
						});
						if (!isNavigation) {
							promises.push(
								new Promise<string>((resolve) => {
									// Resolve with the id so we know which client replied.
									cookieResolvers[id] = () => resolve(id);
								})
							);
						}
					}
					// Wait for the first client to acknowledge the cookie sync.
					// Using Promise.any (not Promise.all) so that extra SW clients created by
					// window.open (e.g. test popup windows) don't cause timeouts — only the
					// main controller client needs to respond.
					if (promises.length > 0) {
						let timeoutId: ReturnType<typeof setTimeout> | undefined;
						let responded = false;
						const timeoutPromise = new Promise<void>((resolve) => {
							timeoutId = setTimeout(() => {
								if (!responded) {
									const pending = ids.filter(
										(id) => cookieResolvers[id] !== undefined
									);
									console.error(
										"timed out waiting for set cookie response (deadlock?): " +
											`cookies=${cookies.length} clients=${clients.length} ` +
											`pending=${pending.length}/${ids.length} ` +
											`clientUrls=${clients.map((c) => c.url).join(",")}`
									);
								}
								resolve();
							}, 1000);
						});

						try {
							await Promise.race([
								timeoutPromise,
								Promise.any(promises)
									.then(() => {
										responded = true;
									})
									.catch(() => {}),
							]);
						} finally {
							// Clear the timeout so it doesn't fire spuriously after the
							// race has already been won by Promise.any.
							if (timeoutId !== undefined) clearTimeout(timeoutId);
							// Clean up any pending resolvers so clients that never
							// responded don't leak entries in cookieResolvers.
							for (const id of ids) {
								delete cookieResolvers[id];
							}
						}
					}
				},
			},
			"tabchannel-" + id,
			(data, transfer) => {
				port.postMessage(data, transfer);
			}
		);
		port.onmessage = (e: MessageEvent) => {
			this.rpc.recieve(e.data);
		};
		port.onmessageerror = console.error;

		this.rpc.call("ready", undefined);
	}
}

const tabs: ControllerReference[] = [];

addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (!e.data.$controller$init) return;
	if (typeof e.data.$controller$init != "object") return;
	const init = e.data.$controller$init;

	// vssh fork: **a referência antiga saía do array levando as chamadas em voo com ela.** Todo
	// `route()` que esperava resposta guardou `{resolve, reject}` no `RpcHelper` DAQUELA referência,
	// e o array acabou de esquecê-la. Quem está pendurado nessa promessa é o
	// `event.respondWith(route(event))` do fetch handler, e uma promessa que nunca assenta ali é a
	// aba girando para sempre — sem erro, sem página, sem nada no console.
	//
	// ⚠ Isto NÃO é o caso de "o outro lado sumiu", e a diferença decidiu o conserto. O controller
	// reconecta de rotina: o SW manda `$controller$swrevive` ~100 ms depois de ativar, sempre, e o
	// controller troca a porta — o que cai bem no meio do carregamento da página, com o script do
	// wasm e o inject em voo. Rejeitar ali derruba a página inteira.
	//
	// Medido, e foi o que me fez desfazer a primeira versão: rejeitando, a suíte completa passou a
	// acusar 383 `WASM not found in global scope!` onde antes havia ZERO — o script do wasm é
	// buscado por este mesmo caminho.
	//
	// A resposta dessas chamadas CHEGA: quem responde usa a porta corrente, e o `$token` continua
	// sendo o da chamada original. Ela só chegava no helper novo, que não conhecia aquele token e a
	// descartava. Adotar o mapa (e o contador junto — ver `adotarPendentes`) faz cada resposta
	// encontrar quem a espera, em vez de matar quem esperava.
	const existing = tabs.findIndex((t) => t.id === init.id);
	const anterior = existing !== -1 ? tabs.splice(existing, 1)[0] : null;

	const nova = new ControllerReference(init.prefix, init.id, e.ports[0]);
	if (anterior) nova.rpc.adotarPendentes(anterior.rpc);
	tabs.push(nova);
});

// vssh fork: **a aba se despede, e a entrada dela sai do array.** Sem isto `tabs` só perdia
// entrada quando um controller do MESMO id reconectava — aba fechada nunca saía. Cada entrada
// órfã segura uma `MessagePort` e um `RpcHelper` de um documento que não existe mais, dentro de
// um worker que sobrevive a todas as abas que abriu; numa sessão longa isso só cresce.
//
// E não é só memória: enquanto a entrada está de pé, `shouldRoute` responde `true` para o prefixo
// dela e `route` chama numa porta que ninguém atende.
//
// ⚠ Aqui SE REJEITA, e no bloco acima não — é a mesma distinção, lida ao contrário. Lá a porta foi
// trocada e a resposta ainda vem pela nova; aqui a aba acabou, e não há porta nova nem resposta
// nenhuma a esperar. Adotar o que está em voo não teria para quem entregar.
//
// É MELHOR ESFORÇO, e de propósito: só o `pagehide` sem bfcache avisa (ver o controller). Aba que
// morre por crash ou kill não manda nada, e a entrada dela continua vazando. A alternativa —
// varrer `clients` e podar quem não responde — troca um vazamento por um risco pior: se uma aba
// congelada no bfcache não aparecer na varredura, ela é podada viva e volta sem rota, que é
// exatamente o travamento que se está tentando matar.
addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (!e.data.$controller$bye) return;
	if (typeof e.data.$controller$bye != "object") return;

	const id = e.data.$controller$bye.id;
	const indice = tabs.findIndex((t) => t.id === id);
	if (indice === -1) return;

	const morta = tabs.splice(indice, 1)[0];
	morta.rpc.rejectPending(ABA_FECHADA);
});

export function shouldRoute(event: FetchEvent): boolean {
	const url = new URL(event.request.url);
	const tab = tabs.find((tab) => url.pathname.startsWith(tab.prefix));
	return tab !== undefined;
}

export async function route(event: FetchEvent): Promise<Response> {
	try {
		const url = new URL(event.request.url);
		const tab = tabs.find((tab) => url.pathname.startsWith(tab.prefix))!;
		const client = await clients.get(event.clientId);

		const rawheaders: RawHeaders = [...event.request.headers];

		const response = await tab.rpc.call(
			"request",
			{
				rawUrl: event.request.url,
				rawReferrer: event.request.referrer,
				destination: event.request.destination,
				mode: event.request.mode,
				referrer: event.request.referrer,
				method: event.request.method,
				body: event.request.body,
				cache: event.request.cache,
				forceCrossOriginIsolated: false,
				initialHeaders: rawheaders,
				rawClientUrl: client ? client.url : undefined,
				clientId: event.clientId || event.resultingClientId,
			},
			event.request.body instanceof ReadableStream ||
				// @ts-expect-error the types for fetchevent are messed up
				event.request.body instanceof ArrayBuffer
				? [event.request.body]
				: undefined
		);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (e) {
		// Subrecurso (script/img/xhr/fetch — tudo que NÃO é navegação principal): traduz a falha
		// num erro de rede REAL, como um navegador de verdade. O fetch() da página rejeita e
		// <img>/<script> disparam onerror, em vez de receber uma página HTML 500 como "conteúdo".
		// Sem console.error, sem 500: URL morta/host bloqueado é normal e não deve poluir nada.
		if (event.request.mode !== "navigate") {
			// vssh fork: **o `Response.error()` fica, o silêncio não.** Devolver erro de rede real ao
			// consumidor é o certo — é o que um navegador faz, e o `<img>`/`<script>`/`fetch()` da
			// página precisa disso para reagir. Mas isto era o único tratamento, então um BUG do motor
			// dentro do caminho de subrecurso desaparecia por completo: nada no console, nada na tela,
			// e o subrecurso simplesmente não vinha.
			//
			// O que a página vê continua idêntico; o que muda é ter rastro quando não é rede.
			if (!isTransportNetworkError(e) && !isFrameGoneError(e)) {
				console.error("Service Worker error (subrecurso):", event.request.url, e);
			}
			return Response.error();
		}
		// Navegação principal: mantém a página de erro legível (renderErrorPage) pra o usuário ver
		// que o site falhou. Loga só se for um erro INESPERADO (bug do motor), não falha de rede.
		if (!isTransportNetworkError(e)) console.error("Service Worker error:", e);
		return new Response(renderErrorPage(e as Error), {
			status: 500,
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}
}

addEventListener("install", () => {
	self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(clients.claim());
});

// the only way to know if a service worker has suddenly died is if this code runs again
// notify all clients to send over their messageports again
setTimeout(async () => {
	console.log("service worker activated, notifying clients to revive");
	for (const client of await clients.matchAll()) {
		client.postMessage({
			$controller$swrevive: {},
		});
	}
	// short delay is apparently needed
}, 100);
