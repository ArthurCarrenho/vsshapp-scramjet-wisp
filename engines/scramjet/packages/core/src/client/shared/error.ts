import { unrewriteUrl } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import {
	lendoPilhaCrua,
	mascarado as quadroDoMotor,
	origemCitaMotor,
	origemRegistrada,
} from "@client/pilha";
import { posicaoOriginal } from "@client/posicoes";
import {
	Object_defineProperty,
	Reflect_apply,
	String_startsWith,
} from "@/shared/snapshot";

type Quadro = {
	cru: any;
	origem: [string, string] | null;
	pos: [number, number, number, number] | null;
	arquivo: string | null;
	texto?: string;
};

const METODOS_DO_SITIO = [
	"getThis",
	"getTypeName",
	"getFunction",
	"getFunctionName",
	"getMethodName",
	"getFileName",
	"getLineNumber",
	"getColumnNumber",
	"getEvalOrigin",
	"isToplevel",
	"isEval",
	"isNative",
	"isConstructor",
	"isAsync",
	"isPromiseAll",
	"getPromiseIndex",
	"getScriptNameOrSourceURL",
	"getScriptHash",
	"getEnclosingColumnNumber",
	"getEnclosingLineNumber",
	"getPosition",
	"toString",
];

const crus = new WeakMap<object, Quadro>();
const prototipos = new WeakMap<ScramjetClient, object>();

/**
 * O CallSite que o formatador do site recebe: os métodos do V8, com o arquivo, a linha, a coluna
 * e a origem do eval do site no lugar dos do motor.
 */
function sitioDe(client: ScramjetClient, q: Quadro): object {
	let proto = prototipos.get(client);
	if (!proto) {
		proto = {};
		for (const nome of METODOS_DO_SITIO) {
			const fn = {
				[nome](this: object) {
					const d = crus.get(this);
					if (!d) throw new TypeError(`CallSite method ${nome} expects CallSite as receiver`);
					switch (nome) {
						case "getFileName":
						case "getScriptNameOrSourceURL":
							return d.arquivo ?? d.cru[nome]();
						case "getLineNumber":
							return d.pos ? d.pos[2] : d.cru.getLineNumber();
						case "getColumnNumber":
							return d.pos ? d.pos[3] : d.cru.getColumnNumber();
						case "getEvalOrigin": {
							const o = d.cru.getEvalOrigin();
							return d.origem && typeof o === "string" ? o.replace(d.origem[0], d.origem[1]) : o;
						}
						case "toString":
							return d.texto ?? String(d.cru);
					}

					return d.cru[nome]();
				},
			}[nome];
			client.box.fontesDinamicas.set(fn, `function ${nome}() { [native code] }`);
			Object_defineProperty(proto, nome, {
				value: fn,
				writable: true,
				enumerable: false,
				configurable: true,
			});
		}
		prototipos.set(client, proto);
	}
	const sitio = Object.create(proto);
	crus.set(sitio, q);

	return sitio;
}

export const enabled = (client: ScramjetClient) =>
	client.flagEnabled("cleanErrors");

