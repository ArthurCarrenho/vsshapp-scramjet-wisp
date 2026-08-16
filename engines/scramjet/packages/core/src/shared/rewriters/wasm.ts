// i am a cat. i like to be petted. i like to be fed. i like to be
import { initSync, Rewriter } from "../../../rewriter/wasm/out/wasm.js";
import type { JsRewriterOutput } from "../../../rewriter/wasm/out/wasm.js";
import { flagEnabled, ScramjetContext } from "@/shared";

export type { JsRewriterOutput, Rewriter };

import { URLMeta } from "@rewriters/url";
import { Error, TextDecoder_decode } from "@/shared/snapshot";

let wasm_u8: Uint8Array;
export function setWasm(u8: Uint8Array | ArrayBuffer) {
	wasm_u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
}

const MAGIC = "\0asm".split("").map((x) => x.charCodeAt(0));

function initWasm() {
	if (!(wasm_u8 instanceof Uint8Array))
		throw new Error("rewriter wasm not found (was setWasm called?)");

	if (![...wasm_u8.slice(0, 4)].every((x, i) => x === MAGIC[i]))
		throw new Error(
			"rewriter wasm does not have wasm magic (was it fetched correctly?)\nrewriter wasm contents: " +
				TextDecoder_decode(wasm_u8)
		);

	initSync({
		module: new WebAssembly.Module(wasm_u8 as unknown as BufferSource),
	});
}

type RewriterBox = { rewriter: Rewriter; inUse: boolean };
const rewriters: RewriterBox[] = [];
export function getRewriter(
	context: ScramjetContext,
	meta: URLMeta
): [Rewriter, () => void] {
	initWasm();

	let obj: RewriterBox;
	const index = rewriters.findIndex((x) => !x.inUse);
	const len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			dbg.log(`creating new rewriter, ${len} rewriters made already`);

		const rewriter = new Rewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}

/**
 * vssh fork: joga o rewriter fora em vez de devolvê-lo ao pool.
 *
 * ⚠ O pool acima **nunca despeja ninguém**, então uma instância que entra em estado ruim volta a
 * ser entregue pelo resto da vida da página. E dá para entrar: o `wasm-snip` troca o corpo das
 * funções podadas por `unreachable`, e um trap do wasm sobe direto para o JS sem dar ao lado Rust
 * a menor chance de devolver o empréstimo que ele tinha tomado — dali em diante toda chamada
 * naquela instância falha com "Already rewriting".
 *
 * Como falha de reescrita caía no `allowInvalidJs` e devolvia a fonte ORIGINAL, um único trap
 * transformava o rewriter num cano furado: todo script seguinte servido **sem wrap**, em silêncio.
 * Código sem wrap enxerga a `location` e a origem reais — a mesma família do painel do YouTube e
 * do reCAPTCHA.
 *
 * O lado Rust repõe o próprio estado nos caminhos que ele controla (`Rewriter::restore`); isto
 * cobre os que ele não controla. É por isso que os dois existem.
 */
export function discardRewriter(rewriter: Rewriter) {
	const index = rewriters.findIndex((x) => x.rewriter === rewriter);
	if (index === -1) return;

	rewriters.splice(index, 1);

	try {
		rewriter.free();
	} catch {
		// já liberado, ou longe demais para liberar — o que importa aqui é soltar a referência
	}
}
