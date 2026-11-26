import { basicTest } from "../../testcommon.ts";

// O que o navegador recusa. Um detector de robô chama uma função nativa de um jeito que o Chrome
// recusa e confere a recusa: o tipo do erro e a frase dele. Uma função do motor no lugar da nativa
// tem de recusar igual. Cada caso roda também sem o motor, e a frase esperada é a do Chrome.

export default [
	// Uma função como protótipo de si mesma. O laço do navegador que procura o ciclo para no
	// primeiro Proxy, e um Proxy sem a armadilha `setPrototypeOf` aceita o que a nativa recusa.
	basicTest({
		name: "refusals-prototype-cycle",
		js: `
			const alvos = {
				setTimeout, setInterval, fetch, postMessage, open, addEventListener, removeEventListener,
				Function, Worker, FontFace, XMLHttpRequest, eval: window.eval,
				pushState: history.pushState, "location.assign": location.assign, "location.toString": location.toString,
			};
			for (const [nome, f] of Object.entries(alvos)) {
				const antes = Object.getPrototypeOf(f);
				const recusa = (como, fazer) => {
					let erro = null;
					try { fazer(); } catch (e) { erro = e; }
					assert(erro instanceof TypeError, nome + ": " + como + " throws a TypeError");
					assertEqual(erro.message, "Cyclic __proto__ value", nome + ": " + como + " message");
				};
				recusa("Object.setPrototypeOf(f, f)", () => Object.setPrototypeOf(f, f));
				recusa("Object.setPrototypeOf(f, Object.create(f))", () => Object.setPrototypeOf(f, Object.create(f)));
				recusa("f.__proto__ = f", () => { f.__proto__ = f; });
				assertEqual(Reflect.setPrototypeOf(f, f), false, nome + ": Reflect.setPrototypeOf(f, f)");
				assertEqual(Object.getPrototypeOf(f), antes, nome + ": the prototype stays");
			}
		`,
	}),
	// Um protótipo sem ciclo continua aceito, e a função segue chamável por ele.
	basicTest({
		name: "refusals-prototype-set-still-works",
		js: `
			const f = setTimeout;
			const antes = Object.getPrototypeOf(f);
			const novo = Object.create(antes, { marca: { value: 7, configurable: true } });
			assertEqual(Object.setPrototypeOf(f, novo), f, "Object.setPrototypeOf returns the function");
			assertEqual(f.marca, 7, "the new prototype is in the chain");
			assertEqual(Reflect.setPrototypeOf(f, antes), true, "Reflect.setPrototypeOf restores it");
			assertEqual(Object.getPrototypeOf(f), antes, "restored");
			assertEqual(await new Promise((ok) => f(() => ok("rodou"), 0)), "rodou", "setTimeout still runs");
		`,
	}),
	basicTest({
		name: "refusals-setattribute",
		js: `
			const frase = (fazer) => { try { fazer(); return "no throw"; } catch (e) { return e.constructor.name + ": " + e.message; } };
			assertEqual(frase(() => Element.prototype.setAttribute.call({}, "a", "b")), "TypeError: Illegal invocation", "wrong this");
			assertEqual(frase(() => Element.prototype.setAttribute.call(undefined, "a", "b")), "TypeError: Illegal invocation", "no this");
			assertEqual(
				frase(() => document.createElement("div").setAttribute()),
				"TypeError: Failed to execute 'setAttribute' on 'Element': 2 arguments required, but only 0 present.",
				"no arguments"
			);
			assertEqual(
				frase(() => document.createElement("div").setAttribute("a")),
				"TypeError: Failed to execute 'setAttribute' on 'Element': 2 arguments required, but only 1 present.",
				"one argument"
			);
			const el = document.createElement("a");
			el.setAttribute("href", "/x");
			assertEqual(el.getAttribute("href"), "/x", "a valid call still sets the attribute");
		`,
	}),
	// O `Error.prepareStackTrace` não existe num Chrome limpo, e o `Error` de outro quadro também
	// não o mostra, pedido com o `Object` de qualquer um dos dois quadros.
	basicTest({
		name: "refusals-preparestacktrace-other-realm",
		js: `
			const quadro = document.createElement("iframe");
			document.body.appendChild(quadro);
			const w = quadro.contentWindow;
			const casos = [
				["this Object, this Error", Object, Error],
				["this Object, frame Error", Object, w.Error],
				["frame Object, this Error", w.Object, Error],
				["frame Object, frame Error", w.Object, w.Error],
			];
			for (const [nome, O, E] of casos) {
				assertEqual(O.getOwnPropertyDescriptor(E, "prepareStackTrace"), undefined, nome + ": descriptor");
				assertEqual(O.getOwnPropertyNames(E).includes("prepareStackTrace"), false, nome + ": own names");
				assertEqual(O.hasOwn(E, "prepareStackTrace"), false, nome + ": hasOwn");
				assertEqual(O.prototype.hasOwnProperty.call(E, "prepareStackTrace"), false, nome + ": hasOwnProperty");
			}
			assertEqual(Reflect.has(w.Error, "prepareStackTrace"), false, "Reflect.has on the frame Error");
			quadro.remove();
		`,
	}),
	// O começo em branco de uma fonte de `eval` fica fora do rewriter (ver `client/shared/eval.ts`),
	// e o código depois dele roda reescrito como qualquer outro.
	basicTest({
		name: "refusals-eval-blank-prefix",
		js: `
			const branco = " ".repeat(200000);
			assertEqual((0, eval)(branco + "0, /.*honk.*/, 1795699094210"), 1795699094210, "indirect eval of a padded expression");
			assertEqual(eval(branco + "1 + 1"), 2, "direct eval of a padded expression");
			assertEqual((0, eval)(branco + "location.href"), location.href, "the code after the padding sees the site location");
			assertEqual((0, eval)("\\n\\t ".repeat(3000) + "typeof location.href"), "string", "mixed whitespace");
			assertEqual((0, eval)(branco + "'use strict'; (function () { return this === undefined; })()"), true, "the directive prologue still counts");
			let erro = null;
			try { (0, eval)(branco + "x ='"); } catch (e) { erro = e; }
			assert(erro instanceof SyntaxError, "invalid code after the padding throws a SyntaxError");
			assertEqual((0, eval)(branco), undefined, "only whitespace");
		`,
	}),
];
