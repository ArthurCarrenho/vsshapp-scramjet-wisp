#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <emscripten.h>

#include "curl/curl.h"
#include "curl/easy.h"
#include "curl/multi.h"

#include "util.h"
#include "types.h"

void finish_request(CURLMsg *curl_msg);
void forward_headers(struct RequestInfo *request_info);

extern struct curl_blob cacert_blob;

size_t write_function(char *data, size_t size, size_t nmemb, struct RequestInfo *request_info) {
  size_t real_size = size * nmemb;
  (*request_info->data_callback)(request_info->request_id, data, real_size);
  return real_size;
}

size_t header_function(char *data, size_t size, size_t nmemb, struct RequestInfo *request_info) {
  size_t real_size = size * nmemb;
  (*request_info->headers_callback)(request_info->request_id, data, real_size);
  return real_size;
}

CURL* create_request(const char* url, int request_id, DataCallback data_callback, EndCallback end_callback, DataCallback headers_callback) {
  CURL *http_handle = curl_easy_init();  

  //create request metadata struct
  struct RequestInfo *request_info = malloc(sizeof(struct RequestInfo));
  request_info->http_handle = http_handle;
  request_info->curl_msg = NULL;
  request_info->headers_list = NULL;
  request_info->request_id = request_id;
  request_info->end_callback = end_callback;
  request_info->data_callback = data_callback;
  request_info->headers_callback = headers_callback;

  curl_easy_setopt(http_handle, CURLOPT_PRIVATE, request_info);
  curl_easy_setopt(http_handle, CURLOPT_URL, url);
  curl_easy_setopt(http_handle, CURLOPT_CAINFO_BLOB, cacert_blob);

  //vssh fork: dentro do WASM não existe sistema de arquivos do host, então qualquer caminho de CA
  //que o `configure` tenha gravado no binário só pode falhar. E falha caro: em `mbed_connect_step1`
  //o CAINFO_BLOB anula o CAfile ("CURLOPT_CAINFO_BLOB overrides CURLOPT_CAINFO"), mas NÃO anula o
  //CApath — o bloco do CApath roda em seguida, o `mbedtls_x509_crt_parse_path` não acha o diretório,
  //e com verifypeer ligado ele devolve CURLE_SSL_CACERT_BADFILE (77). Resultado: todo handshake TLS
  //falha, mesmo com o blob de certificados perfeito.
  //
  //A causa raiz está no build (ver tools/curl.sh, que agora passa --without-ca-bundle/--without-ca-path),
  //mas zerar aqui também torna o binário imune a como ele foi configurado: se alguém buildar numa
  //máquina com ca-certificates instalado, o wasm continua funcionando em vez de recusar todo HTTPS.
  curl_easy_setopt(http_handle, CURLOPT_CAINFO, NULL);
  curl_easy_setopt(http_handle, CURLOPT_CAPATH, NULL);

  curl_easy_setopt(http_handle, CURLOPT_BUFFERSIZE, 512*1024);

  //emscripten doesn't support tcp nodelay anyways
  curl_easy_setopt(http_handle, CURLOPT_TCP_NODELAY, 0L);

  //callbacks to pass the response data back to js
  curl_easy_setopt(http_handle, CURLOPT_WRITEFUNCTION, &write_function);
  curl_easy_setopt(http_handle, CURLOPT_WRITEDATA, request_info);

  //callback which runs on every response header
  curl_easy_setopt(http_handle, CURLOPT_HEADERFUNCTION, &header_function);
  curl_easy_setopt(http_handle, CURLOPT_HEADERDATA, request_info);
  
  return http_handle;
}

void request_cleanup(CURL* http_handle) {
  struct RequestInfo *request_info = get_request_info(http_handle);
  curl_easy_cleanup(http_handle);
  free(request_info);
}

void finish_request(CURLMsg *curl_msg) {
  CURL *http_handle = curl_msg->easy_handle;
  struct RequestInfo *request_info = get_request_info(http_handle);

  int error = (int) curl_msg->data.result;

  //clean up curl
  if (request_info->headers_list != NULL) {
    curl_slist_free_all(request_info->headers_list);
  }
  (*request_info->end_callback)(request_info->request_id, error);
}

void request_set_proxy(CURL* http_handle, const char* proxy_url) {
  curl_easy_setopt(http_handle, CURLOPT_PROXY, proxy_url);
}
