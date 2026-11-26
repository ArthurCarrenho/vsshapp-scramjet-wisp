// O que o Chrome recusa, pedido a um quadro: a função como protótipo de si mesma, o `replaceState`
// para outra origem, a chamada ilegal de um nativo, e o que o isolamento de origem dá. Cada linha
// sai com o tipo do erro e a frase inteira. Use com `MODO=raw` no quadro do desafio, que exige
// Trusted Types e recusa a sonda injetada como <script>.
(async () => {
  const r = {};
  const tenta = (nome, f) => { try { const v = f(); r[nome] = v === undefined ? "undefined" : v; } catch (e) { r[nome] = "!! " + (e && e.name) + ": " + String(e && e.message).slice(0, 500) + " | pilha: " + String(e && e.stack).split("\n")[0].slice(0, 60) + " | " + (e instanceof DOMException ? "DOMException " + e.code : Object.prototype.toString.call(e)); } };
  // 1. Uma função nativa como protótipo de si mesma: o Chrome recusa com "Cyclic __proto__ value".
  for (const n of ["eval", "setTimeout", "setInterval", "removeEventListener", "addEventListener", "fetch", "postMessage", "Worker", "FontFace", "Function", "XMLHttpRequest", "open", "Image"]) {
    const f = window[n]; if (typeof f !== "function") { r["ciclo " + n] = "ausente"; continue; }
    const antes = Object.getPrototypeOf(f);
    tenta("ciclo " + n, () => { try { Object.setPrototypeOf(f, f); return "aceitou"; } finally { try { if (Object.getPrototypeOf(f) !== antes) Object.setPrototypeOf(f, antes); } catch (e) {} } });
  }
  tenta("ciclo por Object.create", () => { const f = window.setTimeout, antes = Object.getPrototypeOf(f); try { Object.setPrototypeOf(f, Object.create(f)); return "aceitou"; } finally { try { Object.setPrototypeOf(f, antes); } catch (e) {} } });
  tenta("ciclo por Reflect", () => { const f = window.setTimeout, antes = Object.getPrototypeOf(f); try { return Reflect.setPrototypeOf(f, f); } finally { try { Object.setPrototypeOf(f, antes); } catch (e) {} } });
  tenta("ciclo por __proto__", () => { const f = window.setInterval, antes = Object.getPrototypeOf(f); try { f.__proto__ = f; return "aceitou"; } finally { try { Object.setPrototypeOf(f, antes); } catch (e) {} } });
  // 2. Isolamento de origem.
  tenta("crossOriginIsolated", () => crossOriginIsolated);
  tenta("typeof SharedArrayBuffer", () => typeof SharedArrayBuffer);
  tenta("SharedArrayBuffer nos nomes da janela", () => Object.getOwnPropertyNames(window).includes("SharedArrayBuffer"));
  tenta("nomes da janela", () => Object.getOwnPropertyNames(window).length);
  // 3. replaceState para outra origem: o Chrome recusa com SecurityError.
  tenta("replaceState outra origem", () => { const u = location.href; try { history.replaceState({}, "", "https://example.org/"); return "aceitou"; } finally { try { history.replaceState(history.state, "", u); } catch (e) {} } });
  tenta("pushState outra origem", () => { history.pushState({}, "", "https://example.org/x"); return "aceitou"; });
  // 4. Error.prepareStackTrace não existe no Chrome.
  tenta("descritor de Error.prepareStackTrace", () => { const d = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"); return d ? Object.keys(d).join(",") : "undefined"; });
  tenta("'prepareStackTrace' in Error", () => "prepareStackTrace" in Error);
  tenta("hasOwn(Error, prepareStackTrace)", () => Object.hasOwn(Error, "prepareStackTrace"));
  tenta("nomes próprios de Error", () => Object.getOwnPropertyNames(Error).join(","));
  // 5. Chamada ilegal de um nativo: o Chrome responde "Illegal invocation".
  tenta("setAttribute sem this", () => Element.prototype.setAttribute.call(undefined));
  tenta("setAttribute sem argumentos", () => document.createElement("div").setAttribute());
  tenta("setAttribute this errado", () => Element.prototype.setAttribute.call({}, "a", "b"));
  tenta("getAttribute this errado", () => Element.prototype.getAttribute.call({}, "a"));
  tenta("appendChild this errado", () => Node.prototype.appendChild.call({}, document.createElement("p")));
  tenta("innerHTML getter this errado", () => Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML").get.call({}));
  tenta("href getter this errado", () => Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, "href").get.call({}));
  tenta("addEventListener this errado", () => EventTarget.prototype.addEventListener.call({}, "x", () => {}));
  tenta("fetch this errado", () => { fetch.call({}, "data:,").catch(() => {}); return "sem throw síncrono"; });
  tenta("postMessage sem argumentos", () => window.postMessage());
  // 6. O registro de performance de um pedido do próprio quadro.
  await new Promise((ok) => {
    const x = new XMLHttpRequest(); const u = "/cdn-cgi/challenge-platform/h/g/pat/sonda-" + Math.random().toString(36).slice(2);
    x.open("GET", u); x.onloadend = () => setTimeout(() => {
      const e = performance.getEntriesByType("resource").filter((y) => y.name.includes("sonda-")).pop();
      r["xhr status"] = x.status; r["xhr corpo"] = (x.responseText || "").length;
      r["xhr content-encoding"] = x.getResponseHeader("content-encoding"); r["xhr content-length"] = x.getResponseHeader("content-length");
      r["registro do xhr"] = e ? { nome: e.name.slice(0, 60), nextHopProtocol: e.nextHopProtocol, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, responseStatus: e.responseStatus, initiatorType: e.initiatorType, deliveryType: e.deliveryType, workerStart: e.workerStart > 0, connectStartIgualFetchStart: e.connectStart === e.fetchStart, secureConnectionStart: e.secureConnectionStart > 0, serverTiming: e.serverTiming.length, renderBlockingStatus: e.renderBlockingStatus, contentType: e.contentType } : "sem registro";
      ok();
    }, 80); x.send();
  });
  tenta("registro de navegação", () => { const e = performance.getEntriesByType("navigation")[0]; return { nextHopProtocol: e.nextHopProtocol, transferSize: e.transferSize > 0, encodedIgualDecoded: e.encodedBodySize === e.decodedBodySize, workerStart: e.workerStart > 0, deliveryType: e.deliveryType, type: e.type, responseStatus: e.responseStatus }; });
  tenta("tipos de registro", () => [...new Set(performance.getEntries().map((e) => e.entryType))].join(","));
  tenta("passo do relógio (µs)", () => { const v = new Set(); let a = performance.now(); for (let i = 0; i < 20000 && v.size < 30; i++) { const b = performance.now(); if (b !== a) { v.add(+(b - a).toFixed(4)); a = b; } } return Math.min(...v) * 1000; });
  return r;
})()
