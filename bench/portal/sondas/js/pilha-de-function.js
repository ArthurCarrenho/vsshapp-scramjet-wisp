(async () => {
  const o = {};
  function chamador() { return new Function("a", "return new Error('x').stack"); }
  o.F1 = chamador()(1);
  o.F2 = new Function("function inner(){ return new Error('y').stack } return inner()")();
  o.TS = chamador().toString();
  o.IE = (0, eval)("(function(){ return new Error('z').stack })")();
  o.E0 = new Error('top').stack;
  o.lim = Error.stackTraceLimit;
  o.pst = typeof Error.prepareStackTrace + ' ' + Object.getOwnPropertyNames(Error).join(',');
  try { null.x } catch (e) { o.TE = e.stack; }
  const t0 = performance.now(); for (let i = 0; i < 100; i++) new Function("return " + i)(); o.T100 = (performance.now() - t0).toFixed(1);
  return o;
})()
