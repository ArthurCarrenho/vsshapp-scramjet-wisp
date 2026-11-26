import type { ScramjetClient } from "@client/index";
import { sha256Hex } from "@/shared/sha256";
import { quadrosCrus, mascarado } from "@client/pilha";

// vssh fork: a linha e a coluna que o Chrome escreveria num quadro de código reescrito.
//
// O rewriter acrescenta texto em toda função e em todo acesso que ele embrulha, e o service worker
// põe a chamada que entrega o mapa da reescrita numa linha própria no começo do script. O V8 conta
// as posições no texto que compilou, e o site que lê a própria pilha acha colunas maiores e uma
// linha a mais do que o Chrome daria para a mesma fonte. O mapa da reescrita (ver
// `shared/sourcemaps.ts`) diz quanto texto entrou antes de cada ponto. Cada script compilado é
// achado pelo hash da fonte (`CallSite.getScriptHash()`), e a posição do quadro volta à da fonte
// do site.
//
// O registro de um script diz como uma posição dele vira posição no texto que o rewriter
// devolveu: as posições a partir de `ini` andam `d` caracteres. A linha do quadro anda `dl`, que
// leva o script à linha em que ele começa no documento do site. Na linha `primeira`, a primeira do
// script, a coluna conta a partir de `col0`, que é onde o script começa nessa linha do documento.

const enum Tipo {
	Insere = 0,
	Troca = 1,
}

export type Registro = {
	tag: string;
	ini: number;
	d: number;
	dl: number;
	primeira: number;
	col0: number;
};

const PENDENTES_MAX = 256;
const CONHECIDOS_MAX = 2048;

export class MapasDeScript {
	porHash = new Map<string, Registro>();
	pendentes: { fonte: () => string; registro: Registro }[] = [];
	ultimaTag: string | null = null;
}

/** Guarda um script que o próprio cliente compila; o hash só se calcula se uma pilha pedir. */
export function registrarScript(
	client: ScramjetClient,
	fonte: () => string,
	registro: Registro,
) {
	const m = client.box.mapas;
	m.pendentes.push({ fonte, registro });
	if (m.pendentes.length > PENDENTES_MAX) m.pendentes.shift();
}

function guardar(m: MapasDeScript, hash: string, r: Registro) {
	if (m.porHash.size >= CONHECIDOS_MAX)
		m.porHash.delete(m.porHash.keys().next().value!);
	m.porHash.set(hash, r);
}

/**
 * O script que o service worker reescreveu chama a entrega do mapa no começo dele, com a linha e a
 * coluna em que o script começa no documento do site. O quadro de quem chama dá o hash e o lugar
 * da chamada.
 */
export function registrarDoServiceWorker(
	client: ScramjetClient,
	buf: ArrayLike<number>,
	tag: string,
	linha: number,
	coluna: number,
) {
	const quadros = quadrosCrus(client);
	if (!quadros) return;
	let i = 0;
	while (i < quadros.length && mascarado(client, quadros[i].getFileName?.())) i++;
	const q = quadros[i];
	if (!q) return;
	let hash: string, pos: number, linhaDaChamada: number;
	try {
		hash = q.getScriptHash();
		pos = q.getPosition();
		linhaDaChamada = q.getLineNumber();
	} catch {
		return;
	}
	if (!hash || typeof pos !== "number") return;
	// O texto da chamada, como `rewriteJsMapeado` o escreve. Depois de um "use strict" ela vem
	// atrás de um `;` a mais.
	const n = `${client.config.globals.pushsourcemapfn}([${Array.prototype.join.call(buf, ",")}], "${tag}", ${linha}, ${coluna});`.length;
	guardar(client.box.mapas, hash, {
		tag,
		ini: pos + n,
		d: -(n + (pos > 0 ? 1 : 0)),
		dl: linha - linhaDaChamada,
		primeira: linhaDaChamada,
		col0: coluna,
	});
}

function registroDe(client: ScramjetClient, hash: string): Registro | null {
	const m = client.box.mapas;
	const r = m.porHash.get(hash);
	if (r) return r;
	while (m.pendentes.length) {
		const p = m.pendentes.pop()!;
		let h: string;
		try {
			h = sha256Hex(p.fonte());
		} catch {
			continue;
		}
		guardar(m, h, p.registro);
		if (h === hash) return p.registro;
	}

	return null;
}

/** Quantos caracteres o rewriter pôs entre `de` e `ate`, no texto que ele devolveu. */
function crescimento(rewrites: any[], de: number, ate: number): number {
	let lo = 0,
		hi = rewrites.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (rewrites[mid].start < de) lo = mid + 1;
		else hi = mid;
	}
	let delta = 0;
	for (let i = lo; i < rewrites.length; i++) {
		const r = rewrites[i];
		if (r.start >= ate) break;
		if (r.type === Tipo.Insere) {
			delta += Math.min(r.size, ate - r.start);
		} else {
			const fim = r.end;
			if (ate >= fim) delta += fim - r.start - r.str.length;
			else delta += ate - r.start;
		}
	}

	return delta;
}

/** A linha e a coluna da fonte do site para um quadro, ou `null` quando elas não mudam. */
export function posicaoOriginal(
	client: ScramjetClient,
	quadro: any,
): [number, number, number, number] | null {
	let hash: string, p: number, L: number, C: number;
	try {
		hash = quadro.getScriptHash();
		if (!hash) return null;
		p = quadro.getPosition();
		L = quadro.getLineNumber();
		C = quadro.getColumnNumber();
	} catch {
		return null;
	}
	if (typeof p !== "number" || typeof L !== "number" || typeof C !== "number")
		return null;
	const r = registroDe(client, hash);
	if (!r || p < r.ini) return null;
	const rewrites = client.box.sourcemaps[r.tag];
	if (!rewrites) return null;
	const q = p + r.d;
	const coluna =
		L === r.primeira
			? r.col0 + 1 + q - crescimento(rewrites, 0, q)
			: C - crescimento(rewrites, Math.max(0, q - (C - 1)), q);
	const linha = L + r.dl;
	if (linha === L && coluna === C) return null;

	return [L, C, linha, coluna];
}
