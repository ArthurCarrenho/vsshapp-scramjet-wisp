// O que um documento mostra de si: os registros de performance com protocolo e tamanhos, as
// folhas de estilo e os elementos (a folha que o shell injeta aparece aqui), e o que o analisador
// de HTML devolve. Use no documento do site (`QUADRO=<regex do host>`, `PRONTO=load`, `MODO=raw`).
(async () => {
  const r = {};
  const tenta = (nome, f) => { try { const v = f(); r[nome] = v === undefined ? "undefined" : v; } catch (e) { r[nome] = "!! " + (e && e.name) + ": " + String(e && e.message).slice(0, 160); } };
  const sinal = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? (v === 0 ? 0 : v > 0 ? "+" : "-") : Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? Object.keys(typeof x.toJSON === "function" ? x.toJSON() : x).join("/") : x)) : typeof v === "string" ? v.replace(/[0-9a-f]{12,}|_[0-9a-f]+/g, "N").slice(0, 90) : v]));
  tenta("registros (tipo inicial protocolo transfer encoded decoded)", () => performance.getEntriesByType("resource").map((e) => [e.initiatorType, e.name.replace(/^https:\/\//, "").replace(/[0-9a-f]{12,}|_[0-9a-f]+/g, "N").slice(0, 60), e.nextHopProtocol, e.transferSize, e.encodedBodySize, e.decodedBodySize, e.responseStatus, e.deliveryType, e.renderBlockingStatus, e.contentType, "worker=" + (e.workerStart > 0), "st=" + e.serverTiming.length].join(" ")));
  tenta("JSON de um registro de script", () => { const e = performance.getEntriesByType("resource").find((x) => x.initiatorType === "script"); return e ? sinal(e.toJSON()) : "nenhum"; });
  tenta("JSON do registro de navegação", () => sinal(performance.getEntriesByType("navigation")[0].toJSON()));
  tenta("chaves do registro de navegação", () => Object.keys(performance.getEntriesByType("navigation")[0].toJSON()).join(","));
  tenta("folhas de estilo", () => [...document.styleSheets].map((s) => (s.ownerNode ? s.ownerNode.tagName + (s.ownerNode.id ? "#" + s.ownerNode.id : "") + "[" + [...s.ownerNode.attributes].map((a) => a.name).join(",") + "] pai=" + (s.ownerNode.parentNode && s.ownerNode.parentNode.nodeName) : "sem nó") + " regras=" + (() => { try { return s.cssRules.length; } catch (e) { return "x"; } })()));
  tenta("adoptedStyleSheets", () => document.adoptedStyleSheets.length);
  tenta("filhos do head", () => [...document.head.children].map((e) => e.tagName).join(","));
  tenta("filhos do html", () => [...document.documentElement.childNodes].map((e) => e.nodeName).join(","));
  tenta("scripts", () => document.scripts.length + " " + [...document.scripts].map((s) => (s.src ? "src" : "inline:" + s.textContent.length)).join(","));
  tenta("document.all", () => document.all.length);
  tenta("querySelectorAll(*)", () => document.querySelectorAll("*").length);
  tenta("iframes", () => [...document.querySelectorAll("iframe")].length + " frames=" + window.length);
  tenta("atributos do html", () => [...document.documentElement.attributes].map((a) => a.name).join(","));
  tenta("getComputedStyle scrollbar", () => { const c = getComputedStyle(document.documentElement); return [c.scrollbarWidth, c.scrollbarColor, c.colorScheme].join(" | "); });
  tenta("pseudo scrollbar", () => getComputedStyle(document.documentElement, "::-webkit-scrollbar").width);
  tenta("politica TT", () => { try { const p = trustedTypes.createPolicy("s" + Math.random().toString(36).slice(2), { createHTML: (s) => s }); return "criou"; } catch (e) { return "recusou: " + String(e.message).slice(0, 120); } });
  tenta("exige TT", () => { const d = document.createElement("div"); try { d.innerHTML = "<b>x</b>"; return "não: " + d.innerHTML; } catch (e) { return "sim: " + String(e.message).slice(0, 80); } });
  tenta("DOMParser recupera </div>", () => new DOMParser().parseFromString("<p>a</div><p>b</p>", "text/html").body.innerHTML);
  tenta("innerHTML de atributo com aspas", () => { const d = document.createElement("div"); d.innerHTML = '<div data-foo="&#34;"></div>'; return d.innerHTML; });
  tenta("select escolhido", () => { const d = document.createElement("div"); d.innerHTML = '<select><option selected value="um">um</option><option value="dois">dois</option></select>'; return d.firstChild.value; });
  tenta("innerHTML com link e imagem", () => { const d = document.createElement("div"); d.innerHTML = '<a href="/x?a=1&amp;b=2">l</a><img src="/i.png"><form action="/f"></form>'; return d.innerHTML; });
  tenta("outerHTML do html (começo)", () => document.documentElement.outerHTML.replace(/[0-9a-f]{12,}/g, "N").slice(0, 200));
  tenta("tamanho do outerHTML", () => document.documentElement.outerHTML.length);
  return r;
})()
