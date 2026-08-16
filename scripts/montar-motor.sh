#!/usr/bin/env bash
# Monta, a partir de um build recém-feito em `engines/`, o diretório `motor/` que o backend vai
# consumir — e recusa montar se faltar algum arquivo que o `backend/server.js` serve.
#
# Uso:  scripts/montar-motor.sh <scramjet|transport>
#       (rodado de dentro de engines/<fork>)
#
# O destino é `backend/vendor/`, que é COMMITADO. Ver o comentário do `motorDir` em
# `backend/server.js`: o motor viaja no tarball do app porque o job que publica é um runner
# separado, com checkout limpo, que nunca veria um artefato construído em outro workflow.
#
# ─── Por que este script existe, e não um passo de YAML ──────────────────────────────────────
#
# `backend/server.js` NÃO importa nenhum destes pacotes. Ele resolve o diretório e serve arquivos
# estáticos de dentro dele (`distDirOf`, linhas 87-89, com o comentário dizendo que só localiza o
# caminho e nunca executa o módulo). Ou seja: o que liga o motor ao backend não é uma API, são
# NOMES DE ARQUIVO. Nenhum type-check pega o dia em que um bundle é renomeado por um bump de
# dependência — o sintoma aparece como navegação vazando para fora do proxy, em produção.
#
# A conferência mora aqui, e não num job separado, porque um job separado só poderia rodar quando
# TODOS os pacotes fossem construídos no mesmo run — e com filtro de caminho isso quase nunca
# acontece. Aqui, cada build confere o que acabou de produzir, sempre.
set -euo pipefail

ALVO="${1:?uso: montar-motor.sh <scramjet|transport>}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAIDA="$RAIZ/backend/vendor"

# Qual subárvore de `engines/` alimenta cada alvo. Serve para duas coisas: apagar só o que este
# alvo monta (montar o scramjet não pode levar embora o libcurl-transport, que vem de outro job e
# quase nunca no mesmo run), e carimbar no BUILD.json de onde o artefato veio.
case "$ALVO" in
	scramjet)  FORK="engines/scramjet";          PACOTES="scramjet controller utils" ;;
	transport) FORK="engines/libcurl-transport"; PACOTES="libcurl-transport" ;;
	*) echo "alvo desconhecido: $ALVO" >&2; exit 2 ;;
esac

# O hash da ÁRVORE do fork, não o do commit. É o que responde "o vendor commitado corresponde a
# este fonte?" — um commit que mexe só no `backend/` muda o SHA do commit e não muda este, então
# usar o commit faria o vendor parecer desatualizado a cada push. Ver o passo de conferência no
# `motor.yml`.
FONTE="$(git -C "$RAIZ" rev-parse "HEAD:$FORK")"

# O contrato, numa lista só. Espelha o `ROUTE_SPECS` de `backend/server.js` mais os nomes que o
# `ScramjetEngine.js` do vssh-client pede. Mexer aqui é mexer no que produção carrega.
contrato_de() {
	case "$1" in
		scramjet)  printf 'scramjet/dist/scramjet.js\nscramjet/dist/scramjet.wasm\ncontroller/dist/controller.api.js\ncontroller/dist/controller.inject.js\ncontroller/dist/controller.sw.js\nutils/dist/scramjet-utils.js\n' ;;
		transport) printf 'libcurl-transport/dist/index.js\n' ;;
	esac
}

# Procedência: qual commit produziu este artefato. Substitui o número de versão como resposta para
# "o que exatamente está em disco?" — uma versão diz qual release, o SHA diz qual código. É a
# pergunta que o `backend/versoes.js` vinha tentando responder desde que produção rodou alpha.4 por
# seis releases sem ninguém notar.
build_json() {
	local dir="$1" nome="$2"
	local versao sha
	# `readFileSync` e não `require()`: o destino agora é um caminho ABSOLUTO, e o `require` do node
	# do Windows não resolve o `/c/...` que o bash do git entrega — a versão saía vazia, em silêncio,
	# e ia assim para o BUILD.json. O script precisa valer também para quem constrói localmente.
	versao="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)' "$dir/package.json")"
	[ -n "$versao" ] || { echo "não consegui ler a versão de $dir/package.json" >&2; exit 1; }
	sha="$(git -C "$RAIZ" rev-parse HEAD)"
	cat > "$dir/BUILD.json" <<JSON
{
  "pacote": "$nome",
  "versao": "$versao",
  "origem": "$sha",
  "fork": "$FORK",
  "fonte": "$FONTE"
}
JSON
}

