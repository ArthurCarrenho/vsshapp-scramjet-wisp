# Scramjet Wisp App (para VSSH-SSO)

Um aplicativo VSSH-SSO (do tipo `engine`) que fornece um servidor Wisp e serve os assets do cliente Scramjet. Este módulo atua como um motor de proxy e reescrita web, consumido nativamente pelo navegador embutido do cliente Xpra, dispensando a necessidade de instalar extensões de navegador.

## 🚀 Funcionalidades

- **Servidor Wisp**: Utiliza o pacote `@mercuryworkshop/wisp-js/server` para fornecer o transporte de rede. O `LibcurlClient` no frontend utiliza esse servidor para abrir conexões TCP e lidar com o tráfego de forma eficiente.
- **Assets Estáticos Isolados**: Serve os bundles JavaScript do *Scramjet*, *scramjet-controller* e *libcurl-transport* diretamente do `node_modules/`. Isso mantém o código isolado no backend, garantindo que dependências AGPL não sejam empacotadas (build) na esteira principal do cliente Xpra.
- **Execução Headless**: Configurado com `"type": "engine"` no manifesto, este aplicativo roda de forma invisível no backend. Ele não cria uma interface gráfica (`PseudoNativeAppWindow`) e não aparece no Launchpad ou no Menu Iniciar do usuário.

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
# Endpoint de Healthcheck (deve retornar 200)
curl http://127.0.0.1:48123/

# Teste de resposta estática para os assets do motor
curl http://127.0.0.1:48123/scram/scramjet_bundled.js
```

> **Aviso**: Testes *end-to-end* (como navegação real num site e reescrita de código) só fazem sentido quando executados contra um servidor VSSH-SSO real, onde o cliente Xpra fará a requisição automática da URL via chamadas à API de inicialização de aplicativos.

## ⚖️ Licenciamento e Arquitetura

O backend deste módulo depende e integra pacotes da organização Mercury Workshop, como `@mercuryworkshop/wisp-js`, `@mercuryworkshop/scramjet`, entre outros, que operam sob a licença **AGPL-3.0**.

A própria arquitetura deste componente como um aplicativo (`vssh-app`) executado num processo Node em separado garante o isolamento adequado de licenciamento em relação ao backend central do VSSH-SSO.
