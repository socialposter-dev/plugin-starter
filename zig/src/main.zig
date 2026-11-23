//! Reference SocialPoster 1.0.0 WebAssembly plugin in Zig (extism/zig-pdk).
//!
//! Compile with:
//!   zig build -Doptimize=ReleaseSmall
//! (emits `../output/example-social-zig.wasm`).

const std = @import("std");
const extism_pdk = @import("extism-pdk");
const Plugin = extism_pdk.Plugin;

const allocator = std.heap.wasm_allocator;

// ---------------------------------------------------------------------------
// SocialPoster 1.0.0 Host Functions (extism:host/user)
// ---------------------------------------------------------------------------

extern "extism:host/user" fn sp_credential(key_ptr: u64) u64;
extern "extism:host/user" fn sp_media_chunk(req_ptr: u64) u64;
extern "extism:host/user" fn sp_http(req_ptr: u64) u64;

// ---------------------------------------------------------------------------
// ABI Data Structures
// ---------------------------------------------------------------------------

const AuthorLink = struct {
    label: []const u8,
    url: []const u8,
};

const Author = struct {
    name: []const u8,
    links: []const AuthorLink,
};

const CredentialField = struct {
    key: []const u8,
    label: []const u8,
    secret: bool,
    required: bool,
};

const AuthMode = struct {
    id: []const u8,
    label: []const u8,
    description: []const u8,
    setup_instructions: []const u8,
    fields: []const CredentialField,
};

const DescribeOutput = struct {
    id: []const u8,
    version: []const u8,
    compatible_app_version: []const u8,
    display_name: []const u8,
    authors: []const Author,
    brand_colour: []const u8,
    icon_svg: []const u8,
    max_characters: u32,
    max_attachments: u32,
    supported_media_types: []const []const u8,
    supports_alt_text: bool,
    supports_threads: bool,
    supports_delete: bool,
    allowed_domains: []const []const u8,
    auth_modes: []const AuthMode,
};

const ValidateAuthOutput = struct {
    valid: bool,
    @"error": ?[]const u8 = null,
};

const Attachment = struct {
    attachment_id: []const u8 = "",
    mime_type: []const u8 = "",
    filename: []const u8 = "",
    size_bytes: usize = 0,
    alt_text: ?[]const u8 = null,
};

const PublishInput = struct {
    text: []const u8 = "",
    attachments: []const Attachment = &.{},
    reply_to_id: ?[]const u8 = null,
};

const PublishOutput = struct {
    post_id: []const u8,
    url: []const u8,
};

const DeletePostInput = struct {
    post_id: []const u8 = "",
};

const DeletePostOutput = struct {
    deleted: bool,
};

