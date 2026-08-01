# Scramjet Wisp App (para VSSH-SSO)

Um aplicativo VSSH-SSO (do tipo `engine`) que fornece um servidor Wisp e serve os assets do cliente Scramjet. Este módulo atua como um motor de proxy e reescrita web, consumido nativamente pelo navegador embutido do cliente Xpra, dispensando a necessidade de instalar extensões de navegador.

## 🚀 Funcionalidades

- **Servidor Wisp**: Utiliza o pacote `@mercuryworkshop/wisp-js/server` para fornecer o transporte de rede. O `LibcurlClient` no frontend utiliza esse servidor para abrir conexões TCP e lidar com o tráfego de forma eficiente.
- **Assets Estáticos Isolados**: Serve os bundles JavaScript do *Scramjet*, *scramjet-controller* e *libcurl-transport* diretamente do `node_modules/`. Isso mantém o código isolado no backend, garantindo que dependências AGPL não sejam empacotadas (build) na esteira principal do cliente Xpra.
- **Execução Headless**: Configurado com `"type": "engine"` no manifesto, este aplicativo roda de forma invisível no backend. Ele não cria uma interface gráfica (`VsshAppWindow`) e não aparece no Launchpad ou no Menu Iniciar do usuário. Como não tem janela, também não usa a ponte `postMessage` host↔app nem o shim `window.vssh` — o contrato dele com o portal é só HTTP/WebSocket.
- **Degradação diagnosticável**: se um pacote não resolver, o processo **não morre**. A porta abre mesmo assim e `/` responde `503` com JSON nomeando o pacote. Morrer antes do `listen()` fazia o portal medir `HTTP 000`, derrubar o túnel SSH e entregar um `502` sem nenhuma pista — o pior modo de falha possível para depurar remotamente.

## 📦 Instalação

Este projeto foi desenhado para ser executado como um App externo dentro do ecossistema VSSH-SSO.

A instalação geralmente é gerenciada automaticamente pelo VSSH-SSO. O manifesto `vssh-app.json` possui um `installCommand` integrado que baixa as dependências (`npm ci`) caso a pasta `node_modules/` não exista no servidor de destino.

Para instalar as dependências manualmente num ambiente de desenvolvimento:

```bash
cd backend
npm install --omit=dev
```

## 🛠️ Testes e Desenvolvimento Local

Para subir o servidor localmente de forma isolada, defina a porta e inicie o backend:

```bash
cd backend
VSSH_APP_PORT=48123 node server.js
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
> (`custom_xprahtml5/js/browser/ScramjetEngine.js` e `scram-sw.js`). Se um upgrade de dependência
> renomear qualquer um deles, o motor para de funcionar em produção — a navegação vaza para o
> upstream em vez de ser reescrita. Ao mexer nas dependências, atualize as duas pontas.

O log estruturado do app fica em `$VSSH_APP_DATA_DIR/app.log` (no servidor,
`~/.vssh-apps/scramjet-wisp/data/app.log`). Ele é separado do `run.log` de propósito: o `run.log`
é rotacionado a cada start pelo portal, então não sobrevive a um app que reinicia em laço — que é
justamente quando você precisa lê-lo.

> **Aviso**: Testes *end-to-end* (como navegação real num site e reescrita de código) só fazem sentido quando executados contra um servidor VSSH-SSO real, onde o cliente Xpra fará a requisição automática da URL via chamadas à API de inicialização de aplicativos.

## ⚖️ Licenciamento e Arquitetura

O backend deste módulo depende e integra pacotes da organização Mercury Workshop, como `@mercuryworkshop/wisp-js`, `@mercuryworkshop/scramjet`, entre outros, que operam sob a licença **AGPL-3.0**.

A própria arquitetura deste componente como um aplicativo (`vssh-app`) executado num processo Node em separado garante o isolamento adequado de licenciamento em relação ao backend central do VSSH-SSO.
