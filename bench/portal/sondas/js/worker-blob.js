(async () => {
  const cod = `
  const n = (f) => { try { return Function.prototype.toString.call(f); } catch (e) { return 'THROW ' + e.name; } };
  let st; try { null.x; } catch (e) { st = String(e.stack).split('\\n').slice(0, 4); }
  let st2; try { throw new Error('w'); } catch (e) { st2 = String(e.stack).split('\\n').slice(0, 3); }
  const nav = {}; for (const k in navigator) { try { const v = navigator[k]; nav[k] = typeof v === 'function' ? 'fn' : (typeof v === 'object' && v ? Object.prototype.toString.call(v) : String(v)); } catch (e) { nav[k] = 'THROW'; } }
  const ts = []; for (let i = 0; i < 5; i++) ts.push(performance.now() % 1);
  postMessage({ globais: Object.getOwnPropertyNames(self).sort(), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(self)).sort(), keys: Object.keys(self).sort(), href: String(location.href).slice(0, 120), origin: self.origin, name: self.name, nav, uad: navigator.userAgentData && JSON.stringify(navigator.userAgentData.brands), fetch: n(fetch), imp: n(importScripts), pm: n(postMessage), fts: n(Function.prototype.toString), ev: n(eval), Fn: n(Function), st, st2, coi: self.crossOriginIsolated, sab: typeof SharedArrayBuffer, pst: typeof Error.prepareStackTrace, ts, wasm: typeof WebAssembly, ctx: self.isSecureContext, tt: typeof self.trustedTypes, perfTO: performance.timeOrigin > 0, chrome: typeof self.chrome });
  `;
  let url = URL.createObjectURL(new Blob([cod], { type: 'text/javascript' }));
  const criar = () => { try { return new Worker(url); } catch (e) { const p = trustedTypes.defaultPolicy; return new Worker(p ? p.createScriptURL(url) : url); } };
  return await new Promise((ok) => { try { const w = criar(); const t = setTimeout(() => ok('timeout'), 6000); w.onmessage = (e) => { clearTimeout(t); ok(e.data); }; w.onerror = (e) => { clearTimeout(t); ok('erro ' + e.message); }; } catch (e) { ok('THROW ' + e); } });
})()
