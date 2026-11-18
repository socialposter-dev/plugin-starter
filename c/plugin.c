/**
 * Reference SocialPoster WebAssembly plugin in C (clang + vendored extism-pdk.h).
 *
 * Compile with WASI SDK:
 *   /opt/wasi-sdk/bin/clang -O2 -mexec-model=reactor -o ../output/example-social-c.wasm plugin.c
 */

#define EXTISM_USE_LIBC
#define EXTISM_IMPLEMENTATION
#include "extism-pdk.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------------- */
/* Minimal JSON Helpers (zero external dependencies)                         */
/* ------------------------------------------------------------------------- */

/**
 * Extracts a string value for `"key": "value"` from a JSON buffer.
 * Writes up to `out_cap - 1` characters into `out` and returns true if found.
 */
static bool json_get_string(const char *json, const char *key, char *out,
                            size_t out_cap) {
  if (!json || !key || !out || out_cap == 0) {
    return false;
  }
  out[0] = '\0';

  char pattern[128];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);

  const char *pos = strstr(json, pattern);
  if (!pos) {
    return false;
  }
  pos += strlen(pattern);
  while (*pos == ' ' || *pos == '\t' || *pos == '\n' || *pos == '\r') {
    pos++;
  }
  if (*pos != ':') {
    return false;
  }
  pos++;
  while (*pos == ' ' || *pos == '\t' || *pos == '\n' || *pos == '\r') {
    pos++;
  }
  if (*pos != '"') {
    return false;
  }
  pos++;

  size_t i = 0;
  while (*pos && *pos != '"' && i + 1 < out_cap) {
    if (*pos == '\\' && *(pos + 1)) {
      pos++;
    }
    out[i++] = *pos++;
  }
  out[i] = '\0';
  return true;
}

static void resolve_base_url(const char *input, char *out, size_t out_cap) {
  if (json_get_string(input, "instance_url", out, out_cap) && out[0] != '\0') {
    size_t len = strlen(out);
    while (len > 0 && out[len - 1] == '/') {
      out[--len] = '\0';
    }
    if (len > 0) {
      return;
    }
  }
  snprintf(out, out_cap, "https://api.example.com");
}

/* ------------------------------------------------------------------------- */
/* Required SocialPoster ABI Exports                                         */
/* ------------------------------------------------------------------------- */

/**
 * Returns plugin metadata, capabilities, and credential field definitions.
 */
int32_t EXTISM_EXPORTED_FUNCTION(describe) {
  static const char *METADATA_JSON =
      "{"
      "\"id\":\"example-social\","
      "\"version\":\"1.0.0\","
      "\"display_name\":\"Example Social\","
      "\"brand_colour\":\"#5B4BFF\","
      "\"icon_svg\":\"<svg viewBox=\\\"0 0 24 24\\\" fill=\\\"none\\\"><circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"10\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"2\\\"/><path d=\\\"M8 12l3 3 5-6\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"2\\\" stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\"/></svg>\","
      "\"max_characters\":500,"
      "\"max_attachments\":4,"
      "\"supported_media_types\":[\"image/jpeg\",\"image/png\",\"image/webp\",\"video/mp4\"],"
      "\"supports_alt_text\":true,"
      "\"supports_threads\":true,"
      "\"supports_delete\":true,"
      "\"allowed_domains\":[\"api.example.com\",\"upload.example.com\"],"
      "\"credential_fields\":["
      "{\"key\":\"api_token\",\"label\":\"API Token\",\"secret\":true,\"required\":true},"
      "{\"key\":\"handle\",\"label\":\"Account Handle\",\"secret\":false,\"required\":true},"
      "{\"key\":\"instance_url\",\"label\":\"Instance URL\",\"secret\":false,\"required\":false},"
      "{\"key\":\"webhook_secret\",\"label\":\"Webhook Signing Secret\",\"secret\":true,\"required\":false}"
      "]"
      "}";

  extism_output_buf_from_sz(METADATA_JSON);
  return 0;
}

