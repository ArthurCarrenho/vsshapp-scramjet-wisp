/* eslint-env browser */
// A API que as sondas dirigem, do lado da página.
//
// Ela é fina de propósito: quem faz o trabalho é o `ScramjetEngine` REAL, carregado do
// `vssh-client` do disco. O que mora aqui é só o que uma janela do shell faria em volta dele —
// criar o frame, pendurá-lo no documento, pedir a navegação e esperar. Qualquer lógica de motor
// que aparecesse aqui seria uma segunda implementação, e a bancada passaria a medir a si mesma.

(() => {
  const motor = () => window.BrowserEngines.get('scramjet-wisp');

  /** Espera com teto, sem inventar erro: devolve o que aconteceu, e quem julga é a sonda. */
  const esperar = (promessa, ms, seDemorar) =>
    Promise.race([promessa, new Promise((ok) => setTimeout(() => ok(seDemorar), ms))]);

  const frames = new Map();
  let seq = 0;

  /**
   * A restauração de cookie ANTES de navegar — a sequência exata do `TabManager.loadTabUrl`.
   *
   * Não é detalhe: é o passo que traz a sessão do portal de volta para o jar do motor, e sem ele a
   * bancada mediria um jar que nunca soube de nada. A capacidade é OPCIONAL no contrato de motor,
   * e a detecção aqui é a mesma de lá — `typeof … === 'function'`.
   */
  async function restaurarCookies(url) {
    const m = motor();
    if (typeof m.restoreCookiesForDomain !== 'function') return;
    try { await m.restoreCookiesForDomain(new URL(url).hostname); } catch (e) { /* como no shell */ }
  }

  window.__bancada = {
    /** Sobe o motor. Devolve o estado observável dele — não um booleano nosso. */
    async iniciar() {
      await motor().init();
      return { estado: motor().getStatus() };
    },

    estado: () => motor().getStatus(),

    /** O que a bandeja recebeu — é o rastro que o cão de guarda deixa. */
    atividades: () => window.Atividade._itens.map((a) => [a[0], a[1]]),

    log: () => window.__log.slice(),
    rejeicoes: () => window.__rejeicoes.slice(),

    /**
     * Abre uma aba: cria o frame do motor, pendura no documento e navega.
     *
     * `estado` é `'carregou'` ou `'pendurado'` — e a distinção é o ponto do arranjo inteiro. Uma
     * aba pendurada é o relato que motivou tudo isto: sem `load`, sem erro, sem console.
     */
    async abrir(url, esperaMs = 15000) {
      const f = await motor().createFrame();
      const id = `f${++seq}`;
      f.el.style.cssText = 'width:900px;height:600px;border:0';
      document.body.appendChild(f.el);
      frames.set(id, f);

      // Os retornos por-frame que o `BrowserWindow` registra. Estão aqui porque são a FRONTEIRA
      // entre a página proxiada e o shell: é por eles que um link de nova aba, um `window.open` e
      // um `window.close()` saem do frame. Registrá-los é o que permite medir o que atravessa —
      // e, principalmente, o que NÃO atravessa.
      const retornos = [];
      retornos.__aba = { fechou: false };
      f.onOpenTab((u) => {
        retornos.push(['onOpenTab', u]);
        // O `BrowserWindow` devolve o punho da aba nova; é ele que faz o `w.close()` do site
        // fechar alguma coisa. Devolver `null` aqui mediria um shell que não existe.
        return { id: 'aba-de-bancada', get closed() { return retornos.__aba.fechou; },
                 close() { retornos.__aba.fechou = true; }, focus() {} };
      });
      f.onCloseSelf(() => retornos.push(['onCloseSelf', null]));
      // Capacidade opcional: um motor que não a ofereça não é defeito, e a sonda mede a diferença.
      if (typeof f.onEsquemaExterno === 'function') {
        f.onEsquemaExterno((u) => retornos.push(['onEsquemaExterno', u]));
      }
      f.onDownload((info) => retornos.push(['onDownload', info && info.url]));
      f.onContextMenu((ctx) => retornos.push(['onContextMenu', ctx && ctx.linkUrl]));
      f.__retornos = retornos;

      await restaurarCookies(url);
      const carregou = new Promise((ok) => f.el.addEventListener('load', () => ok('carregou'), { once: true }));
      f.go(url);
      const estado = await esperar(carregou, esperaMs, 'pendurado');
      return { id, estado, ...window.__bancada.olhar(id) };
    },

    /** Navega uma aba já aberta. */
    async ir(id, url, esperaMs = 15000) {
      const f = frames.get(id);
      await restaurarCookies(url);
      const carregou = new Promise((ok) => f.el.addEventListener('load', () => ok('carregou'), { once: true }));
      f.go(url);
      const estado = await esperar(carregou, esperaMs, 'pendurado');
      return { id, estado, ...window.__bancada.olhar(id) };
    },

    /** O que está desenhado na aba, sem julgar: marca do fixture, título, e a URL REAL. */
    olhar(id) {
      const f = frames.get(id);
      const r = { marca: null, titulo: null, gap: false, urlReal: null };
      try { r.urlReal = f.getCurrentUrl(); } catch (e) { r.urlReal = 'erro:' + e.name; }
      try {
        const d = f.el.contentDocument;
        r.titulo = d ? d.title : null;
        r.marca  = d && d.body ? d.body.getAttribute('data-marca') : null;
        r.gap    = !!(d && d.querySelector('meta[name="vssh-engine-gap"]'));
      } catch (e) { r.marca = 'opaco:' + e.name; }
      return r;
    },

    /** Avalia uma expressão DENTRO da aba — o frame é mesma-origem, como no shell de verdade. */
    async naAba(id, expressao) {
      const f = frames.get(id);
      const w = f.el.contentWindow;
      // eslint-disable-next-line no-new-func
      const fn = new w.Function('return (' + expressao + ')');
      return await fn.call(w);
    },

    /** O que atravessou a fronteira do frame para o shell, na ordem. */
    retornos: (id) => (frames.get(id).__retornos || []).map((r) => [r[0], r[1]]),

    /** Clica de verdade num elemento da aba — o clique é o que dispara os hooks do motor. */
    async clicar(id, seletor) {
      const f = frames.get(id);
      const el = f.el.contentDocument.querySelector(seletor);
      if (!el) return 'não achei ' + seletor;
      const antes = f.el.contentWindow.location.href;
      el.click();
      await new Promise((r) => setTimeout(r, 400));
      return { navegou: f.el.contentWindow.location.href !== antes };
    },

    fechar(id) {
      const f = frames.get(id);
      if (!f) return false;
      try { f.destroy(); } catch (e) { /* o elemento sai de qualquer forma */ }
      f.el.remove();
      frames.delete(id);
      return true;
    },

    /** Registra uma extensão embutida — é como o adblock chega ao motor de verdade. */
    async extensao(id, fonteDoInit) {
      // eslint-disable-next-line no-new-func
      const init = new Function('api', fonteDoInit);
      window.ExtensionRuntime.registerBuiltin({ id, name: id, init });
      await window.ExtensionRuntime.ensureLoaded();
      return true;
    },

    /** O jar do motor, como o portal o vê pela ponte de cookies. */
    async cookiesGuardados(host) {
      const r = await fetch('/api/user/browser/cookies?domain=' + encodeURIComponent(host));
      return (await r.json()).cookies;
    },

    /** Força o flush do jar para o portal — o que o `pagehide` faria. */
    async descarregarCookies() {
      window.dispatchEvent(new Event('pagehide'));
      await new Promise((r) => setTimeout(r, 300));
      return true;
    },
  };
})();
