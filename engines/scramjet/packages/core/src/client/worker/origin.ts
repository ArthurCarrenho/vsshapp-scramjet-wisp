import { ScramjetClient } from "@client/index";

// vssh fork: o `self.origin` de um worker é a origem do endereço que o site deu a ele. Um worker de
// blob tem a origem de quem criou o blob, e um de `data:` tem a origem opaca, `"null"`, como no
// Chrome.

export default function (client: ScramjetClient) {
	client.Trap("origin", {
		get() {
			return client.url.origin;
		},
		set() {
			return false;
		},
	});
}
