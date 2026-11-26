import { unrewriteUrl } from "@rewriters/url";
import type { ScramjetClient } from "@client/index";
import {
	Array_isArray,
	Object_getOwnPropertyDescriptor,
	String_startsWith,
} from "@/shared/snapshot";
import { sha256Hex } from "@/shared/sha256";

// A origem que o V8 escreve num quadro de código compilado em tempo de execução.
//
// O `Function` e o `eval` indireto do site passam pelos invólucros do motor, e o V8 registra como
// origem do código quem chamou o compilador nativo: `eval at s (…/scramjet.js:21:139)`. No Chrome
// a origem é quem chamou o `Function`. O motor guarda, na hora de compilar, a origem que o Chrome
// escreveria, e o `prepareStackTrace` (ver `shared/error.ts`) a acha depois pelo hash do script,
// que é o SHA-256 da fonte que o V8 compilou (`CallSite.getScriptHash()`). O hash só é calculado
// quando uma pilha precisa dele, do registro mais novo para o mais velho.

type Registro = { fonte: () => string; origem: string };

const PENDENTES_MAX = 256;
const CONHECIDOS_MAX = 1024;

export class Compilacoes {
	pendentes: Registro[] = [];
	porHash = new Map<string, string>();
}

let capturando = false;

/** Verdadeiro enquanto `registrarCompilacao` lê a pilha crua. */
export const lendoPilhaCrua = () => capturando;

// Com `encapsulateWorkers`, o script de um worker é o carregador do motor, que importa o código do
// site por um `importScripts` na última linha. A pilha do site passaria por esse quadro, que no
// Chrome não existe. O endereço dele é o `location` nativo do worker, lido antes de qualquer
// script do site.
const carregadorDoWorker: string | null = (() => {
	try {
		if (typeof (self as any).WorkerGlobalScope !== "function") return null;
		if (!(self instanceof (self as any).WorkerGlobalScope)) return null;

		return String(self.location.href);
	} catch {
		return null;
	}
})();

export function mascarado(
	client: ScramjetClient,
	arquivo: string | null | undefined,
) {
	try {
		if (!arquivo) return false;
		if (
			arquivo === carregadorDoWorker &&
			client.flagEnabled("encapsulateWorkers")
		)
			return true;

		return client.config.maskedfiles.some((f) => arquivo.endsWith(f));
	} catch {
		return false;
	}
}

export function origemCitaMotor(
	client: ScramjetClient,
	origem: string | null | undefined,
) {
	try {
		return (
			!!origem && client.config.maskedfiles.some((f) => origem.includes(f))
		);
	} catch {
		return false;
	}
}

export function desreescrito(client: ScramjetClient, arquivo: string) {
	try {
		if (String_startsWith(arquivo, client.context.prefix.href))
			return unrewriteUrl(arquivo, client.context);
	} catch {}

	return arquivo;
}

/** A origem guardada para o script deste quadro, ou `null`. */
export function origemRegistrada(
	client: ScramjetClient,
	quadro: any,
): string | null {
	let hash: string;
	try {
		hash = quadro.getScriptHash();
	} catch {
		return null;
	}
	if (!hash) return null;

	const reg = client.box.compilacoes;
	const conhecida = reg.porHash.get(hash);
	if (conhecida !== undefined) return conhecida;

	while (reg.pendentes.length) {
		const r = reg.pendentes.pop()!;
		let h: string;
		try {
			h = sha256Hex(r.fonte());
		} catch {
			continue;
		}
		if (reg.porHash.size >= CONHECIDOS_MAX)
			reg.porHash.delete(reg.porHash.keys().next().value!);
		reg.porHash.set(h, r.origem);
		if (h === hash) return r.origem;
	}

	return null;
}

// O lugar como o V8 o escreve dentro de `eval at nome (lugar)`: arquivo, linha e coluna de um
// script, só `:linha:coluna` quando o script não tem nome; a `sourceURL` de um código avaliado que tem uma; e, para um código avaliado sem ela, a
// origem dele, sem linha.
function lugarDe(client: ScramjetClient, quadro: any): string {
	if (quadro.isEval()) {
		const url = quadro.getScriptNameOrSourceURL();
		if (url) return desreescrito(client, url);
		const origem: string = quadro.getEvalOrigin() || "";
		if (origemCitaMotor(client, origem))
			return origemRegistrada(client, quadro) ?? origem;

		return origem;
	}
	const arquivo = quadro.getFileName();
	const posicao = `:${quadro.getLineNumber()}:${quadro.getColumnNumber()}`;

	return arquivo ? desreescrito(client, arquivo) + posicao : posicao;
}

/** Os CallSites da pilha de quem chama, sem passar pelo `prepareStackTrace` do motor. */
export function quadrosCrus(client: ScramjetClient, limite = 64): any[] | null {
	const E = client.global.Error as any;
	let quadros: any[] | undefined;
	let descritor: PropertyDescriptor | undefined;
	try {
		descritor = Object_getOwnPropertyDescriptor(E, "stackTraceLimit");
	} catch {}
	// O limite do site conta os quadros do motor, que ficam acima do chamador; ele só é trocado
	// quando é um valor comum, para nenhum setter do site rodar.
	const troca = !!descritor && "value" in descritor && descritor.writable === true;
	capturando = true;
	try {
		if (troca) E.stackTraceLimit = limite;
		const alvo: any = {};
		E.captureStackTrace(alvo);
		quadros = alvo.stack;
	} catch {
	} finally {
		capturando = false;
		if (troca) {
			try {
				E.stackTraceLimit = descritor!.value;
			} catch {}
		}
	}

	return Array_isArray(quadros) ? quadros : null;
}

/**
 * Guarda a origem do código que o motor vai compilar agora em nome do site. `fonte` devolve o
 * texto exato que o compilador nativo recebe, montado só se uma pilha precisar dele.
 */
export function registrarCompilacao(
	client: ScramjetClient,
	fonte: () => string,
) {
	if (!client.flagEnabled("cleanErrors")) return;

	// Os quadros do motor ficam acima de quem chama, e quase sempre cabem em 16; a pilha longa só é
	// lida quando eles não couberam.
	let quadros: any[] | null = null;
	let i = 0;
	for (const limite of [16, 64]) {
		quadros = quadrosCrus(client, limite);
		if (!quadros) return;
		i = 0;
		while (i < quadros.length && mascarado(client, quadros[i].getFileName?.())) i++;
		if (i < quadros.length || quadros.length < limite) break;
	}
	if (!quadros || i >= quadros.length) return;

	let origem: string;
	try {
		const q = quadros[i];
		// O quadro do código avaliado se chama `eval` na pilha, e a função dele não tem nome: a
		// origem escreve `<anonymous>`.
		let nome = q.getFunctionName();
		if (nome === "eval" && q.isEval()) nome = null;
		origem = `eval at ${nome || "<anonymous>"} (${lugarDe(client, q)})`;
	} catch {
		return;
	}

	const reg = client.box.compilacoes;
	reg.pendentes.push({ fonte, origem });
	if (reg.pendentes.length > PENDENTES_MAX) reg.pendentes.shift();
}
