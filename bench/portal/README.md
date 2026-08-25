# Bancada do portal

O motor real, o transporte real, e a **camada do navegador do vssh-sso** — contra uma internet
local.

## Por que ela existe

Há três bancadas neste repositório, e nenhuma alcança a camada do portal:

| bancada | o que mede |
|---|---|
| `bench/` | conexões TCP, multiplexação h2, A/B de versões do libcurl |
| `engines/scramjet/bench/` | defeitos do motor contra sites reais |
| `packages/runway` | o motor contra si mesmo, 204 testes adversariais |

E o README da bancada de reprodução diz, por extenso, onde procurar quando nenhuma delas
reproduz:

> *"a diferença que sobra é a camada do portal — extensões, userscripts, cosmético do adblock e o
> fluxo de restaurar aba"*

O script que chegou mais perto disso, `portal-duas-abas.mjs`, monta o arranjo certo (um controller,
N frames, um transporte) e **aborta sem veredito**, porque o alvo é o YouTube e o player se derruba
sozinho aos 45 s no headless. Trocar o alvo por um sítio local é o que faltava para ele poder
concluir alguma coisa.

## O que ela monta

Um portal de mentira que serve as MESMAS coisas que o de verdade, para que o cliente que carrega em
cima dele seja o de verdade:

```
/s/proxy/app/scramjet-wisp/{scram,controller,libcurl,utils}/  ← backend/vendor/*/dist
/s/proxy/app/scramjet-wisp/wisp/                              ← o wisp real, com rede.js
/s/proxy/vssh-desktop/                                        ← o vssh-client REAL, do disco
/api/user/browser/*, /api/apps                                ← dublês em memória
```

⚠ **O `vssh-client/` nunca é copiado.** É servido do disco do outro repositório (`VSSH_SSO`). Uma
cópia divergiria em silêncio, e a bancada passaria a medir uma versão que ninguém roda — que é o
defeito que ela existe para achar.

Os sítios (`sites.mjs`) resolvem por um `lookup` injetado no wisp: todo `*.teste` cai em
`127.0.0.1`. `rede.js` aceita isso de propósito — o cabeçalho dele já dizia que as opções do wisp
merecem estar num lugar que dê para testar sem tocar a rede.

## Como rodar

```sh
cd backend && npm ci && cd ..

export VSSH_SSO=../vssh-sso                    # o checkout do repositório do portal
export BENCH_PLAYWRIGHT=<...>/playwright/index.js
export BENCH_CHROME=<...>/chrome               # quando o binário do playwright não é o da máquina

cd bench/portal
node primeira-carga.mjs     # quantas cargas precisariam de F5?
node nada-volta.mjs         # a aba gira, ou alguém acorda?
node cookies-dominio.mjs    # a sessão sobrevive à ida e à volta pelo portal?
node adblock-corrente.mjs   # o bloqueio fecha a corrente inteira?
node deeplink.mjs           # o que acontece com cada esquema e cada forma de abrir?
```

Cada script termina com `=== veredito ===` e um `process.exitCode`, no mesmo vocabulário da bancada
irmã: **controle** é o mesmo cenário sem o gatilho, **direto** é sem o proxy, e **INCONCLUSIVO não
é "está tudo certo"**.

## O que cada um responde

| script | pergunta | gatilho |
|---|---|---|
| `primeira-carga.mjs` | a carga pousa sozinha, precisa de recuperação, ou precisaria de F5? | contexto novo a cada volta |
| `nada-volta.mjs` | o silêncio acaba quando nada volta? | `/lento`, que aceita a conexão e nunca responde |
| `cookies-dominio.mjs` | a sessão atravessa domínio→subdomínio, sem vazar host-only nem rebaixar HttpOnly? | contexto novo na volta, jar vazio |
| `adblock-corrente.mjs` | o pedido nem sai, o recurso falha de verdade, e o erro que não é nosso continua aparecendo? | uma extensão com um filtro de uma linha |
| `deeplink.mjs` | o que cada esquema e cada forma de abrir produzem? | uma página com os cinco casos |

## O que ela ACHOU