/**
 * Verifies user credentials against the target platform's authentication endpoint.
 */
int32_t EXTISM_EXPORTED_FUNCTION(validate_auth) {
  char *input = extism_load_input_sz_dup(NULL);
  if (!input) {
    extism_error_set_buf_from_sz("Failed to read input payload.");
    return 1;
  }

  char token[512];
  char handle[256];
  json_get_string(input, "api_token", token, sizeof(token));
  json_get_string(input, "handle", handle, sizeof(handle));

  if (token[0] == '\0' || handle[0] == '\0') {
    free(input);
    extism_output_buf_from_sz(
        "{\"valid\":false,\"error\":\"Both api_token and handle are required.\"}");
    return 0;
  }

  char base_url[512];
  resolve_base_url(input, base_url, sizeof(base_url));
  free(input);

  char req_json[1536];
  snprintf(req_json, sizeof(req_json),
           "{\"url\":\"%s/v1/accounts/verify_credentials\","
           "\"method\":\"GET\","
           "\"headers\":{\"Authorization\":\"Bearer %s\",\"Accept\":\"application/json\"}}",
           base_url, token);

  ExtismHandle req_h = extism_alloc_buf_from_sz(req_json);
  ExtismHandle res_h = extism_http_request(req_h, 0);
  int32_t status = extism_http_status_code();

  extism_free(req_h);
  if (res_h) {
    extism_free(res_h);
  }

  if (status >= 200 && status < 300) {
    extism_output_buf_from_sz("{\"valid\":true}");
  } else {
    char err_json[256];
    snprintf(err_json, sizeof(err_json),
             "{\"valid\":false,\"error\":\"Authorisation failed with HTTP status %d.\"}",
             status);
    extism_output_buf_from_sz(err_json);
  }
  return 0;
}

/**
 * Publishes a post (reading text, attachments with alt_text, and optional reply_to_id).
 */
