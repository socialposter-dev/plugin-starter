//! Reference SocialPoster 1.0.0 WebAssembly plugin in Rust.
//!
//! Compile with:
//!   cargo build --release --target wasm32-unknown-unknown
//!
//! All four required ABI functions (`describe`, `validate_auth`, `publish`,
//! `delete_post`) are exported via `#[plugin_fn]`.

use extism_pdk::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// SocialPoster 1.0.0 Host Functions (extism:host/user)
// ---------------------------------------------------------------------------

#[host_fn]
extern "ExtismHost" {
    /// Reads a secret or configuration value from the host keyring by key.
    /// The reserved key `"__auth_mode"` returns the active authentication mode ID.
    fn sp_credential(key: String) -> String;

    /// Streams a chunk of attachment bytes from the host media store.
    fn sp_media_chunk(request: String) -> Vec<u8>;

    /// Executes an outbound HTTPS request restricted to `allowed_domains`.
    fn sp_http(request: String) -> String;
}

// ---------------------------------------------------------------------------
// ABI Data Structures
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct AuthorLink {
    label: &'static str,
    url: &'static str,
}

#[derive(Serialize)]
struct Author {
    name: &'static str,
    links: Vec<AuthorLink>,
}

#[derive(Serialize)]
struct CredentialField {
    key: &'static str,
    label: &'static str,
    secret: bool,
    required: bool,
}

#[derive(Serialize)]
struct AuthMode {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    setup_instructions: &'static str,
    fields: Vec<CredentialField>,
}

#[derive(Serialize)]
struct DescribeOutput {
    id: &'static str,
    version: &'static str,
    compatible_app_version: &'static str,
    display_name: &'static str,
    authors: Vec<Author>,
    brand_colour: &'static str,
    icon_svg: &'static str,
    max_characters: u32,
    max_attachments: u32,
    supported_media_types: Vec<&'static str>,
    supports_alt_text: bool,
    supports_threads: bool,
    supports_delete: bool,
    allowed_domains: Vec<&'static str>,
    auth_modes: Vec<AuthMode>,
}

#[derive(Serialize)]
struct ValidateAuthOutput {
    valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct Attachment {
    #[serde(default)]
    attachment_id: String,
    mime_type: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    size_bytes: usize,
    #[serde(default)]
    alt_text: Option<String>,
}

#[derive(Deserialize)]
struct PublishInput {
    text: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
    #[serde(default)]
    reply_to_id: Option<String>,
}

#[derive(Serialize)]
struct PublishOutput {
    post_id: String,
    url: String,
}

#[derive(Deserialize)]
struct DeletePostInput {
    post_id: String,
}

#[derive(Serialize)]
struct DeletePostOutput {
    deleted: bool,
}

#[derive(Deserialize)]
struct SpHttpResponse {
    status: u16,
    #[serde(default)]
    body: String,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_credential(key: &str) -> String {
    unsafe { sp_credential(key.to_string()) }.unwrap_or_default()
}

fn active_auth_mode() -> String {
    let mode = read_credential("__auth_mode");
    if mode.trim().is_empty() {
        "api_key".to_string()
    } else {
        mode.trim().to_string()
    }
}

fn resolve_base_url() -> String {
    let custom = read_credential("instance_url");
    let trimmed = custom.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "https://api.example.com".to_string()
    } else {
        trimmed.to_string()
    }
}

fn call_sp_http(
    method: &str,
    url: &str,
    headers: HashMap<&str, String>,
    body: Option<String>,
) -> Result<SpHttpResponse, Error> {
    let req_json = serde_json::json!({
        "method": method,
        "url": url,
        "headers": headers,
        "body": body,
    })
    .to_string();

    let raw = unsafe { sp_http(req_json) }?;
    let parsed: SpHttpResponse = serde_json::from_str(&raw)?;
    Ok(parsed)
}

fn stream_attachment_bytes(attachment: &Attachment) -> Result<Vec<u8>, Error> {
    const CHUNK_SIZE: usize = 65_536;
    let mut buffer = Vec::with_capacity(attachment.size_bytes);
    let mut offset: usize = 0;

    loop {
        let req_json = serde_json::json!({
            "attachment_id": attachment.attachment_id,
            "offset": offset,
            "length": CHUNK_SIZE,
        })
        .to_string();

        let chunk = unsafe { sp_media_chunk(req_json) }?;
        if chunk.is_empty() {
            break;
        }
        let read_len = chunk.len();
        buffer.extend_from_slice(&chunk);
        offset += read_len;

        if read_len < CHUNK_SIZE {
            break;
        }
    }
    Ok(buffer)
}

fn mode_token_key(mode_id: &str) -> &'static str {
    if mode_id == "webhook_app" {
        "app_token"
    } else {
        "api_token"
    }
}

