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

# vssh fork: o curl é o tarball de release, conferido pelo sha256, com os dois patches de
# `tools/patches/curl/` por cima (o CURLOPT_IGNORE_ONION e o typecheck desligado no emscripten). O
# tarball traz a versão de release no curlver.h; um clone da tag diria "-DEV". Subir de versão é
# trocar as duas linhas abaixo e reaplicar os patches.
CURL_VERSION="8.22.0"
CURL_SHA256="f7ef3ae8a22e521f289803fe93543eb64c329b58aa73a9e224dfd915a2a5f4f7"
PATCHES=$(realpath tools/patches/curl)

cd build
rm -rf curl "curl-$CURL_VERSION" "curl-$CURL_VERSION.tar.xz"
wget -q "https://curl.se/download/curl-$CURL_VERSION.tar.xz"
echo "$CURL_SHA256  curl-$CURL_VERSION.tar.xz" | sha256sum -c -
tar xf "curl-$CURL_VERSION.tar.xz"
rm "curl-$CURL_VERSION.tar.xz"
mv "curl-$CURL_VERSION" curl
cd curl
for p in "$PATCHES"/*.patch; do
  patch -p1 < "$p"
done

# O emscripten não tem a syscall pipe2. O cache do autoconf (`ac_cv_func_pipe2=no`, no configure
# abaixo) a dá como ausente sem editar o configure.ac, e o tarball de release já traz o configure
# gerado, então não há autoreconf.
#--without-ca-bundle/--without-ca-path: sem isso o configure procura um bundle de CA NA MÁQUINA QUE
#ESTÁ COMPILANDO e grava o caminho encontrado dentro do wasm (CURL_CA_BUNDLE/CURL_CA_PATH em
#curl_config.h). O binário passa a nascer com /etc/ssl/certs embutido — um caminho que não existe
#dentro do WASM. O CAINFO_BLOB anula o CAfile mas não o CApath, então o mbedtls tenta ler o
#diretório, falha, e devolve erro 77 em TODO handshake TLS. Efeito colateral perverso: o artefato
#fica dependendo de o build ter ou não `ca-certificates` instalado, então builda "bom" no CI de
#ontem e "quebrado" no de hoje sem uma linha de código ter mudado.
emconfigure ./configure --host i686-linux ac_cv_func_pipe2=no \
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