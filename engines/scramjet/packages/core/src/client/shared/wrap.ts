import { iswindow } from "@client/entry";
import { SCRAMJETCLIENT } from "@/symbols";
import { ScramjetClient } from "@client/index";
// import { argdbg } from "@client/shared/err";
import { Object_defineProperty } from "@/shared/snapshot";

export function createWrapFn(client: ScramjetClient, self: GlobalThis) {
	// `parent` e `top` são resolvidos SOB DEMANDA, não uma vez na construção do client — e a
	// diferença aparece na tela.
	//
	// Os dois dependem de os frames ancestrais já terem um client instalado, e isso é uma corrida:
	// um iframe que o site injeta depois do carregamento pode inicializar o próprio client ANTES de
	// o pai ter registrado o dele. Resolvendo tudo na construção, `SCRAMJETCLIENT in self.parent`
	// dava falso e o valor cacheado virava `self` — o frame passava a acreditar que ERA o topo.
	//
	// A consequência não é sutil. `parent.postMessage(...)` é como um iframe fala com a página que o
	// contém; virando `self.postMessage(...)`, a mensagem volta para quem a mandou e nunca chega ao
	// destino. Foi assim que isto foi encontrado: no YouTube, o painel de replay do chat é um iframe
	// injetado tarde, e o botão de ocultar simplesmente não respondia. Como o valor era cacheado,
	// não havia segunda chance — uma vez errado, errado por toda a vida do frame.
	//
	// O cache continua existindo, só que com uma condição de parada honesta: guardamos a resposta
	// quando ela não pode mais mudar, e reconferimos justamente o caso que a corrida produz.
	let parentCache: GlobalThis | null = null;
	let parentSettled = false;
	let topCache: GlobalThis | null = null;
	let topSettled = false;

	function resolveParent(): GlobalThis {
		if (parentSettled) return parentCache!;
		try {
			// `Window` and `typeof globalThis` don't overlap structurally, but a proxied frame's
			// parent is a full global. one cast up front keeps the checks below readable.
			const parent = self.parent as unknown as GlobalThis;
			if (parent === self) {
				// genuinely the top frame — this never changes
				parentSettled = true;
				return (parentCache = self);
			}
			if (SCRAMJETCLIENT in parent) {
				// ... then we're in a subframe, and the parent frame is also in a proxy context, so we should return its proxy
				parentSettled = true;
				return (parentCache = parent);
			}
			// there IS a parent and it's reachable, it just hasn't been hooked yet. that can change
			// on the very next tick, so don't settle: pretend we aren't nested for now and look again.
			parentCache = self;
		} catch {
			// accessing self.parent can throw if it's cross-origin, in which case we should also
			// pretend we aren't nested — and cross-origin never becomes same-origin, so settle.
			parentSettled = true;
			parentCache = self;
		}
		return parentCache;
	}

	function resolveTop(): GlobalThis {
		if (topSettled) return topCache!;
		// instead of returning top, we need to return the uppermost parent that's inside a scramjet context
		let current = self;
		let settled = true;
		for (;;) {
			let test: GlobalThis;
			try {
				test = current.parent.self;
			} catch {
				break; // cross-origin: this is as far as we can ever see
			}
			if (test === current) break; // there is no parent, actual or emulated.

			try {
				if (!(SCRAMJETCLIENT in test)) {
					// `current` is the topmost window in the proxy context *for now* — `test` may still
					// get hooked later, so this answer isn't final.
					settled = false;
					break;
				}
			} catch {
				// accessing test can throw if it's cross-origin, in which case we should also break
				break;
			}
			// test is also insde a proxy, so we should continue up the chain
			current = test;
		}
		topSettled = settled;

		return (topCache = current);
	}

	return function (identifier: any) {
		if (identifier === self.location) return client.locationProxy;
		if (identifier === self.eval) {
			return client.indirectEval;
		}
		if (iswindow) {
			if (identifier === self.parent) {
				return resolveParent();
			} else if (identifier === self.top) {
				return resolveTop();
			}
		}
		return identifier;
	};
}

