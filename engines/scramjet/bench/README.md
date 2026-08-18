# Bancada de reprodução

Como reproduzir, **localmente e com medição**, um defeito que só aparece num site de verdade
atravessando o proxy.

Existe porque duas hipóteses plausíveis sobre o mesmo sintoma estavam erradas, e as duas só caíram
quando a cadeia inteira foi medida em vez de deduzida do log de produção.

## Pré-requisito

```sh
npm run dev            # devserver do fork: scramjet + wisp em localhost:4141
```

```sh
export BENCH_PLAYWRIGHT=<...>/node_modules/.pnpm/playwright@*/node_modules/playwright/index.js
cd bench
node yt-fecha.mjs      # o painel de replay do chat do YouTube fecha ao clicar?
node yt-msg.mjs        # que mensagens atravessam entre o iframe e a página, e quais se perdem?
node cap-repro.mjs     # o reCAPTCHA abre o desafio, ou fica girando?
node cap-rede.mjs      # que chamadas o reCAPTCHA faz, e o que elas respondem?
node cookie-recusa.mjs # a conferência de Domain= recusa cookie legítimo em sites reais?
node eval-sonda.mjs    # `eval("x='")` ainda dá o SyntaxError que o site espera?

node ouvinte-objeto.mjs    # ouvinte-objeto ({handleEvent}) escapa do filtro de eventos?
node ouvinte-semantica.mjs # embrulhar objeto quebrou alguma regra da plataforma? (compara com o direto)
node storage-abas.mjs      # que eventos de storage cruzam de uma aba para outra, e com que chave?
node sw-abas.mjs           # uma aba derruba as requisições da outra pelo service worker?
node yt-desmuta.mjs        # o vídeo mudo do YouTube desmuta quando outra ABA atualiza?
node yt-duas-abas.mjs      # o mesmo, com as abas como iframes irmãos — o arranjo real do portal
node yt-rede-cai.mjs       # e quando a rede cai com o vídeo tocando?
node portal-duas-abas.mjs  # o arranjo do portal: UM controller, N frames, UM transporte
```

Quando o defeito **não** reproduz em bancada, sobra assistir ao ambiente real. Este não dirige nada
— quem reproduz é a pessoa, no portal dela, e a sonda só anota:

```sh
# 1. abra o navegador com a porta de depuração E um perfil separado (o segundo não é opcional:
#    desde o Chrome 136 a porta é ignorada no perfil padrão, sem erro nenhum)
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:/temp/perfil-debug
# 2. chegue ao estado do defeito no portal
# 3. só então:
node anexar-devtools.mjs   # anota quem escreve em video.muted, com pilha, ao vivo
```

Se o portal roda num navegador remoto (dentro do Xpra, no servidor), traga a porta antes:
`ssh -L 9222:localhost:9222 <servidor>`.

`BENCH_CONTROLE=1` roda o cenário do `yt-desmuta.mjs` **sem** o gatilho e `BENCH_DIRETO=1` roda
**sem** o proxy. Os dois existem porque o player do YouTube se derruba sozinho no headless (ver as
armadilhas abaixo): sem essas duas colunas, a rodada atribui ao motor um defeito que não é dele.

`BENCH_ALVO` troca a URL, `BENCH_ESPERA` o tempo de assentamento, `BENCH_LIMITE` o prazo de morte.

`rewriter-falha.mjs` é o único que **não** precisa nem do devserver nem do playwright: ele carrega o
wasm direto no Node e pergunta de quem é a culpa quando a reescrita falha. É o mais rápido de rodar
e o que dá a resposta mais dura, então comece por ele.

```sh
cd packages/core && npm run rewriter:build   # o wasm precisa existir
node bench/rewriter-falha.mjs
```

## A metodologia

**Meça a cadeia inteira, elo por elo.** No painel de chat do YouTube: o evento chega
(`pointerdown → mousedown → mouseup → click`) ✅, o handler do site dispara com os argumentos certos
✅, a mensagem sai ✅ — e o pai recebe **zero**. Cada ✅ elimina uma hipótese; o primeiro ❌ é o
defeito. Sem isso sobra achismo sobre um log.

