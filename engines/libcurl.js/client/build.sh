#!/bin/bash

set -e

#path definitions
OUT_DIR="${OUT_DIR:=out}"
BUILD_DIR="build"
C_DIR="libcurl"
FRAGMENTS_DIR="fragments"
JAVSCRIPT_DIR="javascript"
WISP_CLIENT="wisp_client"

INCLUDE_DIR="$BUILD_DIR/curl-wasm/include/"
LIB_DIR="$BUILD_DIR/curl-wasm/lib/"
OUT_FILE="$OUT_DIR/libcurl.js"
ES6_FILE="$OUT_DIR/libcurl.mjs"
MODULE_FILE="$OUT_DIR/emscripten_compiled.js"
COMPILED_FILE="$OUT_DIR/emscripten_compiled.wasm"
WASM_FILE="$OUT_DIR/libcurl.wasm"

# vssh fork: a versão do emscripten é FIXADA em `.emsdk-version`, e este aviso existe para que o
# pin valha também fora do CI. O `libcurl_full.mjs` de 2 MB que o libcurl-transport vendoriza é
# gerado por builds locais tanto quanto por builds de CI — um pin que só existisse no YAML não
# cobriria o caminho pelo qual o artefato de fato nasce hoje.
#
# ⚠ A versão fixada é `3.1.6` e ISSO NÃO É DESCUIDO. O `patch_js.py` aplica os `fragments/` por
# expressão regular sobre a saída do emscripten, e com 3.1.72 o REPLACE do `force_wsproxy.js` deixa
# de casar: ele procura `url = SOCKFS.websocketArgs["url"];` e o 3.1.72 gera
# `if(SOCKFS.websocketArgs["url"]){url=SOCKFS.websocketArgs["url"]}`. O INSERT continua casando e
# monta a URL do wsproxy com `host:porta`; a linha sobrevivente a sobrescreve logo depois pela URL
# crua. Resultado medido: 0 de 40 requisições, `error code 7`, e o servidor wisp registrando
# `creating a stream to :0 failed - hostname must be a non-empty string`.
#
# Medido, não deduzido: o blob que roda em produção nasceu do `emscripten 3.1.6~dfsg-7` do apt, e
# entrega 40/40 com UMA conexão TCP. Fixar 3.1.6 é o que faz o pin descrever o artefato real.
# Suportar emscripten moderno é consertar aquele regex — trabalho de valor, e separado deste.
#
# Comparação EXATA, e não `grep` do pin na linha: `3.1.6` é prefixo de `3.1.60`..`3.1.69`, então um
# `grep -q` acharia "3.1.6" dentro de "3.1.61" e ficaria calado justamente quando devia falar.
#
# Avisa, não falha: construir com outra versão é legítimo (para testar uma nova, por exemplo), o que
# não é legítimo é fazer isso sem saber.
if [ -f .emsdk-version ]; then
  EMSDK_PIN="$(tr -d '[:space:]' < .emsdk-version)"
  EMCC_ATUAL="$(emcc --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [ "$EMCC_ATUAL" != "$EMSDK_PIN" ]; then
    echo "AVISO: .emsdk-version pede ${EMSDK_PIN}, mas o emcc ativo é: ${EMCC_ATUAL:-desconhecido}" >&2
    echo "       o .wasm gerado NÃO será o mesmo que o CI produz, e os fragments/ podem não casar." >&2
  fi
fi

#check last used emscripten version
CURRENT_EMCC_VER="$(emcc --version)"
LAST_EMCC_VER="$(cat "$BUILD_DIR/emcc_version.txt" || emcc --version)"
if [ ! "$CURRENT_EMCC_VER" = "$LAST_EMCC_VER" ]; then
  echo "triggering a full rebuild since we're on a different emcc version"
  rm -rf "$BUILD_DIR"
fi
mkdir -p "$BUILD_DIR"
emcc --version > "$BUILD_DIR/emcc_version.txt"

#read exported functions
EXPORTED_FUNCS=""
for func in $(cat exported_funcs.txt); do
  EXPORTED_FUNCS="$EXPORTED_FUNCS,_$func"
done
EXPORTED_FUNCS="${EXPORTED_FUNCS:1}"