export const order = 4;
export default function (client: ScramjetClient, self: GlobalThis) {
	Object_defineProperty(self, client.config.globals.wrapfn, {
		value: client.wrapfn,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.wrappropertyfn, {
		value: function (str) {
			if (
				str === "location" ||
				str === "parent" ||
				str === "top" ||
				str === "eval"
			)
				return client.config.globals.wrappropertybase + str;

			return str;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.cleanrestfn, {
		value: function (obj) {
			// TODO
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});

	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "location",
		{
			get: function () {
				// if (this.location.constructor.toString().includes("Location")) {

				if (this === self || this === self.document) {
					return client.locationProxy;
				}

				return this.location;
			},
			set(value: any) {
				if (this === self || this === self.document) {
					client.url = value;

					return;
				}
				this.location = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "parent",
		{
			get: function () {
				return client.wrapfn(this.parent);
			},
			set(value: any) {
				// i guess??
				this.parent = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "top",
		{
			get: function () {
				return client.wrapfn(this.top);
			},
			set(value: any) {
				this.top = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "eval",
		{
			get: function () {
				return client.wrapfn(this.eval);
			},
			set(value: any) {
				this.eval = value;
			},
			configurable: false,
			enumerable: false,
		}
	);

	self.$scramitize = function (v) {
		const t = typeof v;
		if (t === "object" && v !== null) {
			if (v === location) debugger;
			if (iswindow) {
				// if (v === self.parent) debugger;
				if (v === self.top) debugger;
			}
		} else if (t === "string") {
			if (v.includes("scramjet")) debugger;
			if (v.includes("~/sj")) debugger;
			if (v.includes(location.origin)) debugger;
		}

		return v;
	};

	// location = "..." can't be rewritten as wrapfn(location) = ..., so instead it will actually be rewritten as
	// ((t)=>$scramjet$tryset(location,"+=",t)||location+=t)(...);
	// it has to be a discrete function because there's always the possibility that "location" is a local variable
	// we have to use an IIFE to avoid duplicating side-effects in the getter
	Object_defineProperty(self, client.config.globals.trysetfn, {
		value: function (lhs: any, op: string, rhs: any) {
			if (client.box.locations.has(lhs)) {
				lhs.href = rhs;
				return true;
			}

			return false;
		},
		writable: false,
		configurable: false,
	});

	// `$scramjet$temploc` — declared here because nothing else ever declares it.
	//
	// When `location` appears in a destructuring TARGET, the rewriter renames it to the temp id and
	// assigns the real `location` back afterwards, through the `trysetfn` right above:
	//
	//   ({ location } = o)
	//     → ((t)=>($scramjet$tryset(location,"=",$scramjet$temploc)||(location=$scramjet$temploc),t))(
	//         ({ $sj_location: $scramjet$temploc } = o))
	//
	// In a DECLARATION (`var location = …`, `var { location } = …`) the temp id lands inside the
	// declarator, so `var` declares it. In an ASSIGNMENT target — `({location}=x)`, `[location]=a`,
	// `({...location}=x)`, `for (location of …)` — nothing declares it: not the rewriter, which
	// emits a bare `Ty::TempVar => LL::replace(templocid)` and has no program-level hoist, and
	// until now not this file either.
	//
	// Sloppy mode forgives that — the assignment creates an implicit global and the code runs, which
	// is why it went unnoticed for so long. Strict mode does not: assigning to an unresolvable
	// reference is a ReferenceError, and EVERY ES module is strict. So any ESM bundle that does
	// `({ location } = …)` dies with
	//
	//   Uncaught ReferenceError: $scramjet$temploc is not defined
	//
	// which is what dash.cloudflare.com does, crashing into its React Router error boundary.
	//
	// A property on the global object makes the reference resolvable, so the strict-mode assignment
	// becomes legal again: this gives strict code exactly the semantics sloppy code always had —
	// no better, no worse. `writable` is required, since the rewritten code assigns to it. The
	// single shared slot is the same trade the implicit global already made: the cleanup runs
	// synchronously within the same statement, so re-entrancy inside one tick is the only hazard,
	// and it predates this line.
	//
	// The structural fix belongs in the rewriter — hoist `var $scramjet$temploc;` into the enclosing
	// function/program whenever a TempVar is emitted in assignment-target position. This is the
	// cheap half, and it is enough to stop the crash.
	Object_defineProperty(self, client.config.globals.templocid, {
		value: undefined,
		writable: true,
		configurable: false,
	});
}
