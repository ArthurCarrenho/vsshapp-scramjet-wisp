(async () => {
  const o = {};
  const k = (x) => { try { return Reflect.ownKeys(x).map(String).join(','); } catch (e) { return 'THROW'; } };
  const x = new XMLHttpRequest(); x.open('GET', '/favicon.ico'); x.setRequestHeader('x-a', '1'); o.xhr = k(x); x.send(); await new Promise((r) => { x.onloadend = r; setTimeout(r, 3000); }); o.xhr2 = k(x);
  const a = document.createElement('a'); a.href = '/x'; a.setAttribute('target', '_blank'); o.a = k(a);
  const s = document.createElement('script'); s.src = '/y.js'; o.s = k(s);
  const i = document.createElement('img'); i.src = '/z.png'; o.img = k(i);
  const f = document.createElement('iframe'); f.src = 'about:blank'; document.body.appendChild(f); o.ifr = k(f); try { o.ifrw = k(f.contentWindow).split(',').length; o.ifrd = k(f.contentDocument); } catch (e) { o.ifrw = 'THROW'; } f.remove();
  const req = new Request('/q', { method: 'POST', body: 'x' }); o.req = k(req);
  const res = await fetch('/favicon.ico'); o.res = k(res) + ' url=' + res.url.replace(/[?#].*/, ''); o.resh = [...res.headers.keys()].join(',');
  o.ev = k(new Event('x')); o.me = k(new MessageEvent('message', { data: 1 }));
  try { const ws = new WebSocket('wss://echo.websocket.events/'); o.ws = k(ws) + ' url=' + ws.url; ws.close(); } catch (e) { o.ws = 'THROW ' + e.name; }
  const u = URL.createObjectURL(new Blob(['1'])); o.blob = u.replace(/[0-9a-f-]{36}/, 'U'); URL.revokeObjectURL(u);
  o.doc = k(document); o.html = k(document.documentElement); o.body = k(document.body); o.head = k(document.head);
  o.scripts = [...document.scripts].map((s) => k(s)).join('|');
  o.links = [...document.querySelectorAll('link')].map((s) => k(s)).join('|');
  o.nav = k(navigator); o.hist = k(history); o.loc = k(location); o.scr = k(screen);
  o.fn = k(function () {}); o.err = k(new Error('x')); o.prom = k(Promise.resolve());
  return o;
})()
