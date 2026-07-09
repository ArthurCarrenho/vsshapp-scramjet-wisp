# Split do scramjet-wisp para repo próprio + CI de publicação

Guia para mover este diretório (`examples/scramjet-wisp/`) para um repositório próprio no seu
usuário do GitHub (ArthurCarrenho), com CI que publica no repositório de artefatos do vssh
(Worker D1/R2), no mesmo modelo do `colabhd/vsshapp-recoll` — mas adaptado para repo pessoal.

O workflow já está pronto em [`.github/workflows/publish.yml`](.github/workflows/publish.yml).

## Por que é diferente do vsshapp-recoll

O `vsshapp-recoll` usa `uses: colabhd/vssh-sso/.github/workflows/_publish-app-reusable.yml@main`.
Isso só funciona porque ele é da **mesma org** (`colabhd`) do `vssh-sso`. O GitHub **não** deixa
um repositório de um **usuário pessoal** chamar um reusable workflow que está num repo **privado
de outra conta**. Por isso o `publish.yml` daqui **inlineia** os passos (checkout do script de
publish via PAT + rodar `vssh-app-publish`) em vez de `uses:`. Resultado idêntico, sem a
limitação cross-owner.

## Passo a passo

### 1. Criar o repositório (no seu usuário)

```bash
# de dentro de examples/scramjet-wisp/
gh repo create ArthurCarrenho/vsshapp-scramjet-wisp --public --source . --remote origin --push
```

(ou crie pelo site e faça `git init && git remote add origin ... && git add -A && git commit && git push -u origin main`).
`backend/node_modules/` é ignorado (ver `.gitignore`) — só `package.json` + `package-lock.json`
são versionados; as deps são instaladas no servidor por `npm ci --omit=dev`.

### 2. Criar o token de publicação escopado (`app:scramjet-wisp`)

Com o **token mestre** do Worker (secret `PUBLISH_TOKEN` do repo-worker), crie um token escopado:

```bash
curl -fsS -X POST "https://vssh-repo.colabh.org/v1/tokens" \
  -H "Authorization: Bearer $VSSH_MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scope":"app:scramjet-wisp","label":"CI scramjet-wisp (ArthurCarrenho)"}'
# → retorna { "token": "vsshp_..." } UMA ÚNICA VEZ. Guarde.
```

(scramjet-wisp é publicado como `kind:app` com `type:"engine"` no manifest — por isso o escopo é
`app:<id>`, não um kind novo.)

### 3. Criar o PAT de leitura do vssh-sso (`VSSH_TOOLS_TOKEN`)

O `vssh-sso` é privado, então o CI deste repo precisa de um token para dar checkout de `scripts/`:

- GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate.
- Resource owner: `colabhd`; Repository access: só `colabhd/vssh-sso`.
- Permissions → Repository → **Contents: Read-only**.
- (Se você não tem acesso de admin na org `colabhd` para gerar um fine-grained token com esse
  escopo, um **GitHub App** instalado no `vssh-sso` com Contents:Read, ou um classic PAT com
  `repo`, também servem. Alguém com acesso ao `colabhd/vssh-sso` precisa autorizar.)

### 4. Adicionar os secrets ao novo repo

```bash
gh secret set VSSH_REPO_PUBLISH_TOKEN -R ArthurCarrenho/vsshapp-scramjet-wisp   # cole o vsshp_... do passo 2
gh secret set VSSH_TOOLS_TOKEN        -R ArthurCarrenho/vsshapp-scramjet-wisp   # cole o PAT do passo 3
# opcional (default já é https://vssh-repo.colabh.org):
gh variable set VSSH_REPO_API -R ArthurCarrenho/vsshapp-scramjet-wisp -b "https://vssh-repo.colabh.org"
```

### 5. Disparar e verificar

`git push` para `main` dispara o publish (ou Actions → "Publish scramjet-wisp → vssh-repo" →
Run workflow). Verifique:

```bash
curl -fsS https://vssh-repo.colabh.org/v1/apps/scramjet-wisp/manifest.json | jq .latest.version
```

Depois, no servidor: `sudo vssh-app-install scramjet-wisp --force` (ou pela aba admin
"Repositório"). O `installCommand` roda `npm ci --omit=dev`, que baixa os bundles do fork
(`ArthurCarrenho/vssh-scramjet` + `vssh-libcurl-transport`, releases públicas) — sem auth.

## Depois do split

- Remover `examples/scramjet-wisp/` do rastreio do vssh-sso principal não é necessário: ele já é
  um diretório **não-rastreado** (como `examples/vsshapp-recoll/`), agora com seu próprio `.git`.
- O `publish-apps.yml` (manual) do vssh-sso continua funcionando como fallback, mas o caminho
  oficial passa a ser o CI deste repo.
