import type { ScramjetClient } from "@client/index";
import { Error } from "@/shared/snapshot";

const capturar = (Error as any).captureStackTrace as (alvo: object) => void;

/**
 * vssh fork: a `DOMException` que o navegador lançaria no lugar do motor.
 *
 * A exceção que o Blink lança leva a pilha de quem chamou, numa propriedade `stack` própria. A que
 * nasce do construtor não tem `stack`, e a página que confere a recusa lê `undefined` onde o Chrome
 * escreve `SecurityError: …`. O `captureStackTrace` é o que o Blink faz com a dele, e os quadros do
 * motor saem na formatação, como em toda pilha (ver `shared/error.ts`).
 */
export function excecaoDoNavegador(client: ScramjetClient, mensagem: string, nome: string) {
	const excecao = new client.global.DOMException(mensagem, nome);
	try {
		capturar(excecao);
	} catch {}

	return excecao;
}
