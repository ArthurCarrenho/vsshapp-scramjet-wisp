#!/bin/bash

#compile zstd for use with emscripten

# vssh fork: o Chrome anuncia "gzip, deflate, br, zstd", e o perfil do curl-impersonate também. Sem
# o zstd no wasm o motor teria de anunciar uma lista que nenhum Chrome manda, ou anunciar uma
# codificação que não sabe abrir.

set -x
set -e

PREFIX=$(realpath build/zstd-wasm)

cd build
rm -rf zstd
git clone -b v1.5.7 --depth=1 https://github.com/facebook/zstd
cd zstd/lib

emmake make -j$(nproc --all) libzstd.a CFLAGS="-O3" ZSTD_LIB_COMPRESSION=0 ZSTD_LIB_DICTBUILDER=0 ZSTD_LEGACY_SUPPORT=0

rm -rf $PREFIX
mkdir -p $PREFIX/lib $PREFIX/include
cp libzstd.a $PREFIX/lib
cp zstd.h zstd_errors.h zdict.h $PREFIX/include

cd ../../../
