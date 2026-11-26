(() => { const t = performance.now(); for (let i = 0; i < 1500; i++) Function('a', 'return a+' + i); return { us: +((performance.now() - t) * 1000 / 1500).toFixed(1) }; })()
