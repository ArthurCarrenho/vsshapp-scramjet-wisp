#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "cjson/cJSON.h"
#include "curl/curl.h"
#include "mbedtls/ssl.h"

#include "types.h"
#include "util.h"

//vssh fork: a sessão TLS de um pedido que lê o certificado, guardada no RequestInfo. O curl chama esta
//função com a conexão pronta e antes de mandar o pedido, e é o único momento garantido em que ela
//ainda está presa ao pedido: uma resposta pequena termina antes de o JS ler os cabeçalhos, e aí o
//CURLINFO_TLS_SSL_PTR já não tem sessão. A conferência é a do curl: o perfil `next` do mbedtls (o
//que o curl configura), as raízes do CA bundle e o nome do host, que o mbedtls casa com os nomes
//alternativos e os IPs.
static int certinfo_prereq(void* clientp, char* primary_ip, char* local_ip, int primary_port, int local_port) {
  CURL* http_handle = (CURL*) clientp;
  struct RequestInfo* request_info = get_request_info(http_handle);
  const struct curl_tlssessioninfo* tls_info = NULL;
  curl_easy_getinfo(http_handle, CURLINFO_TLS_SSL_PTR, &tls_info);
  if (tls_info == NULL || tls_info->backend != CURLSSLBACKEND_MBEDTLS || tls_info->internals == NULL) {
    return CURL_PREREQFUNC_OK;
  }
  const mbedtls_ssl_context* ssl = (const mbedtls_ssl_context*) tls_info->internals;
  request_info->tls_seen = 1;
  request_info->tls_version = mbedtls_ssl_get_version(ssl);
  request_info->tls_cipher = mbedtls_ssl_get_ciphersuite(ssl);
  request_info->tls_verify_flags = 0xffffffff;

  const mbedtls_x509_crt* peer = mbedtls_ssl_get_peer_cert(ssl);
  char* url = NULL;
  curl_easy_getinfo(http_handle, CURLINFO_EFFECTIVE_URL, &url);
  CURLU* url_handle = curl_url();
  char* host = NULL;
  if (peer != NULL && url != NULL && url_handle != NULL
      && curl_url_set(url_handle, CURLUPART_URL, url, 0) == CURLUE_OK
      && curl_url_get(url_handle, CURLUPART_HOST, &host, 0) == CURLUE_OK) {
    //um IPv6 vem entre colchetes, e o mbedtls o quer sem eles
    char* name = host;
    size_t name_len = strlen(name);
    if (name_len > 2 && name[0] == '[' && name[name_len - 1] == ']') {
      name[name_len - 1] = '\0';
      name++;
    }
    uint32_t flags = 0;
    mbedtls_x509_crt_verify_with_profile((mbedtls_x509_crt*) peer, (mbedtls_x509_crt*) get_ca_chain(),
      NULL, &mbedtls_x509_crt_profile_next, name, &flags, NULL, NULL);
    request_info->tls_verify_flags = flags;
  }
  curl_free(host);
  curl_url_cleanup(url_handle);
  return CURL_PREREQFUNC_OK;
}

