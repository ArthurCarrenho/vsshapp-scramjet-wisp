import { serverTest, basicTest } from "../../testcommon.ts";

// Same-origin frames are the trickiest shape for a proxy: each frame gets its
// own client, and the page can reach across into another frame's document and
// read URLs there. Nothing here currently diverges - this is regression cover
// for an area with no existing tests.

const frameTest = (name: string, js: string) =>
	serverTest({
		name,
		autoPass: true,
		js,
		start: async (server) => {
			server.on("request", (req, res) => {
				if (res.headersSent) return;
				const path = (req.url || "/").split("?")[0];
				if (path === "/" || path === "/script.js") return;
				if (path === "/frame.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						'<!DOCTYPE html><html><body><a id="l" href="/inframe">x</a>' +
							'<img id="i" src="/inframe.png"></body></html>'
					);
					return;
				}
				if (path === "/nested.html") {
					res.writeHead(200, { "Content-Type": "text/html" });
					res.end(
						'<!DOCTYPE html><html><body><iframe src="/frame.html"></iframe></body></html>'
					);
					return;
				}
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("nf");
			});
		},
	});

const LOAD = `const load = (f) => new Promise((r) => { f.onload = r; setTimeout(r, 4000); });`;

export default [
	frameTest(
		"frames-contentdocument-urls",
		`
			${LOAD}
			const f = document.createElement("iframe");
			f.src = "/frame.html";
			document.body.appendChild(f);
			await load(f);
			const doc = f.contentDocument;
			assert(doc, "contentDocument is reachable");
			assertEqual(doc.querySelector("#l").getAttribute("href"), "/inframe", "attribute inside the frame");
			assertEqual(doc.querySelector("#l").href, location.origin + "/inframe", "resolved href inside the frame");
			assertEqual(doc.querySelector("#i").src, location.origin + "/inframe.png", "img src inside the frame");
			assertEqual(f.contentWindow.location.href, location.origin + "/frame.html", "contentWindow.location.href");
			assertEqual(doc.baseURI, location.origin + "/frame.html", "frame baseURI");
			assertEqual(doc.URL, location.origin + "/frame.html", "frame document.URL");
			assertEqual(f.getAttribute("src"), "/frame.html", "the src attribute keeps the literal value");
		`
	),
	frameTest(
		"frames-collection-and-relationships",
		`
			${LOAD}
			const f = document.createElement("iframe");
			f.name = "myframe";
			f.src = "/frame.html";
			document.body.appendChild(f);
			await load(f);
			assertEqual(window.frames.length, 1, "frames.length");
			assertEqual(window.frames[0], f.contentWindow, "frames[0]");
			assertEqual(window.frames["myframe"], f.contentWindow, "frames by name");
			assertEqual(f.contentWindow.frameElement, f, "frameElement");
			assertEqual(f.contentWindow.parent, window, "parent seen from the frame");
			assertEqual(f.contentWindow.top, window.top, "top agrees");
			assertEqual(f.contentWindow.self, f.contentWindow, "self inside the frame");
			assertEqual(document.querySelectorAll("iframe").length, 1, "one iframe in the document");
		`
	),
	frameTest(
		"frames-nested",
		`
			${LOAD}
			const outer = document.createElement("iframe");
			outer.src = "/nested.html";
			document.body.appendChild(outer);
			await load(outer);
			await new Promise((r) => setTimeout(r, 300));
			const inner = outer.contentDocument.querySelector("iframe");
			assert(inner, "the nested iframe exists");
			assertEqual(inner.contentWindow.parent, outer.contentWindow, "the nested frame's parent");
			assertEqual(inner.contentWindow.top, window.top, "top from two levels down");
			assertEqual(
				inner.contentDocument.querySelector("#l").href,
				location.origin + "/inframe",
				"URL resolution two levels down"
			);
		`
	),
	frameTest(
		"frames-cross-document-scripting",
		`
			${LOAD}
			const f = document.createElement("iframe");
			f.src = "/frame.html";
			document.body.appendChild(f);
			await load(f);
			// reach in and mutate the child document from the parent
			const child = f.contentDocument;
			const img = child.createElement("img");
			img.src = "/created-in-parent.png";
			child.body.appendChild(img);
			assertEqual(img.src, location.origin + "/created-in-parent.png", "an element created in the child realm");
			assertEqual(img.getAttribute("src"), "/created-in-parent.png", "its attribute");
			child.body.innerHTML += '<a id="added" href="/added">y</a>';
			assertEqual(child.querySelector("#added").href, location.origin + "/added", "markup written into the child");
			assertEqual(f.contentWindow.document, child, "contentWindow.document === contentDocument");
		`
	),
	basicTest({
		name: "frames-srcdoc",
		js: `
			const f = document.createElement("iframe");
			f.srcdoc = '<!DOCTYPE html><html><body><a id="l" href="/sd">x</a></body></html>';
			document.body.appendChild(f);
			await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
			const doc = f.contentDocument;
			assert(doc, "srcdoc contentDocument");
			assertEqual(doc.querySelector("#l").getAttribute("href"), "/sd", "attribute inside srcdoc");
			assertEqual(doc.querySelector("#l").href, location.origin + "/sd", "resolved href inside srcdoc");
			assert(f.getAttribute("srcdoc").includes("/sd"), "srcdoc attribute round trip");
			assert(!f.getAttribute("srcdoc").includes("/~/sj/"), "srcdoc must not expose the proxy URL");
		`,
	}),
	basicTest({
		name: "frames-document-write",
		js: `
			const f = document.createElement("iframe");
			document.body.appendChild(f);
			const doc = f.contentDocument;
			doc.open();
			doc.write('<a id="l" href="/ab">x</a><img id="i" src="/ab.png">');
			doc.close();
			assertEqual(doc.querySelector("#l").getAttribute("href"), "/ab", "written attribute");
			assertEqual(doc.querySelector("#l").href, location.origin + "/ab", "resolved href in the written frame");
			assertEqual(doc.querySelector("#i").src, location.origin + "/ab.png", "written img src");
			assert(!doc.baseURI.includes("/~/sj/"), "baseURI must not expose the proxy URL: " + doc.baseURI);
			assertEqual(doc.body.innerHTML, '<a id="l" href="/ab">x</a><img id="i" src="/ab.png">',
				"serialization round trip in the written frame");
		`,
	}),
	basicTest({
		// The shape that broke YouTube's chat replay panel: a frame injected after load talks to
		// the page containing it through parent.postMessage. `parent` and `top` used to be resolved
		// once, when the child's client was constructed - and a late frame can get there before its
		// parent has registered a client. The check `SCRAMJETCLIENT in self.parent` then said no,
		// the cached answer became "pretend we aren't nested" (i.e. `self`), and the child spent the
		// rest of its life believing it was the top frame. parent.postMessage() delivered to itself.
		//
		// Both halves are asserted, because either one failing is the bug: what the child *sees*,
		// and whether the message actually *arrives*.
		name: "frames-parent-is-not-self",
		js: `
			const chegaram = [];
			window.addEventListener("message", (e) => {
				if (e.data && typeof e.data === "object" && "souOTopo" in e.data) chegaram.push(e.data);
			});

			const f = document.createElement("iframe");
			// Inline script, so it runs during parse - the earliest a child client can possibly
			// initialize, which is what makes the race reachable at all.
			//
			// The tag name is assembled from pieces on purpose: this test body is injected into a
			// <script> of the harness page, and that page goes through scramjet's HTML rewriter,
			// which re-serializes it. A literal </script> in here - even backslash-escaped - can
			// come back out of the serializer unescaped and close the harness's own script tag,
			// which kills the test before it starts. It failed exactly that way (timeout under
			// scramjet, pass under bare) until the tokens stopped appearing literally.
			const TAG = "scr" + "ipt";
			f.srcdoc = '<!DOCTYPE html><html><body><' + TAG + '>' +
				'parent.postMessage({ souOTopo: parent === window }, "*");' +
				'</' + TAG + '></body></html>';
			document.body.appendChild(f);
			await new Promise((r) => { f.onload = r; setTimeout(r, 4000); });
			await new Promise((r) => setTimeout(r, 300));

			assertEqual(chegaram.length, 1, "the child's message must reach the parent (got " + chegaram.length + ")");
			assertEqual(chegaram[0].souOTopo, false, "a nested frame must not resolve parent to itself");
		`,
	}),
	basicTest({
		name: "frames-sandbox-attribute",
		js: `
			const f = document.createElement("iframe");
			f.sandbox = "allow-scripts allow-same-origin";
			f.src = "/frame.html";
			document.body.appendChild(f);
			assertEqual(f.getAttribute("sandbox"), "allow-scripts allow-same-origin", "sandbox attribute round trip");
			assertEqual([...f.sandbox].sort().join(","), "allow-same-origin,allow-scripts", "sandbox token list");
			f.sandbox.add("allow-forms");
			assert(f.sandbox.contains("allow-forms"), "token list is mutable");
		`,
	}),
];
