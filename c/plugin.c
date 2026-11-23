/**
 * Reference SocialPoster 1.0.0 WebAssembly plugin in C (clang + vendored extism-pdk.h).
 *
 * Compile with WASI SDK:
 *   /opt/wasi-sdk/bin/clang -Os --target=wasm32-wasi -mexec-model=reactor -Wl,--strip-all -o ../output/example-social-c.wasm plugin.c
 */

#define EXTISM_USE_LIBC
#define EXTISM_IMPLEMENTATION
#include "extism-pdk.h"

#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------------- */
/* SocialPoster 1.0.0 Host Functions (extism:host/user)                      */
/* ------------------------------------------------------------------------- */

EXTISM_IMPORT_USER("sp_credential")
extern ExtismHandle sp_credential(const ExtismHandle);

EXTISM_IMPORT_USER("sp_media_chunk")
extern ExtismHandle sp_media_chunk(const ExtismHandle);

EXTISM_IMPORT_USER("sp_http")
extern ExtismHandle sp_http(const ExtismHandle);

/* ------------------------------------------------------------------------- */
/* Minimal JSON & Host Function Helpers (zero external dependencies)         */
/* ------------------------------------------------------------------------- */

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

static int json_get_int(const char *json, const char *key) {
  if (!json || !key) {
    return 0;
  }
  char pattern[128];
  snprintf(pattern, sizeof(pattern), "\"%s\"", key);

  const char *pos = strstr(json, pattern);
  if (!pos) {
    return 0;
  }
  pos += strlen(pattern);
  while (*pos == ' ' || *pos == '\t' || *pos == ':' || *pos == '\n') {
    pos++;
  }
  return atoi(pos);
}

static void read_credential(const char *key, char *out, size_t out_cap) {
  out[0] = '\0';
  ExtismHandle key_h = extism_alloc_buf_from_sz(key);
  ExtismHandle res_h = sp_credential(key_h);
  extism_free(key_h);
  if (!res_h) {
    return;
  }
  char *str = extism_load_sz_dup(res_h, NULL);
  extism_free(res_h);
  if (str) {
    snprintf(out, out_cap, "%s", str);
    free(str);
  }
}

static void active_auth_mode(char *out, size_t out_cap) {
  read_credential("__auth_mode", out, out_cap);
  if (out[0] == '\0') {
    snprintf(out, out_cap, "api_key");
  }
}

static const char *mode_token_key(const char *mode) {
  return strcmp(mode, "webhook_app") == 0 ? "app_token" : "api_token";
}

static void resolve_base_url(char *out, size_t out_cap) {
  read_credential("instance_url", out, out_cap);
  size_t len = strlen(out);
  while (len > 0 && out[len - 1] == '/') {
    out[--len] = '\0';
  }
  if (len == 0) {
    snprintf(out, out_cap, "https://api.example.com");
  }
}

static int32_t call_sp_http(const char *req_json, char *body_out,
                            size_t body_cap) {
  if (body_out && body_cap > 0) {
    body_out[0] = '\0';
  }
  ExtismHandle req_h = extism_alloc_buf_from_sz(req_json);
  ExtismHandle res_h = sp_http(req_h);
  extism_free(req_h);
  if (!res_h) {
    return 0;
  }
  char *res_str = extism_load_sz_dup(res_h, NULL);
  extism_free(res_h);
  if (!res_str) {
    return 0;
  }
  int32_t status = json_get_int(res_str, "status");
  if (body_out && body_cap > 0) {
    json_get_string(res_str, "body", body_out, body_cap);
  }
  free(res_str);
  return status;
}

static size_t stream_attachment_bytes(const char *attachment_id) {
  const size_t chunk_size = 65536;
  size_t total = 0;
  size_t offset = 0;

  while (true) {
    char req_json[512];
    snprintf(req_json, sizeof(req_json),
             "{\"attachment_id\":\"%s\",\"offset\":%zu,\"length\":%zu}",
             attachment_id, offset, chunk_size);
    ExtismHandle req_h = extism_alloc_buf_from_sz(req_json);
    ExtismHandle chunk_h = sp_media_chunk(req_h);
    extism_free(req_h);
    if (!chunk_h) {
      break;
    }
    uint64_t chunk_len = extism_length(chunk_h);
    extism_free(chunk_h);
    if (chunk_len == 0) {
      break;
    }
    total += (size_t)chunk_len;
    offset += (size_t)chunk_len;
    if (chunk_len < chunk_size) {
      break;
    }
  }
  return total;
}

/* ------------------------------------------------------------------------- */
/* Required SocialPoster 1.0.0 ABI Exports                                   */
/* ------------------------------------------------------------------------- */

/**
 * Returns plugin metadata, capabilities, and `auth_modes` definitions.
 */
