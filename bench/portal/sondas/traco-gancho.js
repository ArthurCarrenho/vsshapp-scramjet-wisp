// O traço das chamadas de API que o código da página faz, com o que cada uma devolve. Instala
// ACIMA do motor: num quadro proxiado, espera o cliente do motor estar de pé e entra antes do
// primeiro script do site (o MutationObserver roda no ponto de microtarefas que antecede a execução
// de cada <script> do parser). No Chrome direto entra na criação do documento.
(() => {
  const MODO = "__MODO__"; // traco.mjs põe aqui "direto" ou "motor"
  if (window.__trOk) return; Object.defineProperty(window, "__trOk", { value: 1, enumerable: false });
  const R = Reflect, O = Object;
  const dbg = console.debug.bind(console), JSON_S = JSON.stringify, setInt = window.setInterval.bind(window), agora = performance.now.bind(performance);
  const tsNativo = Function.prototype.toString, ots = O.prototype.toString;
  const proxiado = /\/~sj\//.test(location.href);
  if (MODO === "motor" && !proxiado) return;
  const id = Math.random().toString(36).slice(2, 7), t0 = agora();
  const distintas = new Map(); let novas = []; let dentro = false; let total = 0;
  const NEGADOS = new Set(["Array", "String", "RegExp", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "Symbol", "Number", "Boolean", "BigInt", "Iterator", "ArrayBuffer", "SharedArrayBuffer", "DataView", "Proxy", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "Float16Array", "BigInt64Array", "BigUint64Array", "Function", "Object", "console", "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError", "FinalizationRegistry", "AsyncDisposableStack", "DisposableStack", "SuppressedError", "TextDecoder", "TextEncoder", "Node", "EventTarget", "Event", "MutationObserver", "MutationRecord", "NodeList", "DOMTokenList", "Text", "CharacterData", "Math", "Atomics", "Date", "JSON", "Reflect", "Intl", "WebAssembly", "globalThis", "window", "self", "frames", "parent", "top", "document", "location"]);
  const rep = (v, d) => {
    try {
      switch (typeof v) {
        case "string": return JSON_S(v.length > 140 ? v.slice(0, 140) + "…" + v.length : v);
        case "number": case "boolean": case "undefined": case "bigint": return String(v);
        case "symbol": return "sym";
        case "function": { let n = ""; try { n = O.getOwnPropertyDescriptor(v, "name")?.value; } catch {} return "ƒ" + (typeof n === "string" ? n : "?"); }
        default: {
          if (v === null) return "null";
          const tag = ots.call(v);
          if (tag === "[object Array]" && !d) { const n = v.length; let s = "["; for (let i = 0; i < n && i < 6; i++) s += (i ? "," : "") + rep(v[i], 1); return s + (n > 6 ? ",…" + n : "") + "]"; }
          return tag.slice(8, -1);
        }
      }
    } catch (e) { return "!rep"; }
  };
  const anota = (nome, alvo, args, r, erro) => {
    dentro = true;
    try {
      total++;
      let s = nome + "("; for (let i = 0; i < args.length && i < 5; i++) s += (i ? "," : "") + rep(args[i]);
      s += ")" + (erro !== undefined ? " !! " + rep(String(erro)) : " -> " + rep(r));
      const n = distintas.get(s); if (n === undefined) { distintas.set(s, 1); if (distintas.size < 60000) novas.push(Math.round(agora() - t0) + " " + s); } else distintas.set(s, n + 1);
    } catch (e) {} finally { dentro = false; }
  };
  const embrulhos = new WeakMap();
  const embrulha = (orig, nome) => {
    if (typeof orig !== "function" || embrulhos.has(orig)) return orig;
    const w = function () {
      if (dentro) return new.target ? R.construct(orig, arguments, new.target) : R.apply(orig, this, arguments);
      let r, erro, falhou = false;
      try { r = new.target ? R.construct(orig, arguments, new.target) : R.apply(orig, this, arguments); } catch (e) { erro = e; falhou = true; }
      anota(nome, this, arguments, r, falhou ? erro : undefined);
      if (falhou) throw erro; return r;
    };
    try { O.defineProperty(w, "name", { value: O.getOwnPropertyDescriptor(orig, "name")?.value, configurable: true }); O.defineProperty(w, "length", { value: orig.length, configurable: true }); } catch {}
    embrulhos.set(w, orig);
    return w;
  };
  const trata = (obj, nomeObj, pular) => {
    let chaves; try { chaves = R.ownKeys(obj); } catch { return; }
    for (const k of chaves) {
      if (typeof k !== "string" || k === "constructor" || k === "prototype" || (pular && pular.has(k))) continue;
      let d; try { d = O.getOwnPropertyDescriptor(obj, k); } catch { continue; }
      if (!d || !d.configurable) continue;
      try {
        if (typeof d.value === "function") {
          if (/^[A-Z]/.test(k) && d.value.prototype) continue; // interface: tratada à parte
          O.defineProperty(obj, k, { ...d, value: embrulha(d.value, nomeObj + "." + k) });
        } else if (d.get || d.set) {
          O.defineProperty(obj, k, { ...d, get: d.get && embrulha(d.get, nomeObj + "." + k + "<get>"), set: d.set && embrulha(d.set, nomeObj + "." + k + "<set>") });
        }
      } catch {}
    }
  };
  const instalar = () => {
    dentro = true;
    try {
      const nomes = O.getOwnPropertyNames(window);
      const PULAR_JANELA = new Set(["window", "self", "document", "location", "top", "parent", "frames", "eval", "Function", "console", "customElements", "__trOk", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "requestIdleCallback", "cancelIdleCallback", "cancelAnimationFrame", "addEventListener", "removeEventListener", "dispatchEvent"]);
      for (const n of nomes) {
        if (NEGADOS.has(n) || n.startsWith("$scramjet") || n.startsWith("__")) continue;
        let d; try { d = O.getOwnPropertyDescriptor(window, n); } catch { continue; }
        const v = d && d.value;
        if (typeof v === "function" && /^[A-Z]/.test(n) && v.prototype && typeof v.prototype === "object") { trata(v.prototype, n + "#"); trata(v, n, new Set(["name", "length", "caller", "arguments"])); }
        else if (v && typeof v === "object" && /^[A-Z]/.test(n)) trata(v, n);
      }
      trata(window, "window", PULAR_JANELA);
      // À mão, do que ficou de fora por ser quente demais para embrulhar inteiro.
      for (const [obj, nome, chaves] of [
        [O, "Object", ["getOwnPropertyDescriptor", "getOwnPropertyDescriptors", "getOwnPropertyNames", "getOwnPropertySymbols", "keys", "getPrototypeOf", "setPrototypeOf", "defineProperty", "isFrozen", "isExtensible", "entries"]],
        [R, "Reflect", ["ownKeys", "getOwnPropertyDescriptor", "getPrototypeOf", "has", "construct"]],
        [Function.prototype, "Function#", ["toString", "bind"]],
        [Error, "Error", ["captureStackTrace"]],
        [Date, "Date", ["now"]], [Date.prototype, "Date#", ["getTimezoneOffset", "toString", "toLocaleString", "toLocaleDateString", "toLocaleTimeString", "getTime"]],
        [Math, "Math", ["random"]],
        [Intl.DateTimeFormat.prototype, "Intl.DateTimeFormat#", ["resolvedOptions", "format"]], [Intl.NumberFormat.prototype, "Intl.NumberFormat#", ["resolvedOptions", "format"]],
        [EventTarget.prototype, "EventTarget#", ["addEventListener", "dispatchEvent"]],
        [Node.prototype, "Node#", ["appendChild", "removeChild", "insertBefore", "cloneNode", "getRootNode", "contains"]],
        [String.prototype, "String#", ["localeCompare", "normalize"]],
        [Array.prototype, "Array#", []],
        [JSON, "JSON", ["stringify", "parse"]],
      ]) for (const k of chaves) { try { const d = O.getOwnPropertyDescriptor(obj, k); if (d && typeof d.value === "function" && d.configurable !== false) O.defineProperty(obj, k, { ...d, value: embrulha(d.value, nome + "." + k) }); } catch {} }
      try { const d = O.getOwnPropertyDescriptor(Error.prototype, "stack"); } catch {}
      // O toString dos embrulhos devolve o do que está embaixo (o nativo, ou o invólucro do motor).
      const tsAtual = Function.prototype.toString;
      const ts = function toString() { let alvo = this; for (let i = 0; i < 4 && embrulhos.has(alvo); i++) alvo = embrulhos.get(alvo); return R.apply(tsAtual, alvo, arguments); };
      embrulhos.set(ts, tsNativo);
      O.defineProperty(Function.prototype, "toString", { value: ts, writable: true, configurable: true });
    } catch (e) { novas.push("0 !instalar " + e); } finally { dentro = false; }
    novas.push(Math.round(agora() - t0) + " #instalado " + MODO + " " + document.readyState + " scripts=" + document.scripts.length);
  };
  const manda = () => { if (!novas.length) return; const lote = novas; novas = []; try { dbg("__TR__" + JSON_S({ id, u: location.href.slice(0, 400), total, linhas: lote })); } catch (e) {} };
  setInt(manda, 250); window.addEventListener("pagehide", manda, true);
  if (MODO !== "motor") { instalar(); return; }
  let feito = false;
  const mo = new MutationObserver(() => { if (feito) return; if (typeof self.$scramjet$wrap === "function" || typeof self["$scramjet$wrap"] !== "undefined") { feito = true; mo.disconnect(); instalar(); } });
  mo.observe(document, { childList: true, subtree: true });
})();
