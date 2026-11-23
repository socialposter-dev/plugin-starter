/**
 * Reference SocialPoster 1.0.0 WebAssembly plugin in AssemblyScript (@extism/as-pdk).
 *
 * Compile with:
 *   npm run build
 * (runs `asc assembly/index.ts --config asconfig.json --target release`
 *  to emit `../output/example-social-assemblyscript.wasm`).
 */

import { Host, Memory } from "@extism/as-pdk/lib/pdk";
import { error_set, length } from "@extism/as-pdk/lib/env";

// ---------------------------------------------------------------------------
// SocialPoster 1.0.0 Host Functions (extism:host/user)
// ---------------------------------------------------------------------------

@external("extism:host/user", "sp_credential")
declare function sp_credential(keyOffset: u64): u64;

@external("extism:host/user", "sp_media_chunk")
declare function sp_media_chunk(reqOffset: u64): u64;

@external("extism:host/user", "sp_http")
declare function sp_http(reqOffset: u64): u64;

// Required abort stub for Extism hosts (referenced in asconfig.json).
export function abort(
  _message: string | null,
  _fileName: string | null,
  _lineNumber: u32,
  _columnNumber: u32
): void {}

// ---------------------------------------------------------------------------
// Minimal JSON & Host Function Helpers
// ---------------------------------------------------------------------------

/** Extracts a string value for `"key": "value"` from a JSON payload. */
function jsonGetString(json: string, key: string): string {
  const pattern = `"${key}"`;
  const keyIdx = json.indexOf(pattern);
  if (keyIdx < 0) return "";

  let pos = keyIdx + pattern.length;
  while (
    pos < json.length &&
    (json.charCodeAt(pos) == 32 ||
      json.charCodeAt(pos) == 9 ||
      json.charCodeAt(pos) == 10 ||
      json.charCodeAt(pos) == 13)
  ) {
    pos++;
  }
  if (pos >= json.length || json.charCodeAt(pos) != 58 /* : */) return "";
  pos++;
  while (
    pos < json.length &&
    (json.charCodeAt(pos) == 32 ||
      json.charCodeAt(pos) == 9 ||
      json.charCodeAt(pos) == 10 ||
      json.charCodeAt(pos) == 13)
  ) {
    pos++;
  }
  if (pos >= json.length || json.charCodeAt(pos) != 34 /* " */) return "";
  pos++;

  let out = "";
  while (pos < json.length) {
    const ch = json.charCodeAt(pos);
    if (ch == 34 /* " */) break;
    if (ch == 92 /* \ */ && pos + 1 < json.length) {
      pos++;
    }
    out += json.charAt(pos);
    pos++;
  }
  return out;
}

/** Extracts an integer value for `"key": 123` from a JSON payload. */
function jsonGetInt(json: string, key: string): i32 {
  const pattern = `"${key}"`;
  const keyIdx = json.indexOf(pattern);
  if (keyIdx < 0) return 0;

  let pos = keyIdx + pattern.length;
  while (
    pos < json.length &&
    (json.charCodeAt(pos) == 32 || json.charCodeAt(pos) == 9 || json.charCodeAt(pos) == 58)
  ) {
    pos++;
  }
  let numStr = "";
  while (pos < json.length) {
    const code = json.charCodeAt(pos);
    if (code >= 48 && code <= 57) {
      numStr += json.charAt(pos);
      pos++;
    } else {
      break;
    }
  }
  return numStr.length > 0 ? I32.parseInt(numStr) : 0;
}

