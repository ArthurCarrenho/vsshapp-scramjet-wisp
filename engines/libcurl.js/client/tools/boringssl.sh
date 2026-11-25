#!/bin/bash

#compile boringssl for use with emscripten

# vssh fork: o TLS do curl é o BoringSSL, com o patch do curl-impersonate, porque é a biblioteca do
# Chrome. As extensões que o Chrome manda (o GREASE, o ALPS, a compressão de certificado, o ECH de
# fachada, a permutação da ordem) existem nela, e o mbedTLS não tem nenhuma. O commit é o que o
# curl-impersonate fixado em tools/curl-impersonate.sh pede. OPENSSL_NO_ASM porque o wasm não tem
# o assembly de nenhuma arquitetura.

set -x
set -e

PREFIX=$(realpath build/boringssl-wasm)
COMMIT="156c7b75ae9b8c3b3f847acf264f17594c3859fb"
PATCH=$(realpath build/curl-impersonate/patches/boringssl.patch)

cd build
rm -rf boringssl
git init -q boringssl
cd boringssl
git fetch -q --depth=1 https://boringssl.googlesource.com/boringssl "$COMMIT"
git checkout -q FETCH_HEAD
patch -p1 < "$PATCH"

emcmake cmake -G Ninja -B out -DOPENSSL_NO_ASM=ON -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF \
  -DCMAKE_C_FLAGS="-O3" -DCMAKE_CXX_FLAGS="-O3"
cmake --build out --target ssl crypto

rm -rf $PREFIX
mkdir -p $PREFIX/lib
cp -r include $PREFIX/include
cp out/libssl.a out/libcrypto.a $PREFIX/lib

cd ../../
