// vssh fork: "que site é este?" — uma resposta só, para os três lugares que perguntavam.
//
// ─── O defeito que isto conserta ─────────────────────────────────────────────────────────
//
// Havia duas cópias de `registrableDomain`, as duas terminando em `labels.slice(-2)`. Para
// um host de sufixo multi-rótulo isso dá o SUFIXO, não o site: `folha.com.br` e `uol.com.br`
// viravam ambos `com.br`. Consequências, todas vivas:
//
//   - `computeSameSiteContext` respondia "same-site" para sites sem relação nenhuma, e aí o
//     `CookieJar` não aplicava filtro de `SameSite` — cookie de um ia para o outro. E o jar é
//     ÚNICO para todas as origens proxiadas, então isso é vazamento entre sites de verdade,
//     não curiosidade de mesma origem;
//   - `Sec-Fetch-Site` saía `same-site` onde um navegador de verdade manda `cross-site`;
//   - a detecção de redirect cross-site nunca disparava entre dois `.com.br`.
//
// ─── Por que uma LISTA, e não a PSL inteira ──────────────────────────────────────────────
//
// A Public Suffix List tem ~10 mil entradas e entraria no bundle que roda em toda página
// proxiada. A lista abaixo cobre os sufixos que aparecem de verdade aqui, e o caso brasileiro
// em primeiro lugar — que é onde o defeito foi notado.
//
// ⚠ **E o fallback é o comportamento ANTIGO, de propósito:** sufixo desconhecido continua
// caindo em "últimos dois rótulos". Ou seja, isto nunca regride nada — só acerta mais. O
// preço honesto de não ter a PSL é que um sufixo fora da lista segue com o defeito, e a saída
// é acrescentá-lo aqui.
const SUFIXOS_MULTI = new Set([
	// Brasil
	"com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br", "eco.br",
	// Reino Unido
	"co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "ltd.uk", "plc.uk",
	// Austrália / Nova Zelândia
	"com.au", "net.au", "org.au", "edu.au", "gov.au", "co.nz", "org.nz", "net.nz",
	// Japão / Coreia / China / Taiwan / Hong Kong / Singapura / Índia
	"co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
	"co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "gov.cn",
	"com.tw", "com.hk", "com.sg", "co.in", "net.in", "org.in",
	// América Latina
	"com.ar", "com.mx", "com.co", "com.pe", "com.uy", "com.ve", "com.ec", "com.bo",
	// Outros que aparecem com frequência
	"co.za", "com.tr", "com.pl", "co.il", "com.ua", "com.ru", "com.my", "com.ph",
	"com.vn", "com.eg", "com.sa", "com.pk", "com.ng",
]);

/**
 * O "site registrável" (eTLD+1) de um hostname, para comparação de mesmo-site.
 *
 * IP (v4 ou v6) e hostname sem ponto são eles mesmos.
 */
export function siteRegistravel(hostname: string): string {
	if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;

	const labels = hostname.split(".");
	if (labels.length <= 1) return hostname;
	if (labels.length === 2) return hostname;

	// ⚠ O `www.` NÃO é tratado como caso especial aqui, e isso é conserto e não omissão: o
	// código antigo devolvia `example.com` para `www.example.com` por um `if` próprio, e o
	// mesmo `if` devolvia `folha.com.br` para `www.folha.com.br` — certo por acidente. Com o
	// sufixo conhecido, os dois caem na regra geral e dão a mesma resposta, sem exceção.
	const doisUltimos = labels.slice(-2).join(".");
	// A heurística entra junto com a lista, e pelo mesmo motivo: são as duas metades da MESMA
	// pergunta. Sem ela, `loja.co.ke` e `banco.co.ke` respondiam ambos `co.ke` — dois sites sem
	// relação nenhuma tratados como o mesmo, que é exatamente o defeito que a lista veio corrigir
	// para o Brasil e deixou aberto para o resto do mundo.
	if (
		(SUFIXOS_MULTI.has(doisUltimos) || pareceSufixoPublico(doisUltimos)) &&
		labels.length >= 3
	) {
		return labels.slice(-3).join(".");
	}

	return doisUltimos;
}

/**
 * O host `hostname` casa com o atributo `Domain=` de um cookie? (RFC 6265 §5.1.3)
 *
 * ⚠ **Sem isto, o `CookieJar` guardava qualquer `Domain=` que chegasse.** Um site proxiado
 * podia mandar `Set-Cookie: x=1; Domain=google.com` e o jar guardava e depois ENVIAVA para o
 * google. Como todas as origens proxiadas compartilham um jar só, é injeção entre sites — e a
 * leitura na outra direção também: bastava setar `Domain=` num sufixo amplo para receber de
 * volta o que os outros escreveram.
 */
export function dominioCasa(hostname: string, domain: string): boolean {
	const host = hostname.toLowerCase().replace(/\.$/, "");
	const dom = domain.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
	if (!dom) return false;
	if (host === dom) return true;
	// Sufixo, e na fronteira de rótulo: "evil-example.com" não casa com "example.com".
	if (!host.endsWith("." + dom)) return false;
	// IP não faz sub-domínio: `Domain=` num IP só vale para ele mesmo, já coberto acima.
	if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
	// E o `Domain=` não pode ser um sufixo público: `Domain=com.br` valeria para o país
	// inteiro. É o mesmo teste do `siteRegistravel`, visto do outro lado.
	if (SUFIXOS_MULTI.has(dom)) return false;
	if (!dom.includes(".")) return false; // TLD puro: `Domain=com`
	if (pareceSufixoPublico(dom)) return false;
	return true;
}

// Segundos níveis genéricos: os rótulos que registros nacionais usam para dividir o país em
// categorias, em vez de vender direto no segundo nível.
const SEGUNDO_NIVEL_GENERICO = new Set([
	"com", "net", "org", "edu", "gov", "mil", "int",
	"ac", "co", "or", "ne", "go", "in", "id", "sch", "gob", "nom", "web", "biz", "info",
]);

/**
 * `dom` PARECE um sufixo público que não está na lista fixa?
 *
 * ⚠ Isto existe porque a lista cobre ~60 sufixos e o mundo tem milhares. **Medido**: `co.ke` e
 * `com.gh` passavam pela conferência de `Domain=` — um site sob um sufixo não listado podia escrever
 * cookie para o país inteiro, e LER o que os vizinhos escreveram, já que o jar é um só para todas as
 * origens proxiadas. A lista acertava o Brasil e deixava o Quênia aberto, sem que nada no código
 * dissesse isso.
 *
 * A regra: DOIS rótulos, o último com exatamente duas letras (ccTLD) e o primeiro sendo um segundo
 * nível genérico. Cobre `co.ke`, `com.gh`, `org.mz`, `ne.tz` — a forma que os registros nacionais
 * usam — sem tocar em domínio registrável de verdade: `google.de` tem `google` no primeiro rótulo,
 * `go.com` termina em três letras.
 *
 * O preço, dito na cara: um domínio registrável que POR ACASO tenha essa forma (registrar `co.tv`,
 * num TLD que vende no segundo nível) é recusado indevidamente. É a troca deliberada — errar
 * fechando um caso raro em vez de errar abrindo duzentos países. Quem topar com um assim acrescenta
 * a exceção aqui, e o teste ao lado nomeia o caso.
 */
function pareceSufixoPublico(dom: string): boolean {
	const rotulos = dom.split(".");
	if (rotulos.length !== 2) return false;
	const [primeiro, ultimo] = rotulos;
	return ultimo.length === 2 && SEGUNDO_NIVEL_GENERICO.has(primeiro);
}
