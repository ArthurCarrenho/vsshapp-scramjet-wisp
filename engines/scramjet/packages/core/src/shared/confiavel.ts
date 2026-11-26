import type { ScramjetClient } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";

// vssh fork: os valores de Trusted Types que o motor reescreve.
//
// Num documento que exige Trusted Types (`require-trusted-types-for 'script'`, que a CSP de um
// `<meta>` traz até o navegador, ver `politicaDoMeta`), o `eval`, o `Function`, o texto de um
// `<script>` e o `innerHTML` só aceitam o objeto de uma política. Uma string vai à política padrão
// do site, que a aprova ou recusa. O motor reescreve o valor antes de ele chegar ao navegador, e o
// que sai da reescrita é uma string: sem cuidado, a política do site recebia o código do motor, e
// o código que ela liberou chegava ao navegador como string recusada. O quadro do Turnstile para no
// primeiro `Function` assim.
//
// O caminho de cada valor fica o de um navegador sem o motor. Um objeto da política do site já foi
// liberado, e a reescrita dele volta embrulhada pela política do motor. Uma string vai à política
// padrão do site uma vez, com o texto que a página escreveu: aprovada, a reescrita volta
// embrulhada; recusada, a reescrita segue como string e o navegador a recusa com o erro dele. A
// tradução da CSP acrescenta o nome da política do motor à diretiva `trusted-types` do site.
export const POLITICA_DO_MOTOR = "scramjet";

export type TipoConfiavel =
	| "TrustedScript"
	| "TrustedHTML"
	| "TrustedScriptURL";

const politicas = new WeakMap<object, { politica: any; identidade: unknown }>();
const exigidos = new WeakSet<object>();

// A política mora no global, sob um símbolo compartilhado: o realm de um quadro filho pode ter o
// cliente instalado pelo motor do pai e depois carregar o próprio, e os dois usam a mesma.
const POLITICA_NO_GLOBAL = Symbol.for("scramjet trusted types policy");

function politicaDe(client: ScramjetClient): any {
	const global = client.global as any;
	let identidade: unknown;
	try {
		identidade = global.String;
	} catch {
		return null;
	}
	// O `Window` do about:blank inicial continua o mesmo quando o quadro carrega um documento da
	// mesma origem, e o realm antigo morre com o documento antigo. A política guardada nesse
	// `Window` chama o `String` do realm morto e falha com "The provided callback is no longer
	// runnable"; o `String` do global ter mudado é o sinal de que ela precisa ser criada de novo.
	const guardada = politicas.get(global);
	if (guardada && guardada.identidade === identidade) return guardada.politica;
	let politica = null;
	try {
		const noGlobal = global[POLITICA_NO_GLOBAL];
		if (noGlobal && noGlobal.identidade === identidade) {
			politica = noGlobal.politica;
		} else {
			// As funções da política são o `String` do próprio realm, que devolve a string que recebe.
			// Uma função do motor de outro quadro morreria com ele, e o motor de um quadro filho cria
			// a política do pai pelo `postMessage`. A segunda criação com o mesmo nome no mesmo
			// `Window` cabe porque a tradução da CSP acrescenta 'allow-duplicates' (`politicaDoMeta`).
			politica = global.trustedTypes?.createPolicy(POLITICA_DO_MOTOR, {
				createHTML: identidade,
				createScript: identidade,
				createScriptURL: identidade,
			});
			if (politica) {
				Object_defineProperty(global, POLITICA_NO_GLOBAL, {
					value: { politica, identidade },
					configurable: true,
				});
			}
		}
	} catch {
		politica = null;
	}
	politicas.set(global, { politica, identidade });

	return politica;
}

function metaExige(client: ScramjetClient, doc: Document): boolean {
	let metas: ArrayLike<Element>;
	try {
		metas = client.natives.call(
			"Document.prototype.querySelectorAll",
			doc,
			'meta[http-equiv="content-security-policy" i]',
		);
	} catch {
		return false;
	}
	for (let i = 0; i < metas.length; i++) {
		const politica =
			client.natives.call(
				"Element.prototype.getAttribute",
				metas[i],
				"scramjet-attr-content",
			) || "";
		if (/require-trusted-types-for\s+'script'/i.test(politica)) return true;
	}

	return false;
}

