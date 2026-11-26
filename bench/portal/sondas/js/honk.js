// O custo de avaliar uma fonte com um megabyte de espaços na frente de uma expressão curta, que é
// o que o desafio do Cloudflare avalia duas vezes por segundo: pelo `eval` indireto, pelo `eval`
// seguido da leitura de uma pilha, e pelo `Function`. Use no documento do site, como <script>
// (`MODO=script` pelo motor), para a sonda passar pelo rewriter como o código do site.
(async () => {
  const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const med = (v) => { const o = [...v].sort((a, b) => a - b); return o[Math.floor(o.length / 2)]; };
  const esp = ' '.repeat(1337331);
  const so = [], comPilha = [], pequeno = [], fn = [];
  for (let i = 0; i < 7; i++) {
    let s = esp + '0, /.*honk.*/, ' + (Date.now() + i);
    let t = performance.now(); let v = (0, eval)(s); so.push(performance.now() - t);
    await pausa(15);
    s = esp + '0, /.*honk.*/, ' + (Date.now() + 100 + i);
    t = performance.now(); v = (0, eval)(s); const p = new Error().stack; comPilha.push(performance.now() - t);
    await pausa(15);
    s = '0, /.*honk.*/, ' + (Date.now() + 200 + i);
    t = performance.now(); v = (0, eval)(s); pequeno.push(performance.now() - t);
    s = esp + 'return ' + (Date.now() + 300 + i);
    t = performance.now(); v = Function(s)(); fn.push(performance.now() - t);
    await pausa(15);
  }
  const f = (x) => +x.toFixed(2);
  return { evalHonk_ms: { mediana: f(med(so)), todas: so.map(f) }, evalHonkMaisPilha_ms: { mediana: f(med(comPilha)), todas: comPilha.map(f) }, evalPequeno_ms: { mediana: f(med(pequeno)) }, functionHonk_ms: { mediana: f(med(fn)), todas: fn.map(f) } };
})()
