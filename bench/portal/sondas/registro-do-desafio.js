// O registro de um desafio na página da bancada, sem CDP. `sem-automacao.mjs` o anexa à
// `bancada-api.js` e abre o portal com `?auto=<alvo>&relato=<url>`. A cada 3 s ele manda por
// beacon o título da aba e o que juntou desde o último relato:
//
//   NAV       toda navegação de um quadro (navigation.navigate), com o tipo, se veio de formulário
//             e a pilha de quem a pediu
//   ERRO/REJ  erros e rejeições não tratadas de cada quadro, por nível (P é a aba, F1, F2... os
//             quadros dentro dela)
//   MSG       todo postMessage recebido, com a origem e o começo do dado
//   COOKIE    os nomes dos cookies que cada quadro enxerga, quando mudam
//   pedidos   método, status e caminho de cada pedido do transporte para o alvo e para o
//             Cloudflare, com os nomes dos cookies enviados e recebidos
//
// Um cookie sai só como nome e um hash FNV de 5 caracteres do valor: dá para ver que o valor mudou
// sem que ele apareça no log. O filtro de hosts é o padrão `tandfonline|challenges`, o caso que a
// investigação de desafio-cloudflare.md mediu; troque-o para outro alvo.
// ─── Execução sem automação (só na estação, fora do repositório) ───
(() => {
const __h = (x) => { let h = 2166136261; for (let i = 0; i < x.length; i++) { h ^= x.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36).slice(0, 5); };

  const q = new URLSearchParams(location.search);
  const alvo = q.get('auto'); const relato = q.get('relato');
  if (!alvo || !relato) return;
  const enviar = (o) => { try { navigator.sendBeacon(relato, JSON.stringify(o)); } catch {} };
  const reqs = []; const _vistosN = new WeakSet(), _vistosE = new WeakSet(), _vistosEl = new WeakSet();
  addEventListener('load', async () => {
    try {
      await window.__bancada.iniciar();
      const C = window.LibcurlTransport && window.LibcurlTransport.LibcurlClient;
      if (C && !C.prototype.__sonda) {
        const orig = C.prototype.request; C.prototype.__sonda = 1;
        C.prototype.request = async function (url, method, body, headers, ...r) {
          const u = String(url); const t = Date.now();
          const curto = u.replace(/^https?:\/\//, '').replace(/(cdn-cgi\/challenge-platform\/h\/\w\/)(\w+)\/.*/, '$1$2').slice(0, 90);
          try { const res = await orig.call(this, url, method, body, headers, ...r);
            if (/tandfonline|challenges/.test(u)) {
              const hh = Array.isArray(res.headers) ? res.headers : Object.entries(res.headers || {});
              const sc = hh.filter(([k]) => /^set-cookie$/i.test(k)).map(([, v]) => String(v).split(/,(?=\s*[\w.-]+=)/).map((c) => c.split('=')[0].trim() + '#' + __h(c.split(';')[0].split('=').slice(1).join('=').trim()) + (/partitioned/i.test(c) ? '(P)' : '') + (/samesite=none/i.test(c) ? '(N)' : '')).join('+')).join('+');
              const rq = Array.isArray(headers) ? headers : Object.entries(headers || {});
              const ck = rq.filter(([k]) => /^cookie$/i.test(k)).map(([, v]) => String(v).split(';').map((c) => c.split('=')[0].trim() + '#' + __h(c.split('=').slice(1).join('=').trim())).join('+')).join('+');
              reqs.push(`${method} ${res.status} ${curto}` + (body ? ` len=${body.byteLength ?? body.size ?? body.length ?? '?'} t=${Object.prototype.toString.call(body)}${Array.isArray(body) ? body.length + ':' + body.map((x) => x && (x.byteLength ?? x.length)).join('+') : ''}` : '') + (ck ? ` [ck ${ck}]` : '') + (sc ? ` [sc ${sc}]` : '') + (/eprint|orchestrate|\/flow\/|\/pat|\/fo|turnstile\/f/.test(u) ? ` [h ${rq.map(([k, v]) => /^sec-ch|^user-agent|^sec-fetch|^priority/i.test(k) ? k + '=' + v : k).join('|')}]` : ''));
            }
            return res; }
          catch (e) { if (/tandfonline|challenges/.test(u)) reqs.push(`${method} ERR ${curto}`); throw e; }
        };
      }
      const navs = [];
      const ligar = () => {
        for (const el of document.querySelectorAll('iframe')) {
          if (_vistosEl.has(el)) continue; _vistosEl.add(el);
          const instalar = () => { try { const w = el.contentWindow; if (!w || _vistosN.has(w)) return; _vistosN.add(w);
            w.addEventListener('beforeunload', () => navs.push('beforeunload'));
            const n = w.navigation; if (n) n.addEventListener('navigate', (e) => { let u = ''; try { u = decodeURIComponent(String(e.destination.url)).split('scram/').pop().slice(0, 140); } catch {}
              let pilha = ''; try { const E = Error; const lim = E.stackTraceLimit; E.stackTraceLimit = 40; pilha = String(new E().stack).split('\n').slice(1).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^ ]*(challenge-platform|bancada|scramjet)/, '$1').slice(0, 160)).join(' < '); E.stackTraceLimit = lim; } catch {} navs.push(`NAV ${e.navigationType} form=${!!e.formData} user=${e.userInitiated} ${u} STACK ${pilha}`); });
          } catch (x) { navs.push('instalar ' + x); } };
          el.addEventListener('load', instalar); instalar();
        }
        // os quadros dentro da aba (o do Turnstile mora numa shadow root fechada): por w.frames
        const ver = (w, nivel) => {
          try {
            if (!_vistosE.has(w)) { _vistosE.add(w); const tag = nivel ? 'F' + nivel : 'P';
              w.addEventListener('error', (e) => navs.push(`${tag} ERRO ${String(e.message).slice(0,160)} @${String(e.filename).split('/').pop().slice(0,40)}:${e.lineno}`));
              w.addEventListener('unhandledrejection', (e) => { let r = e.reason; navs.push(`${tag} REJ ${String(r && (r.stack || r.message) || r).slice(0,200)}`); });
              w.addEventListener('message', (e) => { let d = e.data, sd; try { sd = typeof d === 'string' ? d.slice(0,80) : JSON.stringify(d).slice(0,160); } catch { sd = typeof d; } navs.push(`${tag} MSG de=${e.origin} ${sd}`); });
            }
            let ck = ''; try { ck = w.document.cookie.split(';').map((c) => c.split('=')[0].trim()).join('+'); } catch (x) { ck = 'x'; }
            const k = tagDe(w, nivel); if (ultimoCk[k] !== ck) { ultimoCk[k] = ck; navs.push(`${k} COOKIE ${ck}`); }
            for (let i = 0; i < w.frames.length; i++) ver(w.frames[i], nivel + 1);
          } catch (x) {}
        };
        for (const el of document.querySelectorAll('iframe')) { try { ver(el.contentWindow, 0); } catch {} }
      };
      const ultimoCk = {}; const tagDe = (w, n) => (n ? 'F' + n : 'P');
      setInterval(ligar, 200);
      const r = await window.__bancada.abrir(alvo, 30000);
      const t0 = Date.now();
      setInterval(() => {
        let o; try { o = window.__bancada.olhar(r.id); } catch (e) { o = { erro: String(e) }; }
        enviar({ s: Math.round((Date.now() - t0) / 1000), titulo: (o.titulo || '') + ' | ' + navs.splice(0).concat(reqs.splice(0)).join(' ; ') });
      }, 3000);
    } catch (e) { enviar({ erro: String(e && e.stack || e) }); }
  });
})();