**Instrumente as DUAS pontas antes de agir.** Emissor e receptor, gravando em `window.__algo`, e só
então dispare a ação. Comparar o que sai com o que chega é o que localiza a perda.

**Compare o caminho quebrado com um que funciona.** Mandar a mesma mensagem à mão, pelo caminho
envolvido, respondeu em uma rodada o que não era: o mecanismo estava bom, o pedido é que era
descartado. Depois disso a única variável restante era o argumento — e era.

**Bisect contra as tags resolve "quando quebrou".** `git checkout <tag> -- packages/core/src`, esperar
o rspack rebuildar, rodar o probe. Três rodadas levaram de "o captcha parou" a "foi o commit
`06e978c0`", e uma quarta — revertendo arquivos DENTRO do commit — apontou qual dos quatro consertos.

**Instrumentar a própria conferência é o último passo, não o primeiro.** Um `console.warn` com os
dois valores comparados encerrou a discussão:
`{ pedido: "https://www.google.com:443", minhaOrigem: "https://www.google.com" }`.

**Nem tudo precisa de navegador.** O wasm do rewriter carrega no Node em três linhas
(`initSync` + `new WebAssembly.Module`), e o `codec.encode` é uma função JS comum — dá para fazer
ela levantar e observar o que o rewriter faz com isso. `rewriter-falha.mjs` provou em segundos que
uma falha do rewriter de URL deixava a instância **inutilizável para sempre**, coisa que nenhum
teste de navegador ia isolar. Quando a pergunta é sobre o motor e não sobre o site, fale com o
motor.

**Reconstrua sem o conserto e confira que a bancada acusa.** É o passo que separa "meu teste passa"
de "meu teste testa": com o wasm anterior, `rewriter-falha.mjs` dá 1/4 e diz `Already rewriting` na
linha certa. Um teste que nunca foi visto falhando não vale nada.

## Armadilhas que fizeram o teste medir a coisa errada

- **Viewport pequeno serve outra interface.** Com o padrão do headless o YouTube nem renderiza o
  botão que se quer testar. Use 1600x900 e UA de desktop real.
- **O painel de chat começa recolhido** numa página de replay, e enquanto está o iframe nem carrega —
  então o botão "não existe" em frame nenhum. Abra primeiro, espere, depois procure.
- **Os botões estão em shadow DOM.** `document.querySelector` para na borda do shadow root; o
  caminho que o DevTools copia atravessa essas bordas sem avisar. Precisa de travessia recursiva.
- **`element.click()` não dispara eventos de ponteiro.** Componentes modernos escutam `pointerdown`.
  Use `page.mouse.move/down/up` — e some as coordenadas do frame com as do elemento dentro dele.
- **Medir "este script foi reescrito?" com `fetch()` da página NÃO vale.** O service worker do
  scramjet decide reescrever pelo `destination` da requisição, e um fetch avulso tem destination
  vazio: vem o arquivo cru mesmo quando a tag `<script>` recebe o reescrito. Use
  `page.on('response')`.
- **Os frames são recriados no meio do fluxo.** Guardar a referência e usá-la depois dá
  `Frame was detached`. Reresolva por URL a cada etapa.
- **O devserver roda com `allowInvalidJs: false`, produção com `true`.** São `defaultConfigDev` e
  `defaultConfig` em `packages/core/src/index.ts`, e para JS que não parseia elas fazem coisas
  opostas — uma levanta o erro do rewriter, a outra devolve a fonte e deixa o navegador dar o
  SyntaxError. Não dá para virar a flag de fora: o `scramjet-flags` do demo não alcança o client
  dentro do frame proxiado, que recebe a config pelo service worker. Para medir a metade de
  produção, mude `defaultConfigDev` e reinicie.
- **Rode em background, com prazo de morte.** Todo script aqui dirige navegador e fala com a rede;
  em primeiro plano, um que pendure trava a sessão de quem está depurando. `comum.mjs` exporta
  `prazoDeMorte()`.
