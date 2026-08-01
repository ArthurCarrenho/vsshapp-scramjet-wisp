# Operação do CI de publicação

O split para repo próprio já aconteceu. Este documento cobre como a publicação funciona hoje, o que
é preciso configurar uma única vez, e o histórico de uma armadilha que já quebrou a esteira — para
não ser reintroduzida.

O workflow vive em [`.github/workflows/publish.yml`](.github/workflows/publish.yml) e delega ao
reusable do `colabhd/vssh-app-toolkit`. O gate de qualidade é
[`.github/workflows/smoke.yml`](.github/workflows/smoke.yml), que roda antes e em todo PR.

## Como funciona

`push` em `main` → job `smoke` (sobe o backend e confere healthcheck, os 7 assets do contrato,
traversal e gate de token) → job `publish` (empacota e publica no Worker D1/R2) → instalável no
servidor com `sudo vssh-app-install scramjet-wisp --force`.

## O que já quebrou aqui (não reintroduza)

A versão anterior deste workflow **inlineava** os passos e dava checkout de `colabhd/vssh-sso`
(sparse `scripts/`) usando um PAT, para rodar `_tools/scripts/vssh-app-publish`. O racional
registrado era: *"o vssh-sso é privado e de outra conta; o GitHub não deixa um repo pessoal chamar
um reusable workflow privado cross-owner"*.

Duas coisas invalidaram isso:

1. O `vssh-app-publish` **foi movido** do `vssh-sso` para o `colabhd/vssh-app-toolkit` (commit
   `1acc1ef`). O checkout continuou funcionando, mas o arquivo não estava mais lá — **todo push em
   `main` passou a falhar**, e o app ficou sem poder publicar por semanas.
2. O toolkit é **público**. A limitação cross-owner nunca se aplicou a ele, então o `uses:` resolve
   no `github.token` do próprio repo e **nenhum PAT é necessário**.

Se algum dia a publicação voltar a falhar com "No such file or directory", suspeite primeiro de que
o script mudou de casa outra vez.

### Sobre as refs (`@main` e `tools_ref: main`)

As duas apontam para `main` de propósito: **só em `main`** o reusable faz sparse-checkout de
`schema/` junto de `scripts/`, e é isso que faz o `vssh-app-publish` validar o `vssh-app.json`
contra o JSON Schema inteiro. A tag `v1` está congelada num commit **anterior** à existência de
`schema/` — o script de lá nem tem o código de validação, então `@v1` degrada em silêncio para as
checagens mínimas (`id`/`runtime`/`entrypoint`).

Se `main` quebrar, o conserto é trocar as duas refs por `v1`: volta a publicar, validando menos.

## Configuração (uma vez)

### 1. Token de publicação escopado (`app:scramjet-wisp`)

Com o **token mestre** do Worker (secret `PUBLISH_TOKEN` do repo-worker):

```bash
curl -fsS -X POST "https://vssh-repo.colabh.org/v1/tokens" \
  -H "Authorization: Bearer $VSSH_MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"app:scramjet-wisp","label":"CI scramjet-wisp (ArthurCarrenho)"}'
# → retorna { "token": "vsshp_..." } UMA ÚNICA VEZ. Guarde.
```

O `scramjet-wisp` é publicado como `kind:app` com `type:"engine"` no manifesto — por isso o escopo é
`app:<id>`, não um kind novo.

### 2. Registrar no repo

```bash
gh secret set VSSH_REPO_PUBLISH_TOKEN -R ArthurCarrenho/vsshapp-scramjet-wisp   # o vsshp_... acima
# opcional (o default já é https://vssh-repo.colabh.org):
gh variable set VSSH_REPO_API -R ArthurCarrenho/vsshapp-scramjet-wisp -b "https://vssh-repo.colabh.org"
```

**`VSSH_REPO_PUBLISH_TOKEN` é o único secret necessário.** O antigo `VSSH_TOOLS_TOKEN` (PAT com
`Contents: Read` no `colabhd/vssh-sso`) não é mais referenciado por nada:

```bash
gh secret delete VSSH_TOOLS_TOKEN -R ArthurCarrenho/vsshapp-scramjet-wisp
```

Apagar o secret **não revoga** o credential — revogue também em GitHub → Settings → Developer
settings → Fine-grained tokens.

## Publicar e verificar

`git push` para `main` dispara. Para exercitar sem tocar em `main`, use o `workflow_dispatch`
apontando para o branch do PR:

```bash
gh workflow run "Publish scramjet-wisp → vssh-repo" --ref <seu-branch>
```

Nos logs do publish, confirme a linha `✅ ... publicado` **e a ausência** de
`aviso: schema não encontrado; validando só o mínimo` — essa ausência é a prova de que
`tools_ref: main` pegou e a validação completa rodou.

```bash
curl -fsS https://vssh-repo.colabh.org/v1/apps/scramjet-wisp/manifest.json | jq .latest.version
```

Depois, no servidor: `sudo vssh-app-install scramjet-wisp --force` (ou pela aba admin
"Repositório"). O `installCommand` roda `npm ci --omit=dev`, que baixa os bundles dos forks
(`ArthurCarrenho/vssh-scramjet` + `vssh-libcurl-transport`, releases públicas) — sem auth.

## Sobre a `version` do manifesto

O campo `version` em `vssh-app.json` é **sempre sobrescrito** pelo CI com `1.0.<github.run_number>`.
Ele não pode ser removido — o `vssh-app-publish` recusa manifesto sem `version` válida — e continua
valendo para instalação manual a partir de um clone. Mas não adianta bumpá-lo à mão esperando que o
número apareça no repositório de artefatos: quem manda ali é o número da execução do workflow.

## Dependências AGPL e a tag `latest`

As 4 dependências pesadas vêm de URLs `releases/download/**latest**/<pkg>-<ver>.tgz`. A tag
`latest` é **mutável**: já aconteceu de os bytes serem republicados sob o mesmo nome de arquivo,
invalidando o `integrity` do `package-lock.json` e fazendo `npm ci` falhar com `EINTEGRITY` (é o
incidente descrito na mensagem do commit `06d49be`). A única defesa hoje é o `<ver>` no nome do
arquivo, que depende de disciplina de sempre bumpar a versão ao republicar.

Mitigação em vigor: o `smoke.yml` roda também num `schedule` semanal, então esse drift vira build
vermelho aqui em vez de ser descoberto na próxima instalação num servidor de usuário. A correção
definitiva mora nos repos dos forks — publicar releases com tag imutável por versão.
