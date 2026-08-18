import { unrewriteUrl } from "@rewriters/url";
import { ScramjetClient } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";

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
		let cabecalho = "Error";
		try {
			const nome = error?.name === undefined ? "Error" : String(error.name);
			const msg = error?.message === undefined ? "" : String(error.message);
			cabecalho = msg ? `${nome}: ${msg}` : nome;
		} catch {
			// getters do site em `name`/`message` podem lançar; o V8 também os chamaria
		}

		const linhas: string[] = [];
		for (let i = 0; i < stack.length; i++) {
			let arquivo: string | null = null;
			try {
				arquivo = stack[i].getFileName();
			} catch {}

			// strip stack frames including scramjet handlers from the trace
			try {
				if (arquivo && client.config.maskedfiles.some((f) => arquivo!.endsWith(f)))
					continue;
			} catch {}

			let texto: string;
			try {
				texto = String(stack[i]);
			} catch {
				continue;
			}

			if (arquivo) {
				try {
					texto = texto.replaceAll(arquivo, unrewriteUrl(arquivo, client.context));
				} catch {}
			}

			linhas.push("    at " + texto);
		}

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
