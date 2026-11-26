#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "cjson/cJSON.h"
#include "curl/curl.h"
#include <stdio.h>
#include "openssl/ssl.h"
#include "openssl/x509.h"

#include "types.h"
#include "util.h"

//vssh fork: a sessão TLS de um pedido que lê o certificado, guardada no RequestInfo. O curl chama esta
//função com a conexão pronta e antes de mandar o pedido, e é o único momento garantido em que ela
//ainda está presa ao pedido: uma resposta pequena termina antes de o JS ler os cabeçalhos, e aí o
//CURLINFO_TLS_SSL_PTR já não tem sessão. A conferência repete a do curl com o BoringSSL: as raízes do
//CA bundle, a cadeia que o servidor mandou e o nome do host (ou o IP). O resultado sai nas marcas
//MBEDTLS_X509_BADCERT_* que o transporte e o shell já leem: 0x01 expirado, 0x02 revogado, 0x04 nome
//que não casa, 0x08 sem raiz confiável, 0x200 ainda não válido.
static unsigned int marcas_do_x509(int erro) {
  switch (erro) {
    case X509_V_OK: return 0;
    case X509_V_ERR_CERT_HAS_EXPIRED: return 0x01;
    case X509_V_ERR_CERT_NOT_YET_VALID: return 0x200;
    case X509_V_ERR_CERT_REVOKED: return 0x02;
    case X509_V_ERR_HOSTNAME_MISMATCH:
    case X509_V_ERR_IP_ADDRESS_MISMATCH: return 0x04;
    default: return 0x08;
  }
}

//O nome da cifra na forma do mbedTLS, que o shell converte para a do Chrome:
//TLS_AES_128_GCM_SHA256 vira TLS1-3-AES-128-GCM-SHA256, e
//TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 vira TLS-ECDHE-RSA-WITH-AES-128-GCM-SHA256.
static void nome_da_cifra(const char* padrao, int tls13, char* saida, size_t tamanho) {
  const char* resto = strncmp(padrao, "TLS_", 4) == 0 ? padrao + 4 : padrao;
  snprintf(saida, tamanho, "%s%s", tls13 ? "TLS1-3-" : "TLS-", resto);
  for (char* c = saida; *c; c++) if (*c == '_') *c = '-';
}

static int certinfo_prereq(void* clientp, char* primary_ip, char* local_ip, int primary_port, int local_port) {
  CURL* http_handle = (CURL*) clientp;
  struct RequestInfo* request_info = get_request_info(http_handle);
  const struct curl_tlssessioninfo* tls_info = NULL;
  curl_easy_getinfo(http_handle, CURLINFO_TLS_SSL_PTR, &tls_info);
  if (tls_info == NULL || tls_info->internals == NULL
      || (tls_info->backend != CURLSSLBACKEND_OPENSSL && tls_info->backend != CURLSSLBACKEND_BORINGSSL)) {
    return CURL_PREREQFUNC_OK;
  }
  SSL* ssl = (SSL*) tls_info->internals;
  request_info->tls_seen = 1;
  request_info->tls_version = SSL_get_version(ssl);
  const SSL_CIPHER* cifra = SSL_get_current_cipher(ssl);
  if (cifra != NULL) {
    nome_da_cifra(SSL_CIPHER_standard_name(cifra), SSL_version(ssl) == TLS1_3_VERSION,
      request_info->tls_cipher_buf, sizeof(request_info->tls_cipher_buf));
    request_info->tls_cipher = request_info->tls_cipher_buf;
  }
  request_info->tls_verify_flags = 0xffffffff;

  STACK_OF(X509)* cadeia = SSL_get_peer_cert_chain(ssl);
  X509* folha = cadeia != NULL && sk_X509_num(cadeia) > 0 ? sk_X509_value(cadeia, 0) : NULL;
  char* url = NULL;
  curl_easy_getinfo(http_handle, CURLINFO_EFFECTIVE_URL, &url);
  CURLU* url_handle = curl_url();
  char* host = NULL;
  if (folha != NULL && url != NULL && url_handle != NULL
      && curl_url_set(url_handle, CURLUPART_URL, url, 0) == CURLUE_OK
      && curl_url_get(url_handle, CURLUPART_HOST, &host, 0) == CURLUE_OK) {
    //um IPv6 vem entre colchetes, e a conferência o quer sem eles
    char* name = host;
    size_t name_len = strlen(name);
    if (name_len > 2 && name[0] == '[' && name[name_len - 1] == ']') {
      name[name_len - 1] = '\0';
      name++;
    }
    X509_STORE_CTX* ctx = X509_STORE_CTX_new();
    if (ctx != NULL && X509_STORE_CTX_init(ctx, get_ca_store(), folha, cadeia)) {
      X509_VERIFY_PARAM* param = X509_STORE_CTX_get0_param(ctx);
      X509_VERIFY_PARAM_set_purpose(param, X509_PURPOSE_SSL_SERVER);
      if (X509_VERIFY_PARAM_set1_ip_asc(param, name) != 1) {
        X509_VERIFY_PARAM_set1_host(param, name, strlen(name));
      }
      int ok = X509_verify_cert(ctx);
      request_info->tls_verify_flags = ok == 1 ? 0 : marcas_do_x509(X509_STORE_CTX_get_error(ctx));
    }
    X509_STORE_CTX_free(ctx);
  }
  curl_free(host);
  curl_url_cleanup(url_handle);
  return CURL_PREREQFUNC_OK;
}

