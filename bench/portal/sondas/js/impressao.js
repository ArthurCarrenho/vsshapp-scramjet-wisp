(async function () {
  const out = {};
  const nat = (f) => { try { return Function.prototype.toString.call(f); } catch (e) { return 'THROW ' + e.name; } };
  const caminhos = ['fetch','XMLHttpRequest.prototype.open','XMLHttpRequest.prototype.send','setTimeout','setInterval','eval','Function','postMessage','Worker','SharedWorker','Blob','URL','URL.createObjectURL','URL.revokeObjectURL','Document.prototype.createElement','Element.prototype.setAttribute','Element.prototype.getAttribute','Element.prototype.attachShadow','Node.prototype.appendChild','Node.prototype.insertBefore','Node.prototype.cloneNode','History.prototype.pushState','History.prototype.replaceState','console.log','console.clear','console.warn','Promise.prototype.catch','Promise.prototype.then','Function.prototype.toString','Function.prototype.call','Function.prototype.apply','Function.prototype.bind','Object.getOwnPropertyDescriptor','Object.defineProperty','Reflect.apply','Error','Error.captureStackTrace','Performance.prototype.getEntries','Performance.prototype.getEntriesByType','Performance.prototype.now','open','MessagePort.prototype.postMessage','EventTarget.prototype.addEventListener','EventTarget.prototype.dispatchEvent','HTMLFormElement.prototype.submit','HTMLFormElement.prototype.requestSubmit','Storage.prototype.getItem','IDBFactory.prototype.open','Response.prototype.text','Request','Headers','WebSocket','EventSource','Image','Audio','Navigator.prototype.sendBeacon','Navigator.prototype.getBattery','ServiceWorkerContainer.prototype.register','Crypto.prototype.getRandomValues','SubtleCrypto.prototype.digest','WebAssembly.instantiate','WebAssembly.compile','HTMLCanvasElement.prototype.toDataURL','CanvasRenderingContext2D.prototype.getImageData','WebGLRenderingContext.prototype.getParameter','Date','Date.now','Math.random','JSON.parse','JSON.stringify','Array.prototype.push','String.prototype.replace','RegExp.prototype.exec','Symbol','Proxy','MutationObserver','IntersectionObserver','ResizeObserver','requestAnimationFrame','queueMicrotask','structuredClone','atob','btoa','importScripts','CSSStyleSheet.prototype.insertRule','FontFace','Notification','RTCPeerConnection','Intl.DateTimeFormat','DOMParser.prototype.parseFromString','Range.prototype.createContextualFragment','Document.prototype.write','Document.prototype.open','Document.prototype.querySelector','Element.prototype.getBoundingClientRect','HTMLElement.prototype.click','HTMLElement.prototype.focus','Window.prototype.getComputedStyle','getComputedStyle','matchMedia','alert','close','print','stop','focus','blur','scroll','find'];
  const pegar = (c) => c.split('.').reduce((o, k) => (o == null ? undefined : o[k]), self);
  out.fn = {};
  for (const c of caminhos) {
    let f; try { f = pegar(c); } catch (e) { out.fn[c] = 'THROW-GET ' + e.name; continue; }
    if (typeof f !== 'function') { out.fn[c] = typeof f; continue; }
    out.fn[c] = [nat(f), f.name, f.length, 'prototype' in f, Object.getOwnPropertyNames(f).sort().join(','), Object.prototype.toString.call(f)].join(' | ');
  }
  // os getters e setters dos acessores, que o motor costuma trocar
  const acessores = ['Document.prototype.cookie','Document.prototype.referrer','Document.prototype.URL','Document.prototype.domain','Document.prototype.documentURI','Document.prototype.baseURI','Node.prototype.baseURI','Document.prototype.currentScript','Document.prototype.location','Element.prototype.innerHTML','Element.prototype.outerHTML','Node.prototype.textContent','HTMLScriptElement.prototype.src','HTMLIFrameElement.prototype.src','HTMLIFrameElement.prototype.srcdoc','HTMLIFrameElement.prototype.contentWindow','HTMLIFrameElement.prototype.contentDocument','HTMLAnchorElement.prototype.href','HTMLImageElement.prototype.src','HTMLFormElement.prototype.action','Navigator.prototype.userAgent','Navigator.prototype.webdriver','Navigator.prototype.plugins','Navigator.prototype.serviceWorker','Navigator.prototype.languages','MessageEvent.prototype.origin','MessageEvent.prototype.source','MessageEvent.prototype.data','Event.prototype.isTrusted','Error.prototype.stack','PerformanceEntry.prototype.name','PerformanceResourceTiming.prototype.name','Attr.prototype.value','HTMLElement.prototype.style','Element.prototype.attributes','Node.prototype.ownerDocument','Node.prototype.parentNode','Window.prototype.top','Window.prototype.parent','HTMLElement.prototype.dataset','Document.prototype.styleSheets','CSSStyleDeclaration.prototype.cssText','Document.prototype.title'];
  out.acc = {};
  for (const c of acessores) {
    const i = c.lastIndexOf('.'); let o; try { o = pegar(c.slice(0, i)); } catch {}
    const d = o && Object.getOwnPropertyDescriptor(o, c.slice(i + 1));
    out.acc[c] = d ? ['get', d.get ? nat(d.get) : '-', 'set', d.set ? nat(d.set) : '-', d.configurable, d.enumerable, 'value' in d ? typeof d.value : ''].join(' | ') : 'ausente';
  }
  // descritores das propriedades da janela
  out.win = {};
  for (const k of ['location','top','parent','self','frames','opener','frameElement','document','name','origin','window','globalThis','length','closed','navigator','history','eval','Function','console','performance','postMessage','fetch','localStorage','sessionStorage','indexedDB','caches','crypto','isSecureContext','crossOriginIsolated','chrome','onmessage']) {
    const d = Object.getOwnPropertyDescriptor(self, k) || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(self), k) || Object.getOwnPropertyDescriptor(Window.prototype, k);
    out.win[k] = d ? ['get', d.get ? nat(d.get) : '-', 'set', d.set ? nat(d.set) : '-', d.configurable, d.enumerable, d.writable, 'value' in d ? typeof d.value : ''].join(' | ') : 'ausente';
  }
  out.globais = Object.getOwnPropertyNames(self).sort();
  out.globaisProto = Object.getOwnPropertyNames(Object.getPrototypeOf(self)).sort();
  try { out.locationKeys = Object.getOwnPropertyNames(location).sort().join(','); out.locationProto = Object.prototype.toString.call(location) + ' ' + Object.getPrototypeOf(location)?.constructor?.name; out.locationToString = nat(location.toString); out.locationAssign = nat(location.assign); out.locationReload = nat(location.reload); } catch (e) { out.locationErr = String(e); }
  try { out.docProto = Object.prototype.toString.call(document) + ' ' + Object.getPrototypeOf(document)?.constructor?.name; out.docKeys = Object.getOwnPropertyNames(document).sort().join(','); } catch (e) { out.docErr = String(e); }
  try { throw new Error('x'); } catch (e) { out.stack = String(e.stack).split('\n').map((l) => l.replace(/https?:\/\/[^\s)]+/g, (u) => u.length > 90 ? u.slice(0, 90) + '…' : u)); }
  out.stackTraceLimit = Error.stackTraceLimit; out.prepareStackTrace = typeof Error.prepareStackTrace;
  out.misc = {
    top: self.top === self, parent: self.parent === self, frameElement: (() => { try { return String(self.frameElement); } catch (e) { return 'THROW ' + e.name; } })(),
    length: self.length, historyLength: history.length, name: self.name, origin: self.origin, href: location.href, referrer: document.referrer, URL: document.URL, baseURI: document.baseURI,
    ancestorOrigins: location.ancestorOrigins ? [...location.ancestorOrigins] : null,
    scripts: document.scripts.length, elementos: document.querySelectorAll('*').length, headLen: document.head ? document.head.innerHTML.length : -1, html: document.documentElement.outerHTML.slice(0, 600),
    webdriver: navigator.webdriver, ua: navigator.userAgent, plugins: navigator.plugins.length, mime: navigator.mimeTypes.length, hc: navigator.hardwareConcurrency, mem: navigator.deviceMemory, langs: navigator.languages.join(','),
    swController: navigator.serviceWorker ? String(navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL) : 'sem',
    perfNav: (performance.getEntriesByType('navigation')[0] || {}).name, perfRes: performance.getEntriesByType('resource').map((e) => e.name.slice(0, 100)).slice(0, 15),
    perfNow: performance.now() > 0, timeOrigin: performance.timeOrigin > 0, 
    inner: [innerWidth, innerHeight, outerWidth, outerHeight, screenX, screenY, screen.width, screen.height, screen.availWidth, devicePixelRatio].join(','),
    hasFocus: document.hasFocus(), visibility: document.visibilityState, readyState: document.readyState,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone, consoleLogSame: console.log === console.log,
    evalThis: (0, eval)('this') === self, fnThis: Function('return this')() === self, 
    ls: (() => { try { return Object.keys(localStorage).join(','); } catch (e) { return 'THROW ' + e.name; } })(),
    cookie: (() => { try { return document.cookie.split(';').map((x) => x.split('=')[0].trim()).join(','); } catch (e) { return 'THROW ' + e.name; } })(),
    chrome: typeof self.chrome, chromeKeys: self.chrome ? Object.keys(self.chrome).join(',') : '',
  };
  try { out.misc.idb = (await indexedDB.databases()).map((d) => d.name).join(','); } catch (e) { out.misc.idb = 'THROW ' + e.name; }
  try { out.misc.caches = (await caches.keys()).join(','); } catch (e) { out.misc.caches = 'THROW ' + e.name; }
  try { out.misc.swRegs = (await navigator.serviceWorker.getRegistrations()).length; } catch (e) { out.misc.swRegs = 'THROW ' + e.name; }
  // num worker de blob
  try {
    const cod = 'const n=(f)=>Function.prototype.toString.call(f);let st;try{throw new Error("w")}catch(e){st=String(e.stack)};postMessage({href:self.location.href,ua:navigator.userAgent,fetch:n(fetch),importScripts:n(importScripts),postMessage:n(postMessage),stack:st.split("\\n").map(l=>l.slice(0,150)),globais:Object.getOwnPropertyNames(self).length,proto:Object.getOwnPropertyNames(Object.getPrototypeOf(self)).length,wd:navigator.webdriver})';
    const u = URL.createObjectURL(new Blob([cod], { type: 'text/javascript' }));
    out.worker = await new Promise((ok) => { const w = new Worker(u); const t = setTimeout(() => ok('timeout'), 6000); w.onmessage = (e) => { clearTimeout(t); ok(e.data); }; w.onerror = (e) => { clearTimeout(t); ok('erro ' + e.message); }; });
  } catch (e) { out.worker = 'THROW ' + e; }
  // um iframe srcdoc
  try {
    const f = document.createElement('iframe'); f.srcdoc = '<p>x</p>'; document.body.appendChild(f);
    await new Promise((ok) => { f.onload = ok; setTimeout(ok, 3000); });
    const fw = f.contentWindow;
    out.iframe = { href: fw.location.href, origin: fw.origin, top: fw.top === self.top, parent: fw.parent === self, fetchNat: nat(fw.fetch), toStringSame: fw.Function.prototype.toString === Function.prototype.toString, globais: Object.getOwnPropertyNames(fw).length, crossToString: nat.call(null, fw.fetch) };
    f.remove();
  } catch (e) { out.iframe = 'THROW ' + e; }
  return out;
})()
