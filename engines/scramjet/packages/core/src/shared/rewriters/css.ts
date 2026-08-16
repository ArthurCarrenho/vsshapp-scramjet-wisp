import { URLMeta, rewriteUrl, unrewriteUrl } from "@rewriters/url";
import { flagEnabled, ScramjetContext } from "@/shared";
import { String } from "@/shared/snapshot";

export function rewriteCss(
	css: string,
	context: ScramjetContext,
	meta: URLMeta
) {
	return handleCss("rewrite", css, context, meta);
}

export function unrewriteCss(css: string, context: ScramjetContext) {
	return handleCss("unrewrite", css, context);
}

function handleCss(
	type: "rewrite" | "unrewrite",
	css: string,
	context: ScramjetContext,
	meta?: URLMeta
) {
	// vssh fork: substitui o regex compartilhado (vk6/ading2210) por um tokenizer com estado. O
	// regex casava `url(`/`@import` DENTRO de comentários `/* */` e de strings de seletor (ex.:
	// `[style*="url(..."]`), reescrevendo URLs fantasma e às vezes capturando através de tokens.
	// O tokenizer varre respeitando fronteiras: só reescreve url()/@import em posição real de valor.
	css = String(css);
	const n = css.length;
	const encode = (u: string) =>
		type === "rewrite"
			? rewriteUrl(u.trim(), context, meta!)
			: unrewriteUrl(u.trim(), context);

	// Só na ida, e só quando há meta (o unrewrite devolve CSS pra página e não deve inventar
	// diferença: o que foi descartado na ida já não está no CSSOM pra ser lido de volta).
	const dropViewTransitions =
		type === "rewrite" &&
		!!meta &&
		flagEnabled("disableViewTransitions", context, meta.base);

	const isWs = (c: string) =>
		c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
	const isIdent = (c: string) => {
		if (!c) return false;
		const code = c.charCodeAt(0);
		return (
			(code >= 48 && code <= 57) ||
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			code === 45 ||
			code === 95
		);
	};

	let out = "";
	let i = 0;

	// css[start] é a aspa de abertura; devolve índice APÓS a aspa de fechamento (respeita \")
	const scanString = (start: number) => {
		const q = css[start];
		let j = start + 1;
		while (j < n) {
			const c = css[j];
			if (c === "\\") {
				j += 2;
				continue;
			}
			if (c === q) return j + 1;
			j++;
		}
		return n;
	};

	// processa url(...) a partir de i (case-insensitive). Retorna true se consumiu.
	const tryUrl = () => {
		if (i + 4 > n) return false;
		if (css.slice(i, i + 3).toLowerCase() !== "url" || css[i + 3] !== "(")
			return false;
		// fronteira: char anterior não pode ser ident (evita casar `myurl(`)
		if (isIdent(css[i - 1])) return false;

		const prefix = css.slice(i, i + 4); // preserva a caixa: url( / URL( / uRl(
		let j = i + 4;
		while (j < n && isWs(css[j])) j++;

		if (css[j] === '"' || css[j] === "'") {
			const q = css[j];
			const end = scanString(j);
			const inner = css.slice(j + 1, end - 1);
			let k = end;
			while (k < n && isWs(css[k])) k++;
			if (css[k] !== ")") return false; // url() malformado: deixa o scan normal seguir
			out += inner === "" ? css.slice(i, k + 1) : prefix + q + encode(inner) + q + ")";
			i = k + 1;
			return true;
		}

		// unquoted: lê até ')'
		let k = j;
		while (k < n && css[k] !== ")") {
			if (css[k] === "\\") {
				k += 2;
				continue;
			}
			k++;
		}
		if (k >= n) return false; // sem ')' de fechamento
		const inner = css.slice(j, k).trim();
		out += inner === "" ? css.slice(i, k + 1) : prefix + encode(inner) + ")";
		i = k + 1;
		return true;
	};

	// processa @import "..." a partir de i (a forma url() cai no tryUrl). Retorna true se consumiu.
	const tryImport = () => {
		if (css.slice(i, i + 7).toLowerCase() !== "@import") return false;
		if (isIdent(css[i + 7])) return false;
		let j = i + 7;
		if (j < n && !isWs(css[j])) return false;
		while (j < n && isWs(css[j])) j++;
		if (css[j] !== '"' && css[j] !== "'") return false;
		const q = css[j];
		const end = scanString(j);
		const inner = css.slice(j + 1, end - 1);
		out += css.slice(i, j) + q + encode(inner) + q;
		i = end;
		return true;
	};

	// Descarta a at-rule `@view-transition` inteira. É ela que liga a view transition de
	// NAVEGAÇÃO, que não passa por `document.startViewTransition` — logo, o proxy do lado
	// cliente (client/dom/viewtransition.ts) não alcança este caso, e a cascata também não:
	// não existe valor de `navigation` que "desligue por cima" de forma confiável em toda
	// folha. Remover é o único jeito determinístico. Ver ScramjetFlags.disableViewTransitions
	// para o crash de compositor que motiva isso.
	const tryViewTransition = () => {
		if (!dropViewTransitions) return false;
		if (css.slice(i, i + 16).toLowerCase() !== "@view-transition") return false;
		if (isIdent(css[i + 16])) return false; // fronteira: não casar @view-transitions-x

		let j = i + 16;
		while (j < n && isWs(css[j])) j++;

		// Forma sem bloco (`@view-transition;`) — inválida na prática, mas consumir é mais
		// seguro que deixar um `@view-transition` órfão no output.
		if (css[j] === ";") {
			i = j + 1;
			return true;
		}
		if (css[j] !== "{") return false; // algo inesperado: deixa o scan normal seguir

		let depth = 0;
		while (j < n) {
			const c = css[j];
			if (c === "/" && css[j + 1] === "*") {
				const close = css.indexOf("*/", j + 2);
				j = close === -1 ? n : close + 2;
				continue;
			}
			if (c === '"' || c === "'") {
				j = scanString(j); // uma `}` dentro de string não fecha bloco nenhum
				continue;
			}
			if (c === "{") {
				depth++;
			} else if (c === "}") {
				depth--;
				if (depth === 0) {
					j++;
					break;
				}
			}
			j++;
		}
		i = j;

		return true;
	};

	while (i < n) {
		const c = css[i];
		if (c === "/" && css[i + 1] === "*") {
			const close = css.indexOf("*/", i + 2);
			const end = close === -1 ? n : close + 2;
			out += css.slice(i, end);
			i = end;
			continue;
		}
		// string standalone (seletor, content, …): copia verbatim, nunca reescreve
		if (c === '"' || c === "'") {
			const end = scanString(i);
			out += css.slice(i, end);
			i = end;
			continue;
		}
		if (c === "@" && (tryViewTransition() || tryImport())) continue;
		if ((c === "u" || c === "U") && tryUrl()) continue;
		out += c;
		i++;
	}

	return out;
}