void http_set_options(CURL* http_handle, const char* json_params, const char* body, int body_length) {
  struct RequestInfo *request_info = get_request_info(http_handle);

  //some default options
  curl_easy_setopt(http_handle, CURLOPT_FOLLOWLOCATION, 1);
  //vssh fork: as codificações que o wasm decodifica, na ordem em que o Chrome as anuncia. O "" do
  //upstream deixa o curl montar a lista, que sai como "deflate, gzip, br", uma ordem que nenhum
  //navegador manda. O zstd do Chrome fica de fora porque o wasm não o decodifica.
  curl_easy_setopt(http_handle, CURLOPT_ACCEPT_ENCODING, "gzip, deflate, br");
  //vssh fork: CURL_HTTP_VERSION_2TLS (h2 for HTTPS, HTTP/1.1 for cleartext) instead of
  //CURL_HTTP_VERSION_2_0. Forcing 2_0 on http:// makes curl attempt an h2c upgrade
  //(Upgrade: h2c header). Node http servers (e.g. Vite/Astro dev) route any request with an
  //Upgrade header to the 'upgrade' event (meant for WebSockets) instead of 'request', and hang
  //forever when the handler doesn't speak h2c — the exact symptom we saw against a dev server.
  curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2TLS);
  //vssh fork: esta é a linha que faz a multiplexação HTTP/2 acontecer de verdade. Sem ela, ligar h2
  //acima quase não muda nada: quando várias transferências para o MESMO host entram no multi handle
  //de uma vez, o curl ainda não sabe se aquele host fala h2 — a resposta vem no ALPN, depois do
  //handshake. Sem esperar por isso, ele resolve pelo caminho seguro e abre uma conexão nova para
  //cada uma, até o teto por host.
  //
  //Medido contando os `net.connect` do servidor wisp, 40 requisições ao mesmo host h2:
  //
  //                      conexões TCP      parede (por-host 4 / 16)
  //    sem PIPEWAIT         4 e 16          156ms / 299ms
  //    com PIPEWAIT         1 e  1          173ms / 140ms
  //
  //Aquecer a conexão antes do lote não mudava o número sem PIPEWAIT, o que descarta "é só a
  //primeira requisição". Repare no segundo efeito: com multiplexação o teto por host deixa de
  //governar (4 e 16 empatam), enquanto sem ela subir o teto quase dobra a parede — cada slot vira
  //um handshake TLS a mais, feito em software na thread única do WASM.
  //
  //Contra host que só fala HTTP/1.1 o custo é uma espera curta na primeira leva; depois o curl marca
  //a conexão como não-multiplexável e volta a abrir em paralelo normalmente.
  curl_easy_setopt(http_handle, CURLOPT_PIPEWAIT, 1L);
  curl_easy_setopt(http_handle, CURLOPT_IGNORE_ONION, 1L);
  //vssh fork: o teto da fase de conexão (o CONNECT do wisp, o TCP do lado do servidor e o
  //handshake TLS). Sem ele o curl espera 300 s, e quem desiste antes é o service worker do motor,
  //aos 90 s, com a página de lacuna. Com ele a conexão que não sobe vira o erro 28 em 15 s, que a
  //recuperação do motor já sabe tratar. Uma resposta lenta depois de conectada não conta: o teto
  //vale só até o primeiro byte poder ser pedido, e um long-polling continua de pé.
  curl_easy_setopt(http_handle, CURLOPT_CONNECTTIMEOUT_MS, 15000L);

  //parse json options
  cJSON* request_json = cJSON_Parse(json_params);
  cJSON* item = NULL;
  struct curl_slist* headers_list = NULL;

  cJSON_ArrayForEach(item, request_json) {
    char* key = item->string;

    if (strcmp(key, "_libcurl_verbose") == 0) {
      curl_easy_setopt(http_handle, CURLOPT_VERBOSE, 1L);
    }

    if (strcmp(key, "_libcurl_http_version") == 0) {
      if (!cJSON_IsNumber(item)) continue;
      if (item->valuedouble == 1.0) {
        curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_0);
      }
      else if (item->valuedouble == 1.1) {
        curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_1_1);
      }
      else if (item->valuedouble == 2.0) {
        curl_easy_setopt(http_handle, CURLOPT_HTTP_VERSION, CURL_HTTP_VERSION_2_0);
      }
    }

    //vssh fork: HEAD vai por CURLOPT_NOBODY. Pelo CUSTOMREQUEST o curl manda HEAD e espera o corpo
    //que os cabeçalhos anunciam (um Content-Length, um chunked), que nunca vem, e o pedido falha com
    //o erro 56 quando o servidor fecha a conexão.
    if (strcmp(key, "method") == 0 && cJSON_IsString(item)) {
      if (strcmp(item->valuestring, "HEAD") == 0) {
        curl_easy_setopt(http_handle, CURLOPT_NOBODY, 1L);
      }
      else {
        curl_easy_setopt(http_handle, CURLOPT_CUSTOMREQUEST, item->valuestring);
      }
    }
    
    if (strcmp(key, "headers") == 0 && cJSON_IsObject(item)) {
      cJSON* header = NULL;

      cJSON_ArrayForEach(header, item) {
        if (!cJSON_IsString(header)) continue;
        int header_length = strlen(header->string) + strlen(header->valuestring) + 2;
        char* header_str = malloc(header_length+1);
        header_str[header_length] = 0;

        sprintf(header_str, "%s: %s", header->string, header->valuestring);
        headers_list = curl_slist_append(headers_list, header_str);
        free(header_str);
      }

      curl_easy_setopt(http_handle, CURLOPT_HTTPHEADER, headers_list);
    }

    if (strcmp(key, "redirect") == 0 && cJSON_IsString(item)) {
      if (strcmp(item->valuestring, "error") == 0 || strcmp(item->valuestring, "manual") == 0) {
        curl_easy_setopt(http_handle, CURLOPT_FOLLOWLOCATION, 0);
      }
    }

    //vssh fork: allow skipping TLS peer/host verification (self-signed certs on
    //internal/dev servers). Opt-in per session via the "insecure" option on HTTPSession.
    if (strcmp(key, "insecure") == 0 && cJSON_IsTrue(item)) {
      curl_easy_setopt(http_handle, CURLOPT_SSL_VERIFYPEER, 0L);
      curl_easy_setopt(http_handle, CURLOPT_SSL_VERIFYHOST, 0L);
    }

    //vssh fork: o pedido que lê o certificado de um site. O curl só preenche a cadeia durante a
    //troca de certificados do handshake: uma conexão do pool e uma sessão TLS retomada chegam sem
    //ela, por isso a conexão é nova e o cache de sessão fica de fora. A verificação também fica de
    //fora, para a cadeia chegar mesmo quando o servidor seria recusado; quem a confere é o
    //http_get_info, contra as mesmas raízes, e devolve as marcas do mbedtls em "tls".
    if (strcmp(key, "_vssh_certinfo") == 0 && cJSON_IsTrue(item)) {
      curl_easy_setopt(http_handle, CURLOPT_CERTINFO, 1L);
      curl_easy_setopt(http_handle, CURLOPT_FRESH_CONNECT, 1L);
      curl_easy_setopt(http_handle, CURLOPT_SSL_SESSIONID_CACHE, 0L);
      curl_easy_setopt(http_handle, CURLOPT_SSL_VERIFYPEER, 0L);
      curl_easy_setopt(http_handle, CURLOPT_SSL_VERIFYHOST, 0L);
      curl_easy_setopt(http_handle, CURLOPT_PREREQFUNCTION, certinfo_prereq);
      curl_easy_setopt(http_handle, CURLOPT_PREREQDATA, http_handle);
    }
  }
  cJSON_Delete(request_json);

  //add post data if specified
  if (body != NULL) {
    curl_easy_setopt(http_handle, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(http_handle, CURLOPT_POSTFIELDSIZE, body_length);
  }

  request_info->headers_list = headers_list;
}

