# Operação do CI

Um push em `main` publica o app. Este documento diz o que a esteira faz, o que se configura uma
vez, e como conferir que uma publicação chegou.

## O que roda

O CI único é [`.github/workflows/entrega.yml`](.github/workflows/entrega.yml), disparado por push em
`main`, por pull request e à mão. Quatro jobs, em sequência:

1. `motor` ([`motor.yml`](.github/workflows/motor.yml)): constrói o que mudou em `engines/`
   (o fork do Scramjet e o do libcurl-transport). Um push que não toca em `engines/` não paga
   esse build.
2. `vendor`: aplica o resultado em `backend/vendor/`, confere que cada `BUILD.json` aponta para a
   árvore atual do fork e, só em push, commita a remontagem com o `GITHUB_TOKEN`, que não dispara
   outro run.
3. `smoke` ([`smoke.yml`](.github/workflows/smoke.yml)): o gate. O job `tarball` monta o pacote do
   mesmo jeito que a publicação monta e confere o que entra e o que fica de fora; o job `smoke`
   instala pelo `installCommand` do manifesto, roda a bancada do backend, sobe o servidor no
   socket unix e exercita healthcheck, os sete assets do contrato, traversal, o portão de token do
   upgrade e a degradação por pacote ausente.
4. `publish`: só em push para `main`. Faz o checkout esparso de `scripts` e `api` do
   [`colabhd/vssh-sdk`](https://github.com/colabhd/vssh-sdk) e publica no Worker pelo
   `vssh-app-publish` de lá, com a versão `5.0.<número do run>`.

O backend importa o runtime `vssh` do servidor (`/opt/vssh/sdk/node`, no `NODE_PATH` que o
`vssh-app-run` exporta), e por isso não o leva no pacote. No CI quem o fornece é a ação
`colabhd/vssh-sdk/.github/actions/preparar-sdk@main`, chamada no começo do job `smoke`.

[`upstream.yml`](.github/workflows/upstream.yml) é separado: toda segunda ele compara cada
subárvore de `engines/` com o upstream dela e mantém uma issue aberta quando o upstream andou.

## Configuração, uma vez

Um token de publicação escopado em `app:scramjet-wisp`, emitido com o token mestre do Worker:

```bash
curl -fsS -X POST "https://vssh-repo.colabh.org/v1/tokens"   -H "Authorization: Bearer $VSSH_MASTER_TOKEN"   -H "Content-Type: application/json"   -d '{"scope":"app:scramjet-wisp","label":"CI scramjet-wisp (ArthurCarrenho)"}'
# devolve { "token": "vsshp_..." } uma vez só
```

O escopo é `app:<id>` porque o `scramjet-wisp` é publicado como `kind:app`; o `type: engine` fica
no manifesto. Depois, no repositório:

```bash
gh secret set VSSH_REPO_PUBLISH_TOKEN -R ArthurCarrenho/vsshapp-scramjet-wisp
# opcional; o padrão já é https://vssh-repo.colabh.org
gh variable set VSSH_REPO_API -R ArthurCarrenho/vsshapp-scramjet-wisp -b "https://vssh-repo.colabh.org"
```

`VSSH_REPO_PUBLISH_TOKEN` é o único secret. O `vssh-sdk` é público, então o checkout dele sai no
`github.token` do próprio run.

## Publicar e conferir

`git push` para `main` dispara tudo. Para exercitar a esteira sem publicar, rode o workflow à mão
num branch:

```bash
gh workflow run Entrega --ref <seu-branch>
```

Nesse caso `motor`, `vendor` e `smoke` rodam, e `publish` fica de fora, porque ele só roda em push
para `main`. Para conferir uma publicação:

```bash
curl -fsS https://vssh-repo.colabh.org/v1/apps/scramjet-wisp/manifest.json | jq .latest.version
```

No servidor, `sudo vssh-app-install scramjet-wisp --force` (ou a aba "Repositório" do admin). O
`installCommand` roda `npm ci --omit=dev` no `backend/`, e a única dependência é o `wisp-js`, do
npm público; o motor viaja pronto em `backend/vendor/`.

## A `version` do manifesto

O CI sobrescreve o campo `version` de `vssh-app.json` com `5.0.<número do run>` ao publicar. O
valor que está no arquivo vale para uma instalação manual a partir de um clone, e o
`vssh-app-publish` recusa manifesto sem `version` válida, então ele fica. O `run_number` é por
arquivo de workflow, e por isso a contagem só anda para a frente enquanto a publicação morar no
`entrega.yml`; o Worker não compara números, ele guarda como `latest` o último publicado, e as
versões anteriores continuam no `history` para `vssh-app-install scramjet-wisp@<versão>`.
