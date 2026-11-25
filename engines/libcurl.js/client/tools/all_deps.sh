#!/bin/bash

#build all deps

set -e
mkdir -p build

IMPERSONATE_DIR=$(realpath build/curl-impersonate)
BORINGSSL_PREFIX=$(realpath build/boringssl-wasm)
ZSTD_PREFIX=$(realpath build/zstd-wasm)
CJSON_PREFIX=$(realpath build/cjson-wasm)
CURL_PREFIX=$(realpath build/curl-wasm)
ZLIB_PREFIX=$(realpath build/zlib-wasm)
BROTLI_PREFIX=$(realpath build/brotli-wasm)
NGHTTP2_PREFIX=$(realpath build/nghttp2-wasm)

if [ ! -d $IMPERSONATE_DIR ]; then
  tools/curl-impersonate.sh
fi
if [ ! -d $BORINGSSL_PREFIX ]; then
  tools/boringssl.sh
fi
if [ ! -d $ZSTD_PREFIX ]; then
  tools/zstd.sh
fi
if [ ! -d $CJSON_PREFIX ]; then
  tools/cjson.sh
fi
if [ ! -d $ZLIB_PREFIX ]; then
  tools/zlib.sh
fi
if [ ! -d $BROTLI_PREFIX ]; then
  tools/brotli.sh
fi
if [ ! -d $NGHTTP2_PREFIX ]; then
  tools/nghttp2.sh
fi
if [ ! -d $CURL_PREFIX ]; then
  tools/curl.sh
fi

cp -r $BORINGSSL_PREFIX/* $CURL_PREFIX
cp -r $ZSTD_PREFIX/* $CURL_PREFIX
cp -r $CJSON_PREFIX/* $CURL_PREFIX
cp -r $ZLIB_PREFIX/* $CURL_PREFIX
cp -r $BROTLI_PREFIX/* $CURL_PREFIX
cp -r $NGHTTP2_PREFIX/* $CURL_PREFIX