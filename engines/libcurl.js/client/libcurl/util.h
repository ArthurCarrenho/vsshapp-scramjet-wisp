#include "curl/curl.h"

int starts_with(const char *a, const char *b);

struct RequestInfo* get_request_info(CURL* http_handle);

#include "mbedtls/x509_crt.h"
const mbedtls_x509_crt* get_ca_chain();
