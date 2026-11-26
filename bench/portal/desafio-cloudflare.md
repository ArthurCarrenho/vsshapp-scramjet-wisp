# O desafio do Cloudflare pelo motor

Este documento junta o que a bancada mede no desafio gerenciado do Cloudflare (o "Confirme que é
humano" com o Turnstile embutido), as diferenças entre o motor e o Chrome que ela achou e fechou, e
a que continua aberta. O caso de referência é um eprint do Taylor & Francis
(`www.tandfonline.com/eprint/<id>/full?target=<doi>`), que responde a toda primeira visita com o
desafio. Pelo Chrome direto o desafio passa sozinho em poucos segundos; pelo motor ele falha.

As sondas moram em [`sondas/`](sondas/), e a tabela de cada uma está no fim.

## O que o desafio faz

A página do site responde 403 com o script de orquestração (`/cdn-cgi/challenge-platform/h/<x>/orchestrate/chl_page/...`).
Ele monta um quadro de `challenges.cloudflare.com` numa shadow root fechada, e o quadro roda o
Turnstile: lê o ambiente JS, mede tempos, faz os POST de `/flow/ov1/...` com o resultado, e devolve
ao pai um `postMessage` com o veredito. Quando passa, o pai envia um formulário (`POST` de
documento para a própria URL) e o site responde 200 com o cookie `cf_clearance`.

Pelo motor o quadro termina com `{"event":"fail","code":"600010"}` no `postMessage`, e o script do
pai chama `location.reload()`. O registro de [`sem-automacao.mjs`](sondas/sem-automacao.mjs) mostra
as duas formas lado a lado: no Chrome a linha é `NAV push form=true`, e pelo motor é
`NAV reload form=false` com a pilha apontando o `orchestrate`. O código 600010 é o genérico de
"o ambiente não convenceu"; ele não diz qual sinal pesou.

## Onde não está a diferença

Cada linha desta tabela foi medida dos dois lados e deu igual, ou ficou igual depois de um commit
deste repositório.

| camada | como se mede | estado |
|---|---|---|
| TLS: JA4, grupos, ALPS, cifras | `quadro.mjs` com `PRONTO=ja4` e `js/tls-peet.js` contra `tls.peet.ws/api/all` | igual; só o GREASE e a ordem sorteada das extensões variam, como variam entre duas cargas do Chrome |
| HTTP/2: impressão Akamai (SETTINGS, WINDOW_UPDATE, prioridade, ordem dos pseudo-cabeçalhos) | o mesmo | igual |
| ordem e valor dos cabeçalhos do documento, do script, do `fetch` e do POST do desafio | `rede-direta.mjs` contra o registro de `sem-automacao.mjs` | igual |
| Client Hints de alta entropia (`Sec-CH-UA-Full-Version-List`, `-Arch`, `-Platform-Version`, ...) | o mesmo; o desafio responde com `Accept-CH` e `Critical-CH` | igual, por `src/fetch/dicas.ts` |
| `Priority` (RFC 9218) por destino | `rede-direta.mjs` | igual, por `prioridadeDe` em `src/fetch/headers.ts` |
| `Cache-Control`/`Pragma` do modo de cache, `Referer` de worker `blob:`, `Sec-Fetch-Storage-Access` | `rede-direta.mjs` | igual |
| cookies conforme o modo de credenciais do pedido | o registro (nomes e hash do valor) | igual; o service worker repassa `request.credentials` ao motor |
| `PerformanceNavigationTiming` e `PerformanceResourceTiming` | `js/navegacao-timing.js` | igual, menos `confidence` (null num quadro) e `redirectStart`/`redirectEnd` |
| a impressão do ambiente: `toString` dos nativos, descritores, globais, chaves próprias, protótipos, `location`, pilha de erro | `js/impressao.js`, `js/nativos-tostring.js`, `js/chaves-proprias.js`, `js/construtores.js`, `js/valores-do-ambiente.js`, com `diferenca.py` | igual, depois dos commits do quadro do desafio (a pilha com a linha e a coluna do site, o `Error.prepareStackTrace` como undefined, o `WindowProxy` de outra origem, as trocas nos donos dos nativos, o `location` do worker) |
| o worker de `blob:` por dentro | `js/nativos-tostring-worker.js`, `js/worker-blob.js` | igual |
| `WebSocket` e `crossOriginIsolated` | `js/websocket.js`, `js/isolamento.js` | igual |
| notificações e `IntersectionObserver.rootBounds` num quadro de outra origem | `js/impressao.js` e `js/valores-do-ambiente.js` | igual |

Uma coisa que parece diferença e não é: o quadro do desafio pede `brunhild.challenges.cloudflare.com`,
que só tem endereço IPv6. A estação da bancada não tem IPv6, e o pedido falha igual pelo Chrome
direto, que passa o desafio mesmo assim.

## A diferença que sobra: o tempo do JS

O que continua diferente é a velocidade de algumas operações que o Turnstile mede, e o desafio
mede tempos. `js/tempos-de-api.js`, `js/function-e-reescrita.js`, `js/error-stack-custo.js`,
`js/raf.js` e `js/granularidade-do-relogio.js` dão os números, sempre no quadro do desafio:

| operação | Chrome direto | pelo motor |
|---|---|---|
| `Function('a', 'return a+i')`, por chamada | ~4 µs | 72 µs |
| a reescrita dessa chamada no rewriter | | 29 µs, e ~5 µs quando o resultado já está guardado |
| `new Error().stack` | ~5 µs | 10 a 15 µs |
| o primeiro `message` de um `Worker` de `blob:` | ~4 ms | ~94 ms |
| `requestAnimationFrame` no quadro de cima do motor | sem salto | quadros longos enquanto o shell desenha |

Antes do commit "O Function do site custa menos pelo motor" o `Function` custava 98 µs, com 55 µs
de reescrita e 11 µs quando guardada. O perfil do CDP (`quadro.mjs` com `PERFIL=1`) mostra o
resto do custo na ponte entre o JS e o wasm do rewriter e na leitura da pilha que o motor faz para
saber de onde o código veio. Um `Function` reescrito nunca vai custar o mesmo que um nativo: o motor
tem de ler o código, reescrever e compilar o resultado. Se o desafio usa um limiar de tempo nessas
operações, esse limiar é o que falta, e não há leitura do ambiente que o resolva.

Isto é uma hipótese com medida, sem prova. O 600010 não diz qual sinal pesou, e a bancada não tem
como desligar um sinal só do lado do Cloudflare.

## Como rodar

O ambiente é o do resto da bancada (`VSSH_SSO`, `BENCH_PLAYWRIGHT`, `BENCH_CHROME`, ver o
[README](README.md#como-rodar)). As sondas saem para a internet.

```sh
cd bench/portal/sondas
export ALVO='https://www.tandfonline.com/eprint/<id>/full?target=<doi>'

# uma sonda no quadro do desafio, direto e pelo motor, e a diferença
PROBE=js/impressao.js SAIDA=/tmp/q.json node quadro.mjs && python3 diferenca.py /tmp/q.json

# o mesmo num quadro escolhido pela URL (o documento do site, por exemplo)
QUADRO='tandfonline.com.eprint' PRONTO=load PROBE=js/navegacao-timing.js SAIDA=/tmp/q.json node quadro.mjs

# a impressão TLS e h2
ALVO=https://tls.peet.ws/api/all QUADRO=tls.peet.ws PRONTO=ja4 PROBE=js/tls-peet.js SAIDA=/tmp/tls.json node quadro.mjs

# onde o tempo do quadro vai, pelo motor
PERFIL=1 PROBE=js/function-custo.js SAIDA=/tmp/perfil.json node quadro.mjs

# os cabeçalhos de um Chrome comum (sem tela: xvfb-run -a node ...)
node rede-direta.mjs

# o desafio pelo motor num Chrome comum, com o registro das navegações e dos pedidos
xvfb-run -a -s '-screen 0 1366x900x24' node sem-automacao.mjs
```

## As sondas

| arquivo | o que responde |
|---|---|
| `quadro.mjs` | roda uma expressão de `js/` dentro de um quadro, no Chrome direto e pelo motor, e grava as duas respostas; com `PERFIL=1`, o perfil de CPU do lado do motor |
| `diferenca.py` | as chaves em que o motor diverge do direto num JSON do `quadro.mjs` |
| `rede-direta.mjs` | os cabeçalhos, em ordem, que um Chrome comum manda ao alvo e ao Cloudflare, lidos do net-log |
| `sem-automacao.mjs` + `registro-do-desafio.js` | o desafio pelo motor num Chrome sem CDP, com as navegações (e a pilha de quem as pediu), os `postMessage`, os erros por quadro e os pedidos do transporte com os nomes dos cookies |
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

- O quadro do desafio se recarrega sozinho em segundos. Uma sonda que passa de 4 s morre com ele, e
  o `quadro.mjs` tenta o quadro seguinte; uma sonda de tempo com muitas voltas nunca responde.
- No modo `raw` a sonda roda no mundo da página sem passar pelo rewriter, e mede o ambiente que o
  motor montou. No modo `script` ela entra como `<script>` e é reescrita como o código do site, e
  é esse o modo que mede o custo que o site paga.
- O playwright marca a página (`navigator.webdriver`, o `Runtime.enable`). O veredito do desafio
  só vale pelo `sem-automacao.mjs`; o `quadro.mjs` serve para comparar o ambiente, e o desafio
  pode falhar nele pelos dois lados.
- O registro mostra cookie só como nome e hash. Não troque isso por valor: o log vai para arquivo
  e para conversa.
- Um `pkill -f` com o nome da sonda mata também o shell que a rodou, se o comando estava na mesma
  linha.
