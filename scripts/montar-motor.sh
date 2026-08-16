#!/usr/bin/env bash
# Monta, a partir de um build recém-feito em `engines/`, o diretório `motor/` que o backend vai
# consumir — e recusa montar se faltar algum arquivo que o `backend/server.js` serve.
#
# Uso:  scripts/montar-motor.sh <scramjet|transport>
#       (rodado de dentro de engines/<fork>)
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
SAIDA="motor"

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
	versao="$(node -p "require('./$dir/package.json').version")"
	sha="$(git -C "$RAIZ" rev-parse HEAD)"
	cat > "$dir/BUILD.json" <<JSON
{
  "pacote": "$nome",
  "versao": "$versao",
  "origem": "$sha",
  "arvore": "$(git -C "$RAIZ" rev-parse --short HEAD)"
}
JSON
}

copiar() {  # copiar <destino> <origem-do-pacote>
	local destino="$1" pkg="$2"
	mkdir -p "$SAIDA/$destino"
	cp -r "$pkg/dist" "$SAIDA/$destino/"
	cp "$pkg/package.json" "$SAIDA/$destino/"
	[ -d "$pkg/lib" ] && cp -r "$pkg/lib" "$SAIDA/$destino/" || true
	build_json "$SAIDA/$destino" "$destino"
}

rm -rf "$SAIDA"
case "$ALVO" in
	scramjet)
		copiar scramjet   packages/core
		copiar controller packages/controller
		copiar utils      packages/utils
		;;
	transport)
		copiar libcurl-transport .
		;;
	*)
		echo "alvo desconhecido: $ALVO" >&2; exit 2 ;;
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
