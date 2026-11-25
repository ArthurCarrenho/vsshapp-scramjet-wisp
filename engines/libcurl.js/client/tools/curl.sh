#!/bin/bash

#compile curl (with curl-impersonate) for use with emscripten

set -x
set -e

CORE_COUNT=$(nproc --all)
PREFIX=$(realpath build/curl-wasm)
BORINGSSL_PREFIX=$(realpath build/boringssl-wasm)
ZSTD_PREFIX=$(realpath build/zstd-wasm)
ZLIB_PREFIX=$(realpath build/zlib-wasm)
BROTLI_PREFIX=$(realpath build/brotli-wasm)
NGHTTP2_PREFIX=$(realpath build/nghttp2-wasm)

# vssh fork: o curl é a tag de release que o curl-impersonate fixado em tools/curl-impersonate.sh
# pede, com o patch dele por cima e depois os dois de `tools/patches/curl/` (o typecheck desligado no
# emscripten e o CURLOPT_IGNORE_ONION). O patch do curl-impersonate mexe no configure.ac, e por isso
# o configure sai do autoreconf, e não do tarball. Subir de versão é subir o curl-impersonate e
# reaplicar os dois patches daqui por cima do dele.
CURL_TAG="curl-8_23_0"
PATCHES=$(realpath tools/patches/curl)
IMPERSONATE_PATCH=$(realpath build/curl-impersonate/patches/curl.patch)

cd build
rm -rf curl
git clone -q -b "$CURL_TAG" --depth=1 https://github.com/curl/curl curl
cd curl
patch -p1 < "$IMPERSONATE_PATCH"
for p in "$PATCHES"/*.patch; do
  patch -p1 < "$p"
done
autoreconf -fi

# O emscripten não tem a syscall pipe2. O cache do autoconf (`ac_cv_func_pipe2=no`, no configure
# abaixo) a dá como ausente sem editar o configure.ac.
#--enable-ech: o perfil do Chrome no curl-impersonate liga o ECH de fachada (a extensão 65037), e
#sem o ECH compilado o curl_easy_impersonate para no CURLOPT_ECH e deixa de aplicar o GREASE e o
#codepoint novo do ALPS, que vêm depois dele.
#--without-ca-bundle/--without-ca-path: sem isso o configure procura um bundle de CA NA MÁQUINA QUE
#ESTÁ COMPILANDO e grava o caminho encontrado dentro do wasm (CURL_CA_BUNDLE/CURL_CA_PATH em
#curl_config.h). O binário passa a nascer com /etc/ssl/certs embutido — um caminho que não existe
#dentro do WASM. O CAINFO_BLOB anula o CAfile mas não o CApath, então o TLS tenta ler o
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
  --disable-ldap --disable-ldaps --without-libidn2 --enable-ech \
  --with-openssl=$BORINGSSL_PREFIX --with-zlib=$ZLIB_PREFIX --with-zstd=$ZSTD_PREFIX \
  --with-brotli=$BROTLI_PREFIX --with-nghttp2=$NGHTTP2_PREFIX

emmake make -j$CORE_COUNT CFLAGS="-O3" LIBS="-lbrotlicommon"

rm -rf $PREFIX
mkdir -p $PREFIX/include
mkdir -p $PREFIX/lib
cp -r include/curl $PREFIX/include
# O curl-impersonate chama a biblioteca de libcurl-impersonate; o build.sh liga com -lcurl.
cp lib/.libs/libcurl-impersonate.a $PREFIX/lib/libcurl.a

cd ../../