void http_set_options(CURL* http_handle, const char* json_params, const char* body, int body_length) {
  struct RequestInfo *request_info = get_request_info(http_handle);

  //vssh fork: a conexão com a cara do navegador que a página diz ser. O curl-impersonate monta o
  //ClientHello (as cifras, o GREASE, as extensões permutadas, as curvas), os SETTINGS e a janela do
  //HTTP/2, a ordem dos pseudo-cabeçalhos e a ordem dos cabeçalhos. Com default_headers 0 ele não
  //acrescenta cabeçalho nenhum: os valores são os da página, e só a ordem é a do navegador. Um site
  //atrás da Cloudflare compara o user agent com essa impressão, e a diferença entre as duas é o
  //desafio que volta depois de resolvido. Vem antes dos padrões abaixo, porque o perfil também
  //escreve o Accept-Encoding e a versão HTTP, e os nossos valem sobre os dele.
  cJSON* request_json = cJSON_Parse(json_params);
  cJSON* perfil = cJSON_GetObjectItemCaseSensitive(request_json, "_vssh_impersonate");
  if (cJSON_IsString(perfil) && perfil->valuestring[0]) {
    //O curl_easy_impersonate aplica o perfil opção por opção e para na primeira que o build não
    //tem, deixando as seguintes de fora em silêncio. O aviso no console é o que separa "o perfil
    //está de pé" de "metade dele está".
    CURLcode r = curl_easy_impersonate(http_handle, perfil->valuestring, 0);
    if (r != CURLE_OK) {
      fprintf(stderr, "libcurl.js: o perfil %s não foi aplicado inteiro: %s\n", perfil->valuestring, curl_easy_strerror(r));
    }
  }
  //vssh fork: a ordem dos cabeçalhos deste pedido, que o transporte escolhe pelo tipo do pedido. O
  //perfil traz uma ordem só, a de uma navegação, e o Chrome escreve um fetch numa ordem diferente.
  cJSON* ordem = cJSON_GetObjectItemCaseSensitive(request_json, "_vssh_header_order");
  if (cJSON_IsString(ordem) && ordem->valuestring[0]) {
    curl_easy_setopt(http_handle, CURLOPT_HTTPHEADER_ORDER, ordem->valuestring);
  }

  //some default options
  curl_easy_setopt(http_handle, CURLOPT_FOLLOWLOCATION, 1);
  //vssh fork: as codificações que o wasm decodifica, na ordem em que o Chrome as anuncia. O "" do
  //upstream deixa o curl montar a lista numa ordem que nenhum navegador manda.
  curl_easy_setopt(http_handle, CURLOPT_ACCEPT_ENCODING, "gzip, deflate, br, zstd");
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
  cJSON* item = NULL;
  struct curl_slist* headers_list = NULL;

  cJSON_ArrayForEach(item, request_json) {
    char* key = item->string;

    //vssh fork: o teto da fase de conexão deste pedido, no lugar dos 15 s acima. O transporte o
    //sobe quando mede o link até a estação degradado: lá o handshake TLS passa por retransmissões,
    //e 15 s viram a página de erro de um site que só estava devagar.
    if (strcmp(key, "_vssh_connect_timeout_ms") == 0 && cJSON_IsNumber(item) && item->valuedouble > 0) {
      curl_easy_setopt(http_handle, CURLOPT_CONNECTTIMEOUT_MS, (long) item->valuedouble);
    }

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

  //vssh fork: os tempos do pedido até os cabeçalhos, em microssegundos desde o início dele, e se a
  //conexão foi reaproveitada. Numa conexão nova, `tls_us - connect_us` é o handshake TLS, que custa
  //uma ida e volta até o site mais o trecho do wisp; é a medida com que o transporte percebe o link
  //até a estação perdendo pacotes, no tráfego que já passa, sem sonda.
  curl_off_t t_connect = 0, t_tls = 0, t_ttfb = 0;
  long num_connects = 0;
  curl_easy_getinfo(http_handle, CURLINFO_CONNECT_TIME_T, &t_connect);
  curl_easy_getinfo(http_handle, CURLINFO_APPCONNECT_TIME_T, &t_tls);
  curl_easy_getinfo(http_handle, CURLINFO_STARTTRANSFER_TIME_T, &t_ttfb);
  curl_easy_getinfo(http_handle, CURLINFO_NUM_CONNECTS, &num_connects);
  cJSON* timing_item = cJSON_CreateObject();
  cJSON_AddItemToObject(timing_item, "connect_us", cJSON_CreateNumber((double) t_connect));
  cJSON_AddItemToObject(timing_item, "tls_us", cJSON_CreateNumber((double) t_tls));
  cJSON_AddItemToObject(timing_item, "ttfb_us", cJSON_CreateNumber((double) t_ttfb));
  cJSON_AddItemToObject(timing_item, "reused", cJSON_CreateBool(num_connects == 0));
  cJSON_AddItemToObject(response_json, "timing", timing_item);

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