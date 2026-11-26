import { ScramjetClient } from "@client/index";
import { Object_defineProperty, _URL } from "@/shared/snapshot";
import { embrulhar } from "@/shared/confiavel";

export default function (client: ScramjetClient, self: Self) {
	// vssh fork: compilada pelo `eval` com um TrustedScript, na primeira vez que o código reescrito
	// a chama. O `Function` nativo, com strings, vai à política padrão do site num documento que
	// exige Trusted Types, e ela recusa o código do motor. Um realm que não roda código (quadro
	// sandbox sem 'allow-scripts') nunca chega a chamá-la.
	let importar: ((url: string) => Promise<unknown>) | null = null;
	const boundimport = (url: string) => {
		importar ??= client.natives.call(
			"eval",
			null,
			embrulhar(client, "TrustedScript", "(function (url) {\n\treturn import(url);\n})")
		);

		return importar(url);
	};

	Object_defineProperty(self, client.config.globals.importfn, {
		value: function (base: string, url: string) {
			const resolved = new _URL(url, base).href;

			if (
				url.includes(":") ||
				url.startsWith("/") ||
				url.startsWith(".") ||
				url.startsWith("..")
			) {
				// this is a url
				return boundimport(client.rewriteUrl(resolved, { isModule: true }));
			} else {
				// this is a specifier handled by importmaps
				return boundimport(url);
			}
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.metafn, {
		value: function (metaobj: any, base: string) {
			metaobj.url = base;
			metaobj.resolve = function (url: string) {
				return new _URL(url, base).href;
			};

			return metaobj;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
}
