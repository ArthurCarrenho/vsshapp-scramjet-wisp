import { basicTest, multiFrameTest } from "../testcommon.ts";

export default [
	basicTest({
		name: "postmessage-fake-target-sanity",
		js: `
            const messages = [];
            const fakeTarget = {
                postMessage: (msg) => messages.push(msg)
            };
            fakeTarget.postMessage("test");
            assertEqual(messages.length, 1, "postMessage should be called");
            assertEqual(messages[0], "test", "message should be correct");
        `,
	}),
	basicTest({
		name: "postmessage-sanity",
		js: `
            addEventListener("message", (event) => {
                assertEqual(event.data, "test", "message should be correct");
                pass();
            });
            postMessage("test");
        `,
		autoPass: false,
	}),
	basicTest({
		// `x["postMessage"]` has to behave exactly like `x.postMessage`. The rewriter wraps the
		// *object* on the static form so the envelope can carry the real origin; the computed form
		// used to skip that entirely, which meant a page could spell the property as a string and
		// silently get a different origin than the one every other caller sees. Anti-bot and captcha
		// code reaches for computed access routinely, so the gap pointed at its most likely caller.
		//
		// The assertion is on `origin`, not on delivery: an unwrapped call still *arrives*, it just
		// arrives claiming the proxy's own origin. Asserting only that the message showed up would
		// pass with the bug present.
		name: "postmessage-computed-property-origin",
		js: `
            addEventListener("message", (event) => {
                assertEqual(event.data, "computed", "message should be correct");
                assertEqual(event.origin, location.origin, "computed access must report the proxied origin");
                pass();
            });
            window["postMessage"]("computed", "*");
        `,
		autoPass: false,
	}),
	basicTest({
		name: "postmessage-event-meta-sanity",
		js: `
            addEventListener("message", (event) => {
                assertEqual(event.isTrusted, true, "isTrusted should be true");
                assertEqual(event.source, window, "source should be correct");
                assertEqual(event.origin, location.origin, "origin should be correct");
                pass();
            });
            postMessage("test");
        `,
		autoPass: false,
	}),
	basicTest({
		name: "postmessage-self-sanity",
		js: `
            addEventListener("message", (event) => {
                assertEqual(event.data, "test", "message should be correct");
                pass();
            });
            self.postMessage("test");
        `,
		autoPass: false,
	}),
	basicTest({
		name: "postmessage-self-event-meta-sanity",
		js: `
            addEventListener("message", (event) => {
                assertEqual(event.isTrusted, true, "isTrusted should be true");
                assertEqual(event.source, window, "source should be correct");
                assertEqual(event.origin, location.origin, "origin should be correct");
                pass();
            });
            self.postMessage("test");
        `,
		autoPass: false,
	}),
	multiFrameTest({
		name: "postmessage-multi-frame-sanity",
		root: {
			js: () => `
                addEventListener("message", (event) => {
                    assertEqual(event.data, "test", "message should be correct");
                    pass();
                });
            `,
			subframes: [
				{
					id: "child",
					js: () => `
                        parent.postMessage("test");
                    `,
				},
			],
		},
	}),
	multiFrameTest({
		name: "postmessage-multi-frame-sanity-reverse",
		root: {
			js: () => `
                window.onload = () => {
                    frames[0].postMessage("test-reverse");
                };
            `,
			subframes: [
				{
					id: "child",
					js: () => `
                    addEventListener("message", (event) => {
                        assertEqual(event.data, "test-reverse", "message should be correct");
                        pass();
                    });
                    `,
				},
			],
		},
	}),
	multiFrameTest({
		name: "postmessage-multi-frame-sanity-cross",
		root: {
			js: () => `
                addEventListener("message", (event) => {
                    assertEqual(event.data, "test", "message should be correct");
                    pass();
                });
            `,
			subframes: [
				{
					originid: "cross",
					id: "child",
					js: () => `
                        parent.postMessage("test", "*");
                    `,
				},
			],
		},
	}),
	multiFrameTest({
		name: "postmessage-multi-frame-sanity-reverse-cross",
		root: {
			js: () => `
                window.onload = () => {
                    frames[0].postMessage("test-reverse", "*");
                };
            `,
			subframes: [
				{
					originid: "cross",
					id: "child",
					js: () => `
                        addEventListener("message", (event) => {
                            assertEqual(event.data, "test-reverse", "message should be correct");
                            pass();
                        });
                    `,
				},
			],
		},
	}),
	multiFrameTest({
		// `targetOrigin` is a URL, not an origin. The native postMessage accepts any absolute URL
		// and compares only its origin component, so "https://a.com/" and "https://a.com" address
		// the same window.
		//
		// Scramjet can't let the browser make that call - the real origin is the proxy's - so the
		// requested target rides in the envelope and is checked on arrival. That check compared the
		// raw string against `client.url.origin`, and `URL.origin` never carries a trailing slash:
		// any site that spelled its own origin as a URL had its messages dropped, silently.
		//
		// YouTube is one. The close button on the chat replay panel posts
		// `{"yt-hide-live-chat":"*"}` to `location.origin + "/"`, the watch page never saw it, and
		// the panel would not close - no error, nothing in the console, just a dead button.
		//
		// The trailing slash IS the test. Remove it and this passes with the bug present.
		name: "postmessage-multi-frame-target-origin-url",
		root: {
			js: () => `
                addEventListener("message", (event) => {
                    assertEqual(event.data, "barra-final", "message should be correct");
                    assertEqual(event.origin, location.origin, "origin must be the proxied one");
                    pass();
                });
            `,
			subframes: [
				{
					id: "child",
					js: () => `
                        parent.postMessage("barra-final", location.origin + "/");
                    `,
				},
			],
		},
	}),
	multiFrameTest({
		// O outro lado: normalizar NÃO pode afrouxar. Uma mensagem endereçada a outra origem
		// continua não sendo entregue — é a restrição que o remetente escreveu, e o motivo de a
		// conferência existir (`postMessage(token, "https://conhecido")` existe para o token não ir
		// a mais ninguém).
		//
		// O marcador vem depois, sem restrição, para dar um ponto de parada determinístico: afirmar
		// ausência esperando um timeout tornaria o teste lento e frouxo.
		name: "postmessage-multi-frame-target-origin-alheia",
		root: {
			js: () => `
                let indevida = false;
                addEventListener("message", (event) => {
                    if (event.data === "para-outra-origem") indevida = true;
                    if (event.data === "marcador") {
                        assertEqual(indevida, false, "message addressed to another origin must not be delivered");
                        pass();
                    }
                });
            `,
			subframes: [
				{
					id: "child",
					js: () => `
                        parent.postMessage("para-outra-origem", "https://nao-somos-nos.invalid/");
                        parent.postMessage("marcador", "*");
                    `,
				},
			],
		},
	}),
];