int32_t EXTISM_EXPORTED_FUNCTION(publish) {
  char *input = extism_load_input_sz_dup(NULL);
  if (!input) {
    extism_error_set_buf_from_sz("Failed to read input payload.");
    return 1;
  }

  char token[512];
  if (!json_get_string(input, "api_token", token, sizeof(token)) ||
      token[0] == '\0') {
    free(input);
    extism_error_set_buf_from_sz("Missing required credential: api_token");
    return 1;
  }

  char base_url[512];
  char text[1024];
  char reply_to_id[256];
  char alt_text[512];
  resolve_base_url(input, base_url, sizeof(base_url));
  json_get_string(input, "text", text, sizeof(text));
  json_get_string(input, "reply_to_id", reply_to_id, sizeof(reply_to_id));
  json_get_string(input, "alt_text", alt_text, sizeof(alt_text));

  /* 1. If attachments are present, upload to upload.example.com preserving alt_text. */
  char media_id[128] = "";
  if (strstr(input, "\"attachments\"") != NULL &&
      strstr(input, "\"mime_type\"") != NULL) {
    char upload_req_json[1024];
    snprintf(upload_req_json, sizeof(upload_req_json),
             "{\"url\":\"https://upload.example.com/v1/media\","
             "\"method\":\"POST\","
             "\"headers\":{\"Authorization\":\"Bearer %s\",\"Content-Type\":\"application/json\"}}",
             token);

    char upload_body[1024];
    snprintf(upload_body, sizeof(upload_body), "{\"alt_text\":\"%s\"}", alt_text);

    ExtismHandle up_req_h = extism_alloc_buf_from_sz(upload_req_json);
    ExtismHandle up_body_h = extism_alloc_buf_from_sz(upload_body);
    ExtismHandle up_res_h = extism_http_request(up_req_h, up_body_h);
    int32_t up_status = extism_http_status_code();

    extism_free(up_req_h);
    extism_free(up_body_h);

    if (up_status < 200 || up_status >= 300) {
      if (up_res_h) {
        extism_free(up_res_h);
      }
      free(input);
      extism_error_set_buf_from_sz("Media upload failed.");
      return 1;
    }

    if (up_res_h) {
      char *up_res_str = extism_load_sz_dup(up_res_h, NULL);
      if (up_res_str) {
        json_get_string(up_res_str, "media_id", media_id, sizeof(media_id));
        free(up_res_str);
      }
      extism_free(up_res_h);
    }
  }
  free(input);

  /* 2. Create the post (including reply_to_id for threads when provided). */
  char post_req_json[1536];
  snprintf(post_req_json, sizeof(post_req_json),
           "{\"url\":\"%s/v1/posts\","
           "\"method\":\"POST\","
           "\"headers\":{\"Authorization\":\"Bearer %s\",\"Content-Type\":\"application/json\"}}",
           base_url, token);

  char post_body[2048];
  snprintf(post_body, sizeof(post_body),
           "{\"text\":\"%s\",\"media_id\":\"%s\",\"reply_to_id\":\"%s\"}",
           text, media_id, reply_to_id);

  ExtismHandle req_h = extism_alloc_buf_from_sz(post_req_json);
  ExtismHandle body_h = extism_alloc_buf_from_sz(post_body);
  ExtismHandle res_h = extism_http_request(req_h, body_h);
  int32_t status = extism_http_status_code();

  extism_free(req_h);
  extism_free(body_h);

  if (status < 200 || status >= 300) {
    if (res_h) {
      extism_free(res_h);
    }
    extism_error_set_buf_from_sz("Publish request failed.");
    return 1;
  }

  char post_id[128] = "post_unknown";
  char post_url[512] = "";
  if (res_h) {
    char *res_str = extism_load_sz_dup(res_h, NULL);
    if (res_str) {
      json_get_string(res_str, "id", post_id, sizeof(post_id));
      json_get_string(res_str, "url", post_url, sizeof(post_url));
      free(res_str);
    }
    extism_free(res_h);
  }
  if (post_url[0] == '\0') {
    snprintf(post_url, sizeof(post_url), "%s/posts/%s", base_url, post_id);
  }

  char out_json[768];
  snprintf(out_json, sizeof(out_json),
           "{\"post_id\":\"%s\",\"url\":\"%s\"}", post_id, post_url);
  extism_output_buf_from_sz(out_json);
  return 0;
}

/**
 * Deletes a previously published post by its `post_id`.
 */
int32_t EXTISM_EXPORTED_FUNCTION(delete_post) {
  char *input = extism_load_input_sz_dup(NULL);
  if (!input) {
    extism_error_set_buf_from_sz("Failed to read input payload.");
    return 1;
  }

  char token[512];
  char post_id[256];
  if (!json_get_string(input, "api_token", token, sizeof(token)) ||
      token[0] == '\0') {
    free(input);
    extism_error_set_buf_from_sz("Missing required credential: api_token");
    return 1;
  }
  if (!json_get_string(input, "post_id", post_id, sizeof(post_id)) ||
      post_id[0] == '\0') {
    free(input);
    extism_error_set_buf_from_sz("post_id must not be empty.");
    return 1;
  }

  char base_url[512];
  resolve_base_url(input, base_url, sizeof(base_url));
  free(input);

  char req_json[1536];
  snprintf(req_json, sizeof(req_json),
           "{\"url\":\"%s/v1/posts/%s\","
           "\"method\":\"DELETE\","
           "\"headers\":{\"Authorization\":\"Bearer %s\"}}",
           base_url, post_id, token);

  ExtismHandle req_h = extism_alloc_buf_from_sz(req_json);
  ExtismHandle res_h = extism_http_request(req_h, 0);
  int32_t status = extism_http_status_code();

  extism_free(req_h);
  if (res_h) {
    extism_free(res_h);
  }

  if (status < 200 || status >= 300) {
    extism_error_set_buf_from_sz("Delete request failed.");
    return 1;
  }

  extism_output_buf_from_sz("{\"deleted\":true}");
  return 0;
}