- **O devserver rodando junto faz a suíte do runway estourar por timeout.** `npm run dev` mantém
  rspack em watch e o vite servindo; com ele de pé, quase todo teste do runway devolve
  `Test timed out after 30000ms` no lado scramjet e passa no bare. Isso acontece **com a árvore
  limpa também** — chegou a produzir "11 falhas inesperadas" que não tinham nada a ver com a
  mudança sendo testada. Derrube o devserver antes de rodar o runway, e desconfie de qualquer
  rodada em que o bare passa e o scramjet só dá timeout.
- **Editar `src/` enquanto o runway roda invalida a rodada.** O rspack em watch reescreve
  `packages/core/dist` no meio da suíte, e os testes que pegarem o bundle a meio caminho falham por
  motivo nenhum. Uma rodada só vale se a árvore ficou parada do começo ao fim.
- **O player do YouTube se derruba sozinho por volta de 45 s no headless.** Vira
  `getPlayerState() === -1`, `currentTime` zerado, `emptied` no elemento. Parece defeito do motor e
  não é: com `BENCH_DIRETO=1`, sem proxy nenhum, acontece igual e no mesmo instante. Qualquer
  medição sobre vídeo do YouTube precisa de controle (sem o gatilho) **e** de baseline direto —
  duas hipóteses desta bancada morreram exatamente aí.
- **`navigator.userActivation` não mede nada sob automação.** O chromium dirigido por playwright
  entrega `hasBeenActive` e `isActive` verdadeiros em todo frame, antes de qualquer clique e mesmo
  entre origens diferentes. Para medir gesto de usuário, meça o EFEITO (o autoplay tocou? o
  `AudioContext` nasceu `running`?), não a flag.
- **O playwright injeta `--autoplay-policy=no-user-gesture-required` nos args padrão dele.** Passar
  a política restritiva em `args` não adianta, porque a permissiva continua na linha de comando.
  É preciso `ignoreDefaultArgs: ["--autoplay-policy=no-user-gesture-required"]`.
- **`?goto=` não navega o frame da demo.** O parâmetro é consumido no mount e o frame fica em
  `about:blank`. Para dirigir a demo, preencha a caixa de endereço e mande `Enter`, como o resto
  dos scripts daqui faz.
- **Página de cima não recarrega iframe de outra origem.** `contentWindow.location.reload()` levanta
  `SecurityError`. Quem navega o frame é o playwright (`frame.goto(...)`), que não está sujeito à
  mesma-origem.
- **Script que conecta por CDP precisa fechar o browser.** Sem `await browser.close()` no fim, o
  `connectOverCDP` mantém a conexão aberta, o node nunca sai e o comando fica pendurado até o prazo
  de morte — parecendo que travou o navegador de quem está do outro lado, quando só faltou o
  fechamento. Vale também para o recorte: filtre dentro da página e traga só o que interessa, em
  vez de despejar o arquivo inteiro pelo `evaluate`.
- **Frame sem documento não navega.** Um `<iframe>` recém-criado, ainda em `about:blank`, não
  completa o primeiro `frame.go(url)`: aparece `unrewriteUrl: unexpected url` no console e o frame
  fica onde estava — enquanto um `fetch()` da MESMA URL proxiada, feito pela página de cima, devolve
  200 com o HTML certo. Dê um `data:` URL ao iframe antes do primeiro `go()`, como a demo faz com a
  homepage.

## Sobre testes no runway

- `basicTest` com `postMessage(dado, alvo)` **para a própria janela** estoura, mesmo com `"*"`. Use
  `multiFrameTest` (filho manda para o pai), que é a forma real e funciona.
- Um `</script>` literal no corpo de um teste volta sem escape do serializador de HTML e fecha o
  `<script>` do próprio harness — timeout no scramjet, passando no bare. Monte a tag por
  concatenação.
- A suíte é **flaky sob paralelismo**: uma rodada dos testes de cookie deu 5 falhas inesperadas e a
  seguinte deu 1, idêntica ao baseline. Antes de atribuir uma falha a uma mudança, repita — e
  compare com `git stash`.
- Paralelismo padrão é **1**, e há centenas de timeouts de 30 s. Use `RUNWAY_PARALLEL=8`, e um filtro
  posicional com o nome exato do teste quando for só um.
