# Scramjet Wisp App (para VSSH-SSO)

Um aplicativo VSSH-SSO (do tipo `engine`) que fornece um servidor Wisp e serve os assets do cliente Scramjet. Este módulo atua como um motor de proxy e reescrita web, consumido pelo navegador embutido do ambiente VSSH, dispensando a necessidade de instalar extensões de navegador.

## 🚀 Funcionalidades

- Servidor Wisp: o pacote `@mercuryworkshop/wisp-js/server` fornece o transporte de rede. O `LibcurlClient` no frontend usa esse servidor para abrir conexões TCP e lidar com o tráfego.
- Assets estáticos isolados: os bundles do *Scramjet*, do *scramjet-controller* e do *libcurl-transport* são construídos de `engines/` e servidos de `backend/vendor/`. O código AGPL fica neste backend, fora da esteira de build do shell.
- Execução sem janela: com `"type": "engine"` no manifesto, o app roda invisível no servidor. Ele não cria janela, não aparece no Launchpad nem no menu iniciar, e não carrega o SDK web (`_sdk/vssh.js`); o contrato dele com o portal é só HTTP e WebSocket. O backend importa o runtime `vssh` que o portal instala em cada servidor.
- Degradação diagnosticável: se um pacote do motor faltar, o processo continua de pé. O endereço abre mesmo assim e `/` responde `503` com JSON nomeando o pacote. Morrer antes do `listen()` faria o portal medir `HTTP 000`, derrubar o túnel SSH e entregar um `502` sem nenhuma pista.

## 📦 Instalação

Este projeto foi desenhado para ser executado como um App externo dentro do ecossistema VSSH-SSO.

A instalação é do portal. O `installCommand` do manifesto `vssh-app.json` roda `npm ci --omit=dev` em `backend/` quando o `package-lock.json` mudou desde a última instalação (ou quando `VSSH_APP_REBUILD=1`). A única dependência é o `wisp-js`; o runtime `vssh` vem do servidor, pelo `NODE_PATH` que o `vssh-app-run` exporta.

Para instalar as dependências manualmente num ambiente de desenvolvimento:

```bash
cd backend
npm install --omit=dev
```

## 🛠️ Testes e Desenvolvimento Local

A bancada do backend roda com `npm test` em `backend/`, com o runtime `vssh` no `NODE_PATH`. A
cópia pública dele está em `runtime/node` do [`colabhd/vssh-sdk`](https://github.com/colabhd/vssh-sdk).

Para subir o servidor localmente, a partir da raiz do repositório, `--tcp` troca o socket unix por
uma porta:

```bash
NODE_PATH=/caminho/para/vssh-sdk/runtime/node VSSH_APP_DATA_DIR=/tmp/scramjet-wisp node backend/server.js --tcp 127.0.0.1:48123
# anuncia: [scramjet-wisp] versão 5.0.0 escutando em 127.0.0.1:48123
```

Com o servidor rodando, você pode validar os endpoints:

```bash
# Healthcheck — 200 e corpo "scramjet-wisp ok". Um 503 aqui significa que falta pacote
# essencial, e o corpo JSON diz qual.
curl -i http://127.0.0.1:48123/

# Os 7 assets que o cliente realmente carrega. Todos devem dar 200 com tamanho > 0.
for p in scram/scramjet.js scram/scramjet.wasm \
         controller/controller.api.js controller/controller.inject.js \
         controller/controller.sw.js libcurl/index.js utils/scramjet-utils.js; do
  curl -sS -o /dev/null -w "%{http_code} %{size_download}\t$p\n" "http://127.0.0.1:48123/$p"
done
```

> Esta é a mesma lista que `.github/workflows/smoke.yml` verifica no CI, e ela não é arbitrária:
> cada caminho é carregado nominalmente pelo consumidor no `vssh-sso`
> (`vssh-client/js/browser/ScramjetEngine.js` e `vssh-client/scram-sw.js`). Se uma remontagem do
> motor renomear qualquer um deles, a navegação vaza para o upstream em vez de ser reescrita. Ao
> mexer no motor, atualize as duas pontas.

O log estruturado do app fica em `$VSSH_APP_DATA_DIR/app.log` (no servidor,
`~/.vssh-apps/scramjet-wisp/data/app.log`). Ele é separado do `run.log` de propósito: o `run.log`
é rotacionado a cada start pelo portal, então não sobrevive a um app que reinicia em laço — que é
justamente quando você precisa lê-lo.

> Testes de ponta a ponta (navegação real num site, reescrita de código) só fazem sentido contra um servidor VSSH real, onde o navegador embutido do ambiente pede o motor ao portal.

## ⚖️ Licenciamento e Arquitetura

O backend deste módulo depende e integra pacotes da organização Mercury Workshop, como `@mercuryworkshop/wisp-js`, `@mercuryworkshop/scramjet`, entre outros, que operam sob a licença **AGPL-3.0**.

A própria arquitetura deste componente como um aplicativo (`vssh-app`) executado num processo Node em separado garante o isolamento adequado de licenciamento em relação ao backend central do VSSH-SSO.
