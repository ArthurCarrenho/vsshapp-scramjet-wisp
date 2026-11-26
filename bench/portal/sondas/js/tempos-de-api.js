(async () => { const m = (f, n) => { try { const t = performance.now(); for (let i = 0; i < n; i++) f(i); return +((performance.now() - t) * 1000 / n).toFixed(2); } catch (e) { return "E"; } }; const o = {};
o.fn = m((i) => Function('a', 'return a+' + i), 40);
o.eval = m((i) => (0, eval)('1+' + i), 40);
o.stack = m(() => new Error('x').stack, 100);
o.tostr = m(() => Function.prototype.toString.call(Math.max), 300);
o.gopd = m(() => Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent').get.call(navigator), 300);
o.ua = m(() => navigator.userAgent, 500);
o.loc = m(() => location.href, 500);
o.doc = m(() => document.createElement('div').getBoundingClientRect(), 100);
o.canvas = m(() => { const c = document.createElement('canvas'); c.getContext('2d').fillText('x', 1, 1); return c.toDataURL(); }, 10);
o.json = m(() => JSON.stringify({ a: [1, 2, 3], b: 'x' }), 500);
o.date = m(() => Date.now(), 2000);
o.pnow = m(() => performance.now(), 2000);
let g = 1e9; let last = performance.now(); for (let i = 0; i < 2e4; i++) { const t = performance.now(); if (t !== last) { g = Math.min(g, t - last); last = t; } } o.gran = +(g * 1000).toFixed(1);
const t0 = performance.now(); const b = new Blob(['onmessage=e=>postMessage(e.data)'], { type: 'text/javascript' }); const w = new Worker(URL.createObjectURL(b)); await new Promise((ok) => { w.onmessage = ok; w.postMessage(1); }); o.worker = +(performance.now() - t0).toFixed(1); w.terminate();
const t1 = performance.now(); await new Promise((ok) => setTimeout(ok, 0)); o.st0 = +(performance.now() - t1).toFixed(2);
const t2 = performance.now(); await new Promise((ok) => { const c = new MessageChannel(); c.port1.onmessage = ok; c.port2.postMessage(1); }); o.mc = +(performance.now() - t2).toFixed(2);
return o; })()
