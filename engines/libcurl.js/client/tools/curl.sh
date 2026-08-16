#!/bin/bash

#compile openssl for use with emscripten

set -x
set -e

CORE_COUNT=$(nproc --all)
PREFIX=$(realpath build/curl-wasm)
MBEDTLS_PREFIX=$(realpath build/mbedtls-wasm)
ZLIB_PREFIX=$(realpath build/zlib-wasm)
BROTLI_PREFIX=$(realpath build/brotli-wasm)
NGHTTP2_PREFIX=$(realpath build/nghttp2-wasm)

cd build
rm -rf curl
git clone -b 8.17.0-patched --depth=1 https://github.com/ading2210/curl
cd curl

#emscripten does not support the pipe2 syscall
sed -i '/pipe2/d' configure.ac

autoreconf -fi
#--without-ca-bundle/--without-ca-path: sem isso o configure procura um bundle de CA NA MÁQUINA QUE
#ESTÁ COMPILANDO e grava o caminho encontrado dentro do wasm (CURL_CA_BUNDLE/CURL_CA_PATH em
#curl_config.h). O binário passa a nascer com /etc/ssl/certs embutido — um caminho que não existe
#dentro do WASM. O CAINFO_BLOB anula o CAfile mas não o CApath, então o mbedtls tenta ler o
#diretório, falha, e devolve erro 77 em TODO handshake TLS. Efeito colateral perverso: o artefato
#fica dependendo de o build ter ou não `ca-certificates` instalado, então builda "bom" no CI de
#ontem e "quebrado" no de hoje sem uma linha de código ter mudado.
emconfigure ./configure --host i686-linux \
  --without-ca-bundle --without-ca-path \
  --disable-shared --disable-threaded-resolver --without-libpsl \
  --disable-netrc --disable-ipv6 --disable-tftp --disable-ntlm-wb \
  --enable-websockets --disable-ftp --disable-file --disable-gopher \
  --disable-imap --disable-mqtt --disable-pop3 --disable-rtsp \
  --disable-smb --disable-smtp --disable-telnet --disable-dict \
  --with-mbedtls=$MBEDTLS_PREFIX --with-zlib=$ZLIB_PREFIX \
  --with-brotli=$BROTLI_PREFIX --with-nghttp2=$NGHTTP2_PREFIX

emmake make -j$CORE_COUNT CFLAGS="-O3" LIBS="-lbrotlicommon"

rm -rf $PREFIX
mkdir -p $PREFIX/include
mkdir -p $PREFIX/lib
cp -r include/curl $PREFIX/include
cp lib/.libs/libcurl.a $PREFIX/lib

cd ../../