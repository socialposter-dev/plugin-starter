//! Reference SocialPoster WebAssembly plugin in Rust.
//!
//! Compile with:
//!   cargo build --release --target wasm32-wasip1
//!
//! All four required ABI functions (`describe`, `validate_auth`, `publish`,
//! `delete_post`) are exported via `#[plugin_fn]`.

use extism_pdk::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ---------------------------------------------------------------------------
// ABI Data Structures
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct CredentialField {
    key: &'static str,
    label: &'static str,
    secret: bool,
    required: bool,
}

#[derive(Serialize)]
struct DescribeOutput {
    id: &'static str,
    version: &'static str,
    display_name: &'static str,
    brand_colour: &'static str,
    icon_svg: &'static str,
    max_characters: u32,
    max_attachments: u32,
    supported_media_types: Vec<&'static str>,
    supports_alt_text: bool,
    supports_threads: bool,
    supports_delete: bool,
    allowed_domains: Vec<&'static str>,
    credential_fields: Vec<CredentialField>,
}

#[derive(Deserialize)]
struct ValidateAuthInput {
    credentials: HashMap<String, String>,
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
    data_base64: String,
    mime_type: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    alt_text: Option<String>,
}

#[derive(Deserialize)]
struct PublishInput {
    credentials: HashMap<String, String>,
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
    credentials: HashMap<String, String>,
    post_id: String,
}

#[derive(Serialize)]
struct DeletePostOutput {
    deleted: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolves the base API URL, honouring an optional custom `instance_url`.
fn resolve_base_url(credentials: &HashMap<String, String>) -> String {
    credentials
        .get("instance_url")
        .map(|s| s.trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://api.example.com".to_string())
}

// ---------------------------------------------------------------------------
// Required SocialPoster ABI Exports
// ---------------------------------------------------------------------------

/// Returns plugin metadata, capabilities, and credential field definitions.
#[plugin_fn]
pub fn describe() -> FnResult<Json<DescribeOutput>> {
    Ok(Json(DescribeOutput {
        id: "example-social",
        version: "1.0.0",
        display_name: "Example Social",
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
        credential_fields: vec![
            // 1. Required secret
            CredentialField {
                key: "api_token",
                label: "API Token",
                secret: true,
                required: true,
            },
            // 2. Required plain text
            CredentialField {
                key: "handle",
                label: "Account Handle",
                secret: false,
                required: true,
            },
            // 3. Optional plain text
            CredentialField {
                key: "instance_url",
                label: "Instance URL",
                secret: false,
                required: false,
            },
            // 4. Optional secret
            CredentialField {
                key: "webhook_secret",
                label: "Webhook Signing Secret",
                secret: true,
                required: false,
            },
        ],
    }))
}

/// Verifies user credentials against the target platform's authentication endpoint.
#[plugin_fn]
pub fn validate_auth(Json(input): Json<ValidateAuthInput>) -> FnResult<Json<ValidateAuthOutput>> {
    let token = input
        .credentials
        .get("api_token")
        .map(String::as_str)
        .unwrap_or("");
    let handle = input
        .credentials
        .get("handle")
        .map(String::as_str)
        .unwrap_or("");

    if token.is_empty() || handle.is_empty() {
        return Ok(Json(ValidateAuthOutput {
            valid: false,
            error: Some("Both api_token and handle are required.".to_string()),
        }));
    }

    let url = format!("{}/v1/accounts/verify_credentials", resolve_base_url(&input.credentials));
    let req = HttpRequest::new(&url)
        .with_method("GET")
        .with_header("Authorization", format!("Bearer {token}"))
        .with_header("Accept", "application/json");

    let res = http::request(&req, None)?;
    if res.status_code() >= 200 && res.status_code() < 300 {
        Ok(Json(ValidateAuthOutput {
            valid: true,
            error: None,
        }))
    } else {
        Ok(Json(ValidateAuthOutput {
            valid: false,
            error: Some(format!(
                "Authorisation failed with HTTP status {}.",
                res.status_code()
            )),
        }))
    }
}

/// Publishes a post with optional media attachments (including alt-text) and thread parent ID.
#[plugin_fn]
pub fn publish(Json(input): Json<PublishInput>) -> FnResult<Json<PublishOutput>> {
    let token = input
        .credentials
        .get("api_token")
        .ok_or_else(|| Error::msg("Missing required credential: api_token"))?;
    let base_url = resolve_base_url(&input.credentials);

    // 1. Upload any media attachments to the dedicated upload domain first.
    let mut media_ids: Vec<String> = Vec::with_capacity(input.attachments.len());
    for attachment in &input.attachments {
        let upload_payload = serde_json::json!({
            "filename": attachment.filename,
            "mime_type": attachment.mime_type,
            "data_base64": attachment.data_base64,
            "alt_text": attachment.alt_text,
        });
        let upload_req = HttpRequest::new("https://upload.example.com/v1/media")
            .with_method("POST")
            .with_header("Authorization", format!("Bearer {token}"))
            .with_header("Content-Type", "application/json");

        let upload_res = http::request(&upload_req, Some(serde_json::to_vec(&upload_payload)?))?;
        if upload_res.status_code() < 200 || upload_res.status_code() >= 300 {
            return Err(Error::msg(format!(
                "Media upload failed with HTTP status {}.",
                upload_res.status_code()
            )));
        }

        let parsed: serde_json::Value = serde_json::from_slice(&upload_res.body())?;
        if let Some(id) = parsed.get("media_id").and_then(|v| v.as_str()) {
            media_ids.push(id.to_string());
        }
    }

    // 2. Create the post, attaching uploaded media IDs and optional thread reply_to_id.
    let post_payload = serde_json::json!({
        "text": input.text,
        "media_ids": media_ids,
        "reply_to_id": input.reply_to_id,
    });

    let post_url = format!("{base_url}/v1/posts");
    let post_req = HttpRequest::new(&post_url)
        .with_method("POST")
        .with_header("Authorization", format!("Bearer {token}"))
        .with_header("Content-Type", "application/json");

    let post_res = http::request(&post_req, Some(serde_json::to_vec(&post_payload)?))?;
    if post_res.status_code() < 200 || post_res.status_code() >= 300 {
        return Err(Error::msg(format!(
            "Publish failed with HTTP status {}.",
            post_res.status_code()
        )));
    }

    let body: serde_json::Value = serde_json::from_slice(&post_res.body())?;
    let post_id = body
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("post_unknown")
        .to_string();
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("{base_url}/posts/{post_id}"));

    Ok(Json(PublishOutput { post_id, url }))
}

/// Deletes a previously published post by its `post_id`.
#[plugin_fn]
pub fn delete_post(Json(input): Json<DeletePostInput>) -> FnResult<Json<DeletePostOutput>> {
    let token = input
        .credentials
        .get("api_token")
        .ok_or_else(|| Error::msg("Missing required credential: api_token"))?;
    if input.post_id.trim().is_empty() {
        return Err(Error::msg("post_id must not be empty."));
    }

    let url = format!("{}/v1/posts/{}", resolve_base_url(&input.credentials), input.post_id);
    let req = HttpRequest::new(&url)
        .with_method("DELETE")
        .with_header("Authorization", format!("Bearer {token}"));

    let res = http::request(&req, None)?;
    if res.status_code() >= 200 && res.status_code() < 300 {
        Ok(Json(DeletePostOutput { deleted: true }))
    } else {
        Err(Error::msg(format!(
            "Delete failed with HTTP status {}.",
            res.status_code()
        )))
    }
}
