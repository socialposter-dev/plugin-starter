//! Reference SocialPoster WebAssembly plugin in Zig (extism/zig-pdk).
//!
//! Compile with:
//!   zig build -Doptimize=ReleaseSmall
//! (emits `../output/example-social-zig.wasm`).

const std = @import("std");
const extism_pdk = @import("extism-pdk");
const Plugin = extism_pdk.Plugin;
const http = extism_pdk.http;

const allocator = std.heap.wasm_allocator;

// ---------------------------------------------------------------------------
// ABI Data Structures
// ---------------------------------------------------------------------------

const CredentialField = struct {
    key: []const u8,
    label: []const u8,
    secret: bool,
    required: bool,
};

const DescribeOutput = struct {
    id: []const u8,
    version: []const u8,
    display_name: []const u8,
    brand_colour: []const u8,
    icon_svg: []const u8,
    max_characters: u32,
    max_attachments: u32,
    supported_media_types: []const []const u8,
    supports_alt_text: bool,
    supports_threads: bool,
    supports_delete: bool,
    allowed_domains: []const []const u8,
    credential_fields: []const CredentialField,
};

const Credentials = struct {
    api_token: ?[]const u8 = null,
    handle: ?[]const u8 = null,
    instance_url: ?[]const u8 = null,
    webhook_secret: ?[]const u8 = null,
};

const ValidateAuthInput = struct {
    credentials: Credentials = .{},
};

const ValidateAuthOutput = struct {
    valid: bool,
    @"error": ?[]const u8 = null,
};

const Attachment = struct {
    data_base64: []const u8 = "",
    mime_type: []const u8 = "",
    filename: []const u8 = "",
    alt_text: ?[]const u8 = null,
};

const PublishInput = struct {
    credentials: Credentials = .{},
    text: []const u8 = "",
    attachments: []const Attachment = &.{},
    reply_to_id: ?[]const u8 = null,
};

const PublishOutput = struct {
    post_id: []const u8,
    url: []const u8,
};

const DeletePostInput = struct {
    credentials: Credentials = .{},
    post_id: []const u8 = "",
};

