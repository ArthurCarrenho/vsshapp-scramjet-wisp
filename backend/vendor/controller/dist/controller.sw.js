var $scramjetController;(()=>{var e={805(e,t,r){r.d(t,{C:()=>o});class o{methods;id;sendRaw;counter=0;promiseCallbacks=new Map;constructor(e,t,r){this.methods=e,this.id=t,this.sendRaw=r}recieve(e){if(null==e||"object"!=typeof e)return;let t=e[this.id];if(null==t||"object"!=typeof t)return;let r=t.$type;if("response"===r){let e=t.$token,r=t.$data,o=t.$error,s=this.promiseCallbacks.get(e);if(!s)return;this.promiseCallbacks.delete(e),void 0!==o?s.reject(Error(o)):s.resolve(r)}else if("request"===r){let e=t.$method,r=t.$args;this.methods[e](r).then(e=>{this.sendRaw({[this.id]:{$type:"response",$token:t.$token,$data:e?.[0]}},e?.[1])}).catch(e=>{console.error(e),this.sendRaw({[this.id]:{$type:"response",$token:t.$token,$error:e?.toString()||"Unknown error"}},[])})}}rejectPending(e){if(!this.promiseCallbacks.size)return;let t=[...this.promiseCallbacks.values()];for(let r of(this.promiseCallbacks.clear(),t))try{r.reject(Error(e))}catch{}}call(e,t,r=[]){let o=this.counter++;return new Promise((s,i)=>{this.promiseCallbacks.set(o,{resolve:s,reject:i}),this.sendRaw({[this.id]:{$type:"request",$method:e,$args:t,$token:o}},r)})}}}},t={};function r(o){var s=t[o];if(void 0!==s)return s.exports;var i=t[o]={exports:{}};return e[o](i,i.exports,r),i.exports}r.d=(e,t)=>{for(var o in t)r.o(t,o)&&!r.o(e,o)&&Object.defineProperty(e,o,{enumerable:!0,get:t[o]})},r.o=(e,t)=>Object.prototype.hasOwnProperty.call(e,t),r.r=e=>{"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(e,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(e,"__esModule",{value:!0})};var o={};(()=>{r.r(o),r.d(o,{route:()=>d,shouldRoute:()=>n});var e=r(805);function t(e){let t=e?.name;if("AbortError"===t||"NetworkError"===t||"TimeoutError"===t)return!0;let r=e instanceof Error?e.message:String(e??"");return/Request failed with error code \d+|Request failed because redirects were disallowed/i.test(r)||/error code \d+/i.test(r)||/Transferred a partial/i.test(r)||/Failed to fetch|NetworkError|Load failed|The operation was aborted/i.test(r)||/\b(ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|EAI_AGAIN|EOF)\b/.test(r)||/(connection|socket|stream)\s+(closed|reset|refused|aborted|failed|lost|ended)/i.test(r)||/(closed|reset|refused|aborted) by (peer|remote|host)/i.test(r)||/\btimed?\s?out\b/i.test(r)||/host (blocked|not allowed)/i.test(r)}let s={};addEventListener("message",e=>{if(e.data&&"object"==typeof e.data){if(e.data.$sw$setCookieDone&&"object"==typeof e.data.$sw$setCookieDone){let t=e.data.$sw$setCookieDone,r=s[t.id];r&&(r(),delete s[t.id])}if(e.data.$sw$initRemoteTransport&&"object"==typeof e.data.$sw$initRemoteTransport){let{port:t,prefix:r}=e.data.$sw$initRemoteTransport,o=a.find(e=>new URL(r).pathname.startsWith(e.prefix));if(!o)return void console.error("No relevant controller found for transport init");o.rpc.call("initRemoteTransport",t,[t])}}});class i{prefix;id;rpc;constructor(t,r,o){this.prefix=t,this.id=r,this.rpc=new e.C({sendSetCookie:async({cookies:e,options:t})=>{let r=await self.clients.matchAll(),o=[],i=[],a=t?.destination==="document"||t?.destination==="iframe";for(let n of r){let r=Math.random().toString(36).substring(2,10);o.push(r),n.postMessage({$controller$setCookie:{cookies:e,options:t,id:r}}),a||i.push(new Promise(e=>{s[r]=()=>e(r)}))}if(i.length>0){let t,a=!1,n=new Promise(i=>{t=setTimeout(()=>{if(!a){let t=o.filter(e=>void 0!==s[e]);console.error(`timed out waiting for set cookie response (deadlock?): cookies=${e.length} clients=${r.length} pending=${t.length}/${o.length} clientUrls=${r.map(e=>e.url).join(",")}`)}i()},1e3)});try{await Promise.race([n,Promise.any(i).then(()=>{a=!0}).catch(()=>{})])}finally{for(let e of(void 0!==t&&clearTimeout(t),o))delete s[e]}}}},"tabchannel-"+r,(e,t)=>{o.postMessage(e,t)}),o.onmessage=e=>{this.rpc.recieve(e.data)},o.onmessageerror=console.error,this.rpc.call("ready",void 0)}}let a=[];function n(e){let t=new URL(e.request.url);return void 0!==a.find(e=>t.pathname.startsWith(e.prefix))}async function d(e){try{let t=new URL(e.request.url),r=a.find(e=>t.pathname.startsWith(e.prefix)),o=await clients.get(e.clientId),s=[...e.request.headers],i=await r.rpc.call("request",{rawUrl:e.request.url,rawReferrer:e.request.referrer,destination:e.request.destination,mode:e.request.mode,referrer:e.request.referrer,method:e.request.method,body:e.request.body,cache:e.request.cache,forceCrossOriginIsolated:!1,initialHeaders:s,rawClientUrl:o?o.url:void 0,clientId:e.clientId||e.resultingClientId},e.request.body instanceof ReadableStream||e.request.body instanceof ArrayBuffer?[e.request.body]:void 0);return new Response(i.body,{status:i.status,statusText:i.statusText,headers:i.headers})}catch(l){let r,o,s,i,a,n,d;if("navigate"!==e.request.mode){let r;return t(l)||(r=l instanceof Error?l.message:String(l??""),/No frame found for request|Port not found/i.test(r))||console.error("Service Worker error (subrecurso):",e.request.url,l),Response.error()}return t(l)||console.error("Service Worker error:",l),new Response((r=l?.message||"Erro desconhecido",i=null!==(s=(o=/error code (\d+)/i.exec(r))?parseInt(o[1],10):null)?({6:{title:"N\xe3o foi poss\xedvel resolver o endere\xe7o",detail:"O nome do servidor n\xe3o p\xf4de ser encontrado (DNS). Verifique se o endere\xe7o est\xe1 correto."},7:{title:"N\xe3o foi poss\xedvel conectar ao servidor",detail:"A conex\xe3o foi recusada. O servidor pode estar fora do ar ou a porta pode estar errada."},28:{title:"Tempo esgotado",detail:"O servidor demorou demais para responder."},52:{title:"O servidor n\xe3o respondeu nada",detail:"A conex\xe3o foi aberta mas fechada sem resposta. O servi\xe7o pode ter ca\xeddo no meio da requisi\xe7\xe3o."},56:{title:"Falha ao receber dados",detail:"A conex\xe3o foi interrompida durante o recebimento da resposta."},60:{title:"Certificado de seguran\xe7a inv\xe1lido",detail:"O certificado TLS deste site n\xe3o p\xf4de ser validado (por exemplo, um certificado autoassinado). \xc9 poss\xedvel permitir certificados inv\xe1lidos nas configura\xe7\xf5es do navegador, se voc\xea confia neste destino."}})[s]:void 0,a=i?.title??"N\xe3o foi poss\xedvel carregar a p\xe1gina",n=i?.detail??"Ocorreu um erro ao processar a requisi\xe7\xe3o atrav\xe9s do motor de navega\xe7\xe3o.",d=e=>e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"),`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${d(a)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #f5f5f7; color: #1d1d1f; padding: 24px;
  }
  .card {
    max-width: 480px; width: 100%; text-align: center;
    background: #fff; border-radius: 16px; padding: 40px 32px;
    box-shadow: 0 2px 24px rgba(0,0,0,.08);
  }
  .icon { font-size: 48px; line-height: 1; margin-bottom: 16px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
  p { font-size: 15px; line-height: 1.5; margin: 0 0 8px; color: #515154; }
  .code {
    margin-top: 20px; font-size: 12px; color: #86868b;
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    word-break: break-word;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #1d1d1f; color: #f5f5f7; }
    .card { background: #2c2c2e; box-shadow: 0 2px 24px rgba(0,0,0,.4); }
    p { color: #a1a1a6; }
    .code { color: #6e6e73; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">⚠️</div>
    <h1>${d(a)}</h1>
    <p>${d(n)}</p>
    <div class="code">${d(r)}</div>
  </div>
</body>
</html>`),{status:500,headers:{"Content-Type":"text/html; charset=utf-8"}})}}addEventListener("message",e=>{if(!e.data||"object"!=typeof e.data||!e.data.$controller$init||"object"!=typeof e.data.$controller$init)return;let t=e.data.$controller$init,r=a.findIndex(e=>e.id===t.id);-1!==r&&a.splice(r,1),a.push(new i(t.prefix,t.id,e.ports[0]))}),addEventListener("install",()=>{self.skipWaiting()}),addEventListener("activate",e=>{e.waitUntil(clients.claim())}),setTimeout(async()=>{for(let e of(console.log("service worker activated, notifying clients to revive"),await clients.matchAll()))e.postMessage({$controller$swrevive:{}})},100)})(),$scramjetController=o})();
//# sourceMappingURL=controller.sw.js.map