// ---------------------------------------------------------------------------
// Required SocialPoster 1.0.0 ABI Exports
// ---------------------------------------------------------------------------

/// Returns plugin metadata, capabilities, and `auth_modes` definitions.
#[plugin_fn]
pub fn describe() -> FnResult<Json<DescribeOutput>> {
    Ok(Json(DescribeOutput {
        id: "example-social",
        version: "1.0.0",
        compatible_app_version: "^1.0.0",
        display_name: "Example Social",
        authors: vec![Author {
            name: "Your Name",
            links: vec![AuthorLink {
                label: "Website",
                url: "https://example.com",
            }],
        }],
        brand_colour: "#5B4BFF",
        icon_svg: r#"<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>"#,
        max_characters: 500,
        max_attachments: 4,
        supported_media_types: vec![
            "image/jpeg",
            "image/png",
            "image/webp",
            "video/mp4",
        ],
        supports_alt_text: true,
        supports_threads: true,
        supports_delete: true,
        allowed_domains: vec!["api.example.com", "upload.example.com"],
        auth_modes: vec![
            AuthMode {
                id: "api_key",
                label: "API Key",
                description: "Authenticate using a personal API token and account handle.",
                setup_instructions: "1. Open **Settings -> Developer** on Example Social.\n2. Create a new **API Token** with publish and delete permissions.\n3. Paste your token and account handle below.",
                fields: vec![
                    CredentialField {
                        key: "api_token",
                        label: "API Token",
                        secret: true,
                        required: true,
                    },
                    CredentialField {
                        key: "handle",
                        label: "Account Handle",
                        secret: false,
                        required: true,
                    },
                    CredentialField {
                        key: "instance_url",
                        label: "Instance URL",
                        secret: false,
                        required: false,
                    },
                ],
            },
            AuthMode {
                id: "webhook_app",
                label: "App Credentials",
                description: "Authenticate using an application token and optional webhook signing secret.",
                setup_instructions: "1. Register an application in the **Example Social App Portal**.\n2. Copy the **App Token** and optional **Webhook Signing Secret**.",
                fields: vec![
                    CredentialField {
                        key: "app_token",
                        label: "App Token",
                        secret: true,
                        required: true,
                    },
                    CredentialField {
                        key: "webhook_secret",
                        label: "Webhook Signing Secret",
                        secret: true,
                        required: false,
                    },
                ],
            },
        ],
    }))
}

/// Verifies credentials for the active `__auth_mode` via `sp_credential` and `sp_http`.
#[plugin_fn]
pub fn validate_auth() -> FnResult<Json<ValidateAuthOutput>> {
    let mode = active_auth_mode();
    let token = read_credential(mode_token_key(&mode));

    if token.trim().is_empty() {
        return Ok(Json(ValidateAuthOutput {
            valid: false,
            error: Some(format!(
                "Missing required token for authentication mode '{mode}'."
            )),
        }));
    }

    if mode == "api_key" && read_credential("handle").trim().is_empty() {
        return Ok(Json(ValidateAuthOutput {
            valid: false,
            error: Some("Account Handle is required for API Key mode.".to_string()),
        }));
    }

    let url = format!("{}/v1/accounts/verify_credentials", resolve_base_url());
    let mut headers = HashMap::new();
    headers.insert("Authorization", format!("Bearer {token}"));
    headers.insert("Accept", "application/json".to_string());

    let res = call_sp_http("GET", &url, headers, None)?;
    if (200..300).contains(&res.status) {
        Ok(Json(ValidateAuthOutput {
            valid: true,
            error: None,
        }))
    } else {
        Ok(Json(ValidateAuthOutput {
            valid: false,
            error: Some(format!(
                "Authorisation failed with HTTP status {}.",
                res.status
            )),
        }))
    }
}

