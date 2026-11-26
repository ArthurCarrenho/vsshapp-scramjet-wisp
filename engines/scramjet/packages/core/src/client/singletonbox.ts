import { IncrementalHtmlRewriter } from "@/shared";
import { ScramjetClient } from "./client";
import { SourceMaps } from "./shared/sourcemaps";
import { Compilacoes } from "./pilha";
import { MapasDeScript } from "./posicoes";
import { Object_getOwnPropertyDescriptor, Object_keys } from "@/shared/snapshot";

// Os nomes que o motor passa ao `instanceof` da caixa. Um nome novo funciona sem estar aqui, mas é
// lido na primeira pergunta, e o site pode ter trocado o construtor antes.
const NOMES_DO_INSTANCEOF = [
	"Attr", "Document", "DocumentFragment", "Element", "Error", "HTMLScriptElement", "HTMLStyleElement",
	"HTMLTemplateElement", "MathMLElement", "Node", "Object", "Request", "SVGElement",
	"SVGForeignObjectElement", "SVGScriptElement", "Text", "TrustedHTML", "TrustedScript",
	"TrustedScriptURL", "Window",
];

export class SingletonBox {
	clients: ScramjetClient[] = [];
	/** Os clientes dos ouvintes de evento em execução, o mais recente no fim (ver `dom/open.ts`). */
	entradas: ScramjetClient[] = [];
	/** Os `blob:` que o site revogou, no endereço do motor (ver `shared/blob.ts`). */
	blobsRevogados = new Set<string>();
	globals: Map<Self, ScramjetClient> = new Map();
	documents: Map<Document, ScramjetClient> = new Map();
	histories: Map<History, ScramjetClient> = new Map();
	locations: Map<Location, ScramjetClient> = new Map();
	writeRewriters = new WeakMap<Document, IncrementalHtmlRewriter>();
	// De cada função do motor para a nativa que ela cobre. As chaves são fracas: a função que cobre
	// o `postMessage` de um objeto da página (ver `shared/postmessage.ts`) vai embora com ele.
	unproxy = new WeakMap<any, any>();

	ctors: Record<string, Function[]> = {};

	sourcemaps: SourceMaps = {};

	// O texto que um `toString` devolve para cada função que o `Function` do motor compilou: o que
	// o `Function` nativo devolveu para os argumentos do site (ver `shared/function.ts`).
	fontesDinamicas = new WeakMap<Function, string>();
	compilacoes = new Compilacoes();
	mapas = new MapasDeScript();

	constructor(public ownerclient: ScramjetClient) {}

	registerClient(client: ScramjetClient, global: Self) {
		this.clients.push(client);
		this.globals.set(global, client);
		this.documents.set(global.document, client);
		this.locations.set(global.location, client);
		this.histories.set(global.history, client);

		this.globaisRegistrados.push(global);
		// vssh fork: os construtores são lidos agora, antes do código do site, que pode trocar
		// `window.HTMLScriptElement` e fazer o `instanceof` do motor responder errado. Só os nomes
		// que o motor pergunta: percorrer os mil nomes do `window` custava uns 5 ms por documento.
		for (const prop of NOMES_DO_INSTANCEOF) this.capturar(global, prop);
		for (const prop of Object_keys(this.ctors))
			if (!NOMES_DO_INSTANCEOF.includes(prop)) this.capturar(global, prop);
	}

	private globaisRegistrados: Self[] = [];

	private capturar(global: Self, prop: string) {
		const desc = Object_getOwnPropertyDescriptor(global, prop);
		if (desc && typeof desc.value === "function") {
			if (!this.ctors[prop]) this.ctors[prop] = [];
			this.ctors[prop].push(desc.value);
		}
	}

	instanceof(obj: any, name: string): boolean {
		let ctors = this.ctors[name];
		if (!ctors) {
			// Um nome fora da lista é lido dos globais já registrados na primeira pergunta.
			for (const g of this.globaisRegistrados) this.capturar(g, name);
			ctors = this.ctors[name];
		}
		if (!ctors) {
			dbg.error(`No constructors for ${name} found`);
			return false;
		}
		for (const ctor of ctors) {
			// eslint-disable-next-line scramjet-core/no-instanceof
			if (obj instanceof ctor) return true;
		}
		return false;
	}
}
