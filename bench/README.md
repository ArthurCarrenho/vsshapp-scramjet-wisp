# Bancada do transporte

Ferramentas para responder perguntas sobre o **transporte** — quantas conexões o motor abre, se ele
multiplexa, se uma versão nova é melhor que a antiga. Nasceram de um caso concreto: subir o teto de
conexões deixou a navegação mais LENTA, e ninguém sabia por quê.

Nada aqui roda em produção. O backend não depende de playwright, de propósito.

## Como rodar

```sh
# playwright vem de onde você tiver; aqui reaproveitamos o do fork do scramjet
export BENCH_PLAYWRIGHT=<...>/vssh-scramjet/node_modules/.pnpm/playwright@*/node_modules/playwright/index.js

cd bench
node ab-run.mjs           # A/B entre versões do libcurl, contando conexões TCP
node transporte-run.mjs   # o mesmo, mas pelo bundle do libcurl-transport
node real-ab.mjs          # sites reais, versões x tetos de conexão
node suite-run.mjs        # a suíte de testes do fork do libcurl.js
```

`BENCH_BACKEND` aponta para o backend a medir (padrão: `../backend`, o deste repositório).
`BENCH_LIMITE` é o prazo de morte de cada script.

## O que cada um responde

| script | pergunta |
|---|---|
| `conta-conexoes.mjs` | *(servidor)* wisp local que **conta os `net.connect`**, e serve as páginas de teste |
| `ab-run.mjs` | 40 requisições ao mesmo host h2 abrem quantas conexões, em cada versão do libcurl? |
| `transporte-run.mjs` | a mesma pergunta, pelo bundle que o cliente carrega de verdade |
| `real-ab.mjs` | em sites reais, versão × teto: parede, TTFB e conexões por host |
| `suite-run.mjs` | os testes do fork do libcurl.js (POST, redirect, websocket, TLS socket) |

Para comparar versões, `ab-run.mjs` serve `/lc/<nome>`: `antigo` é o que está em
`backend/node_modules/libcurl.js`; qualquer outro nome vira `../libcurl-<nome>`, então basta copiar
um `out/` recém-compilado para lá.

## O que a bancada ensinou

**Conte conexões no servidor, não no cliente.** A pergunta "o libcurl multiplexa HTTP/2?" não se
responde por leitura de código — o wasm tinha nghttp2 compilado e negociava h2, e mesmo assim abria
uma conexão por requisição. Só embrulhando `net.Socket.prototype.connect` no wisp o número apareceu:
40 requisições, 40 conexões. É a medida que não dá para discutir.

⚠ Embrulhe o **prototype**, não a função de módulo. O wisp faz `new net.Socket()` seguido de
`.connect()`; envolver `net.connect` não pega nada, e "zero conexões" parece resultado.

**Bancada sintética sem TLS mente.** Uma bateria em localhost com HTTP puro dizia que subir o teto
de conexões por host de 6 para 16 dava 2,4×. Contra sites reais o sinal se INVERTE, porque o que
domina é o handshake TLS feito em software na thread única do WASM. Qualquer conclusão sobre número
de conexões precisa de TLS de verdade.

**Um A/B honesto muda uma coisa só.** As páginas (`ab.html`, `real-ab.html`) escolhem a versão do
libcurl pela query, então a MESMA página mede as duas — o que difere é o wasm, e nada mais.

**Alterne a ordem entre repetições.** Sem isso o cache do CDN premia quem rodou por último, e a
última configuração "ganha" sempre.

**Mediana com N par é a média dos dois centrais.** `v[Math.floor(v.length/2)]` devolve o PIOR dos
dois, e foi o que produziu um outlier de 10 s numa bateria inteira.

**Limitador de banda começa cheio.** Um balde de tokens inicializado com um segundo de crédito
engole a carga inteira antes de limitar: 50 Mbps configurados, 397 medidos.

## Armadilhas de ambiente

- **`libcurl.js` avulso não carrega o wasm sozinho.** É preciso `await libcurl.load_wasm(url)`;
  esperar por `ready`/`onload` sem isso trava para sempre. Só o `libcurl_full.js` traz embutido.
- **Nunca `comando-longo | tail`** — trava o processo. Redirecione para arquivo e leia depois.
- **Processo órfão segura porta** depois de um kill. Libere antes de relançar.
