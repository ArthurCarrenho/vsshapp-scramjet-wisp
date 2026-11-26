// O registro de um desafio na página da bancada, sem CDP. `sem-automacao.mjs` o anexa à
// `bancada-api.js` e abre o portal com `?auto=<alvo>&relato=<url>`. A cada 2 s ele manda por
// beacon o título da aba e as linhas que juntou, cada uma com o segundo em que aconteceu:
//
//   DOC       um documento novo num quadro (P é a aba, P.0 o primeiro quadro dentro dela)
//   NAV       toda navegação de um quadro (navigation.navigate), com o tipo e se veio de formulário
//   MSG       todo postMessage recebido, com a origem e o começo do dado
//   ERRO/REJ  erros e rejeições não tratadas de cada quadro
//   CSP       cada recusa da política de segurança de conteúdo
//   REQ       cada pedido do transporte ao alvo e ao Cloudflare: início, duração, método, status,
//             tamanho do corpo enviado, `content-length` da resposta e os cookies
//
// Os quadros são achados pelos getters nativos desta página (`length`, `document` e o índice da
// janela). O motor devolve a quem lê `frames` de dentro da página uma vista com as regras de uma
// janela de outra origem, e por ela o registro não chegaria ao quadro do Turnstile.
//
// Um cookie sai como nome, um hash FNV de 5 caracteres do valor e o tamanho dele: dá para ver que
// o valor mudou sem que ele apareça no log. O filtro de hosts é `tandfonline|cloudflare`, o caso
// que desafio-cloudflare.md mediu; troque-o para outro alvo.
(() => {
  const q = new URLSearchParams(location.search);
  const alvo = q.get('auto'); const relato = q.get('relato');
  if (!alvo || !relato) return;
  const T0 = performance.now(); const t = () => ((performance.now() - T0) / 1000).toFixed(2);
  const fila = []; const p = (s) => fila.push(t() + ' ' + String(s).slice(0, Number(q.get('larg') || 420)));
  const hsh = (x) => { let h = 2166136261; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 5); };
  const gLen = Object.getOwnPropertyDescriptor(window, 'length').get;
  const gDoc = Object.getOwnPropertyDescriptor(window, 'document').get;
  const gURL = Object.getOwnPropertyDescriptor(Document.prototype, 'URL').get;
  const ouvir = EventTarget.prototype.addEventListener;
  const curto = (u) => { let s = String(u); try { s = decodeURIComponent(s); } catch {} s = s.split('/scram/').pop().replace(/^https?:\/\//, ''); return s.replace(/(challenge-platform\/h\/\w\/)([\w-]+\/[\w-]+)\/.*/, '$1$2…').slice(0, 110); };
  const docs = new WeakSet(); const barrados = new WeakSet();
  const instalar = (w, d, rot) => {
    p(`DOC ${rot} ${curto(gURL.call(d))}`);
    ouvir.call(w, 'error', (e) => p(`${rot} ERRO ${String(e.message).slice(0, 200)} @${curto(e.filename || '')}:${e.lineno}:${e.colno}`), true);
    ouvir.call(w, 'unhandledrejection', (e) => { const r = e.reason; p(`${rot} REJ ${String(r && (r.stack || r.message) || r).replace(/\s+/g, ' ').slice(0, 300)}`); });
    ouvir.call(w, 'message', (e) => { let d2 = e.data, sd; try { sd = typeof d2 === 'string' ? d2 : JSON.stringify(d2); } catch { sd = typeof d2; } p(`${rot} MSG de=${e.origin} ${String(sd).slice(0, 260)}`); }, true);
    ouvir.call(d, 'securitypolicyviolation', (e) => p(`${rot} CSP ${e.violatedDirective} bloqueou=${curto(e.blockedURI)} @${curto(e.sourceFile || '')}:${e.lineNumber}`), true);
    ouvir.call(w, 'pagehide', () => p(`${rot} pagehide`), true);
    try { const n = w.navigation; if (n) ouvir.call(n, 'navigate', (e) => { p(`${rot} NAV ${e.navigationType} form=${!!e.formData} user=${e.userInitiated} ${curto(e.destination.url)}`); }); } catch (x) { p(`${rot} nav? ${x}`); }
  };
  const andar = (w, rot, fundo) => {
    let d; try { d = gDoc.call(w); } catch (x) { if (!barrados.has(w)) { barrados.add(w); p(`${rot} barrado ${String(x).slice(0, 80)}`); } return; }
    if (!d) return;
    if (!docs.has(d)) { docs.add(d); try { instalar(w, d, rot); } catch (x) { p(`${rot} instalar? ${x}`); } }
    if (fundo > 5) return;
    let n = 0; try { n = gLen.call(w); } catch {}
    for (let i = 0; i < n; i++) { try { andar(w[i], rot + '.' + i, fundo + 1); } catch (x) { p(`${rot}.${i} andar? ${x}`); } }
  };
  const reqs = [];
  addEventListener('load', async () => {
    try {
      await window.__bancada.iniciar();
      const C = window.LibcurlTransport && window.LibcurlTransport.LibcurlClient;
      if (C && !C.prototype.__sonda) {
        const orig = C.prototype.request; C.prototype.__sonda = 1;
        C.prototype.request = async function (url, method, body, headers, ...r) {
          const u = String(url); const ini = t(); const i0 = performance.now();
          const interessa = /tandfonline|cloudflare/.test(u);
          const rq = Array.isArray(headers) ? headers : Object.entries(headers || {});
          const ck = rq.filter(([k]) => /^cookie$/i.test(k)).map(([, v]) => String(v).split(';').map((c) => c.split('=')[0].trim() + '#' + hsh(c.split('=').slice(1).join('=').trim())).join('+')).join('+');
          let tam = null;
          if (interessa && body) {
            if (typeof body.tee === 'function') { const [a, b] = body.tee(); body = b; tam = (async () => { let n = 0; const rd = a.getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.byteLength; } return n; })().catch(() => '?'); }
            else tam = Promise.resolve(body.byteLength ?? body.size ?? body.length ?? '?');
          }
          try {
            const res = await orig.call(this, url, method, body, headers, ...r);
            if (interessa) {
              const hh = Array.isArray(res.headers) ? res.headers : Object.entries(res.headers || {});
              const sc = hh.filter(([k]) => /^set-cookie$/i.test(k)).flatMap(([, v]) => String(v).split(/,(?=\s*[\w.-]+=)/)).map((c) => { const nome = c.split('=')[0].trim(); const val = c.split(';')[0].split('=').slice(1).join('=').trim(); return `${nome}#${hsh(val)}/${val.length}${/partitioned/i.test(c) ? 'P' : ''}${/samesite=none/i.test(c) ? 'N' : ''}${/max-age=0|expires=thu, 01.jan.1970/i.test(c) ? 'X' : ''}`; }).join('+');
              const cl = (hh.find(([k]) => /^content-length$/i.test(k)) || [])[1];
              p(`REQ ini=${ini} dur=${Math.round(performance.now() - i0)}ms ${method} ${res.status} ${curto(u)}${tam ? ' corpo=' + await tam : ''}${cl ? ' cl=' + cl : ''}${ck ? ' [ck ' + ck + ']' : ''}${sc ? ' [sc ' + sc + ']' : ''}`);
            }
            return res;
          } catch (e) { if (interessa) p(`REQ ini=${ini} dur=${Math.round(performance.now() - i0)}ms ${method} ERR ${curto(u)} ${String(e).slice(0, 80)}`); throw e; }
        };
      }
      setInterval(() => { for (const el of document.querySelectorAll('iframe')) { try { andar(el.contentWindow, 'P', 0); } catch (x) { p('andar ' + x); } } }, 40);
      const r = await window.__bancada.abrir(alvo, 30000);
      setInterval(() => {
        let o; try { o = window.__bancada.olhar(r.id); } catch (e) { o = { erro: String(e) }; }
        try { navigator.sendBeacon(relato, JSON.stringify({ titulo: o.titulo || o.erro || '', foco: document.hasFocus(), vis: document.visibilityState, linhas: fila.splice(0) })); } catch {}
      }, 2000);
    } catch (e) { try { navigator.sendBeacon(relato, JSON.stringify({ erro: String(e && e.stack || e) })); } catch {} }
  });
})();