Três defeitos, e nenhum deles aparecia na leitura do código:

- **`window.open` de uma página proxiada lançava `TypeError`** — *depois* de a aba já ter sido
  aberta, que é exatamente o defeito que o toco de janela existe para impedir. O wrapper de
  `window.open` do motor tenta instalar o cliente dentro do que o open de baixo devolveu
  (`if (!(SCRAMJETCLIENT in realwin)) client.init.hookSubcontext(realwin)`), e o toco é truthy sem
  ser uma janela. Quebrava no meio de todo fluxo de OAuth e de pagamento.
- **`mailto:`, `tel:` e `magnet:` sumiam calados.** Chegam à página intactos (o motor não os
  reescreve, de propósito) e o clique não fazia nada: não navegava, não abria, não avisava, não
  logava. Indistinguível de um link quebrado do site.
- **O diagnóstico do cão de guarda chamava de "órfão" toda navegação pendurada** — as duas situações
  têm a mesma assinatura, porque `about:blank` nunca é controlado por ninguém, e o rótulo errado
  mandava quem fosse ler o log caçar um defeito de service worker que não estava lá.

E uma quarta que era da própria bancada, e vale registrar porque é o modo de falha mais perigoso
que ela tem: a primeira versão da captura de console fazia `String(objeto)`, e o diagnóstico do
motor viaja como objeto. A sonda apagava, em silêncio, exatamente a informação que ela existe para
ler.

## Armadilhas

- **O contexto tem de ser NOVO** entre as rodadas que medem primeira carga ou restauração de
  cookie. Reaproveitar deixa o service worker instalado e o jar cheio — e aí a sonda mede a memória
  do processo em vez do caminho.
- **"O cookie voltou" se lê pelo que o SERVIDOR recebeu**, nunca por `document.cookie`: este não
  enxerga `HttpOnly` (um cookie certo pareceria perdido) e um cookie pode existir no jar sem ser
  enviado (um perdido pareceria presente). A rota `/conta` devolve o cabeçalho que chegou.
- **Um `onerror` sozinho não prova bloqueio** — prova que algo falhou, e "o motor está fora do ar"
  tem a mesma cara. É a irmã NÃO bloqueada, carregando na mesma página, que separa as duas. E a
  prova mais dura não é do cliente: é o servidor do sítio nunca ter recebido o pedido.
- **A sonda de cookie precisa das DUAS colunas.** Rodar o cliente antigo contra o portal NOVO passa
  verde: a consulta larga sozinha já resgata o cookie de sessão, e metade do defeito fica escondida.
  `BENCH_PORTAL_ANTIGO=1` devolve o portal à igualdade exata de domínio e fecha a matriz.
- **O binário do Chromium não é o do playwright.** Um playwright recém-instalado espera a build que
  ele pinou; `BENCH_CHROME` resolve, e sem ele o erro (`Executable doesn't exist at
  …chromium_headless_shell-1234`) lê-se como "a bancada está quebrada".
- **Isto NÃO substitui uma rodada contra a internet.** Um sítio local não tem TLS de verdade, não
  tem CDN, e não tem o handshake que domina o tempo do WASM — a bancada de transporte já mediu que
  bateria sintética sem TLS **inverte** o sinal sobre número de conexões. O que se mede aqui é
  comportamento da camada do portal, nunca desempenho do transporte.

## O que ainda não tem sonda

Está escrito para não ser confundido com "medido e certo":

- **duas abas dividindo um controller e um transporte** — o arranjo do `portal-duas-abas.mjs`, agora
  que existe um alvo local que permite dar veredito;
- **egresso de extensão** — o que um bundle remoto alcança de dentro do portal, medido em vez de
  deduzido do gate;
- **a forma de um captcha** — o fixture `terceiro.teste` já existe (iframe de outra origem,
  `postMessage` com `targetOrigin` conferido, `location.origin` lido de dentro), e falta a sonda que
  monta a tabela do que um desafio veria;
- **`ShadowRoot.innerHTML`** — o fixture `/shadow` existe; o buraco é do rewriter, declarado no fork,
  e medi-lo aqui só diz se ele alcança a camada do portal.