export default function (client: ScramjetClient, self: Self) {
	// v8 only. all we need to do is clean the scramjet urls from stack traces
	//
	// vssh fork: a pilha é montada a partir dos CallSites, e NÃO lida de `error.stack`.
	//
	// `prepareStackTrace` é chamado justamente para PRODUZIR `error.stack`; ler essa propriedade
	// aqui dentro é pedir ao V8 o que ele está no meio de calcular. O que devolve depende de
	// reentrância e não é contrato de lugar nenhum — e o valor de retorno desta função vira o
	// `.stack` que o site enxerga, então errar aqui é entregar pilha vazia ou `undefined` a todo
	// código que lê pilha. Montar a partir de `stack` é o caminho documentado e é estável.
	const closure = (error: any, stack: any[]) => {
		if (lendoPilhaCrua()) return stack;

		let cabecalho = "Error";
		try {
			const nome = error?.name === undefined ? "Error" : String(error.name);
			const msg = error?.message === undefined ? "" : String(error.message);
			cabecalho = msg ? `${nome}: ${msg}` : nome;
		} catch {
			// getters do site em `name`/`message` podem lançar; o V8 também os chamaria
		}

		const mascarado = (arquivo: string | null | undefined) =>
			quadroDoMotor(client, arquivo);
		const arquivoDe = (i: number) => {
			try {
				return stack[i].getFileName() as string | null;
			} catch {
				return null;
			}
		};
		const desreescrito = (arquivo: string) => {
			try {
				if (String_startsWith(arquivo, client.context.prefix.href))
					return unrewriteUrl(arquivo, client.context);
			} catch {}

			return arquivo;
		};

		// O `eval` indireto e o `Function` passam pelo invólucro do motor, e o V8 escreve a origem
		// do código avaliado como o invólucro: `eval at i (…/scramjet.js:18:39738)`. No Chrome a
		// origem é quem chamou, e quem chamou é o primeiro quadro de fora do motor abaixo do
		// invólucro. A origem é reescrita com o nome e o lugar desse quadro.
		const origemDoEval = (i: number): [string, string] | null => {
			let origem: string | undefined;
			try {
				if (!stack[i].isEval()) return null;
				origem = stack[i].getEvalOrigin();
			} catch {
				return null;
			}
			if (!origem || !client.config.maskedfiles.some((f) => origem!.includes(f)))
				return null;
			let j = i + 1;
			while (j < stack.length && !mascarado(arquivoDe(j))) j++;
			while (j < stack.length && mascarado(arquivoDe(j))) j++;
			if (j >= stack.length) return null;
			try {
				const q = stack[j];
				const nome = q.getFunctionName() || "<anonymous>";
				const arquivo = q.getFileName();
				const lugar = arquivo
					? `${desreescrito(arquivo)}:${q.getLineNumber()}:${q.getColumnNumber()}`
					: "<anonymous>";

				return [origem, `eval at ${nome} (${lugar})`];
			} catch {
				return null;
			}
		};

		const linhas: string[] = [];
		const quadros: Quadro[] = [];
		for (let i = 0; i < stack.length; i++) {
			const arquivo = arquivoDe(i);

			// strip stack frames including scramjet handlers from the trace
			if (mascarado(arquivo)) continue;

			let texto: string;
			try {
				texto = String(stack[i]);
			} catch {
				continue;
			}

			// A origem guardada na compilação vale para o código que roda depois dela, quando o
			// invólucro que compilou já saiu da pilha; o quadro de baixo só serve ao que roda
			// dentro do invólucro.
			let registrada: [string, string] | null = null;
			try {
				const origem = stack[i].isEval() ? stack[i].getEvalOrigin() : null;
				if (origem && origemCitaMotor(client, origem)) {
					const achada = origemRegistrada(client, stack[i]);
					if (achada) registrada = [origem, achada];
				}
			} catch {}
			const troca = registrada ?? origemDoEval(i);
			if (troca) texto = texto.replace(troca[0], troca[1]);
			const quadro: Quadro = { cru: stack[i], origem: troca, pos: null, arquivo: null };
			// A posição do quadro é a do texto reescrito; ela volta à da fonte do site.
			try {
				const pos = posicaoOriginal(client, stack[i]);
				quadro.pos = pos;
				if (pos) {
					const velha = `:${pos[0]}:${pos[1]}`;
					const k = texto.lastIndexOf(velha);
					if (k >= 0)
						texto =
							texto.slice(0, k) + `:${pos[2]}:${pos[3]}` + texto.slice(k + velha.length);
				}
			} catch {}
			// Um quadro de código avaliado não tem arquivo, e a origem dele carrega o endereço da
			// página como o motor o serve; cada endereço sob o prefixo volta ao do site.
			if (!arquivo) {
				try {
					const prefixo = client.context.prefix.href;
					if (texto.includes(prefixo)) {
						texto = texto.replace(/[^\s()]+(?=:\d+:\d+)/g, (u) =>
							String_startsWith(u, prefixo) ? desreescrito(u) : u
						);
					}
				} catch {}
			}

			// Só o que está SOB O PROXY, e o teste vem ANTES da chamada.
			//
			// ⚠ Não é otimização: uma URL fora do prefixo já voltaria inalterada de `unrewriteUrl`
			// — o `replaceAll` seria um no-op —, mas a chamada tem EFEITO COLATERAL. Ela faz
			// `dbg.error("unrewriteurl: unexpected url")` para o que não reconhece, e `dbg` monta o
			// rótulo dele lançando um Error e lendo o `.stack`. Esse `.stack` volta para CÁ, este
			// closure roda de novo, e cada frame de arquivo externo gera outro erro. Um `<a href>`
			// não reescrito numa página vira uma cascata no console, e a cascata é o que aparece:
			// o rastro do primeiro erro é sempre `error.ts` e `Object.fmt`, apontando para o
			// logger em vez de para o site.
			//
			// A pilha de uma página tem quase só arquivo do site e de extensão — nenhum deles é do
			// proxy —, então o caminho comum é justamente o que pagava a conta.
			//
			// É o mesmo corte que o `ScramjetEngine.js` do vssh-sso já faz desde 3cd2710: o
			// chamador só manda desreescrever o que está sob o escopo do proxy. Aquele conserto
			// não alcançou este chamador.
			//
			// ⚠ O teste fica DENTRO do try, junto da chamada. Ele toca `client.context.prefix`, e
			// este closure é o `prepareStackTrace`: uma exceção aqui não falha só a desreescrita —
			// ela quebra a leitura de `.stack` de todo Error da página, inclusive os do site.
			// Todos os outros passos deste laço já são guardados pela mesma razão.
			try {
				if (arquivo && String_startsWith(arquivo, client.context.prefix.href)) {
					quadro.arquivo = unrewriteUrl(arquivo, client.context);
					texto = texto.replaceAll(arquivo, quadro.arquivo);
				}
			} catch {}

			linhas.push("    at " + texto);
			quadro.texto = texto;
			quadros.push(quadro);
		}

		// O formatador que o site pôs recebe os quadros como o Chrome os daria a ele.
		const doSite = client.pstDoSite;
		if (typeof doSite === "function")
			return Reflect_apply(doSite, self.Error, [error, quadros.map((q) => sitioDe(client, q))]);

		return linhas.length ? cabecalho + "\n" + linhas.join("\n") : cabecalho;
	};

	// ⚠ `client.Trap` NÃO serve aqui, e é por isso que esta flag não fazia nada.
	//
	// `RawTrap` começa com `if (!Reflect_has(target, prop)) return;`, e no Chromium
	// `Error.prepareStackTrace` **não existe**: é uma extensão do V8 que só passa a existir quando
	// alguém a define (`Reflect.has(Error, "prepareStackTrace") === false` num Chromium limpo — no
	// Node ela existe, o que torna fácil concluir o contrário testando no lugar errado).
	//
	// Resultado medido antes deste conserto: com `cleanErrors: true` chegando ao cliente, o
	// descritor de `Error.prepareStackTrace` seguia sem getter e as três formas de um site ler a
	// própria pilha devolviam a URL do proxy inteira — host, prefixo do motor e a URL de destino
	// escapada dentro do caminho. A flag ligava e não mordia.
	//
	// Isto importa para além de estética: código anti-bot lê pilha. Um único carregamento do
	// reCAPTCHA produz 54 `new Error()` capturados pelo próprio widget (ver
	// `bench/captcha-erros.mjs`), e cada um deles enxergava a assinatura do proxy.
	//
	// ⚠ O `set` ignora quem tentar instalar o próprio `prepareStackTrace` — inclusive o
	// `debugTrampolines` do cliente, que salva e restaura essa propriedade em volta de cada trap.
	// As duas flags não se cruzam nas configurações reais (produção liga uma, o devserver liga a
	// outra), mas ligar as duas juntas deixa o trampolim sem o formatador dele.
	Object_defineProperty(self.Error, "prepareStackTrace", {
		configurable: true,
		enumerable: false,
		// this is a funny js quirk. the getter is ran every time you type something in console
		get() {
			return closure;
		},
		set() {
			// just ignore it if a site tries setting their own. not much we can really do
		},
	});
}