int32_t EXTISM_EXPORTED_FUNCTION(describe) {
  static const char *METADATA_JSON =
      "{"
      "\"id\":\"example-social\","
      "\"version\":\"1.0.0\","
      "\"compatible_app_version\":\"^1.0.0\","
      "\"display_name\":\"Example Social\","
      "\"authors\":[{\"name\":\"Your Name\",\"links\":[{\"label\":\"Website\",\"url\":\"https://example.com\"}]}],"
      "\"brand_colour\":\"#5B4BFF\","
      "\"icon_svg\":\"<svg viewBox=\\\"0 0 24 24\\\" fill=\\\"none\\\"><circle cx=\\\"12\\\" cy=\\\"12\\\" r=\\\"10\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"2\\\"/><path d=\\\"M8 12l3 3 5-6\\\" stroke=\\\"currentColor\\\" stroke-width=\\\"2\\\" stroke-linecap=\\\"round\\\" stroke-linejoin=\\\"round\\\"/></svg>\","
      "\"max_characters\":500,"
      "\"max_attachments\":4,"
      "\"supported_media_types\":[\"image/jpeg\",\"image/png\",\"image/webp\",\"video/mp4\"],"
      "\"supports_alt_text\":true,"
      "\"supports_threads\":true,"
      "\"supports_delete\":true,"
      "\"allowed_domains\":[\"api.example.com\",\"upload.example.com\"],"
      "\"auth_modes\":["
      "{"
      "\"id\":\"api_key\","
      "\"label\":\"API Key\","
      "\"description\":\"Authenticate using a personal API token and account handle.\","
      "\"setup_instructions\":\"1. Open **Settings -> Developer** on Example Social.\\n2. Create a new **API Token** with publish and delete permissions.\\n3. Paste your token and account handle below.\","
      "\"fields\":["
      "{\"key\":\"api_token\",\"label\":\"API Token\",\"secret\":true,\"required\":true},"
      "{\"key\":\"handle\",\"label\":\"Account Handle\",\"secret\":false,\"required\":true},"
      "{\"key\":\"instance_url\",\"label\":\"Instance URL\",\"secret\":false,\"required\":false}"
      "]"
      "},"
      "{"
      "\"id\":\"webhook_app\","
      "\"label\":\"App Credentials\","
      "\"description\":\"Authenticate using an application token and optional webhook signing secret.\","
      "\"setup_instructions\":\"1. Register an application in the **Example Social App Portal**.\\n2. Copy the **App Token** and optional **Webhook Signing Secret**.\","
      "\"fields\":["
      "{\"key\":\"app_token\",\"label\":\"App Token\",\"secret\":true,\"required\":true},"
      "{\"key\":\"webhook_secret\",\"label\":\"Webhook Signing Secret\",\"secret\":true,\"required\":false}"
      "]"
      "}"
      "]"
      "}";

  extism_output_buf_from_sz(METADATA_JSON);
  return 0;
}

/**
 * Verifies credentials for the active `__auth_mode` via `sp_credential` and `sp_http`.
 */