/// Publishes a post, streaming attachments via `sp_media_chunk` and prefixing `post_id` with `<mode>:`.
#[plugin_fn]
pub fn publish(Json(input): Json<PublishInput>) -> FnResult<Json<PublishOutput>> {
    let mode = active_auth_mode();
    let token = read_credential(mode_token_key(&mode));
    if token.trim().is_empty() {
        return Err(Error::msg(format!(
            "Missing required credential for mode '{mode}'."
        ))
        .into());
    }

    let base_url = resolve_base_url();

    // 1. Stream each attachment via `sp_media_chunk` and upload via `sp_http`.
    let mut media_ids: Vec<String> = Vec::with_capacity(input.attachments.len());
    for attachment in &input.attachments {
        let raw_bytes = stream_attachment_bytes(attachment)?;
        let upload_payload = serde_json::json!({
            "filename": attachment.filename,
            "mime_type": attachment.mime_type,
            "byte_length": raw_bytes.len(),
            "alt_text": attachment.alt_text,
        })
        .to_string();

        let mut upload_headers = HashMap::new();
        upload_headers.insert("Authorization", format!("Bearer {token}"));
        upload_headers.insert("Content-Type", "application/json".to_string());

        let upload_res = call_sp_http(
            "POST",
            "https://upload.example.com/v1/media",
            upload_headers,
            Some(upload_payload),
        )?;
        if !(200..300).contains(&upload_res.status) {
            return Err(Error::msg(format!(
                "Media upload failed with HTTP status {}.",
                upload_res.status
            ))
            .into());
        }

        let parsed: serde_json::Value = serde_json::from_str(&upload_res.body)?;
        if let Some(id) = parsed.get("media_id").and_then(|v| v.as_str()) {
            media_ids.push(id.to_string());
        }
    }

    // 2. Create the post via `sp_http`, attaching media IDs and optional `reply_to_id`.
    let post_payload = serde_json::json!({
        "text": input.text,
        "media_ids": media_ids,
        "reply_to_id": input.reply_to_id,
    })
    .to_string();

    let mut post_headers = HashMap::new();
    post_headers.insert("Authorization", format!("Bearer {token}"));
    post_headers.insert("Content-Type", "application/json".to_string());

    let post_url = format!("{base_url}/v1/posts");
    let post_res = call_sp_http("POST", &post_url, post_headers, Some(post_payload))?;
    if !(200..300).contains(&post_res.status) {
        return Err(Error::msg(format!(
            "Publish failed with HTTP status {}.",
            post_res.status
        ))
        .into());
    }

    let body: serde_json::Value = serde_json::from_str(&post_res.body)?;
    let raw_id = body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("post_unknown");
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("{base_url}/posts/{raw_id}"));

    // Prefix `post_id` with `<mode>:` so `delete_post` routes correctly even if the user switches modes.
    Ok(Json(PublishOutput {
        post_id: format!("{mode}:{raw_id}"),
        url,
    }))
}

/// Deletes a previously published post, routing via the `<mode>:` prefix on `post_id`.
#[plugin_fn]
pub fn delete_post(Json(input): Json<DeletePostInput>) -> FnResult<Json<DeletePostOutput>> {
    let trimmed = input.post_id.trim();
    if trimmed.is_empty() {
        return Err(Error::msg("post_id must not be empty.").into());
    }

    let (mode, raw_id) = match trimmed.split_once(':') {
        Some((m, id)) if !m.is_empty() && !id.is_empty() => (m.to_string(), id),
        _ => (active_auth_mode(), trimmed),
    };

    let token = read_credential(mode_token_key(&mode));
    if token.trim().is_empty() {
        return Err(Error::msg(format!(
            "Missing required credential for mode '{mode}'."
        ))
        .into());
    }

    let url = format!("{}/v1/posts/{raw_id}", resolve_base_url());
    let mut headers = HashMap::new();
    headers.insert("Authorization", format!("Bearer {token}"));

    let res = call_sp_http("DELETE", &url, headers, None)?;
    if (200..300).contains(&res.status) {
        Ok(Json(DeletePostOutput { deleted: true }))
    } else {
        Err(Error::msg(format!(
            "Delete failed with HTTP status {}.",
            res.status
        ))
        .into())
    }
}
