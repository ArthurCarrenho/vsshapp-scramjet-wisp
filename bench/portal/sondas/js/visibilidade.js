(async () => {
  const o = { vis: document.visibilityState, hid: document.hidden, focus: document.hasFocus() };
  o.paint0 = performance.getEntriesByType('paint').map((e) => e.name).join(',');
  o.raf = await new Promise((ok) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else ok(n); }; requestAnimationFrame(f); setTimeout(() => ok('to ' + n), 2500); });
  o.io = await new Promise((ok) => { try { const io = new IntersectionObserver((es) => { ok(es.map((e) => e.isIntersecting + ':' + e.intersectionRatio.toFixed(2) + ':' + Math.round(e.boundingClientRect.width) + 'x' + Math.round(e.boundingClientRect.height) + ':' + JSON.stringify(e.rootBounds && [Math.round(e.rootBounds.width), Math.round(e.rootBounds.height)])).join(';')); io.disconnect(); }); io.observe(document.body || document.documentElement); setTimeout(() => ok('to'), 2000); } catch (e) { ok('THROW ' + e); } });
  o.paint1 = performance.getEntriesByType('paint').map((e) => e.name).join(',');
  o.loaf = performance.getEntriesByType('long-animation-frame').length;
  o.loafObs = await new Promise((ok) => { try { new PerformanceObserver((l) => ok(l.getEntries().length)).observe({ type: 'long-animation-frame', buffered: true }); setTimeout(() => ok('none'), 1500); } catch (e) { ok('THROW ' + e); } });
  o.paintObs = await new Promise((ok) => { try { new PerformanceObserver((l) => ok(l.getEntries().map((e) => e.name).join(','))).observe({ type: 'paint', buffered: true }); setTimeout(() => ok('none'), 1500); } catch (e) { ok('THROW ' + e); } });
  o.supported = PerformanceObserver.supportedEntryTypes.join(',');
  return o;
})()