const SpHttpResponse = struct {
    status: u16 = 0,
    body: []const u8 = "",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn readCredential(plugin: Plugin, key: []const u8) []const u8 {
    const key_mem = plugin.allocateBytes(key);
    defer key_mem.free();

    const ptr = sp_credential(key_mem.offset);
    if (ptr == 0) return "";
    const mem = plugin.findMemory(ptr);
    defer mem.free();
    return mem.loadAlloc(allocator) catch "";
}

fn activeAuthMode(plugin: Plugin) []const u8 {
    const raw = std.mem.trim(u8, readCredential(plugin, "__auth_mode"), " \t\r\n");
    if (raw.len == 0) return "api_key";
    return raw;
}

fn modeTokenKey(mode: []const u8) []const u8 {
    if (std.mem.eql(u8, mode, "webhook_app")) return "app_token";
    return "api_token";
}

fn resolveBaseUrl(plugin: Plugin) []const u8 {
    const raw = readCredential(plugin, "instance_url");
    const trimmed = std.mem.trimRight(u8, std.mem.trim(u8, raw, " \t\r\n"), "/");
    if (trimmed.len > 0) return trimmed;
    return "https://api.example.com";
}

fn callSpHttp(plugin: Plugin, method: []const u8, url: []const u8, auth_header: []const u8, content_type: ?[]const u8, body: ?[]const u8) !SpHttpResponse {
    const req_json = if (content_type) |ct|
        try std.json.stringifyAlloc(allocator, .{
            .method = method,
            .url = url,
            .headers = .{
                .Authorization = auth_header,
                .@"Content-Type" = ct,
            },
            .body = body,
        }, .{})
    else
        try std.json.stringifyAlloc(allocator, .{
            .method = method,
            .url = url,
            .headers = .{
                .Authorization = auth_header,
            },
            .body = body,
        }, .{});
    defer allocator.free(req_json);

    const req_mem = plugin.allocateBytes(req_json);
    defer req_mem.free();

    const res_ptr = sp_http(req_mem.offset);
    if (res_ptr == 0) return error.NullHostResponse;

    const res_mem = plugin.findMemory(res_ptr);
    defer res_mem.free();
    const res_bytes = try res_mem.loadAlloc(allocator);
    defer allocator.free(res_bytes);

    const parsed = try std.json.parseFromSlice(SpHttpResponse, allocator, res_bytes, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
    return parsed.value;
}

fn streamAttachmentBytes(plugin: Plugin, attachment_id: []const u8) ![]u8 {
    const chunk_size: usize = 65_536;
    var out = std.ArrayList(u8).init(allocator);
    var offset: usize = 0;

    while (true) {
        const req_json = try std.json.stringifyAlloc(allocator, .{
            .attachment_id = attachment_id,
            .offset = offset,
            .length = chunk_size,
        }, .{});
        const req_mem = plugin.allocateBytes(req_json);
        const chunk_ptr = sp_media_chunk(req_mem.offset);
        req_mem.free();
        allocator.free(req_json);

        if (chunk_ptr == 0) break;
        const chunk_mem = plugin.findMemory(chunk_ptr);
        const chunk = try chunk_mem.loadAlloc(allocator);
        chunk_mem.free();

        if (chunk.len == 0) {
            allocator.free(chunk);
            break;
        }
        try out.appendSlice(chunk);
        const read_len = chunk.len;
        allocator.free(chunk);
        offset += read_len;
        if (read_len < chunk_size) break;
    }
    return out.toOwnedSlice();
}

// ---------------------------------------------------------------------------
// Required SocialPoster 1.0.0 ABI Exports
// ---------------------------------------------------------------------------

/// Returns plugin metadata, capabilities, and `auth_modes` definitions.
export fn describe() i32 {
    const plugin = Plugin.init(allocator);
    const meta = DescribeOutput{
        .id = "example-social-zig",
        .version = "1.0.0",
        .compatible_app_version = "^1.0.0",
        .display_name = "Example Social",
        .authors = &.{.{
            .name = "Your Name",
            .links = &.{.{ .label = "Website", .url = "https://example.com" }},
        }},
        .brand_colour = "#5B4BFF",
        .icon_svg = "<svg viewBox=\"0 0 24 24\" fill=\"none\"><circle cx=\"12\" cy=\"12\" r=\"10\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M8 12l3 3 5-6\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>",
        .max_characters = 500,
        .max_attachments = 4,
        .supported_media_types = &.{
            "image/jpeg",
            "image/png",
            "image/webp",
            "video/mp4",
        },
        .supports_alt_text = true,
        .supports_threads = true,
        .supports_delete = true,
        .allowed_domains = &.{
            "api.example.com",
            "upload.example.com",
        },
        .auth_modes = &.{
            .{
                .id = "api_key",
                .label = "API Key",
                .description = "Authenticate using a personal API token and account handle.",
                .setup_instructions = "1. Open **Settings -> Developer** on Example Social.\n2. Create a new **API Token** with publish and delete permissions.\n3. Paste your token and account handle below.",
                .fields = &.{
                    .{ .key = "api_token", .label = "API Token", .secret = true, .required = true },
                    .{ .key = "handle", .label = "Account Handle", .secret = false, .required = true },
                    .{ .key = "instance_url", .label = "Instance URL", .secret = false, .required = false },
                },
            },
            .{
                .id = "webhook_app",
                .label = "App Credentials",
                .description = "Authenticate using an application token and optional webhook signing secret.",
                .setup_instructions = "1. Register an application in the **Example Social App Portal**.\n2. Copy the **App Token** and optional **Webhook Signing Secret**.",
                .fields = &.{
                    .{ .key = "app_token", .label = "App Token", .secret = true, .required = true },
                    .{ .key = "webhook_secret", .label = "Webhook Signing Secret", .secret = true, .required = false },
                },
            },
        },
    };

    plugin.outputJson(meta, .{}) catch {
        plugin.setError("Failed to serialise describe() metadata.");
        return 1;
    };
    return 0;
}

/// Verifies credentials for the active `__auth_mode` via `sp_credential` and `sp_http`.
export fn validate_auth() i32 {
    const plugin = Plugin.init(allocator);
    const mode = activeAuthMode(plugin);
    const token = std.mem.trim(u8, readCredential(plugin, modeTokenKey(mode)), " \t\r\n");

    if (token.len == 0) {
        const msg = std.fmt.allocPrint(allocator, "Missing required token for authentication mode '{s}'.", .{mode}) catch return 1;
        plugin.outputJson(ValidateAuthOutput{
            .valid = false,
            .@"error" = msg,
        }, .{ .emit_null_optional_fields = false }) catch return 1;
        return 0;
    }

    if (std.mem.eql(u8, mode, "api_key")) {
        const handle = std.mem.trim(u8, readCredential(plugin, "handle"), " \t\r\n");
        if (handle.len == 0) {
            plugin.outputJson(ValidateAuthOutput{
                .valid = false,
                .@"error" = "Account Handle is required for API Key mode.",
            }, .{ .emit_null_optional_fields = false }) catch return 1;
            return 0;
        }
    }

    const base_url = resolveBaseUrl(plugin);
    const url = std.fmt.allocPrint(allocator, "{s}/v1/accounts/verify_credentials", .{base_url}) catch return 1;
    defer allocator.free(url);

    const auth_header = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch return 1;
    defer allocator.free(auth_header);

    const res = callSpHttp(plugin, "GET", url, auth_header, null, null) catch {
        plugin.setError("Authorisation HTTP request failed.");
        return 1;
    };

    if (res.status >= 200 and res.status < 300) {
        plugin.outputJson(ValidateAuthOutput{ .valid = true }, .{ .emit_null_optional_fields = false }) catch return 1;
    } else {
        const msg = std.fmt.allocPrint(allocator, "Authorisation failed with HTTP status {d}.", .{res.status}) catch return 1;
        defer allocator.free(msg);
        plugin.outputJson(ValidateAuthOutput{
            .valid = false,
            .@"error" = msg,
        }, .{ .emit_null_optional_fields = false }) catch return 1;
    }
    return 0;
}

/// Publishes a post, streaming attachments via `sp_media_chunk` and prefixing `post_id` with `<mode>:`.
export fn publish() i32 {
    const plugin = Plugin.init(allocator);
    const input = plugin.getJson(PublishInput) catch {
        plugin.setError("Invalid input JSON.");
        return 1;
    };

    const mode = activeAuthMode(plugin);
    const token = std.mem.trim(u8, readCredential(plugin, modeTokenKey(mode)), " \t\r\n");
    if (token.len == 0) {
        plugin.setErrorFmt("Missing required credential for mode '{s}'.", .{mode}) catch return 1;
        return 1;
    }

    const base_url = resolveBaseUrl(plugin);
    const auth_header = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch return 1;
    defer allocator.free(auth_header);

    // 1. Stream each attachment via `sp_media_chunk` and upload via `sp_http`.
    var media_ids = std.ArrayList([]const u8).init(allocator);
    defer media_ids.deinit();

    for (input.attachments) |att| {
        const raw_bytes = streamAttachmentBytes(plugin, att.attachment_id) catch {
            plugin.setError("Failed to stream media attachment.");
            return 1;
        };
        defer allocator.free(raw_bytes);

        const upload_payload = std.json.stringifyAlloc(allocator, .{
            .filename = att.filename,
            .mime_type = att.mime_type,
            .byte_length = raw_bytes.len,
            .alt_text = att.alt_text,
        }, .{}) catch return 1;
        defer allocator.free(upload_payload);

        const upload_res = callSpHttp(plugin, "POST", "https://upload.example.com/v1/media", auth_header, "application/json", upload_payload) catch {
            plugin.setError("Media upload request failed.");
            return 1;
        };

        if (upload_res.status < 200 or upload_res.status >= 300) {
            plugin.setErrorFmt("Media upload failed with HTTP status {d}.", .{upload_res.status}) catch return 1;
            return 1;
        }

        const UploadResp = struct { media_id: ?[]const u8 = null };
        if (std.json.parseFromSlice(UploadResp, allocator, upload_res.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always })) |parsed| {
            if (parsed.value.media_id) |mid| {
                media_ids.append(mid) catch {};
            }
        } else |_| {}
    }

    // 2. Create the post via `sp_http`, attaching media IDs and optional `reply_to_id`.
    const post_payload = std.json.stringifyAlloc(allocator, .{
        .text = input.text,
        .media_ids = media_ids.items,
        .reply_to_id = input.reply_to_id,
    }, .{}) catch return 1;
    defer allocator.free(post_payload);

    const post_url = std.fmt.allocPrint(allocator, "{s}/v1/posts", .{base_url}) catch return 1;
    defer allocator.free(post_url);

    const post_res = callSpHttp(plugin, "POST", post_url, auth_header, "application/json", post_payload) catch {
        plugin.setError("Publish HTTP request failed.");
        return 1;
    };

    if (post_res.status < 200 or post_res.status >= 300) {
        plugin.setErrorFmt("Publish failed with HTTP status {d}.", .{post_res.status}) catch return 1;
        return 1;
    }

    const PostResp = struct {
        id: ?[]const u8 = null,
        url: ?[]const u8 = null,
    };
    var raw_id: []const u8 = "post_unknown";
    var result_url: ?[]const u8 = null;
    if (std.json.parseFromSlice(PostResp, allocator, post_res.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always })) |parsed| {
        if (parsed.value.id) |pid| raw_id = pid;
        if (parsed.value.url) |u| result_url = u;
    } else |_| {}

    const prefixed_id = std.fmt.allocPrint(allocator, "{s}:{s}", .{ mode, raw_id }) catch return 1;
    const final_url = result_url orelse (std.fmt.allocPrint(allocator, "{s}/posts/{s}", .{ base_url, raw_id }) catch return 1);
    plugin.outputJson(PublishOutput{
        .post_id = prefixed_id,
        .url = final_url,
    }, .{}) catch return 1;
    return 0;
}

