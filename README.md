# SocialPoster WebAssembly Plugin Starter

A multi-language starter repository and interactive build tool for creating compact, sandboxed WebAssembly (`.wasm`) plugins targeting the **SocialPoster `1.0.0` Plugin ABI**, licensed under the [MIT Licence](LICENSE).

## Repository Layout

```text
plugin-starter/
├── LICENSE                    # MIT Licence
├── build.ps1                  # Interactive builder wrapper for Windows (PowerShell)
├── build.sh                   # Interactive builder wrapper for macOS and Linux
├── rust/                      # Rust reference plugin (extism-pdk)
├── go/                        # Go reference plugin (TinyGo + go-pdk)
├── assemblyscript/            # AssemblyScript reference plugin (@extism/as-pdk)
├── zig/                       # Zig reference plugin (extism/zig-pdk)
├── c/                         # C reference plugin (clang + vendored extism-pdk.h)
├── cli/                       # Interactive @clack/prompts builder and ABI verifier
├── dist/                      # Compiled .wasm artefacts from build.sh / build.ps1 (git-ignored)
└── output/                    # Compiled .wasm artefacts from interactive CLI / CI (git-ignored)
```

## Quick Start (Build Scripts & Interactive CLI)

### Prerequisites

- **Local toolchains** for the language(s) you wish to build (`cargo` with `wasm32-unknown-unknown`, `go` + `tinygo`, `node` + `npm` for AssemblyScript, `zig`, or WASI-capable `clang`)
- **Or Docker Desktop** + **Node.js 20+** if you prefer the interactive containerised builder (`node cli/index.mjs`)

### Building All Detected Plugins

Running `build.sh` or `build.ps1` with no arguments scans top-level subdirectories in the repository root (excluding `.git`, `dist`, `target`, `node_modules`, `output`, `cli`, and hidden directories), detects each recognised manifest (`Cargo.toml`, `go.mod`, `package.json`, `build.zig`, `CMakeLists.txt`, or `Makefile`), compiles every plugin, and copies the artefacts to `dist/<folder-name>.wasm`:

On **Windows (PowerShell)**:

```powershell
.\build.ps1
```

On **macOS / Linux**:

```sh
./build.sh
```

### Building Specific or Custom Plugin Directories

Pass one or more folder names or relative paths as positional arguments to build only those targets:

On **Windows (PowerShell)**:

```powershell
.\build.ps1 rust
.\build.ps1 my-plugin another-plugin
```

On **macOS / Linux**:

```sh
./build.sh rust
./build.sh my-plugin another-plugin
```

Each script prints the final `.wasm` size in KB and bytes and displays a warning if any artefact exceeds the `1 MB` (`1,048,576` bytes) Hub limit.

### Interactive Builder (with Docker Fallback)

If you do not have local compilers installed and want Docker fallback with a `describe()` metadata preview, run the interactive CLI directly:

```sh
npm --prefix cli install
node cli/index.mjs
```

You can also verify any compiled module directly with:

```sh
node cli/verify-wasm.mjs dist/assemblyscript.wasm
```

## Local Testing in SocialPoster

1. Open SocialPoster and navigate to **Settings → Developer**.
2. Enable **Developer Mode**.
3. Open **Plugins → Sideload .wasm** and select your compiled `.wasm` artefact from `output/`.
4. Configure your chosen authentication mode and test `validate_auth`, `publish`, and `delete_post` directly inside the app.

## Customising Your Plugin

Edit the `describe()` metadata and platform API hooks in the source file for your chosen language:

| Language | Source File | Build Command (inside language directory) |
| :--- | :--- | :--- |
| Rust | `rust/src/lib.rs` | `cargo build --release --target wasm32-unknown-unknown` |
| Go | `go/main.go` | `GOFLAGS="-buildvcs=false" tinygo build -o ../output/example-social-go.wasm -target wasip1 -buildmode=c-shared -no-debug .` |
| AssemblyScript | `assemblyscript/assembly/index.ts` | `npm ci && npm run build` |
| Zig | `zig/src/main.zig` | `zig build -Doptimize=ReleaseSmall` |
| C | `c/plugin.c` | `make` |

## SocialPoster `1.0.0` Plugin ABI

SocialPoster executes plugins inside a sandboxed **Extism** (Wasmtime) runtime with no filesystem access and outbound HTTPS restricted strictly to the hostnames listed in `allowed_domains`.

