#include <stdlib.h>

#include "curl/multi.h"
#include "curl/curl.h"

#include "types.h"
#include "request.h"
#include "util.h"

struct SessionInfo* session_create() {
  struct SessionInfo *session = malloc(sizeof(struct SessionInfo));
  session->multi_handle = curl_multi_init();
  session->request_active = 0;
  return session;
}

void session_perform(struct SessionInfo *session) {
  CURLMcode mc;
  session->request_active = 0;
  mc = curl_multi_perform(session->multi_handle, &session->request_active);

  //vssh fork: drain the whole info-read queue each tick instead of reading a single
  //message. curl_multi_info_read returns one message per call and must be looped until
  //NULL — if two requests finish in the same tick, the original code only fired
  //finish_request() for the first, leaving the second pending until the next setInterval
  //tick.
  int msgq = 0;
  struct CURLMsg *curl_msg;
  while ((curl_msg = curl_multi_info_read(session->multi_handle, &msgq))) {
    if (curl_msg->msg == CURLMSG_DONE) {
      finish_request(curl_msg);
    }
  }
}

void session_set_options(struct SessionInfo *session, int connections_limit, int cache_limit, int host_conn_limit) {
  curl_multi_setopt(session->multi_handle, CURLMOPT_MAX_TOTAL_CONNECTIONS, connections_limit);
  curl_multi_setopt(session->multi_handle, CURLMOPT_MAXCONNECTS, cache_limit);
  curl_multi_setopt(session->multi_handle, CURLMOPT_MAX_HOST_CONNECTIONS, host_conn_limit);

  //vssh fork: fixa a multiplexação em vez de herdar o default. Medido: esta linha sozinha NÃO muda
  //nada — CURLPIPE_MULTIPLEX já é o default do curl desde a 7.62, e um build só com ela continuava
  //abrindo uma conexão por requisição. Quem destrava a multiplexação é o CURLOPT_PIPEWAIT do
  //http.c; é lá que está a medição.
  //
  //Ela fica porque o valor é consequente demais para depender de um default: os três limites acima
  //só fazem sentido sob a premissa de que h2 multiplexa, e se um curl futuro mudar o default a
  //regressão apareceria como "a navegação ficou lenta", sem nada no código apontando para cá.
  curl_multi_setopt(session->multi_handle, CURLMOPT_PIPELINING, CURLPIPE_MULTIPLEX);
}

void session_add_request(struct SessionInfo *session, CURL* http_handle) {
  curl_multi_add_handle(session->multi_handle, http_handle);
}

int session_get_active(struct SessionInfo *session) {
  return session->request_active;
}

void session_remove_request(struct SessionInfo *session, CURL* http_handle) {
  curl_multi_remove_handle(session->multi_handle, http_handle);
}

void session_cleanup(struct SessionInfo *session) {
  curl_multi_cleanup(session->multi_handle);
  free(session);
}