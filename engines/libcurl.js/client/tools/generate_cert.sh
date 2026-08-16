#!/bin/bash

#export ca certs to a c header file

set -e
set -x

CURL_PREFIX="$(realpath build/curl-wasm)"
CACERT_FILE="$(realpath build/cacert.pem)"
CACERT_HEADER="$CURL_PREFIX/include/cacert.h"

CACERT_DIR="$(dirname "$CACERT_FILE")"
REPLACE_STR="$(echo "$CACERT_DIR" | tr '/-' '_')"

if [ ! -f "$CACERT_FILE" ]; then
  wget "https://curl.se/ca/cacert.pem" -O "$CACERT_FILE"
fi

#vssh fork: o cabeçalho tem que ser regerado por conta própria, não como efeito colateral do
#download. Ele mora em build/curl-wasm/include/, e tools/curl.sh faz `rm -rf` nesse prefixo toda vez
#que recompila o curl — então rebuildar o curl com o cacert.pem já baixado apagava o cacert.h e a
#condição acima pulava a regeração, quebrando o build seguinte com "cacert.h: No such file".
if [ ! -f "$CACERT_HEADER" ]; then
  python3 tools/gen_cert.py "$CACERT_FILE" > "$CACERT_HEADER"
fi
