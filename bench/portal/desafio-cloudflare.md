# O desafio do Cloudflare pelo motor

Este documento junta o que a bancada mede no desafio gerenciado do Cloudflare (o "Confirme que é
humano" com o Turnstile embutido): o que o desafio faz, o que decide o veredito dele pelo motor, as
diferenças entre o motor e o Chrome que a bancada achou, e o método que as acha. O caso de
referência é um eprint do Taylor & Francis (`www.tandfonline.com/eprint/<id>/full?target=<doi>`),
que responde a toda primeira visita com o desafio. O desafio passa pelo Chrome direto e passa pelo
motor.

As sondas moram em [`sondas/`](sondas/), e a tabela de cada uma está no fim.

## O que o desafio faz

A página do site responde 403 com o script de orquestração
(`/cdn-cgi/challenge-platform/h/<x>/orchestrate/chl_page/...`). Ele monta um quadro de
`challenges.cloudflare.com` numa shadow root fechada, e o quadro roda o Turnstile. A sequência de
pedidos é a mesma nos dois lados:

| passo | quem pede | corpo enviado |
|---|---|---|
| `POST …/fo/…` do site | a página do desafio | ~3,4 kB |
| `POST …/fo/…` do quadro | o Turnstile, ao subir | ~5,7 kB |
| `GET …/pat/…` (401) e `GET …/ci/…` | o Turnstile | |
| `POST …/fo/…` do quadro | o Turnstile, com o que coletou | ~90 kB |
| `POST …/fo/…` do site | a página, com o resultado | ~10 kB quando passou, ~9 kB quando reprovou |

O servidor julga o segundo `POST` do quadro. A resposta dele faz o quadro mandar ao pai um
`postMessage` com `{"event":"complete","token":…}` ou com `{"event":"fail","code":"600010"}`.
Quando passa, a página recebe o `cf_clearance` no último `POST`, envia um formulário (`POST` de
documento para a própria URL) e o site responde 200. Quando reprova, a página chama
`location.reload()` e o laço recomeça. O 600010 é o genérico de "o ambiente não convenceu", e não
diz qual sinal pesou.

O registro de [`sem-automacao.mjs`](sondas/sem-automacao.mjs) mostra as duas formas: `NAV push
form=true` quando passa, `NAV reload form=false` quando reprova.

## O que decide o veredito pelo motor

O Turnstile pede `history.replaceState({}, "", "https://example.org/")` dentro do quadro dele e
confere a recusa. O Chrome lança um `SecurityError` que cita o endereço pedido, a origem e o
endereço do documento. Um proxy que reescreve URLs leva o endereço de outro site para a própria
origem, e a chamada passa: é o sinal que separa a página proxiada da direta.

O motor recusa como o Chrome (`client/dom/history.ts`): o endereço se resolve contra o do
documento, e o de outra origem recebe a mesma `DOMException`, com a mesma frase e com `stack`.

A prova é o veredito de `sem-automacao.mjs` com variantes do motor, alternadas na mesma estação:

| motor | desfecho |
|---|---|
| sem a recusa do `replaceState`, sem nenhuma das outras correções desta página | `fail 600010` em todas as voltas |
| só com a recusa do `replaceState` | passa |
| com as outras correções desta página e sem a recusa do `replaceState` | `fail 600010` em todas as voltas |
| com todas | passa |

## As outras diferenças que o traço achou

[`traco.mjs`](sondas/traco.mjs) registra cada chamada de API que o código do desafio faz, com o que
ela devolve, nos dois lados. As linhas abaixo são chamadas que o desafio faz e que respondiam
diferente pelo motor. Nenhuma muda sozinha o veredito deste desafio (cada uma foi retirada do motor
com as outras no lugar, e ele passou), e todas são o tipo de recusa que um detector confere.

| o que o desafio pede | o Chrome | o motor |
|---|---|---|
| `Object.setPrototypeOf(f, f)` em `setTimeout`, `setInterval`, `eval`, `removeEventListener`, `FontFace`, `Worker` | `TypeError: Cyclic __proto__ value`; pelo `Reflect`, `false` | igual, pela armadilha `setPrototypeOf` de todo Proxy de função (`client/shared/proto.ts`). Sem ela o Proxy repassa o pedido ao alvo, que o aceita |
| `Element.prototype.setAttribute` sem argumentos ou num `this` que não é elemento | `TypeError` com a frase do Blink, ou `Illegal invocation` | igual: a chamada que o navegador recusa vai a ele como veio |
| o descritor de `Error.prepareStackTrace` no `Error` de outro quadro | `undefined` | igual: o `Error` de qualquer quadro do motor esconde o acessor |
| `nextHopProtocol` do registro do próprio `POST` | o protocolo em que o pedido saiu | `h2`, que é o que o transporte pede a todo servidor https. O servidor sabe por onde o pedido chegou |
| `transferSize` de uma resposta sem corpo | 300 | 300 |
| `eval` de 1,3 MB de espaços seguidos de `0, /.*honk.*/, <relógio>`, a cada meio segundo | 1,5 ms por chamada | 2 ms. O começo em branco fica fora do rewriter (`client/shared/eval.ts`); com ele dentro eram 15 ms |

## O que não decide

Duas hipóteses foram medidas e não se sustentam.

O tempo do JS não reprova o desafio. Com a CPU do Chrome direto limitada a 15%
(`systemd-run --user --scope -p CPUQuota=15%`), a coleta do Turnstile leva 24 s no lugar de 3 s e o
desafio passa. O motor é mais lento que o Chrome em `Function`, em `new Error().stack` e na subida
de um `Worker` de `blob:`, e passa com essas diferenças.

O isolamento de origem também não reprova. A página de desafio vem com COOP e COEP, e no Chrome
roda isolada. Pelo motor ela roda dentro do shell, sem isolamento (ver abaixo), e passa assim.

## As diferenças que continuam abertas

Cada uma é visível ao código do site, e o desafio do caso de referência passa com elas.

- `crossOriginIsolated` é `false` num documento que o Chrome isola, quando o shell que hospeda a
  aba não é isolado. Faltam o `SharedArrayBuffer` entre os nomes do global e o relógio de 5 µs (o
  passo do `performance.now()` é 100 µs). O motor não tem como entregar memória compartilhada sem
  o isolamento de verdade. O shell do ambiente só é isolado na amostra de `VSSH_ISOLAMENTO`
  (`src/utils/isolamento.ts` do vssh-sso). Nela o motor põe COOP e COEP nos documentos proxiados
  (`handler.crossOriginIsolated`) e responde a cada site o que ele pediu
  (`client/shared/isolamento.ts`): o documento com COOP e COEP próprios, os quadros que a política
  de permissões alcança e os workers deles se veem isolados, e os outros se veem como num
  documento comum. `isolamento.mjs` mede as duas situações contra o Chrome.
- `'prepareStackTrace' in Error` é `true`. O V8 lê o formatador do próprio `Error`, e o operador
  `in` não passa por nenhuma função que o motor troque.
- A folha `<style id="__vssh_ext_css">` do shell (a barra de rolagem do ambiente e o cosmético das
  extensões) é o primeiro filho do `<head>` do documento da aba. Ela aparece em
  `document.styleSheets`, em `head.children`, no `outerHTML` e em
  `getComputedStyle(el, "::-webkit-scrollbar")`. A preferência `navegadorRolagemDoAmbiente` tira a
  parte da barra.
- `encodedBodySize` de uma resposta comprimida sem `Content-Length` é uma estimativa. O libcurl
  entrega o corpo já descomprimido e não informa quantos bytes vieram pela rede.
- `Function` com um megabyte de espaços no corpo custa 7 ms pelo motor e 1,4 ms no Chrome. O
  desafio usa o `eval` para essa sonda.
- `Object.setPrototypeOf(Function.prototype, setTimeout)` é aceito: o laço do navegador para no
  Proxy, e nenhuma armadilha do Proxy é consultada nesse sentido.
- A linha do tempo de performance não traz as entradas `long-animation-frame` que o Chrome traz.
- A primeira linha da pilha de um `TypeError` do Blink (`setAttribute()` sem argumentos) traz a
  frase curta no Chrome (`2 arguments required, but only 0 present.`) e a frase inteira pelo motor,
  que monta o cabeçalho quando a pilha é lida. Medido sob o playwright, dos dois lados.

## O que a página do artigo ainda acusa

Depois do desafio, o artigo abre com dois erros não tratados no console, pelo motor da `main` e
por qualquer variante medida aqui: `String.prototype.startsWith called on null or undefined`, no
gerenciador de consentimento do site (`transcend-cdn.com/cm/<id>/airgap.js`), e em seguida
`window.airgap.getConsent is not a function`. O script guarda os nativos na carga e os chama por
fora dos objetos, e algum deles devolve `null` pelo motor onde o Chrome devolve texto. O
`sem-automacao.mjs` com `CONSOLE=1` mostra os dois. O caminho para achar a chamada é o do traço,
com o script numa página sem desafio.

## Onde não está a diferença

Cada linha desta tabela foi medida dos dois lados e deu igual.

| camada | como se mede | estado |
|---|---|---|
| TLS: JA4, grupos, ALPS, cifras | `quadro.mjs` com `PRONTO=ja4` e `js/tls-peet.js` contra `tls.peet.ws/api/all` | igual; só o GREASE e a ordem sorteada das extensões variam, como variam entre duas cargas do Chrome |
| HTTP/2: impressão Akamai (SETTINGS, WINDOW_UPDATE, prioridade, ordem dos pseudo-cabeçalhos) | o mesmo | igual |
| ordem e valor dos cabeçalhos do documento, do script, do `fetch` e do POST do desafio | `rede-direta.mjs` contra o registro de `sem-automacao.mjs` | igual |
| Client Hints de alta entropia (`Sec-CH-UA-Full-Version-List`, `-Arch`, `-Platform-Version`, ...) | o mesmo; o desafio responde com `Accept-CH` e `Critical-CH` | igual, por `src/fetch/dicas.ts` |
| `Priority` (RFC 9218) por destino | `rede-direta.mjs` | igual, por `prioridadeDe` em `src/fetch/headers.ts` |
| `Cache-Control`/`Pragma` do modo de cache, `Referer` de worker `blob:`, `Sec-Fetch-Storage-Access` | `rede-direta.mjs` | igual |
| cookies conforme o modo de credenciais do pedido | o registro (nomes e hash do valor) | igual; o service worker repassa `request.credentials` ao motor |
| o tamanho do corpo de cada `POST` do fluxo | `direto.mjs` contra o registro de `sem-automacao.mjs` | igual: a coleta do Turnstile roda inteira pelo motor |
| `PerformanceNavigationTiming` e `PerformanceResourceTiming` | `js/navegacao-timing.js`, `js/registros.js` | igual, menos `confidence` (null num quadro), `redirectStart`/`redirectEnd` e o `encodedBodySize` estimado |
| a impressão do ambiente: `toString` dos nativos, descritores, globais, chaves próprias, protótipos, `location`, pilha de erro | `js/impressao.js`, `js/nativos-tostring.js`, `js/chaves-proprias.js`, `js/construtores.js`, `js/valores-do-ambiente.js`, com `diferenca.py` | igual |
| as recusas: o ciclo de protótipo, o `replaceState` para outra origem, a chamada ilegal | `js/recusas.js` | igual, menos as linhas do isolamento |
| o worker de `blob:` por dentro | `js/nativos-tostring-worker.js`, `js/worker-blob.js` | igual |
| `WebSocket` | `js/websocket.js` | igual |
| notificações e `IntersectionObserver.rootBounds` num quadro de outra origem | `js/impressao.js` e `js/valores-do-ambiente.js` | igual |

Uma coisa que parece diferença e não é: o quadro do desafio pede `brunhild.challenges.cloudflare.com`,
que só tem endereço IPv6. A estação da bancada não tem IPv6, e o pedido falha igual pelo Chrome
direto, que passa o desafio mesmo assim.

## Como achar a próxima diferença

O método que achou o `replaceState` serve a qualquer desafio que reprove pelo motor.

1. O veredito, sem automação, dos dois lados: `sem-automacao.mjs` pelo motor e `direto.mjs` pelo
   Chrome. Se o Chrome direto reprova naquela máquina, a rede dela não serve para o veredito (um
   proxy de saída que refaz o TLS reprova os dois lados).
2. O tamanho de cada `POST` nos dois lados. Tamanhos iguais dizem que a coleta roda inteira, e que
   o servidor reprova pelo conteúdo dela.
3. O traço: `traco.mjs` e `compara-traco.py`, no modo `difere`. Cada linha é uma chamada que o
   código do desafio fez com os mesmos argumentos e que respondeu diferente.
4. Uma sonda dirigida de `js/` para cada linha do traço, que vira a regressão dela.
5. O veredito de novo, com uma variante do motor para cada correção retirada. Um conjunto de
   correções que passa junto não diz qual delas pesa.

As sondas de `js/` perguntam o que alguém pensou em perguntar. O traço registra o que o desafio
pergunta, e foi ele que mostrou uma chamada que nenhuma sonda fazia.

## Como rodar

O ambiente é o do resto da bancada (`VSSH_SSO`, `BENCH_PLAYWRIGHT`, `BENCH_CHROME`, ver o
[README](README.md#como-rodar)). As sondas saem para a internet.

```sh
cd bench/portal/sondas
export ALVO='https://www.tandfonline.com/eprint/<id>/full?target=<doi>'

# o veredito: o desafio pelo motor num Chrome comum, com as navegações, as mensagens e os pedidos
xvfb-run -a -s '-screen 0 1366x900x24' node sem-automacao.mjs

# a coluna direta: os pedidos de um Chrome comum, na mesma forma
xvfb-run -a node direto.mjs

# o traço das chamadas de API dos dois lados, e as chamadas que respondem diferente
HEADED=1 SAIDA=/tmp/traco.json xvfb-run -a node traco.mjs
python3 compara-traco.py /tmp/traco.json desafio resumo
python3 compara-traco.py /tmp/traco.json desafio difere

# uma sonda no quadro do desafio, direto e pelo motor, e a diferença
MODO=raw PROBE=js/recusas.js SAIDA=/tmp/q.json node quadro.mjs && python3 diferenca.py /tmp/q.json

# o mesmo num quadro escolhido pela URL (o documento do site, por exemplo)
QUADRO='tandfonline.com.eprint' PRONTO=load MODO=raw PROBE=js/registros.js SAIDA=/tmp/q.json node quadro.mjs

# a impressão TLS e h2
ALVO=https://tls.peet.ws/api/all QUADRO=tls.peet.ws PRONTO=ja4 PROBE=js/tls-peet.js SAIDA=/tmp/tls.json node quadro.mjs

# onde o tempo do quadro vai, pelo motor
PERFIL=1 PROBE=js/function-custo.js SAIDA=/tmp/perfil.json node quadro.mjs

# os cabeçalhos de um Chrome comum
xvfb-run -a node rede-direta.mjs
```

## As sondas

| arquivo | o que responde |
|---|---|
| `sem-automacao.mjs` + `registro-do-desafio.js` | o veredito: o desafio pelo motor num Chrome sem CDP, com cada documento, navegação, `postMessage`, erro e recusa de CSP por quadro, e os pedidos do transporte com o tamanho do corpo e os cookies |
| `direto.mjs` | os pedidos de um Chrome comum ao alvo e ao Cloudflare, lidos do net-log: status, protocolo, tamanho do corpo e cookies |
| `traco.mjs` + `traco-gancho.js` | as chamadas de API que o código da página faz, com o que cada uma devolve, no Chrome direto e pelo motor |
| `compara-traco.py` | as chamadas do traço que respondem diferente nos dois lados, e as que só um lado fez |
| `quadro.mjs` | roda uma expressão de `js/` dentro de um quadro, no Chrome direto e pelo motor, e grava as duas respostas; com `PERFIL=1`, o perfil de CPU do lado do motor |
| `diferenca.py` | as chaves em que o motor diverge do direto num JSON do `quadro.mjs` |
| `rede-direta.mjs` | os cabeçalhos, em ordem, que um Chrome comum manda ao alvo e ao Cloudflare, lidos do net-log |
| `fixos.mjs` | os endereços fixos de uma rodada (`FIXOS`), para o wisp da bancada e para o Chrome direto |
| `js/recusas.js` | o que o Chrome recusa: o ciclo de protótipo, o `replaceState` para outra origem, a chamada ilegal de um nativo, e o que o isolamento de origem dá |
| `js/registros.js` | o que um documento mostra de si: os registros de performance com protocolo e tamanhos, as folhas de estilo, os elementos e o analisador de HTML |
| `js/honk.js` | o custo do `eval` e do `Function` de uma fonte com um megabyte de espaços na frente |
| `js/impressao.js` | a impressão larga: `toString`, nome e tamanho de uma centena de nativos, descritores de acessores, propriedades da janela, globais, `location`, pilha, um worker e um iframe `srcdoc` |
| `js/nativos-tostring.js`, `js/nativos-tostring-worker.js` | os nativos com cara de nativo, na janela e num worker |
| `js/chaves-proprias.js`, `js/construtores.js` | as chaves próprias de objetos da plataforma e o `constructor` de cada protótipo |
| `js/valores-do-ambiente.js` | os valores que o Turnstile lê do `navigator`, da tela e do documento |
| `js/navegacao-timing.js` | as chaves do registro de navegação em performance, com o sinal de cada número |
| `js/tls-peet.js` | o resumo do JSON do tls.peet.ws: JA4, grupos, ALPS, Akamai |
| `js/pedidos-do-desafio.js` | os `fetch` que o desafio faz para `/flow`, `/pat` e afins, com as opções |
| `js/pilha-de-function.js`, `js/prepare-stack-trace.js` | a pilha vista de dentro de um `Function` e o `Error.prepareStackTrace` |
| `js/function-custo.js`, `js/function-e-reescrita.js`, `js/error-stack-custo.js`, `js/microtempos.js`, `js/tempos-de-api.js` | o custo por chamada do `Function`, da reescrita, da pilha e de outras APIs |
| `js/raf.js`, `js/granularidade-do-relogio.js`, `js/visibilidade.js` | o ritmo do `requestAnimationFrame`, o passo do `performance.now()` e o estado de visibilidade e pintura |
| `js/worker-blob.js`, `js/websocket.js`, `js/isolamento.js` | o worker de `blob:` (tempo e ambiente), um WebSocket de eco e o `crossOriginIsolated` |

## Armadilhas

- O quadro do desafio se recarrega sozinho em segundos quando reprova. Uma sonda que passa de 4 s
  morre com ele, e o `quadro.mjs` tenta o quadro seguinte; uma sonda de tempo com muitas voltas
  nunca responde.
- O quadro do desafio exige Trusted Types. Uma sonda injetada como `<script>` é recusada ali, no
  Chrome direto e pelo motor: use `MODO=raw`.
- No modo `raw` a sonda roda no mundo da página sem passar pelo rewriter, e mede o ambiente que o
  motor montou. No modo `script` ela entra como `<script>` e é reescrita como o código do site, e
  é esse o modo que mede o custo que o site paga.
- O playwright marca a página (`navigator.webdriver`, o `Runtime.enable`). O veredito do desafio
  só vale pelo `sem-automacao.mjs`; o `quadro.mjs` e o `traco.mjs` servem para comparar o ambiente,
  e o desafio reprova neles pelos dois lados.
- O traço guarda cada linha distinta uma vez. Uma chamada que devolve pelo motor um valor que outra
  chamada igual já devolveu não aparece como diferença: a leitura de `innerHTML` que volta vazia
  some atrás da primeira leitura vazia. Confirme com uma sonda dirigida.
- O resolvedor da estação pode perder consultas. Uma rodada em que `challenges.cloudflare.com` não
  resolve mostra `REQ … ERR` no script do Turnstile e nenhum `POST` do quadro. `FIXOS` tira o DNS
  da medida.
- O registro mostra cookie só como nome, hash e tamanho. Não troque isso por valor: o log vai para
  arquivo e para conversa.
- Um `pkill -f` com o nome da sonda mata também o shell que a rodou, se o comando estava na mesma
  linha.