const DeletePostOutput = struct {
    deleted: bool,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn resolveBaseUrl(creds: Credentials) []const u8 {
    if (creds.instance_url) |raw| {
        const trimmed = std.mem.trimRight(u8, std.mem.trim(u8, raw, " \t\r\n"), "/");
        if (trimmed.len > 0) {
            return trimmed;
        }
    }
    return "https://api.example.com";
}

// ---------------------------------------------------------------------------
// Required SocialPoster ABI Exports
// ---------------------------------------------------------------------------

/// Returns plugin metadata, capabilities, and credential field definitions.
export fn describe() i32 {
    const plugin = Plugin.init(allocator);
    const meta = DescribeOutput{
        .id = "example-social-zig",
        .version = "1.0.0",
        .display_name = "Example Social",
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
        .credential_fields = &.{
            // 1. Required secret
            .{ .key = "api_token", .label = "API Token", .secret = true, .required = true },
            // 2. Required plain text
            .{ .key = "handle", .label = "Account Handle", .secret = false, .required = true },
            // 3. Optional plain text
            .{ .key = "instance_url", .label = "Instance URL", .secret = false, .required = false },
            // 4. Optional secret
            .{ .key = "webhook_secret", .label = "Webhook Signing Secret", .secret = true, .required = false },
        },
    };

    plugin.outputJson(meta, .{}) catch {
        plugin.setError("Failed to serialise describe() metadata.");
        return 1;
    };
    return 0;
}

/// Verifies user credentials against the target platform's authentication endpoint.
export fn validate_auth() i32 {
    const plugin = Plugin.init(allocator);
    const input = plugin.getJson(ValidateAuthInput) catch {
        plugin.setError("Invalid input JSON.");
        return 1;
    };

    const token = std.mem.trim(u8, input.credentials.api_token orelse "", " \t\r\n");
    const handle = std.mem.trim(u8, input.credentials.handle orelse "", " \t\r\n");
    if (token.len == 0 or handle.len == 0) {
        plugin.outputJson(ValidateAuthOutput{
            .valid = false,
            .@"error" = "Both api_token and handle are required.",
        }, .{ .emit_null_optional_fields = false }) catch return 1;
        return 0;
    }

    const base_url = resolveBaseUrl(input.credentials);
    const url = std.fmt.allocPrint(allocator, "{s}/v1/accounts/verify_credentials", .{base_url}) catch return 1;
    defer allocator.free(url);

    const auth_header = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch return 1;
    defer allocator.free(auth_header);

    var req = http.HttpRequest.init("GET", url);
    defer req.deinit(allocator);
    req.setHeader(allocator, "Authorization", auth_header) catch return 1;
    req.setHeader(allocator, "Accept", "application/json") catch return 1;

    const res = plugin.request(req, null) catch {
        plugin.setError("Authorisation HTTP request failed.");
        return 1;
    };
    defer res.deinit();

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

/// Publishes a post with optional media attachments (including alt-text) and thread parent ID.
export fn publish() i32 {
    const plugin = Plugin.init(allocator);
    const input = plugin.getJson(PublishInput) catch {
        plugin.setError("Invalid input JSON.");
        return 1;
    };

    const token = input.credentials.api_token orelse "";
    if (token.len == 0) {
        plugin.setError("Missing required credential: api_token");
        return 1;
    }

    const base_url = resolveBaseUrl(input.credentials);
    const auth_header = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch return 1;
    defer allocator.free(auth_header);

    // 1. Upload media attachments (preserving alt_text) to upload.example.com.
    var media_ids = std.ArrayList([]const u8).init(allocator);
    defer media_ids.deinit();

    for (input.attachments) |att| {
        const upload_payload = std.json.stringifyAlloc(allocator, .{
            .filename = att.filename,
            .mime_type = att.mime_type,
            .data_base64 = att.data_base64,
            .alt_text = att.alt_text,
        }, .{}) catch return 1;
        defer allocator.free(upload_payload);

        var upload_req = http.HttpRequest.init("POST", "https://upload.example.com/v1/media");
        defer upload_req.deinit(allocator);
        upload_req.setHeader(allocator, "Authorization", auth_header) catch return 1;
        upload_req.setHeader(allocator, "Content-Type", "application/json") catch return 1;

        const upload_res = plugin.request(upload_req, upload_payload) catch {
            plugin.setError("Media upload request failed.");
            return 1;
        };
        defer upload_res.deinit();

        if (upload_res.status < 200 or upload_res.status >= 300) {
            plugin.setErrorFmt("Media upload failed with HTTP status {d}.", .{upload_res.status}) catch return 1;
            return 1;
        }

        const UploadResp = struct { media_id: ?[]const u8 = null };
        const up_body = upload_res.body(allocator) catch "";
        if (std.json.parseFromSlice(UploadResp, allocator, up_body, .{ .ignore_unknown_fields = true })) |parsed| {
            if (parsed.value.media_id) |mid| {
                media_ids.append(mid) catch {};
            }
        } else |_| {}
    }

    // 2. Create the post, attaching uploaded media IDs and optional reply_to_id.
    const post_payload = std.json.stringifyAlloc(allocator, .{
        .text = input.text,
        .media_ids = media_ids.items,
        .reply_to_id = input.reply_to_id,
    }, .{}) catch return 1;
    defer allocator.free(post_payload);

    const post_url = std.fmt.allocPrint(allocator, "{s}/v1/posts", .{base_url}) catch return 1;
    defer allocator.free(post_url);

    var post_req = http.HttpRequest.init("POST", post_url);
    defer post_req.deinit(allocator);
    post_req.setHeader(allocator, "Authorization", auth_header) catch return 1;
    post_req.setHeader(allocator, "Content-Type", "application/json") catch return 1;

    const post_res = plugin.request(post_req, post_payload) catch {
        plugin.setError("Publish HTTP request failed.");
        return 1;
    };
    defer post_res.deinit();

    if (post_res.status < 200 or post_res.status >= 300) {
        plugin.setErrorFmt("Publish failed with HTTP status {d}.", .{post_res.status}) catch return 1;
        return 1;
    }

    const PostResp = struct {
        id: ?[]const u8 = null,
        url: ?[]const u8 = null,
    };
    const post_body = post_res.body(allocator) catch "";
    var post_id: []const u8 = "post_unknown";
    var result_url: ?[]const u8 = null;
    if (std.json.parseFromSlice(PostResp, allocator, post_body, .{ .ignore_unknown_fields = true })) |parsed| {
        if (parsed.value.id) |pid| post_id = pid;
        if (parsed.value.url) |u| result_url = u;
    } else |_| {}

    const final_url = result_url orelse (std.fmt.allocPrint(allocator, "{s}/posts/{s}", .{ base_url, post_id }) catch return 1);
    plugin.outputJson(PublishOutput{
        .post_id = post_id,
        .url = final_url,
    }, .{}) catch return 1;
    return 0;
}

/// Deletes a previously published post by its `post_id`.
export fn delete_post() i32 {
    const plugin = Plugin.init(allocator);
    const input = plugin.getJson(DeletePostInput) catch {
        plugin.setError("Invalid input JSON.");
        return 1;
    };

    const token = input.credentials.api_token orelse "";
    if (token.len == 0) {
        plugin.setError("Missing required credential: api_token");
        return 1;
    }

    const post_id = std.mem.trim(u8, input.post_id, " \t\r\n");
    if (post_id.len == 0) {
        plugin.setError("post_id must not be empty.");
        return 1;
    }

    const base_url = resolveBaseUrl(input.credentials);
    const url = std.fmt.allocPrint(allocator, "{s}/v1/posts/{s}", .{ base_url, post_id }) catch return 1;
    defer allocator.free(url);

    const auth_header = std.fmt.allocPrint(allocator, "Bearer {s}", .{token}) catch return 1;
    defer allocator.free(auth_header);

    var req = http.HttpRequest.init("DELETE", url);
    defer req.deinit(allocator);
    req.setHeader(allocator, "Authorization", auth_header) catch return 1;

    const res = plugin.request(req, null) catch {
        plugin.setError("Delete HTTP request failed.");
        return 1;
    };
    defer res.deinit();

    if (res.status < 200 or res.status >= 300) {
        plugin.setErrorFmt("Delete failed with HTTP status {d}.", .{res.status}) catch return 1;
        return 1;
    }

    plugin.outputJson(DeletePostOutput{ .deleted = true }, .{}) catch return 1;
    return 0;
}
