import { ScramjetClient } from "@client/index";
import { excecaoDoNavegador } from "@client/shared/excecao";
import { String, _URL } from "@/shared/snapshot";

// Os esquemas que o Chrome aceita sem o prefixo `web+`.
const PERMITIDOS = [
	"bitcoin", "cabal", "did", "dat", "dweb", "ethereum", "ftp", "ftps", "geo", "im", "ipfs", "ipns",
	"irc", "ircs", "magnet", "mailto", "matrix", "mms", "news", "nntp", "openpgp4fpr", "sftp", "sip",
	"sms", "smsto", "ssb", "ssh", "tel", "urn", "webcal", "wtai", "xmpp",
];

export default function (client: ScramjetClient) {
	// Um manipulador de protocolo registrado aqui abriria o endereço do motor, sem service worker
	// garantido do outro lado, e o registro não vai ao navegador. vssh fork: as conferências vêm
	// antes, com os erros do Chrome, para o site que testa um registro inválido receber a mesma
	// recusa.
	const conferir = (metodo: string, args: unknown[]) => {
		const falha = (msg: string, nome: string) =>
			excecaoDoNavegador(client, `Failed to execute '${metodo}' on 'Navigator': ${msg}`, nome);
		if (args.length < 2)
			throw new (client.global as any).TypeError(
				`Failed to execute '${metodo}' on 'Navigator': 2 arguments required, but only ${args.length} present.`
			);
		const esquema = String(args[0]).toLowerCase();
		const endereco = String(args[1]);
		if (!/^[a-z][a-z0-9+.-]*$/.test(esquema))
			throw falha(`The scheme name '${String(args[0])}' is not allowed by URI syntax (RFC3986).`, "SecurityError");
		if (!/^web\+[a-z]+$/.test(esquema) && !PERMITIDOS.includes(esquema))
			throw falha(
				`The scheme '${esquema}' doesn't belong to the scheme allowlist. Please prefix non-allowlisted schemes with the string 'web+'.`,
				"SecurityError"
			);
		if (!endereco.includes("%s"))
			throw falha(`The url provided ('${endereco}') does not contain '%s'.`, "SyntaxError");
		let resolvido: URL;
		try {
			resolvido = new _URL(endereco.replace("%s", ""), client.url.href);
		} catch {
			throw falha(
				`The custom handler URL created by removing '%s' and prepending '${client.url.href}' is invalid.`,
				"SyntaxError"
			);
		}
		if (resolvido.origin !== client.url.origin)
			throw falha("Can only register custom handler in the document's origin.", "SecurityError");
	};
	client.Proxy("Navigator.prototype.registerProtocolHandler", {
		apply(ctx) {
			conferir("registerProtocolHandler", ctx.args);
			ctx.return(undefined);
		},
	});
	client.Proxy("Navigator.prototype.unregisterProtocolHandler", {
		apply(ctx) {
			conferir("unregisterProtocolHandler", ctx.args);
			ctx.return(undefined);
		},
	});
}
