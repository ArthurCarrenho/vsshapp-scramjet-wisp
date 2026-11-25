#!/bin/bash

#fetch the curl-impersonate patches (lexiforest/curl-impersonate, MIT)

# vssh fork: o curl-impersonate é a fonte dos patches que dão ao curl e ao BoringSSL a impressão de
# um navegador: o ClientHello, os SETTINGS do HTTP/2, a ordem dos cabeçalhos. O clone fica fixo num
# commit, e o curl e o BoringSSL que os patches pedem estão fixados em tools/curl.sh e em
# tools/boringssl.sh. Subir o curl-impersonate é trocar o commit abaixo e conferir nos dois scripts
# a versão do curl e o commit do BoringSSL que o Makefile dele cita.

set -x
set -e

COMMIT="4fd3c5b995a841c537380ac79f8853daa870037b"

cd build
rm -rf curl-impersonate
git init -q curl-impersonate
cd curl-impersonate
git fetch -q --depth=1 https://github.com/lexiforest/curl-impersonate "$COMMIT"
git checkout -q FETCH_HEAD

cd ../../
