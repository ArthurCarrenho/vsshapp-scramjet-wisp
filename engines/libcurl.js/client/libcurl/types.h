#include "curl/curl.h"

typedef void(*DataCallback)(int request_id, char* chunk_ptr, int chunk_size);
typedef void(*EndCallback)(int request_id, int error);

struct RequestInfo {
  CURL* http_handle;
  struct CURLMsg *curl_msg;
  struct curl_slist* headers_list;
  int request_id;
  DataCallback data_callback;
  DataCallback headers_callback;
  EndCallback end_callback;
  //vssh fork: a sessão TLS de um pedido com "_vssh_certinfo", lida pelo certinfo_prereq
  int tls_seen;
  unsigned int tls_verify_flags;
  const char* tls_version;
  const char* tls_cipher;
  //vssh fork: a frase do curl sobre a falha do pedido (CURLOPT_ERRORBUFFER), que diz a fase em que
  //ele parou ("Failed to connect ... after 15002 ms", "SSL connection timeout") e o código só nomeia
  char error_buffer[CURL_ERROR_SIZE];
};

struct WSResult {
  int res;
  int buffer_size;
  int closed;
  int bytes_left;
  int is_text;
  char* buffer;
};

struct SessionInfo {
  CURLM* multi_handle;
  int request_active;
};