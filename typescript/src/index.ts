/**
 * Reference SocialPoster WebAssembly plugin in TypeScript.
 *
 * Compile with:
 *   npm run build
 * (runs `tsc --noEmit`, bundles with `esbuild`, and compiles with `extism-js`).
 */

interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
}

interface DescribeOutput {
  id: string;
  version: string;
  display_name: string;
  brand_colour: string;
  icon_svg: string;
  max_characters: number;
  max_attachments: number;
  supported_media_types: string[];
  supports_alt_text: boolean;
  supports_threads: boolean;
  supports_delete: boolean;
  allowed_domains: string[];
  credential_fields: CredentialField[];
}

interface Attachment {
  data_base64: string;
  mime_type: string;
  filename: string;
  alt_text?: string;
}

interface PublishInput {
  credentials: Record<string, string>;
  text: string;
  attachments?: Attachment[];
  reply_to_id?: string;
}

interface DeletePostInput {
  credentials: Record<string, string>;
  post_id: string;
}

function resolveBaseUrl(credentials: Record<string, string>): string {
  const custom = (credentials.instance_url ?? "").trim().replace(/\/+$/, "");
  return custom.length > 0 ? custom : "https://api.example.com";
}

// ---------------------------------------------------------------------------
// Required SocialPoster ABI Exports
// ---------------------------------------------------------------------------

/** Returns plugin metadata, capabilities, and credential field definitions. */
export function describe(): number {
  const metadata: DescribeOutput = {
    id: "example-social",
    version: "1.0.0",
    display_name: "Example Social",
    brand_colour: "#5B4BFF",
    icon_svg:
      '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M8 12l3 3 5-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    max_characters: 500,
    max_attachments: 4,
    supported_media_types: ["image/jpeg", "image/png", "image/webp", "video/mp4"],
    supports_alt_text: true,
    supports_threads: true,
    supports_delete: true,
    allowed_domains: ["api.example.com", "upload.example.com"],
    credential_fields: [
      // 1. Required secret
      { key: "api_token", label: "API Token", secret: true, required: true },
      // 2. Required plain text
      { key: "handle", label: "Account Handle", secret: false, required: true },
      // 3. Optional plain text
      { key: "instance_url", label: "Instance URL", secret: false, required: false },
      // 4. Optional secret
      { key: "webhook_secret", label: "Webhook Signing Secret", secret: true, required: false },
    ],
  };

  Host.outputString(JSON.stringify(metadata));
  return 0;
}

/** Verifies user credentials against the target platform's authentication endpoint. */
export function validate_auth(): number {
  const input = JSON.parse(Host.inputString()) as {
    credentials: Record<string, string>;
  };
  const credentials = input.credentials ?? {};
  const token = (credentials.api_token ?? "").trim();
  const handle = (credentials.handle ?? "").trim();

  if (!token || !handle) {
    Host.outputString(
      JSON.stringify({
        valid: false,
        error: "Both api_token and handle are required.",
      })
    );
    return 0;
  }

  const baseUrl = resolveBaseUrl(credentials);
  const res = Http.request({
    url: `${baseUrl}/v1/accounts/verify_credentials`,
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  if (res.status >= 200 && res.status < 300) {
    Host.outputString(JSON.stringify({ valid: true }));
  } else {
    Host.outputString(
      JSON.stringify({
        valid: false,
        error: `Authorisation failed with HTTP status ${res.status}.`,
      })
    );
  }
  return 0;
}

/** Publishes a post with optional media attachments (including alt-text) and thread parent ID. */
export function publish(): number {
  const input = JSON.parse(Host.inputString()) as PublishInput;
  const credentials = input.credentials ?? {};
  const token = credentials.api_token;
  if (!token) {
    throw new Error("Missing required credential: api_token");
  }

  const baseUrl = resolveBaseUrl(credentials);
  const mediaIds: string[] = [];

  // 1. Upload media attachments (preserving alt_text) to upload.example.com.
  for (const att of input.attachments ?? []) {
    const uploadRes = Http.request(
      {
        url: "https://upload.example.com/v1/media",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      JSON.stringify({
        filename: att.filename,
        mime_type: att.mime_type,
        data_base64: att.data_base64,
        alt_text: att.alt_text,
      })
    );

    if (uploadRes.status < 200 || uploadRes.status >= 300) {
      throw new Error(`Media upload failed with HTTP status ${uploadRes.status}.`);
    }

    const uploaded = JSON.parse(uploadRes.body) as { media_id?: string };
    if (uploaded.media_id) {
      mediaIds.push(uploaded.media_id);
    }
  }

  // 2. Publish the post, including optional reply_to_id for threads.
  const postRes = Http.request(
    {
      url: `${baseUrl}/v1/posts`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
    JSON.stringify({
      text: input.text,
      media_ids: mediaIds,
      reply_to_id: input.reply_to_id,
    })
  );

  if (postRes.status < 200 || postRes.status >= 300) {
    throw new Error(`Publish failed with HTTP status ${postRes.status}.`);
  }

  const created = JSON.parse(postRes.body || "{}") as { id?: string; url?: string };
  const postId = created.id ?? "post_unknown";
  const url = created.url ?? `${baseUrl}/posts/${postId}`;

  Host.outputString(JSON.stringify({ post_id: postId, url }));
  return 0;
}

/** Deletes a previously published post by its `post_id`. */
export function delete_post(): number {
  const input = JSON.parse(Host.inputString()) as DeletePostInput;
  const credentials = input.credentials ?? {};
  const token = credentials.api_token;
  if (!token) {
    throw new Error("Missing required credential: api_token");
  }
  if (!input.post_id || input.post_id.trim().length === 0) {
    throw new Error("post_id must not be empty.");
  }

  const baseUrl = resolveBaseUrl(credentials);
  const res = Http.request({
    url: `${baseUrl}/v1/posts/${encodeURIComponent(input.post_id)}`,
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Delete failed with HTTP status ${res.status}.`);
  }

  Host.outputString(JSON.stringify({ deleted: true }));
  return 0;
}