### Host Functions (`extism:host/user`)

- `sp_credential(key)`: Reads a credential or setting from the host keyring. Use the reserved key `"__auth_mode"` to read the user's active authentication mode ID, then read mode-specific credential keys.
- `sp_media_chunk(request_json)`: Streams attachment bytes from the host media store in chunks (`{ "attachment_id", "offset", "length" }`).
- `sp_http(request_json)`: Executes an outbound HTTPS request (`{ "method", "url", "headers", "body" }`) restricted to `allowed_domains`.

### Required Exported Functions

Every plugin must export four functions using the Extism calling convention:

| Export | Input | Output | Purpose |
| :--- | :--- | :--- | :--- |
| `describe` | *(none)* | JSON string | Returns plugin metadata, capabilities, `compatible_app_version`, `authors`, and `auth_modes`. |
| `validate_auth` | *(none)* | JSON string | Reads `"__auth_mode"` and mode credentials via `sp_credential`, verifies them via `sp_http`, and returns `{"valid": true}` or `{"valid": false, "error": "..."}`. |
| `publish` | JSON string | JSON string | Streams attachments via `sp_media_chunk`, publishes via `sp_http`, and returns `{"post_id": "<mode>:<id>", "url": "..."}`. |
| `delete_post` | JSON string | JSON string | Reads the `<mode>:` prefix on `post_id` to route deletion using the originating mode's credentials and returns `{"deleted": true}`. |

### `describe()` Schema Reference

| Field | Type | Validation Rules |
| :--- | :--- | :--- |
| `id` | `string` | Lowercase alphanumeric characters and hyphens only (`^[a-z0-9-]+$`), matching your Hub slug. |
| `version` | `string` | Strict SemVer `MAJOR.MINOR.PATCH` (for example, `"1.0.0"`). |
| `compatible_app_version` | `string` | SemVer range for compatible SocialPoster releases (for example, `"^1.0.0"`). |
| `display_name` | `string` | Non-empty human-readable platform name. |
| `authors` | `object[]` | Array of `{ name, links: [{ label, url }] }` objects attributing plugin authors. |
| `brand_colour` | `string` | `#RRGGBB` 6-digit hexadecimal accent colour used in SocialPoster UI and `registry.json`. |
| `icon_svg` | `string` | Clean single-root `<svg viewBox="0 0 24 24">...</svg>` markup with no `<script>` tags, inline event handlers, or external URLs. |
| `max_characters` | `integer` | Positive integer (`> 0`). |
| `max_attachments` | `integer` | Non-negative integer (`>= 0`). |
| `supported_media_types` | `string[]` | Array of supported MIME type strings (for example, `["image/jpeg", "image/png", "image/webp", "video/mp4"]`). |
| `supports_alt_text` | `boolean` | `true` if media attachments support accessibility alt-text. |
| `supports_threads` | `boolean` | `true` if threaded replies via `reply_to_id` are supported. |
| `supports_delete` | `boolean` | `true` if `delete_post` is supported. |
| `allowed_domains` | `string[]` | Array of public `https` hostnames (schemes such as `http://`, `localhost`, and private/loopback IPs are rejected). |
| `auth_modes` | `object[]` | Array of `{ id, label, description, setup_instructions, fields }` objects defining one or more authentication modes. Each `fields` entry has `{ key, label, secret, required }`. |

### Hub Validation Rules

Before publishing, ensure your compiled plugin satisfies these Hub checks:

- **Maximum binary size:** Compiled `.wasm` artefacts must not exceed `1 MB` (`1,048,576` bytes).
- **Versioning:** `version` must follow strict `MAJOR.MINOR.PATCH` SemVer.
- **Network allowlist:** `allowed_domains` may contain only public `https` hostnames.
- **Icon markup:** `icon_svg` must be sanitised single-root `<svg viewBox="0 0 24 24">` markup without `<script>` tags, inline event handlers, or external URLs.

## Publishing to the SocialPoster Hub

1. Sign in to the SocialPoster Hub using your GitHub account.
2. Claim your plugin slug (`id`) under your personal account or a GitHub organisation.
3. Upload the compiled `.wasm` file from `output/`.
4. Add Markdown release notes describing the changes in this version.

Once a version is verified and published on the Hub, its `.wasm` artefact and release notes are immutable; subsequent updates must be released under a new SemVer version.
