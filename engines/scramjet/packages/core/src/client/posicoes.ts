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
	/** Os scripts do service worker: o quadro da chamada guarda o script, e o hash sai dele só quando uma pilha precisa. */
	doServiceWorker: { quadro: any; registro: Registro }[] = [];
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

/**
 * O comprimento de `buf.join(",")` sem montar o texto. O mapa de um script de 250 KB tem centenas
 * de milhares de números, e o `join` só para medir custava dezenas de milissegundos por script.
 */
function tamanhoDaLista(buf: ArrayLike<number>): number {
	const n = buf.length;
	if (n === 0) return 0;
	let total = n - 1;
	for (let i = 0; i < n; i++) {
		const v = buf[i];
		total += v >= 0 && v < 10 ? 1 : v >= 10 && v < 100 ? 2 : v >= 100 && v < 1000 && (v | 0) === v ? 3 : String(v).length;
	}

	return total;
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
	buf: ArrayLike<number> | string,
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
	// vssh fork: o hash do script (`getScriptHash`) é o SHA-256 do texto inteiro, e o V8 o calcula na
	// primeira pergunta: uns 6 ms num script de 250 KB. Ele fica para quando uma pilha precisar.
	let pos: number, linhaDaChamada: number;
	try {
		pos = q.getPosition();
		linhaDaChamada = q.getLineNumber();
	} catch {
		return;
	}
	if (typeof pos !== "number") return;
	// O texto da chamada, como `rewriteJsMapeado` o escreve. Depois de um "use strict" ela vem
	// atrás de um `;` a mais.
	const n =
		typeof buf === "string"
			? `${client.config.globals.pushsourcemapfn}("${buf}", "${tag}", ${linha}, ${coluna});`.length
			: `${client.config.globals.pushsourcemapfn}([], "${tag}", ${linha}, ${coluna});`.length + tamanhoDaLista(buf);
	const m = client.box.mapas;
	m.doServiceWorker.push({
		quadro: q,
		registro: {
			tag,
			ini: pos + n,
			d: -(n + (pos > 0 ? 1 : 0)),
			dl: linha - linhaDaChamada,
			primeira: linhaDaChamada,
			col0: coluna,
		},
	});
	if (m.doServiceWorker.length > PENDENTES_MAX) m.doServiceWorker.shift();
}

function registroDe(
	client: ScramjetClient,
	hash: string,
	avaliado: boolean,
): Registro | null {
	const m = client.box.mapas;
	const r = m.porHash.get(hash);
	if (r) return r;
	// Os scripts do service worker ainda sem hash: o deste quadro pode estar entre eles.
	if (m.doServiceWorker.length) {
		const fila = m.doServiceWorker;
		m.doServiceWorker = [];
		let achado: Registro | null = null;
		for (const p of fila) {
			let h = "";
			try {
				h = p.quadro.getScriptHash();
			} catch {}
			if (!h) continue;
			guardar(m, h, p.registro);
			if (h === hash) achado = p.registro;
		}
		if (achado) return achado;
	}
	// Os pendentes são o código do `Function` e do `eval`, e só um quadro de código avaliado pode
	// ser de um deles: o quadro de um script com arquivo não paga o hash de nenhum.
	if (!avaliado) return null;
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

/** Quanto texto uma troca acrescenta quando a posição `ate` já passou dela, ou parte dela. */
function deUma(r: any, ate: number): number {
	if (r.type === Tipo.Insere) return Math.min(r.size, ate - r.start);
	if (ate >= r.end) return r.end - r.start - r.str.length;

	return ate - r.start;
}

/** Quantas trocas começam antes de `pos`. */
function antesDe(rewrites: any[], pos: number): number {
	let lo = 0,
		hi = rewrites.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (rewrites[mid].start < pos) lo = mid + 1;
		else hi = mid;
	}

	return lo;
}

// A soma de cada troca inteira até cada índice, feita uma vez por mapa. Um script minificado é uma
// linha só, e somar as trocas do começo da linha até o quadro a cada pilha custaria milhares de
// passos por quadro.
const somas = new WeakMap<any[], Float64Array>();

function somaDe(rewrites: any[]): Float64Array {
	let s = somas.get(rewrites);
	if (s && s.length === rewrites.length + 1) return s;
	s = new Float64Array(rewrites.length + 1);
	for (let i = 0; i < rewrites.length; i++)
		s[i + 1] = s[i] + deUma(rewrites[i], Infinity);
	somas.set(rewrites, s);

	return s;
}

/** Quantos caracteres o rewriter pôs entre `de` e `ate`, no texto que ele devolveu. */
function crescimento(rewrites: any[], de: number, ate: number): number {
	const lo = antesDe(rewrites, de);
	const k = antesDe(rewrites, ate);
	if (k <= lo) return 0;
	const s = somaDe(rewrites);
	const ultima = rewrites[k - 1];

	return s[k - 1] - s[lo] + deUma(ultima, ate);
}

/** A linha e a coluna da fonte do site para um quadro, ou `null` quando elas não mudam. */
export function posicaoOriginal(
	client: ScramjetClient,
	quadro: any,
): [number, number, number, number] | null {
	let hash: string, p: number, L: number, C: number, avaliado: boolean;
	try {
		hash = quadro.getScriptHash();
		if (!hash) return null;
		avaliado = !!quadro.isEval();
		p = quadro.getPosition();
		L = quadro.getLineNumber();
		C = quadro.getColumnNumber();
	} catch {
		return null;
	}
	if (typeof p !== "number" || typeof L !== "number" || typeof C !== "number")
		return null;
	const r = registroDe(client, hash, avaliado);
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
