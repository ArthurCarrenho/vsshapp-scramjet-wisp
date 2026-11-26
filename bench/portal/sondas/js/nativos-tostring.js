(async () => {
  const out = {};
  const fts = Function.prototype.toString;
  const sigF = (f) => { let s; try { s = fts.call(f); } catch (e) { s = 'THROW'; } const nat = /^function [\w$ ]*\(\) \{ \[native code\] \}$|^(get|set) [\w$]+\(\) \{ \[native code\] \}$|^function \(\) \{ \[native code\] \}$/.test(s); let n, l; try { n = f.name; l = f.length; } catch { } return 'f:' + n + '/' + l + (nat ? ':N' : ':' + s.slice(0, 50)); };
  const sigV = (v) => typeof v === 'function' ? sigF(v) : typeof v === 'object' ? (v === null ? 'null' : 'o:' + Object.prototype.toString.call(v)) : typeof v;
  const sigD = (d) => { if (!d) return 'none'; let s = (d.enumerable ? 'e' : '-') + (d.configurable ? 'c' : '-'); if ('value' in d) return s + (d.writable ? 'w' : '-') + ' ' + sigV(d.value); return s + ' G' + (d.get ? sigF(d.get) : '-') + ' S' + (d.set ? sigF(d.set) : '-'); };
  const walk = (obj, path) => { let ks; try { ks = Reflect.ownKeys(obj); } catch { out[path] = 'THROW keys'; return; } out[path + '#'] = ks.length + ' ' + String(Object.getPrototypeOf(obj) && Object.prototype.toString.call(Object.getPrototypeOf(obj))); for (const k of ks) { const ks2 = typeof k === 'symbol' ? k.toString() : k; let d; try { d = Object.getOwnPropertyDescriptor(obj, k); } catch { out[path + '.' + ks2] = 'THROW'; continue; } out[path + '.' + ks2] = sigD(d); } };
  walk(window, 'W');
  let p = Object.getPrototypeOf(window), i = 0; while (p && i < 6) { walk(p, 'Wp' + i); p = Object.getPrototypeOf(p); i++; }
  for (const k of Object.getOwnPropertyNames(window)) { let v; try { v = window[k]; } catch { continue; } if (typeof v === 'function' && /^[A-Z]/.test(k)) { walk(v, k); if (v.prototype) walk(v.prototype, k + '.P'); } else if (v && typeof v === 'object' && /^[A-Z]/.test(k) && k !== 'Window') walk(v, k); }
  for (const [n, o] of [['doc', document], ['nav', navigator], ['scr', screen], ['loc', location], ['hist', history], ['perf', performance]]) walk(o, n);
  return out;
})()
