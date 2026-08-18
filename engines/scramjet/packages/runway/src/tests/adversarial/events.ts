import { basicTest } from "../../testcommon.ts";

// addEventListener is proxied so that handlers can be unwrapped and event
// objects fixed up. The listener registry has to keep the spec's identity
// rules: a (type, callback, capture) triple that is already registered is
// ignored, and removeEventListener has to match on the page's own function.
//
// Registering the same handler twice is the standard idempotent-init pattern;
// if it stops being a no-op, handlers fire twice - double form submits, double
// analytics beacons, double network requests.

export default [
	basicTest({
		name: "events-once-and-signal",
		js: `
			const t = document.createElement("div");
			let once = 0;
			t.addEventListener("y", () => once++, { once: true });
			t.dispatchEvent(new Event("y"));
			t.dispatchEvent(new Event("y"));
			assertEqual(once, 1, "once");
			const ac = new AbortController();
			let aborted = 0;
			t.addEventListener("z", () => aborted++, { signal: ac.signal });
			t.dispatchEvent(new Event("z"));
			ac.abort();
			t.dispatchEvent(new Event("z"));
			assertEqual(aborted, 1, "an aborted signal removes the listener");
		`,
	}),
	basicTest({
		name: "events-remove",
		js: `
			const t = document.createElement("div");
			let n = 0;
			const fn = () => n++;
			t.addEventListener("x", fn);
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "fired once");
			t.removeEventListener("x", fn);
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "removeEventListener with the same function");
			t.addEventListener("c", fn, true);
			t.removeEventListener("c", fn, true);
			t.dispatchEvent(new Event("c"));
			assertEqual(n, 1, "capture-phase removal");
			t.addEventListener("o", fn, { capture: true });
			t.removeEventListener("o", fn, { capture: true });
			t.dispatchEvent(new Event("o"));
			assertEqual(n, 1, "capture removal via options");
		`,
	}),
	basicTest({
		name: "events-capture-and-bubble-are-distinct",
		js: `
			const t = document.createElement("div");
			let n = 0;
			const fn = () => n++;
			t.addEventListener("y", fn, false);
			t.addEventListener("y", fn, true);
			t.dispatchEvent(new Event("y"));
			assertEqual(n, 2, "capture and bubble are separate registrations");
		`,
	}),
	basicTest({
		name: "events-handleevent-object",
		js: `
			const t = document.createElement("div");
			let n = 0;
			const handler = { handleEvent() { n++; } };
			t.addEventListener("x", handler);
			t.addEventListener("x", handler);
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "handleEvent objects are deduped");
			t.removeEventListener("x", handler);
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "and removable");
		`,
	}),
	basicTest({
		// A listener object is only wrapped for filtering if the proxy can hand the platform a
		// function that delegates to it - a Proxy can't intercept a plain object's invocation. That
		// delegation has to keep the spec's late binding: `handleEvent` is looked up at dispatch
		// time, not at registration, so an object may be registered empty and gain the method
		// later. Reading it once at registration turns those listeners into permanent no-ops.
		name: "events-handleevent-late-binding",
		js: `
			const t = document.createElement("div");
			let n = 0;
			const handler = {};
			t.addEventListener("x", handler);
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 0, "an object with no handleEvent yet is simply not called");
			handler.handleEvent = () => n++;
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "handleEvent installed after registration still fires");
			handler.handleEvent = "not a function";
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "and a non-callable handleEvent must not throw");
		`,
	}),
	basicTest({
		// Inside handleEvent, `this` is the listener object - not the event target, and not the
		// wrapper the proxy handed the platform. Object listeners exist precisely so the handler
		// can reach its own instance state; getting `this` wrong breaks every one of them.
		name: "events-handleevent-this",
		js: `
			const t = document.createElement("div");
			const handler = {
				marca: "meu",
				vistos: [],
				handleEvent(e) { this.vistos.push(this.marca + ":" + e.type); },
			};
			t.addEventListener("x", handler);
			t.dispatchEvent(new Event("x"));
			assertDeepEqual(handler.vistos, ["meu:x"], "this inside handleEvent is the listener object");
		`,
	}),
	basicTest({
		// The registry translates the page's listener into the wrapper that was actually handed to
		// the platform, and removal consumes one registration. A listener registered in BOTH phases
		// is two registrations and needs two removals - so the bookkeeping cannot collapse them,
		// even when both share one wrapper. If the second removal finds nothing to translate, the
		// listener stays attached forever and keeps firing after the page thinks it is gone.
		name: "events-remove-both-phases",
		js: `
			const pai = document.createElement("div");
			const filho = document.createElement("div");
			pai.appendChild(filho);
			document.body.appendChild(pai);
			let n = 0;
			const fn = () => n++;
			pai.addEventListener("x", fn, true);
			pai.addEventListener("x", fn, false);
			filho.dispatchEvent(new Event("x", { bubbles: true }));
			assertEqual(n, 2, "precondition: both phases fired");
			pai.removeEventListener("x", fn, true);
			pai.removeEventListener("x", fn, false);
			filho.dispatchEvent(new Event("x", { bubbles: true }));
			assertEqual(n, 2, "both phases must actually come off");
			pai.remove();
		`,
	}),
	basicTest({
		// Capture and bubble are separate registrations for the same object, exactly as they are
		// for the same function (see events-capture-and-bubble-are-distinct). Deduping an object
		// listener must not collapse the two phases into one.
		name: "events-handleevent-capture-and-bubble",
		js: `
			const pai = document.createElement("div");
			const filho = document.createElement("div");
			pai.appendChild(filho);
			document.body.appendChild(pai);
			let n = 0;
			const handler = { handleEvent() { n++; } };
			pai.addEventListener("x", handler, true);
			pai.addEventListener("x", handler, false);
			filho.dispatchEvent(new Event("x", { bubbles: true }));
			assertEqual(n, 2, "the same object in both phases is two listeners");
			pai.remove();
		`,
	}),
	basicTest({
		name: "events-propagation",
		js: `
			const outer = document.createElement("div");
			const inner = document.createElement("span");
			outer.appendChild(inner);
			document.body.appendChild(outer);
			const order = [];
			outer.addEventListener("t", (e) => {
				order.push("capture:" + (e.currentTarget === outer) + ":" + (e.target === inner));
			}, true);
			inner.addEventListener("t", () => order.push("target"));
			outer.addEventListener("t", () => order.push("bubble"));
			inner.dispatchEvent(new Event("t", { bubbles: true }));
			assertDeepEqual(order, ["capture:true:true", "target", "bubble"], "order, currentTarget and target");
			let detail, path;
			outer.addEventListener("c", (e) => { detail = e.detail; path = e.composedPath(); });
			const ce = new CustomEvent("c", { detail: { a: 1 }, bubbles: true });
			inner.dispatchEvent(ce);
			assertDeepEqual(detail, { a: 1 }, "CustomEvent detail");
			assertEqual(ce.isTrusted, false, "a synthetic event is not trusted");
			assertDeepEqual(
				path.slice(0, 2).map((n) => n === inner || n === outer),
				[true, true],
				"composedPath starts at the target"
			);
		`,
	}),
	basicTest({
		name: "events-stop-and-cancel",
		js: `
			const t = document.createElement("div");
			document.body.appendChild(t);
			const seen = [];
			t.addEventListener("s", (e) => { seen.push(1); e.stopImmediatePropagation(); });
			t.addEventListener("s", () => seen.push(2));
			t.dispatchEvent(new Event("s"));
			assertDeepEqual(seen, [1], "stopImmediatePropagation");
			const ev = new Event("p", { cancelable: true });
			t.addEventListener("p", (e) => e.preventDefault());
			assertEqual(t.dispatchEvent(ev), false, "dispatchEvent returns false when cancelled");
			assertEqual(ev.defaultPrevented, true, "defaultPrevented");
		`,
	}),
	basicTest({
		name: "events-handler-property",
		js: `
			const t = document.createElement("div");
			let n = 0;
			t.onclick = () => n++;
			t.onclick = () => { n += 10; };
			t.dispatchEvent(new Event("click"));
			assertEqual(n, 10, "assigning onclick twice replaces the handler");
			assertEqual(typeof t.onclick, "function", "onclick reads back as a function");
			t.onclick = null;
			t.dispatchEvent(new Event("click"));
			assertEqual(n, 10, "nulling onclick removes it");
		`,
	}),
	basicTest({
		name: "events-unhandledrejection",
		autoPass: false,
		js: `
			const ev = await new Promise((resolve) => {
				window.addEventListener("unhandledrejection", resolve, { once: true });
				Promise.reject(new Error("nope"));
			});
			assertEqual(ev.reason.message, "nope", "reason");
			assertEqual(ev.type, "unhandledrejection", "type");
			ev.preventDefault();
			pass();
		`,
	}),

	// Estes três descreviam um defeito — registrar o mesmo ouvinte duas vezes fazia o handler
	// disparar duas vezes — e passaram a valer quando o registro de ouvintes passou a reaproveitar
	// o embrulho por par (evento, ouvinte). Ver `client/shared/event.ts`.
	basicTest({
		name: "events-duplicate-listener-element",
		js: `
			const t = document.createElement("div");
			let n = 0;
			const fn = () => n++;
			t.addEventListener("x", fn);
			t.addEventListener("x", fn);
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "duplicate listeners must be deduped");
		`,
	}),
	basicTest({
		// Nos alvos globais, que é onde código de inicialização idempotente costuma registrar.
		name: "events-duplicate-listener-global",
		js: `
			let w = 0;
			const wf = () => w++;
			window.addEventListener("adversarial-w", wf);
			window.addEventListener("adversarial-w", wf);
			window.dispatchEvent(new Event("adversarial-w"));
			window.removeEventListener("adversarial-w", wf);
			assertEqual(w, 1, "window duplicate listeners must be deduped");
			let d = 0;
			const df = () => d++;
			document.addEventListener("adversarial-d", df);
			document.addEventListener("adversarial-d", df);
			document.dispatchEvent(new Event("adversarial-d"));
			document.removeEventListener("adversarial-d", df);
			assertEqual(d, 1, "document duplicate listeners must be deduped");
		`,
	}),
	basicTest({
		// E com um objeto de opções, que é a forma moderna comum.
		name: "events-duplicate-listener-options",
		js: `
			const t = document.createElement("div");
			let n = 0;
			const fn = () => n++;
			t.addEventListener("x", fn, { passive: true });
			t.addEventListener("x", fn, { passive: true });
			t.dispatchEvent(new Event("x"));
			assertEqual(n, 1, "deduped with identical options");
		`,
	}),
	basicTest({
		// `addEventListener(...)` solto e `window.addEventListener(...)` são a MESMA operação: a
		// WebIDL manda tratar `this` nulo ou indefinido como o objeto global. Um registro que trate
		// as duas como alvos distintos guarda o embrulho num balde e procura no outro, e aí a
		// remoção não acha o que traduzir — o ouvinte fica registrado para sempre.
		//
		// A chamada solta é a forma mais comum de escutar `message`, e não havia teste cruzando as
		// duas: foi por essa fresta que passou um `TypeError` levantado dentro do
		// `addEventListener` do site, que derrubou treze testes de `postmessage` de uma vez.
		name: "events-chamada-solta-e-window-sao-o-mesmo-alvo",
		js: `
			let n = 0;
			const fn = () => n++;
			addEventListener("adversarial-solto", fn);
			window.dispatchEvent(new Event("adversarial-solto"));
			assertEqual(n, 1, "a chamada solta registra no global");
			window.removeEventListener("adversarial-solto", fn);
			window.dispatchEvent(new Event("adversarial-solto"));
			assertEqual(n, 1, "remover por window desfaz o que a chamada solta registrou");

			let m = 0;
			const gn = () => m++;
			window.addEventListener("adversarial-por-window", gn);
			dispatchEvent(new Event("adversarial-por-window"));
			assertEqual(m, 1, "o despacho solto alcança o que window registrou");
			removeEventListener("adversarial-por-window", gn);
			window.dispatchEvent(new Event("adversarial-por-window"));
			assertEqual(m, 1, "a remoção solta desfaz o que window registrou");

			let d = 0;
			const dn = () => d++;
			addEventListener("adversarial-solto-dedup", dn);
			window.addEventListener("adversarial-solto-dedup", dn);
			window.dispatchEvent(new Event("adversarial-solto-dedup"));
			window.removeEventListener("adversarial-solto-dedup", dn);
			assertEqual(d, 1, "as duas formas são um registro só, e a plataforma deduplica");
		`,
	}),
];