/**
 * Se o documento exige Trusted Types, pela CSP de um `<meta>` (a política original fica no atributo
 * guardado). Um `about:blank` herda a CSP de quem o criou, que é o quadro pai.
 */
export function exigeConfiavel(client: ScramjetClient): boolean {
	const doc = (client.global as any).document;
	if (!doc) return false;
	if (exigidos.has(doc)) return true;

	let win: any = client.global;
	let atual: Document = doc;
	for (let nivel = 0; nivel < 8; nivel++) {
		if (metaExige(client, atual)) {
			exigidos.add(doc);

			return true;
		}
		let href = "";
		try {
			href = String(win.location.href);
		} catch {
			return false;
		}
		if (!href.startsWith("about:")) return false;
		let pai: any;
		try {
			pai = win.parent;
			if (!pai || pai === win) return false;
			atual = pai.document;
		} catch {
			return false;
		}
		win = pai;
	}

	return false;
}

export function ehConfiavel(
	client: ScramjetClient,
	valor: unknown,
	tipo: TipoConfiavel,
): boolean {
	return (
		valor != null &&
		typeof valor === "object" &&
		client.box.instanceof(valor, tipo)
	);
}

/**
 * Se o realm do cliente roda código. Um quadro sandbox sem 'allow-scripts' não roda: o `eval` nele
 * é recusado, e antes da recusa o navegador ainda registra uma violação de Trusted Types, que a
 * página vê pelo evento `securitypolicyviolation`. O motor não compila nada num realm assim.
 */
export function podeRodar(client: ScramjetClient): boolean {
	const politica = politicaDe(client);
	if (!politica) return true;
	try {
		politica.createScript("");

		return true;
	} catch {
		return false;
	}
}

export function embrulhar<T>(
	client: ScramjetClient,
	tipo: TipoConfiavel,
	valor: T,
): T {
	if (typeof valor !== "string") return valor;
	const politica = politicaDe(client);
	if (!politica) return valor;
	// Um quadro sandbox sem 'allow-scripts' não roda função nenhuma do próprio realm, nem a da
	// política ("The provided callback is no longer runnable"). Nada executa ali, então a string
	// segue, e o navegador a recusa como recusaria a do site.
	try {
		if (tipo === "TrustedScript") return politica.createScript(valor);
		if (tipo === "TrustedHTML") return politica.createHTML(valor);

		return politica.createScriptURL(valor);
	} catch {
		return valor;
	}
}

/**
 * O valor reescrito com o tipo que o `original` teria no sink. `reescrever` recebe o texto que o
 * navegador usaria e devolve a reescrita dele. `sink` é o nome que o navegador passa à política
 * padrão ("eval", "Element innerHTML"...); sem ele, o valor não vai a um sink.
 *
 * O texto que a política padrão devolve é o que o navegador usa, e é ele que se reescreve. Uma
 * política pode trocar o texto: a do quadro do Cloudflare devolve "" para tudo, e um `innerHTML`, o
 * texto de um `<script>` ou o `setTimeout` de uma string ali ficam vazios. Reescrever o original no
 * lugar do que ela devolveu rodaria o código que o navegador teria descartado.
 */
export function comoOriginal<T>(
	client: ScramjetClient,
	tipo: TipoConfiavel,
	original: unknown,
	reescrever: (texto: string) => T,
	sink?: string,
): T {
	const tipado = (r: T): T =>
		typeof r === "string" ? embrulhar(client, tipo, r) : r;
	if (ehConfiavel(client, original, tipo))
		return tipado(reescrever(String(original)));
	if (!sink || typeof original === "object" || !exigeConfiavel(client))
		return reescrever(String(original));

	const padrao = (client.global as any).trustedTypes?.defaultPolicy;
	if (!padrao) return reescrever(String(original));
	const metodo =
		tipo === "TrustedScript"
			? "createScript"
			: tipo === "TrustedHTML"
				? "createHTML"
				: "createScriptURL";
	const aprovado = padrao[metodo](String(original), sink);
	if (aprovado == null) return reescrever(String(original));

	// O `eval` é a exceção medida: o Chrome só pede a aprovação à política, e compila o texto que
	// a página passou.
	return tipado(reescrever(sink === "eval" ? String(original) : String(aprovado)));
}
