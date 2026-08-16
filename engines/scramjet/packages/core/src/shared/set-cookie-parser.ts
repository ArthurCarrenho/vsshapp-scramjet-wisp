// adapted from https://www.npmjs.com/package/set-cookie-parser, licensed MIT
// we'll be forever in the shadow of node-unblocker or something

type ParsedCookie = {
	name: string;
	value: string;
	expires?: Date;
	maxAge?: number;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: string;
	partitioned?: boolean;
	[key: string]: unknown;
};

const MAX_COOKIE_PAIR_BYTES = 4096;
const textEncoder = new TextEncoder();

function isNonEmptyString(str: unknown): str is string {
	return typeof str === "string" && !!str.trim();
}

function hasCtlCharacters(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (((code >= 0x00 && code <= 0x1f) || code === 0x7f) && code !== 0x09) {
			return true;
		}
	}

	return false;
}

function cookiePairByteLength(name: string, value: string): number {
	// RFC length checks ignore the '=' separator.
	return textEncoder.encode(`${name}${value}`).length;
}

function parseString(setCookieValue: string): ParsedCookie | null {
	const parts = setCookieValue.split(";");

	const nameValuePairStr = parts.shift();
	if (!nameValuePairStr) return null;
	if (!nameValuePairStr.trim()) return null;

	const parsed = parseNameValuePair(nameValuePairStr);
	if (!parsed) return null;

	const { name } = parsed;
	const { value } = parsed;

	const cookie: ParsedCookie = {
		name,
		value,
	};

	for (const part of parts.filter(isNonEmptyString)) {
		const sides = part.split("=");
		const key = (sides.shift() || "").trimStart().toLowerCase();
		const sideValue = sides.join("=");

		if (key === "expires") {
			cookie.expires = new Date(sideValue);
		} else if (key === "max-age") {
			cookie.maxAge = parseInt(sideValue, 10);
		} else if (key === "secure") {
			cookie.secure = true;
		} else if (key === "httponly") {
			cookie.httpOnly = true;
		} else if (key === "samesite") {
			cookie.sameSite = sideValue;
		} else if (key === "partitioned") {
			cookie.partitioned = true;
		} else {
			cookie[key] = sideValue;
		}
	}

	return cookie;
}

function parseNameValuePair(
	nameValuePairStr: string
): { name: string; value: string } | null {
	let name = "";
	let value = "";
	const nameValueArr = nameValuePairStr.split("=");

	if (nameValueArr.length > 1) {
		name = (nameValueArr.shift() || "").trim();
		value = nameValueArr.join("=").trim();
	} else {
		value = nameValuePairStr.trim();
	}

	if (!name && !value) {
		return null;
	}

	if (!name && /^__secure-|^__host-/i.test(value)) {
		return null;
	}

	if (hasCtlCharacters(name) || hasCtlCharacters(value)) {
		return null;
	}

	if (cookiePairByteLength(name, value) > MAX_COOKIE_PAIR_BYTES) {
		return null;
	}

	return { name, value };
}

function parse(input: string | undefined): ParsedCookie[] {
	if (!isNonEmptyString(input)) {
		return [];
	}

	// vssh fork: era `[input]` — uma string, um cookie. O `splitCookiesString` logo abaixo
	// existe exatamente para isto, está exportado, e **não era chamado por ninguém** (o
	// arquivo é vendorizado de `set-cookie-parser`, e a ligação se perdeu na vendorização).
	//
	// Por que importa: se a camada de transporte entregar dois `Set-Cookie` juntos num
	// header só — o que um proxy pode fazer, e o que não dá para descartar daqui sem medir
	// dentro do WASM do libcurl —, o `parseString` corta no primeiro `;` e `"a=1, b=2"`
	// vira o cookie `a` com valor `"1, b=2"`. Um cookie corrompido e outro perdido, calados.
	//
	// O preço de dividir sempre: um valor que contenha `, algo=` seria partido em dois. É
	// aceitável porque a RFC 6265 exclui a vírgula do `cookie-octet` (valor com vírgula tem
	// de vir entre aspas ou percent-encoded), e porque o corte só acontece quando depois da
	// vírgula vem mesmo um `nome=` — o que preserva `Expires=Wed, 09 Jun 2021 ...`, onde
	// depois da vírgula vem uma data.
	//
	// Com isto a resposta deixa de depender de qual formato o transporte usa: os dois
	// funcionam, e a medição que estava planejada não precisa mais decidir nada.
	return splitCookiesString(input)
		.map((str) => parseString(str))
		.filter((cookie): cookie is ParsedCookie => cookie !== null);
}

function splitCookiesString(cookiesString: unknown): string[] {
	if (Array.isArray(cookiesString)) {
		return cookiesString;
	}
	if (typeof cookiesString !== "string") {
		return [];
	}

	const source = cookiesString;

	const cookiesStrings: string[] = [];
	let pos = 0;
	let start = 0;
	let ch = "";
	let lastComma = 0;
	let nextStart = 0;
	let cookiesSeparatorFound = false;

	function skipWhitespace() {
		while (pos < source.length && /\s/.test(source.charAt(pos))) {
			pos += 1;
		}

		return pos < source.length;
	}

	function notSpecialChar() {
		ch = source.charAt(pos);
		return ch !== "=" && ch !== ";" && ch !== ",";
	}

	while (pos < source.length) {
		start = pos;
		cookiesSeparatorFound = false;

		while (skipWhitespace()) {
			ch = source.charAt(pos);
			if (ch === ",") {
				lastComma = pos;
				pos += 1;

				skipWhitespace();
				nextStart = pos;

				while (pos < source.length && notSpecialChar()) {
					pos += 1;
				}

				if (pos < source.length && source.charAt(pos) === "=") {
					cookiesSeparatorFound = true;
					pos = nextStart;
					cookiesStrings.push(source.substring(start, lastComma));
					start = pos;
				} else {
					pos = lastComma + 1;
				}
			} else {
				pos += 1;
			}
		}

		if (!cookiesSeparatorFound || pos >= source.length) {
			cookiesStrings.push(source.substring(start, source.length));
		}
	}

	return cookiesStrings;
}

export default parse;
export { parse, parseNameValuePair, parseString, splitCookiesString };