copiar() {  # copiar <destino> <origem-do-pacote>
	local destino="$1" pkg="$2"
	mkdir -p "$SAIDA/$destino"
	cp -r "$pkg/dist" "$SAIDA/$destino/"
	# Só `dist/` e o `package.json`. O `lib/` do pacote npm NÃO vem, e agora que o vendor é
	# versionado isso deixou de ser detalhe: o `lib/` do libcurl-transport são 2 MB de
	# `libcurl_full.mjs` que o esbuild JÁ inlineou dentro de `dist/index.js` — o `dist` só o menciona
	# num comentário (`// lib/libcurl_full.mjs`), e nenhum `dist/` de nenhum dos quatro tem import
	# real para `../lib`. Copiá-lo dobraria o blob no repositório a cada bump do motor, para servir
	# a um `exports` que ninguém resolve: o backend não importa estes pacotes, serve arquivos de
	# dentro deles.
	cp "$pkg/package.json" "$SAIDA/$destino/"

	# Fora do `dist/` copiado: o que nenhum navegador carrega. `temp-types-build/` é o bundle
	# intermediário que o rspack usa para gerar as declarações (952 KB, dos quais 764 são sourcemap
	# DELE, e o nome já diz que é temporário); `types/` e os `.d.ts` são declarações TypeScript.
	# Nenhum bundle servido referencia qualquer um dos dois. Juntos são ~1,1 MB por bump do motor,
	# num diretório que agora é versionado.
	#
	# Os sourcemaps de PRODUÇÃO ficam, e isso é decisão e não descuido: são 4,4 MB, e foram eles que
	# permitiram descobrir que produção rodava alpha.4 — a única pista era um stack trace do console
	# do usuário com números de linha de outra versão. Diagnóstico de incidente vale o espaço.
	rm -rf "$SAIDA/$destino/dist/temp-types-build" "$SAIDA/$destino/dist/types"
	find "$SAIDA/$destino/dist" -name '*.d.ts' -delete

	build_json "$SAIDA/$destino" "$destino"
}

# Apaga só o que ESTE alvo monta, e não o `$SAIDA` inteiro. Os dois alvos escrevem no mesmo
# diretório mas quase nunca no mesmo run — o filtro de caminho do `motor.yml` faz questão disso —,
# então um `rm -rf "$SAIDA"` aqui levaria embora o libcurl-transport toda vez que o scramjet fosse
# montado, e o defeito só apareceria no `git status` de quem commitasse sem olhar.
for p in $PACOTES; do rm -rf "${SAIDA:?}/$p"; done
mkdir -p "$SAIDA"

case "$ALVO" in
	scramjet)
		copiar scramjet   packages/core
		copiar controller packages/controller
		copiar utils      packages/utils
		;;
	transport)
		copiar libcurl-transport .
		;;
esac

# ─── O contrato ──────────────────────────────────────────────────────────────────────────────
erro=0
while read -r arq; do
	[ -z "$arq" ] && continue
	if [ ! -f "$SAIDA/$arq" ]; then
		echo "FALTA no build: $arq" >&2; erro=1
	elif [ ! -s "$SAIDA/$arq" ]; then
		echo "VAZIO no build: $arq" >&2; erro=1
	else
		printf 'ok  %-42s %s bytes\n' "$arq" "$(stat -c%s "$SAIDA/$arq")"
	fi
done <<< "$(contrato_de "$ALVO")"

if [ "$erro" -ne 0 ]; then
	echo >&2
	echo "O build não produziu um arquivo que o backend serve. Publicar assim daria 503 numa rota" >&2
	echo "do motor, com o healthcheck respondendo 200 — sem nada vermelho em lugar nenhum." >&2
	exit 1
fi

echo
find "$SAIDA" -name BUILD.json -exec sh -c 'echo "--- $1"; cat "$1"' _ {} \;