function jsonEscape(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    if (ch == "\\") out += "\\\\";
    else if (ch == '"') out += '\\"';
    else if (ch == "\n") out += "\\n";
    else if (ch == "\r") out += "\\r";
    else if (ch == "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

function readCredential(key: string): string {
  const keyMem = Memory.allocateString(key);
  const resOffset = sp_credential(keyMem.offset);
  keyMem.free();
  if (resOffset == 0) return "";
  const resLen = length(resOffset);
  if (resLen == 0) return "";
  const resMem = new Memory(resOffset, resLen);
  const value = resMem.toString();
  resMem.free();
  return value;
}

function activeAuthMode(): string {
  const mode = readCredential("__auth_mode").trim();
  return mode.length > 0 ? mode : "api_key";
}

function modeTokenKey(mode: string): string {
  return mode == "webhook_app" ? "app_token" : "api_token";
}

function resolveBaseUrl(): string {
  let custom = readCredential("instance_url").trim();
  while (custom.endsWith("/")) {
    custom = custom.slice(0, custom.length - 1);
  }
  return custom.length > 0 ? custom : "https://api.example.com";
}

function setHostError(msg: string): void {
  const mem = Memory.allocateString(msg);
  error_set(mem.offset);
}

class HttpResult {
  status: i32;
  body: string;

  constructor(status: i32, body: string) {
    this.status = status;
    this.body = body;
  }
}

/** Executes an outbound HTTPS request via `sp_http`. */
function callSpHttp(reqJson: string): HttpResult {
  const reqMem = Memory.allocateString(reqJson);
  const resOffset = sp_http(reqMem.offset);
  reqMem.free();

  if (resOffset == 0) {
    return new HttpResult(0, "");
  }
  const resLen = length(resOffset);
  const resMem = new Memory(resOffset, resLen);
  const raw = resMem.toString();
  resMem.free();

  const status = jsonGetInt(raw, "status");
  const body = jsonGetString(raw, "body");
  return new HttpResult(status, body);
}

/** Streams attachment bytes in 64 KB chunks via `sp_media_chunk`. */
function streamAttachmentLength(attachmentId: string): i32 {
  const chunkSize: i32 = 65536;
  let totalBytes: i32 = 0;
  let offset: i32 = 0;

  while (true) {
    const reqJson = `{"attachment_id":"${jsonEscape(attachmentId)}","offset":${offset.toString()},"length":${chunkSize.toString()}}`;
    const reqMem = Memory.allocateString(reqJson);
    const chunkOffset = sp_media_chunk(reqMem.offset);
    reqMem.free();

    if (chunkOffset == 0) break;
    const chunkLen = i32(length(chunkOffset));
    const chunkMem = new Memory(chunkOffset, u64(chunkLen));
    chunkMem.free();

    if (chunkLen == 0) break;
    totalBytes += chunkLen;
    offset += chunkLen;
    if (chunkLen < chunkSize) break;
  }
  return totalBytes;
}

// ---------------------------------------------------------------------------
// Required SocialPoster 1.0.0 ABI Exports
// ---------------------------------------------------------------------------

/** Returns plugin metadata, capabilities, and `auth_modes` definitions. */
export function describe(): i32 {
  const metadata =
    "{" +
    '"id":"example-social-assemblyscript",' +
    '"version":"1.0.0",' +
    '"compatible_app_version":"^1.0.0",' +
    '"display_name":"Example Social",' +
    '"authors":[{"name":"Your Name","links":[{"label":"Website","url":"https://example.com"}]}],' +
    '"brand_colour":"#5B4BFF",' +
    '"icon_svg":"<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"10\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"/><path d=\\"M8 12l3 3 5-6\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"/></svg>",' +
    '"max_characters":500,' +
    '"max_attachments":4,' +
    '"supported_media_types":["image/jpeg","image/png","image/webp","video/mp4"],' +
    '"supports_alt_text":true,' +
    '"supports_threads":true,' +
    '"supports_delete":true,' +
    '"allowed_domains":["api.example.com","upload.example.com"],' +
    '"auth_modes":[' +
    "{" +
    '"id":"api_key",' +
    '"label":"API Key",' +
    '"description":"Authenticate using a personal API token and account handle.",' +
    '"setup_instructions":"1. Open **Settings -> Developer** on Example Social.\\n2. Create a new **API Token** with publish and delete permissions.\\n3. Paste your token and account handle below.",' +
    '"fields":[' +
    '{"key":"api_token","label":"API Token","secret":true,"required":true},' +
    '{"key":"handle","label":"Account Handle","secret":false,"required":true},' +
    '{"key":"instance_url","label":"Instance URL","secret":false,"required":false}' +
    "]" +
    "}," +
    "{" +
    '"id":"webhook_app",' +
    '"label":"App Credentials",' +
    '"description":"Authenticate using an application token and optional webhook signing secret.",' +
    '"setup_instructions":"1. Register an application in the **Example Social App Portal**.\\n2. Copy the **App Token** and optional **Webhook Signing Secret**.",' +
    '"fields":[' +
    '{"key":"app_token","label":"App Token","secret":true,"required":true},' +
    '{"key":"webhook_secret","label":"Webhook Signing Secret","secret":true,"required":false}' +
    "]" +
    "}" +
    "]" +
    "}";

  Host.outputString(metadata);
  return 0;
}

/** Verifies credentials for the active `__auth_mode` via `sp_credential` and `sp_http`. */
export function validate_auth(): i32 {
  const mode = activeAuthMode();
  const token = readCredential(modeTokenKey(mode)).trim();

  if (token.length == 0) {
    Host.outputString(
      `{"valid":false,"error":"Missing required token for authentication mode '${jsonEscape(mode)}'."}`
    );
    return 0;
  }

  if (mode == "api_key" && readCredential("handle").trim().length == 0) {
    Host.outputString(
      '{"valid":false,"error":"Account Handle is required for API Key mode."}'
    );
    return 0;
  }

  const baseUrl = resolveBaseUrl();
  const reqJson =
    `{"method":"GET","url":"${jsonEscape(baseUrl)}/v1/accounts/verify_credentials",` +
    `"headers":{"Authorization":"Bearer ${jsonEscape(token)}","Accept":"application/json"}}`;

  const res = callSpHttp(reqJson);
  if (res.status >= 200 && res.status < 300) {
    Host.outputString('{"valid":true}');
  } else {
    Host.outputString(
      `{"valid":false,"error":"Authorisation failed with HTTP status ${res.status.toString()}."}`
    );
  }
  return 0;
}

/** Publishes a post, streaming attachments via `sp_media_chunk` and prefixing `post_id` with `<mode>:`. */
export function publish(): i32 {
  const input = Host.inputString();
  const mode = activeAuthMode();
  const token = readCredential(modeTokenKey(mode)).trim();
  if (token.length == 0) {
    setHostError(`Missing required credential for mode '${mode}'.`);
    return 1;
  }

  const baseUrl = resolveBaseUrl();
  const text = jsonGetString(input, "text");
  const replyToId = jsonGetString(input, "reply_to_id");
  const altText = jsonGetString(input, "alt_text");
  const attachmentId = jsonGetString(input, "attachment_id");

  // 1. Stream media attachment via `sp_media_chunk` and upload via `sp_http` when present.
  let mediaId = "";
  if (attachmentId.length > 0) {
    const byteLength = streamAttachmentLength(attachmentId);
    const uploadBody = `{"byte_length":${byteLength.toString()},"alt_text":"${jsonEscape(altText)}"}`;
    const uploadReq =
      '{"method":"POST","url":"https://upload.example.com/v1/media",' +
      `"headers":{"Authorization":"Bearer ${jsonEscape(token)}","Content-Type":"application/json"},` +
      `"body":"${jsonEscape(uploadBody)}"}`;

    const uploadRes = callSpHttp(uploadReq);
    if (uploadRes.status < 200 || uploadRes.status >= 300) {
      setHostError(
        `Media upload failed with HTTP status ${uploadRes.status.toString()}.`
      );
      return 1;
    }
    mediaId = jsonGetString(uploadRes.body, "media_id");
  }

  // 2. Create the post via `sp_http`, attaching media ID and optional `reply_to_id`.
  const postBody =
    `{"text":"${jsonEscape(text)}",` +
    `"media_id":"${jsonEscape(mediaId)}",` +
    `"reply_to_id":"${jsonEscape(replyToId)}"}`;
  const postReq =
    `{"method":"POST","url":"${jsonEscape(baseUrl)}/v1/posts",` +
    `"headers":{"Authorization":"Bearer ${jsonEscape(token)}","Content-Type":"application/json"},` +
    `"body":"${jsonEscape(postBody)}"}`;

  const postRes = callSpHttp(postReq);
  if (postRes.status < 200 || postRes.status >= 300) {
    setHostError(
      `Publish failed with HTTP status ${postRes.status.toString()}.`
    );
    return 1;
  }

  let rawId = jsonGetString(postRes.body, "id");
  if (rawId.length == 0) rawId = "post_unknown";
  let postUrl = jsonGetString(postRes.body, "url");
  if (postUrl.length == 0) postUrl = `${baseUrl}/posts/${rawId}`;

  // Prefix `post_id` with `<mode>:` so `delete_post` routes correctly even if modes change.
  Host.outputString(
    `{"post_id":"${jsonEscape(mode)}:${jsonEscape(rawId)}","url":"${jsonEscape(postUrl)}"}`
  );
  return 0;
}

/** Deletes a previously published post, routing via the `<mode>:` prefix on `post_id`. */
export function delete_post(): i32 {
  const input = Host.inputString();
  const trimmed = jsonGetString(input, "post_id").trim();
  if (trimmed.length == 0) {
    setHostError("post_id must not be empty.");
    return 1;
  }

  let mode = activeAuthMode();
  let rawId = trimmed;
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0 && colonIdx + 1 < trimmed.length) {
    mode = trimmed.slice(0, colonIdx);
    rawId = trimmed.slice(colonIdx + 1);
  }

  const token = readCredential(modeTokenKey(mode)).trim();
  if (token.length == 0) {
    setHostError(`Missing required credential for mode '${mode}'.`);
    return 1;
  }

  const baseUrl = resolveBaseUrl();
  const reqJson =
    `{"method":"DELETE","url":"${jsonEscape(baseUrl)}/v1/posts/${jsonEscape(rawId)}",` +
    `"headers":{"Authorization":"Bearer ${jsonEscape(token)}"}}`;

  const res = callSpHttp(reqJson);
  if (res.status < 200 || res.status >= 300) {
    setHostError(`Delete failed with HTTP status ${res.status.toString()}.`);
    return 1;
  }

  Host.outputString('{"deleted":true}');
  return 0;
}
