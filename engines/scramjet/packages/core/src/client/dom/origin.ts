import { ScramjetClient } from "@client/index";
import { SCRAMJETCLIENT } from "@/symbols";

export default function (client: ScramjetClient, self: Self) {
	client.Trap("origin", {
		get() {
			const url = client.url;
			// vssh fork: um documento `about:srcdoc` ou `about:blank` herda a origem de quem o criou,
			// e `new URL("about:srcdoc").origin` é `"null"`. O iframe `srcdoc` que um site monta dentro
			// da própria página via a origem dele num navegador, e a origem opaca pelo motor. A
			// origem herdada vem do pai, e na falta dele de quem abriu a janela; quando nenhum dos
			// dois é do motor, fica a do próprio URL.
			if (url.protocol === "about:") {
				for (const outro of [self.parent, self.opener]) {
					try {
						if (outro && outro !== self && outro[SCRAMJETCLIENT]) {
							return outro.origin;
						}
					} catch {
						// de outra origem: a herança não se lê daqui
					}
				}
			}

			return url.origin;
		},
		set() {
			return false;
		},
	});
}
