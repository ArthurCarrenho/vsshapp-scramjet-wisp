// Os endereços fixos de uma rodada. O resolvedor de uma estação pode perder consultas, e a rodada
// em que `challenges.cloudflare.com` não resolve mede o DNS no lugar do desafio: o script do
// Turnstile nem carrega. `FIXOS` tira o DNS da medida, no wisp da bancada e no Chrome direto.
//
//   FIXOS  pares nome=endereço separados por vírgula, por exemplo
//          FIXOS="www.tandfonline.com=$(dig +short www.tandfonline.com | head -1),challenges.cloudflare.com=$(dig +short challenges.cloudflare.com | head -1)"
import dns from "node:dns/promises";

const FIXOS = Object.fromEntries(
	(process.env.FIXOS || "").split(",").filter(Boolean).map((par) => par.split("=").map((x) => x.trim())));

/** O `lookup` do wisp: o endereço fixo quando há um, e o resolvedor com três tentativas no resto. */
export async function lookupComFixos(hostname, opcoes) {
	if (FIXOS[hostname]) return { address: FIXOS[hostname], family: 4 };
	let erro;
	for (let i = 0; i < 3; i++) {
		try { return await dns.lookup(hostname, { ...opcoes, family: 4 }); }
		catch (e) { erro = e; if (e.code === "ENOTFOUND") break; }
	}
	throw erro;
}

/** Os argumentos que dão os mesmos endereços a um Chrome direto. */
export function argumentosDoChrome() {
	const regras = Object.entries(FIXOS).map(([nome, ip]) => `MAP ${nome} ${ip}`).join(",");
	return regras ? [`--host-resolver-rules=${regras}`] : [];
}