#compile options
RUNTIME_METHODS="addFunction,removeFunction,allocate,ALLOC_NORMAL"
COMPILER_OPTIONS="-o $MODULE_FILE -lcurl -lmbedtls -lmbedcrypto -lmbedx509 -lcjson -lz -lbrotlidec -lbrotlicommon -lnghttp2 -I $INCLUDE_DIR -L $LIB_DIR"
EMSCRIPTEN_OPTIONS="-lwebsocket.js -sENVIRONMENT=worker,web -sASSERTIONS=1 -sLLD_REPORT_UNDEFINED -sALLOW_TABLE_GROWTH -sALLOW_MEMORY_GROWTH -sNO_EXIT_RUNTIME -sEXPORTED_FUNCTIONS=$EXPORTED_FUNCS -sEXPORTED_RUNTIME_METHODS=$RUNTIME_METHODS"

#clean output dir
rm -rf $OUT_DIR
mkdir -p $OUT_DIR

if [[ "$*" == *"all"* ]]; then
  mkdir -p $OUT_DIR/release
  mkdir -p $OUT_DIR/single_file
  OUT_DIR=$OUT_DIR/release ./build.sh release
  OUT_DIR=$OUT_DIR/single_file ./build.sh release single_file
  mv $OUT_DIR/release/* $OUT_DIR
  mv $OUT_DIR/single_file/* $OUT_DIR
  rm -rf $OUT_DIR/release
  rm -rf $OUT_DIR/single_file
  exit 0
fi

if [[ "$*" == *"release"* ]]; then
  COMPILER_OPTIONS="-Oz -flto $COMPILER_OPTIONS"
  echo "note: building with release optimizations"
else
  COMPILER_OPTIONS="$COMPILER_OPTIONS --profiling -g "
  EMSCRIPTEN_OPTIONS="$EMSCRIPTEN_OPTIONS -sSTACK_OVERFLOW_CHECK=2"
  echo "note: this is a debug build"
fi

if [[ "$*" == *"asan"* ]]; then
  COMPILER_OPTIONS="$COMPILER_OPTIONS -fsanitize=address"
  echo "note: building with asan, performance will suffer"
fi

if [[ "$*" == *"single_file"* ]]; then
  EMSCRIPTEN_OPTIONS="-sSINGLE_FILE $EMSCRIPTEN_OPTIONS"
  OUT_FILE="$OUT_DIR/libcurl_full.js"
  ES6_FILE="$OUT_DIR/libcurl_full.mjs"
  echo "note: building as a single js file"
fi

#ensure deps are compiled
tools/all_deps.sh
tools/generate_cert.sh

#compile the main c file
COMPILE_CMD="emcc $C_DIR/*.c $COMPILER_OPTIONS $EMSCRIPTEN_OPTIONS"
echo $COMPILE_CMD
$COMPILE_CMD
mv $COMPILED_FILE $WASM_FILE || true

#merge compiled emscripten module and wrapper code
cp $JAVSCRIPT_DIR/main.js $OUT_FILE
sed -i "/__emscripten_output__/r $MODULE_FILE" $OUT_FILE
rm $MODULE_FILE

#add version number and copyright notice
VERSION=$(cat package.json | jq -r '.version')
[[ "$*" != *"release"* ]] && VERSION="$VERSION-dev"
[[ "$*" == *"asan"* ]] && VERSION="$VERSION-asan"
sed -i "s/__library_version__/$VERSION/" $OUT_FILE
WISP_VERSION=$(cat $WISP_CLIENT/package.json | jq -r '.version')
sed -i "s/__wisp_version__/$WISP_VERSION/" $OUT_FILE


#js files are inserted in reverse order
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/ftp.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/tls_socket.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/ws_polyfill.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/websocket.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/http.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/session.js" $OUT_FILE

sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/copyright.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/messages.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/util.js" $OUT_FILE
sed -i "/__extra_libraries__/r $JAVSCRIPT_DIR/logger.js" $OUT_FILE

sed -i "/__extra_libraries__/r $WISP_CLIENT/polyfill.js" $OUT_FILE
sed -i "/__extra_libraries__/r $WISP_CLIENT/wisp.js" $OUT_FILE


#apply patches
python3 tools/patch_js.py $FRAGMENTS_DIR $OUT_FILE

#generate es6 module
cp $OUT_FILE $ES6_FILE
sed -i 's/const libcurl = /export const libcurl = /' $ES6_FILE