void http_set_cookie_jar(CURL* http_handle, const char* filename) {
  curl_easy_setopt(http_handle, CURLOPT_COOKIEFILE, filename);
  curl_easy_setopt(http_handle, CURLOPT_COOKIEJAR, filename);
}

char* http_get_info(CURL* http_handle) {
  struct RequestInfo *request_info = get_request_info(http_handle);

  //create new json object with response info
  cJSON* response_json = cJSON_CreateObject();

  long response_code;
  curl_easy_getinfo(http_handle, CURLINFO_RESPONSE_CODE, &response_code);
  cJSON* status_item = cJSON_CreateNumber(response_code);
  cJSON_AddItemToObject(response_json, "status", status_item);

  char* response_url;
  curl_easy_getinfo(http_handle, CURLINFO_EFFECTIVE_URL, &response_url);
  cJSON* url_item = cJSON_CreateString(response_url);
  cJSON_AddItemToObject(response_json, "url", url_item);

  cJSON* headers_item = cJSON_CreateArray();
  struct curl_header *prev_header = NULL;
  struct curl_header *header = NULL;
  while ((header = curl_easy_nextheader(http_handle, CURLH_HEADER, -1, prev_header))) {
    cJSON* header_key_entry = cJSON_CreateString(header->name);
    cJSON* header_value_entry = cJSON_CreateString(header->value);
    cJSON* header_pair_item = cJSON_CreateArray();
    cJSON_AddItemToArray(header_pair_item, header_key_entry);
    cJSON_AddItemToArray(header_pair_item, header_value_entry);
    cJSON_AddItemToArray(headers_item, header_pair_item);
    prev_header = header;
  }
  cJSON_AddItemToObject(response_json, "headers", headers_item);

  long redirect_count;
  curl_easy_getinfo(http_handle, CURLINFO_REDIRECT_COUNT, &redirect_count);
  cJSON* redirects_item = cJSON_CreateBool(redirect_count > 0);
  cJSON_AddItemToObject(response_json, "redirected", redirects_item);

  //vssh fork: a cadeia que o servidor mandou, em PEM, da folha à raiz, e a sessão TLS. Só um pedido
  //com "_vssh_certinfo" tem cadeia; os outros saem sem os dois campos, e o JSON de todo pedido
  //continua do tamanho de antes.
  struct curl_certinfo* certinfo = NULL;
  curl_easy_getinfo(http_handle, CURLINFO_CERTINFO, &certinfo);
  if (certinfo != NULL && certinfo->num_of_certs > 0) {
    cJSON* certs_item = cJSON_CreateArray();
    for (int i = 0; i < certinfo->num_of_certs; i++) {
      for (struct curl_slist* slist = certinfo->certinfo[i]; slist; slist = slist->next) {
        if (strncmp(slist->data, "Cert:", 5) == 0) {
          cJSON_AddItemToArray(certs_item, cJSON_CreateString(slist->data + 5));
          break;
        }
      }
    }
    cJSON_AddItemToObject(response_json, "certinfo", certs_item);

    cJSON* tls_item = cJSON_CreateObject();
    if (request_info->tls_seen) {
      if (request_info->tls_version) cJSON_AddItemToObject(tls_item, "version", cJSON_CreateString(request_info->tls_version));
      if (request_info->tls_cipher) cJSON_AddItemToObject(tls_item, "cipher", cJSON_CreateString(request_info->tls_cipher));
      if (request_info->tls_verify_flags != 0xffffffff)
        cJSON_AddItemToObject(tls_item, "verify_flags", cJSON_CreateNumber(request_info->tls_verify_flags));
    }
    cJSON_AddItemToObject(response_json, "tls", tls_item);
  }

  char* response_json_str = cJSON_Print(response_json);
  cJSON_Delete(response_json);

  return response_json_str;
}

//the address sanitizer falsely flags any malloc operation as a memory leak
const char* __asan_default_options() { return "detect_leaks=false"; }