/**
 * Reference SocialPoster WebAssembly plugin in AssemblyScript (@extism/as-pdk).
 *
 * Compile with:
 *   npm run build
 * (runs `asc assembly/index.ts --config asconfig.json --target release`
 *  to emit `../output/example-social-assemblyscript.wasm`).
 */

import { Host, Memory } from "@extism/as-pdk/lib/pdk";
import { error_set, http_request, length } from "@extism/as-pdk/lib/env";

@external("extism:host/env", "http_status_code")
declare function http_status_code(): i32;

// Required abort stub for Extism hosts (referenced in asconfig.json).
export function abort(
  _message: string | null,
  _fileName: string | null,
  _lineNumber: u32,
  _columnNumber: u32
): void {}

// ---------------------------------------------------------------------------
// Minimal JSON & HTTP Helpers
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

function resolveBaseUrl(input: string): string {
  let custom = jsonGetString(input, "instance_url").trim();
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

/** Performs an outbound HTTPS request via the Extism host function. */
function sendHttpRequest(reqJson: string, bodyJson: string | null): HttpResult {
  const reqMem = Memory.allocateString(reqJson);
  const bodyMem = bodyJson !== null ? Memory.allocateString(bodyJson) : null;
  const resOffset = http_request(
    reqMem.offset,
    bodyMem !== null ? bodyMem.offset : 0
  );
  const status = http_status_code();

  reqMem.free();
  if (bodyMem !== null) {
    bodyMem.free();
  }

  let body = "";
  if (resOffset != 0) {
    const resLen = length(resOffset);
    const resMem = new Memory(resOffset, resLen);
    body = resMem.toString();
    resMem.free();
  }

  return new HttpResult(status, body);
}

// ---------------------------------------------------------------------------
// Required SocialPoster ABI Exports
// ---------------------------------------------------------------------------

/** Returns plugin metadata, capabilities, and credential field definitions. */
export function describe(): i32 {
  const metadata =
    "{" +
    '"id":"example-social-assemblyscript",' +
    '"version":"1.0.0",' +
    '"display_name":"Example Social",' +
    '"brand_colour":"#5B4BFF",' +
    '"icon_svg":"<svg viewBox=\\"0 0 24 24\\" fill=\\"none\\"><circle cx=\\"12\\" cy=\\"12\\" r=\\"10\\" stroke=\\"currentColor\\" stroke-width=\\"2\\"/><path d=\\"M8 12l3 3 5-6\\" stroke=\\"currentColor\\" stroke-width=\\"2\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"/></svg>",' +
    '"max_characters":500,' +
    '"max_attachments":4,' +
    '"supported_media_types":["image/jpeg","image/png","image/webp","video/mp4"],' +
    '"supports_alt_text":true,' +
    '"supports_threads":true,' +
    '"supports_delete":true,' +
    '"allowed_domains":["api.example.com","upload.example.com"],' +
    '"credential_fields":[' +
    '{"key":"api_token","label":"API Token","secret":true,"required":true},' +
    '{"key":"handle","label":"Account Handle","secret":false,"required":true},' +
    '{"key":"instance_url","label":"Instance URL","secret":false,"required":false},' +
    '{"key":"webhook_secret","label":"Webhook Signing Secret","secret":true,"required":false}' +
    "]" +
    "}";

  Host.outputString(metadata);
  return 0;
}

/** Verifies user credentials against the target platform's authentication endpoint. */
export function validate_auth(): i32 {
  const input = Host.inputString();
  const token = jsonGetString(input, "api_token").trim();
  const handle = jsonGetString(input, "handle").trim();

  if (token.length == 0 || handle.length == 0) {
    Host.outputString(
      '{"valid":false,"error":"Both api_token and handle are required."}'
    );
    return 0;
  }

  const baseUrl = resolveBaseUrl(input);
  const reqJson =
    `{"url":"${jsonEscape(baseUrl)}/v1/accounts/verify_credentials",` +
    '"method":"GET",' +
    `"headers":{"Authorization":"Bearer ${jsonEscape(token)}","Accept":"application/json"}}`;

  const res = sendHttpRequest(reqJson, null);
  if (res.status >= 200 && res.status < 300) {
    Host.outputString('{"valid":true}');
  } else {
    Host.outputString(
      `{"valid":false,"error":"Authorisation failed with HTTP status ${res.status.toString()}."}`
    );
  }
  return 0;
}

/** Publishes a post with optional media attachments (including alt-text) and thread parent ID. */
export function publish(): i32 {
  const input = Host.inputString();
  const token = jsonGetString(input, "api_token");
  if (token.length == 0) {
    setHostError("Missing required credential: api_token");
    return 1;
  }

  const baseUrl = resolveBaseUrl(input);
  const text = jsonGetString(input, "text");
  const replyToId = jsonGetString(input, "reply_to_id");
  const altText = jsonGetString(input, "alt_text");

  // 1. Upload media attachment (preserving alt_text) to upload.example.com when present.
  let mediaId = "";
  if (input.includes('"attachments"') && input.includes('"mime_type"')) {
    const uploadReq =
      '{"url":"https://upload.example.com/v1/media",' +
      '"method":"POST",' +
      `"headers":{"Authorization":"Bearer ${jsonEscape(token)}","Content-Type":"application/json"}}`;
    const uploadBody = `{"alt_text":"${jsonEscape(altText)}"}`;

    const uploadRes = sendHttpRequest(uploadReq, uploadBody);
    if (uploadRes.status < 200 || uploadRes.status >= 300) {
      setHostError(
        `Media upload failed with HTTP status ${uploadRes.status.toString()}.`
      );
      return 1;
    }
    mediaId = jsonGetString(uploadRes.body, "media_id");
  }

  // 2. Create the post, attaching uploaded media ID and optional reply_to_id.
  const postReq =
    `{"url":"${jsonEscape(baseUrl)}/v1/posts",` +
    '"method":"POST",' +
    `"headers":{"Authorization":"Bearer ${jsonEscape(token)}","Content-Type":"application/json"}}`;
  const postBody =
    `{"text":"${jsonEscape(text)}",` +
    `"media_id":"${jsonEscape(mediaId)}",` +
    `"reply_to_id":"${jsonEscape(replyToId)}"}`;

  const postRes = sendHttpRequest(postReq, postBody);
  if (postRes.status < 200 || postRes.status >= 300) {
    setHostError(
      `Publish failed with HTTP status ${postRes.status.toString()}.`
    );
    return 1;
  }

  let postId = jsonGetString(postRes.body, "id");
  if (postId.length == 0) postId = "post_unknown";
  let postUrl = jsonGetString(postRes.body, "url");
  if (postUrl.length == 0) postUrl = `${baseUrl}/posts/${postId}`;

  Host.outputString(
    `{"post_id":"${jsonEscape(postId)}","url":"${jsonEscape(postUrl)}"}`
  );
  return 0;
}

/** Deletes a previously published post by its `post_id`. */
export function delete_post(): i32 {
  const input = Host.inputString();
  const token = jsonGetString(input, "api_token");
  if (token.length == 0) {
    setHostError("Missing required credential: api_token");
    return 1;
  }

  const postId = jsonGetString(input, "post_id").trim();
  if (postId.length == 0) {
    setHostError("post_id must not be empty.");
    return 1;
  }

  const baseUrl = resolveBaseUrl(input);
  const reqJson =
    `{"url":"${jsonEscape(baseUrl)}/v1/posts/${jsonEscape(postId)}",` +
    '"method":"DELETE",' +
    `"headers":{"Authorization":"Bearer ${jsonEscape(token)}"}}`;

  const res = sendHttpRequest(reqJson, null);
  if (res.status < 200 || res.status >= 300) {
    setHostError(`Delete failed with HTTP status ${res.status.toString()}.`);
    return 1;
  }

  Host.outputString('{"deleted":true}');
  return 0;
}