/// Deletes a previously published post, routing via the `<mode>:` prefix on `post_id`.
export fn delete_post() i32 {
    const plugin = Plugin.init(allocator);
    const input = plugin.getJson(DeletePostInput) catch {
        plugin.setError("Invalid input JSON.");
        return 1;
    };

    const trimmed = std.mem.trim(u8, input.post_id, " \t\r\n");
    if (trimmed.len == 0) {
        plugin.setError("post_id must not be empty.");
        return 1;
    }

    var mode = activeAuthMode(plugin);
    var raw_id = trimmed;
    if (std.mem.indexOfScalar(u8, trimmed, ':')) |idx| {
        if (idx > 0 and idx + 1 < trimmed.len) {
            mode = trimmed[0..idx];
            raw_id = trimmed[idx + 1 ..];
        }
    }

    const token = std.mem.trim(u8, readCredential(plugin, modeTokenKey(mode)), " \t\r\n");
    if (token.len == 0) {
        plugin.setErrorFmt("Missing required credential for mode '{s}'.", .{mode}) catch return 1;
        return 1;
    }

    const base_url = resolveBaseUrl(plugin);
    const url = std.fmt.allocPrint(allocator, "{s}/v1/posts/{s}", .{ base_url, raw_id }) catch return 1;
    defer allocator.free(url);

    const auth_header = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch return 1;
    defer allocator.free(auth_header);

    const res = callSpHttp(plugin, "DELETE", url, auth_header, null, null) catch {
        plugin.setError("Delete HTTP request failed.");
        return 1;
    };

    if (res.status < 200 or res.status >= 300) {
        plugin.setErrorFmt("Delete failed with HTTP status {d}.", .{res.status}) catch return 1;
        return 1;
    }

    plugin.outputJson(DeletePostOutput{ .deleted = true }, .{}) catch return 1;
    return 0;
}
