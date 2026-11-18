# SocialPoster WebAssembly Plugin Starter

A multi-language starter repository and interactive build tool for creating compact, sandboxed WebAssembly (`.wasm`) plugins for SocialPoster.

## Repository Layout

```text
plugin-starter-wasm/
├── build.ps1                  # Interactive builder wrapper for Windows (PowerShell)
├── build.sh                   # Interactive builder wrapper for macOS and Linux
├── rust/                      # Rust reference plugin (extism-pdk)
├── go/                        # Go reference plugin (TinyGo + go-pdk)
├── assemblyscript/            # AssemblyScript reference plugin (@extism/as-pdk)
├── zig/                       # Zig reference plugin (extism/zig-pdk)
├── c/                         # C reference plugin (clang + vendored extism-pdk.h)
├── cli/                       # Interactive @clack/prompts builder and ABI verifier
└── output/                    # Compiled .wasm artefacts (git-ignored)
```

## Quick Start (Interactive Builder)

### Prerequisites

- **Node.js 20+** (required to run the interactive CLI and WebAssembly export verifier)
- **Either** the local toolchain for your chosen language (`cargo`, `go` + `tinygo`, `npm` for AssemblyScript, `zig`, or WASI-capable `clang`) **or Docker Desktop** for zero-setup containerised compilation

### Running the Builder

On **Windows (PowerShell)**:

```powershell
.\build.ps1
```

On **macOS / Linux**:

```sh
./build.sh
```

On first run, the wrapper installs `cli/` dependencies automatically. The interactive CLI then:

1. Prompts you to select a language implementation (`Rust`, `Go`, `AssemblyScript`, `Zig`, or `C`).
2. Parses `describe()` from that language's source file and displays a summary of your plugin ID, version, brand colour, limits, capabilities, `allowed_domains`, and `credential_fields` for confirmation.
3. Compiles the plugin using your local toolchain—or falls back automatically to an official Docker build container if the local compiler is missing—and writes the binary to `output/`.
4. Prints the artefact's file size (in KB and bytes) and SHA-256 checksum, and verifies via `WebAssembly.Module.exports()` that all four required ABI functions are exported and that the binary is within the 1 MB Hub limit.

You can also verify any compiled module directly with:

```sh
node cli/verify-wasm.mjs output/example-social-assemblyscript.wasm
```

## Customising Your Plugin

Edit the `describe()` metadata and platform API hooks in the source file for your chosen language:

| Language | Source File | Manifest / Build Config |
| :--- | :--- | :--- |
| Rust | `rust/src/lib.rs` | `rust/Cargo.toml` |
| Go | `go/main.go` | `go/go.mod` |
| AssemblyScript | `assemblyscript/assembly/index.ts` | `assemblyscript/package.json`, `assemblyscript/asconfig.json`, `assemblyscript/tsconfig.json` |
| Zig | `zig/src/main.zig` | `zig/build.zig`, `zig/build.zig.zon` |
| C | `c/plugin.c` | `c/Makefile`, `c/extism-pdk.h` |

## Plugin ABI & `describe()` Specification

SocialPoster executes plugins inside a sandboxed **Extism** (Wasmtime) runtime with no filesystem access and outbound HTTPS restricted strictly to the hostnames listed in `allowed_domains`.

### Required Exported Functions

Every plugin must export four functions using the Extism calling convention:

| Export | Input | Output | Purpose |
| :--- | :--- | :--- | :--- |
| `describe` | *(none)* | JSON string | Returns plugin metadata, capabilities, and credential schema. |
| `validate_auth` | JSON string | JSON string | Verifies `credentials` against the target service and returns `{"valid": true}` or `{"valid": false, "error": "..."}`. |
| `publish` | JSON string | JSON string | Publishes a post (receiving `credentials`, `text`, `attachments`, and optional `reply_to_id` for threads) and returns `{"post_id": "...", "url": "..."}`. |
| `delete_post` | JSON string | JSON string | Deletes a previously published post by `post_id` and returns `{"deleted": true}`. |

### `describe()` Schema Reference

| Field | Type | Validation Rules |
| :--- | :--- | :--- |
| `id` | `string` | Lowercase alphanumeric characters and hyphens only (`^[a-z0-9-]+$`), matching your Hub slug. |
| `version` | `string` | Strict SemVer `MAJOR.MINOR.PATCH` (for example, `"1.0.0"`). |
| `display_name` | `string` | Non-empty human-readable platform name. |
| `brand_colour` | `string` | `#RRGGBB` 6-digit hexadecimal accent colour used in SocialPoster UI and `registry.json`. |
| `icon_svg` | `string` | Clean `<svg viewBox="0 0 24 24">...</svg>` markup with no `<script>` tags, inline event handlers, or external URLs. |
| `max_characters` | `integer` | Positive integer (`> 0`). |
| `max_attachments` | `integer` | Non-negative integer (`>= 0`). |
| `supported_media_types` | `string[]` | Array of supported MIME type strings (for example, `["image/jpeg", "image/png", "image/webp", "video/mp4"]`). |
| `supports_alt_text` | `boolean` | `true` if media attachments support accessibility alt-text. |
| `supports_threads` | `boolean` | `true` if threaded replies via `reply_to_id` are supported. |
| `supports_delete` | `boolean` | `true` if `delete_post` is supported. |
| `allowed_domains` | `string[]` | Array of public `https` hostnames (schemes such as `http://`, `localhost`, and private/loopback IPs are rejected). |
| `credential_fields` | `object[]` | Array of `{ key, label, secret, required }` objects defining the authentication form rendered in SocialPoster. |

### Hub Validation Rules

Before publishing, ensure your compiled plugin satisfies these Hub checks:

- **Maximum binary size:** Compiled `.wasm` artefacts must not exceed `1 MB` (`1,048,576` bytes).
- **Versioning:** `version` must follow strict `MAJOR.MINOR.PATCH` SemVer.
- **Network allowlist:** `allowed_domains` may contain only public `https` hostnames.
- **Icon markup:** `icon_svg` must be script-free `<svg viewBox="0 0 24 24">` markup without inline event handlers or external URLs.

## Publishing to the SocialPoster Hub

1. Sign in to the SocialPoster Hub using your GitHub account.
2. Claim your plugin slug (`id`) under your personal account or a GitHub organisation.
3. Upload the compiled `.wasm` file from `output/`.
4. Add Markdown release notes describing the changes in this version.

Once a version is verified and published on the Hub, its `.wasm` artefact and release notes are immutable; subsequent updates must be released under a new SemVer version.
