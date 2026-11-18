"""Reference SocialPoster WebAssembly plugin in Python (extism-py).

Compile with:
    extism-py plugin.py -o ../output/example-social-python.wasm
"""

import json
from typing import Any, Dict, List
import extism


def _resolve_base_url(credentials: Dict[str, str]) -> str:
    """Resolve the API base URL, honouring an optional custom instance_url."""
    custom = (credentials.get("instance_url") or "").strip().rstrip("/")
    return custom if custom else "https://api.example.com"


# ---------------------------------------------------------------------------
# Required SocialPoster ABI Exports
# ---------------------------------------------------------------------------


@extism.plugin_fn
def describe() -> None:
    """Return plugin metadata, capabilities, and credential field definitions."""
    metadata: Dict[str, Any] = {
        "id": "example-social",
        "version": "1.0.0",
        "display_name": "Example Social",
        "brand_colour": "#5B4BFF",
        "icon_svg": (
            '<svg viewBox="0 0 24 24" fill="none">'
            '<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/>'
            '<path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" '
            'stroke-linecap="round" stroke-linejoin="round"/>'
            "</svg>"
        ),
        "max_characters": 500,
        "max_attachments": 4,
        "supported_media_types": [
            "image/jpeg",
            "image/png",
            "image/webp",
            "video/mp4",
        ],
        "supports_alt_text": True,
        "supports_threads": True,
        "supports_delete": True,
        "allowed_domains": ["api.example.com", "upload.example.com"],
        "credential_fields": [
            # 1. Required secret
            {
                "key": "api_token",
                "label": "API Token",
                "secret": True,
                "required": True,
            },
            # 2. Required plain text
            {
                "key": "handle",
                "label": "Account Handle",
                "secret": False,
                "required": True,
            },
            # 3. Optional plain text
            {
                "key": "instance_url",
                "label": "Instance URL",
                "secret": False,
                "required": False,
            },
            # 4. Optional secret
            {
                "key": "webhook_secret",
                "label": "Webhook Signing Secret",
                "secret": True,
                "required": False,
            },
        ],
    }
    extism.output_str(json.dumps(metadata))


@extism.plugin_fn
def validate_auth() -> None:
    """Verify user credentials against the target platform's authentication endpoint."""
    payload = json.loads(extism.input_str() or "{}")
    credentials = payload.get("credentials") or {}
    token = (credentials.get("api_token") or "").strip()
    handle = (credentials.get("handle") or "").strip()

    if not token or not handle:
        extism.output_str(
            json.dumps(
                {
                    "valid": False,
                    "error": "Both api_token and handle are required.",
                }
            )
        )
        return

    base_url = _resolve_base_url(credentials)
    res = extism.Http.request(
        f"{base_url}/v1/accounts/verify_credentials",
        meth="GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )

    if 200 <= res.status_code < 300:
        extism.output_str(json.dumps({"valid": True}))
    else:
        extism.output_str(
            json.dumps(
                {
                    "valid": False,
                    "error": f"Authorisation failed with HTTP status {res.status_code}.",
                }
            )
        )


@extism.plugin_fn
def publish() -> None:
    """Publish a post with optional media attachments (including alt-text) and reply_to_id."""
    payload = json.loads(extism.input_str() or "{}")
    credentials = payload.get("credentials") or {}
    token = credentials.get("api_token")
    if not token:
        raise ValueError("Missing required credential: api_token")

    base_url = _resolve_base_url(credentials)
    text = payload.get("text", "")
    attachments = payload.get("attachments") or []
    reply_to_id = payload.get("reply_to_id")

    # 1. Upload media attachments (preserving alt_text) to upload.example.com.
    media_ids: List[str] = []
    for att in attachments:
        upload_body = json.dumps(
            {
                "filename": att.get("filename", ""),
                "mime_type": att.get("mime_type", ""),
                "data_base64": att.get("data_base64", ""),
                "alt_text": att.get("alt_text"),
            }
        )
        upload_res = extism.Http.request(
            "https://upload.example.com/v1/media",
            meth="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            data=upload_body,
        )
        if not (200 <= upload_res.status_code < 300):
            raise RuntimeError(
                f"Media upload failed with HTTP status {upload_res.status_code}."
            )

        uploaded = json.loads(upload_res.data_str() or "{}")
        if uploaded.get("media_id"):
            media_ids.append(uploaded["media_id"])

    # 2. Create the post, attaching uploaded media IDs and optional reply_to_id.
    post_body = json.dumps(
        {
            "text": text,
            "media_ids": media_ids,
            "reply_to_id": reply_to_id,
        }
    )
    post_res = extism.Http.request(
        f"{base_url}/v1/posts",
        meth="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        data=post_body,
    )
    if not (200 <= post_res.status_code < 300):
        raise RuntimeError(f"Publish failed with HTTP status {post_res.status_code}.")

    created = json.loads(post_res.data_str() or "{}")
    post_id = created.get("id") or "post_unknown"
    url = created.get("url") or f"{base_url}/posts/{post_id}"

    extism.output_str(json.dumps({"post_id": post_id, "url": url}))


@extism.plugin_fn
def delete_post() -> None:
    """Delete a previously published post by its post_id."""
    payload = json.loads(extism.input_str() or "{}")
    credentials = payload.get("credentials") or {}
    token = credentials.get("api_token")
    if not token:
        raise ValueError("Missing required credential: api_token")

    post_id = (payload.get("post_id") or "").strip()
    if not post_id:
        raise ValueError("post_id must not be empty.")

    base_url = _resolve_base_url(credentials)
    res = extism.Http.request(
        f"{base_url}/v1/posts/{post_id}",
        meth="DELETE",
        headers={"Authorization": f"Bearer {token}"},
    )
    if not (200 <= res.status_code < 300):
        raise RuntimeError(f"Delete failed with HTTP status {res.status_code}.")

    extism.output_str(json.dumps({"deleted": True}))