int32_t EXTISM_EXPORTED_FUNCTION(validate_auth) {
  char mode[64];
  char token[512];
  active_auth_mode(mode, sizeof(mode));
  read_credential(mode_token_key(mode), token, sizeof(token));

  if (token[0] == '\0') {
    char err_json[256];
    snprintf(err_json, sizeof(err_json),
             "{\"valid\":false,\"error\":\"Missing required token for authentication mode '%s'.\"}",
             mode);
    extism_output_buf_from_sz(err_json);
    return 0;
  }

  if (strcmp(mode, "api_key") == 0) {
    char handle[256];
    read_credential("handle", handle, sizeof(handle));
    if (handle[0] == '\0') {
      extism_output_buf_from_sz(
          "{\"valid\":false,\"error\":\"Account Handle is required for API Key mode.\"}");
      return 0;
    }
  }

  char base_url[512];
  resolve_base_url(base_url, sizeof(base_url));

  char req_json[1536];
  snprintf(req_json, sizeof(req_json),
           "{\"method\":\"GET\",\"url\":\"%s/v1/accounts/verify_credentials\","
           "\"headers\":{\"Authorization\":\"Bearer %s\",\"Accept\":\"application/json\"}}",
           base_url, token);

  int32_t status = call_sp_http(req_json, NULL, 0);
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
 * Publishes a post, streaming attachments via `sp_media_chunk` and prefixing `post_id` with `<mode>:`.
 */
int32_t EXTISM_EXPORTED_FUNCTION(publish) {
  char *input = extism_load_input_sz_dup(NULL);
  if (!input) {
    extism_error_set_buf_from_sz("Failed to read input payload.");
    return 1;
  }

  char mode[64];
  char token[512];
  active_auth_mode(mode, sizeof(mode));
  read_credential(mode_token_key(mode), token, sizeof(token));
  if (token[0] == '\0') {
    free(input);
    extism_error_set_buf_from_sz("Missing required credential for active mode.");
    return 1;
  }

  char base_url[512];
  char text[1024];
  char reply_to_id[256];
  char alt_text[512];
  char attachment_id[256];
  resolve_base_url(base_url, sizeof(base_url));
  json_get_string(input, "text", text, sizeof(text));
  json_get_string(input, "reply_to_id", reply_to_id, sizeof(reply_to_id));
  json_get_string(input, "alt_text", alt_text, sizeof(alt_text));
  json_get_string(input, "attachment_id", attachment_id, sizeof(attachment_id));
  free(input);

  /* 1. Stream media attachment via `sp_media_chunk` and upload via `sp_http`. */
  char media_id[128] = "";
  if (attachment_id[0] != '\0') {
    size_t byte_len = stream_attachment_bytes(attachment_id);
    char upload_req_json[2048];
    snprintf(upload_req_json, sizeof(upload_req_json),
             "{\"method\":\"POST\",\"url\":\"https://upload.example.com/v1/media\","
             "\"headers\":{\"Authorization\":\"Bearer %s\",\"Content-Type\":\"application/json\"},"
             "\"body\":\"{\\\"byte_length\\\":%zu,\\\"alt_text\\\":\\\"%s\\\"}\"}",
             token, byte_len, alt_text);

    char upload_body[512];
    int32_t up_status = call_sp_http(upload_req_json, upload_body, sizeof(upload_body));
    if (up_status < 200 || up_status >= 300) {
      extism_error_set_buf_from_sz("Media upload failed.");
      return 1;
    }
    json_get_string(upload_body, "media_id", media_id, sizeof(media_id));
  }

  /* 2. Create the post via `sp_http` (including optional `reply_to_id`). */
  char post_req_json[3072];
  snprintf(post_req_json, sizeof(post_req_json),
           "{\"method\":\"POST\",\"url\":\"%s/v1/posts\","
           "\"headers\":{\"Authorization\":\"Bearer %s\",\"Content-Type\":\"application/json\"},"
           "\"body\":\"{\\\"text\\\":\\\"%s\\\",\\\"media_id\\\":\\\"%s\\\",\\\"reply_to_id\\\":\\\"%s\\\"}\"}",
           base_url, token, text, media_id, reply_to_id);

  char res_body[1024];
  int32_t status = call_sp_http(post_req_json, res_body, sizeof(res_body));
  if (status < 200 || status >= 300) {
    extism_error_set_buf_from_sz("Publish request failed.");
    return 1;
  }

  char raw_id[128] = "post_unknown";
  char post_url[512] = "";
  json_get_string(res_body, "id", raw_id, sizeof(raw_id));
  json_get_string(res_body, "url", post_url, sizeof(post_url));
  if (post_url[0] == '\0') {
    snprintf(post_url, sizeof(post_url), "%s/posts/%s", base_url, raw_id);
  }

  /* Prefix `post_id` with `<mode>:` so `delete_post` routes correctly across mode switches. */
  char out_json[896];
  snprintf(out_json, sizeof(out_json),
           "{\"post_id\":\"%s:%s\",\"url\":\"%s\"}", mode, raw_id, post_url);
  extism_output_buf_from_sz(out_json);
  return 0;
}

/**
 * Deletes a previously published post, routing via the `<mode>:` prefix on `post_id`.
 */
int32_t EXTISM_EXPORTED_FUNCTION(delete_post) {
  char *input = extism_load_input_sz_dup(NULL);
  if (!input) {
    extism_error_set_buf_from_sz("Failed to read input payload.");
    return 1;
  }

  char post_id[256];
  if (!json_get_string(input, "post_id", post_id, sizeof(post_id)) ||
      post_id[0] == '\0') {
    free(input);
    extism_error_set_buf_from_sz("post_id must not be empty.");
    return 1;
  }
  free(input);

  char mode[64];
  active_auth_mode(mode, sizeof(mode));
  const char *raw_id = post_id;
  char *colon = strchr(post_id, ':');
  if (colon && colon != post_id && *(colon + 1) != '\0') {
    size_t mode_len = (size_t)(colon - post_id);
    if (mode_len < sizeof(mode)) {
      memcpy(mode, post_id, mode_len);
      mode[mode_len] = '\0';
    }
    raw_id = colon + 1;
  }

  char token[512];
  read_credential(mode_token_key(mode), token, sizeof(token));
  if (token[0] == '\0') {
    extism_error_set_buf_from_sz("Missing required credential for mode.");
    return 1;
  }

  char base_url[512];
  resolve_base_url(base_url, sizeof(base_url));

  char req_json[1536];
  snprintf(req_json, sizeof(req_json),
           "{\"method\":\"DELETE\",\"url\":\"%s/v1/posts/%s\","
           "\"headers\":{\"Authorization\":\"Bearer %s\"}}",
           base_url, raw_id, token);

  int32_t status = call_sp_http(req_json, NULL, 0);
  if (status < 200 || status >= 300) {
    extism_error_set_buf_from_sz("Delete request failed.");
    return 1;
  }

  extism_output_buf_from_sz("{\"deleted\":true}");
  return 0;
}
