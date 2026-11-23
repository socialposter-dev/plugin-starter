#!/usr/bin/env sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIST_DIR="$ROOT_DIR/dist"
MAX_WASM_BYTES=1048576

has_manifest() {
  dir="$1"
  [ -f "$dir/Cargo.toml" ] || [ -f "$dir/go.mod" ] || [ -f "$dir/package.json" ] || \
    [ -f "$dir/build.zig" ] || [ -f "$dir/CMakeLists.txt" ] || [ -f "$dir/Makefile" ]
}

build_target() {
  target_dir="$1"
  folder_name=$(basename "$target_dir")
  dest_wasm="$DIST_DIR/$folder_name.wasm"

  printf '==> Building plugin '\''%s'\''...\n' "$folder_name"

  if [ -f "$target_dir/Cargo.toml" ]; then
    (cd "$target_dir" && cargo build --release --target wasm32-unknown-unknown)
    wasm_src=$(find "$target_dir/target/wasm32-unknown-unknown/release" -maxdepth 1 -name '*.wasm' -type f | head -n 1)
    if [ -z "$wasm_src" ]; then
      echo "Error: No compiled .wasm artefact found in $target_dir/target/wasm32-unknown-unknown/release" >&2
      exit 1
    fi
    cp "$wasm_src" "$dest_wasm"

  elif [ -f "$target_dir/go.mod" ]; then
    (cd "$target_dir" && go mod tidy && GOFLAGS="-buildvcs=false" tinygo build -o "$dest_wasm" -target=wasi -no-debug .)

  elif [ -f "$target_dir/package.json" ]; then
    (
      cd "$target_dir"
      if [ ! -d node_modules ]; then
        if [ -f package-lock.json ]; then
          npm ci --no-audit --no-fund
        else
          npm install --no-audit --no-fund
        fi
      fi
      npm run build
    )
    wasm_src=$(find "$target_dir" -maxdepth 3 -path '*/node_modules' -prune -o -name '*.wasm' -type f -print | head -n 1)
    if [ -z "$wasm_src" ] && [ -d "$ROOT_DIR/output" ]; then
      wasm_src=$(find "$ROOT_DIR/output" -maxdepth 1 -name "*$folder_name*.wasm" -type f | head -n 1)
    fi
    if [ -z "$wasm_src" ]; then
      echo "Error: No compiled .wasm artefact found after running npm run build in $target_dir" >&2
      exit 1
    fi
    cp "$wasm_src" "$dest_wasm"

  elif [ -f "$target_dir/build.zig" ]; then
    (cd "$target_dir" && zig build -Doptimize=ReleaseSmall)
    wasm_src=$(find "$target_dir/zig-out" -name '*.wasm' -type f 2>/dev/null | head -n 1)
    if [ -z "$wasm_src" ] && [ -d "$ROOT_DIR/output" ]; then
      wasm_src=$(find "$ROOT_DIR/output" -maxdepth 1 -name "*$folder_name*.wasm" -type f | head -n 1)
    fi
    if [ -z "$wasm_src" ]; then
      echo "Error: No compiled .wasm artefact found after running zig build in $target_dir" >&2
      exit 1
    fi
    cp "$wasm_src" "$dest_wasm"

  elif [ -f "$target_dir/CMakeLists.txt" ]; then
    cmake -B "$target_dir/build" -S "$target_dir"
    cmake --build "$target_dir/build" --config Release
    wasm_src=$(find "$target_dir/build" -name '*.wasm' -type f | head -n 1)
    if [ -z "$wasm_src" ]; then
      echo "Error: No compiled .wasm artefact found in $target_dir/build" >&2
      exit 1
    fi
    cp "$wasm_src" "$dest_wasm"

  elif [ -f "$target_dir/Makefile" ]; then
    (cd "$target_dir" && make OUT="$dest_wasm")

  else
    echo "Error: No recognised plugin manifest found in $target_dir" >&2
    exit 1
  fi

  if [ ! -f "$dest_wasm" ]; then
    echo "Error: Expected output artefact was not created: $dest_wasm" >&2
    exit 1
  fi

  size_bytes=$(wc -c < "$dest_wasm" | tr -d ' ')
  size_kb=$(awk "BEGIN { printf \"%.2f\", $size_bytes / 1024 }")
  printf '    Artefact : dist/%s.wasm\n' "$folder_name"
  printf '    Size     : %s KB (%s bytes)\n' "$size_kb" "$size_bytes"

  if [ "$size_bytes" -gt "$MAX_WASM_BYTES" ]; then
    printf '    WARNING  : Artefact dist/%s.wasm (%s bytes) exceeds the 1 MB (%s bytes) SocialPoster Hub limit!\n' \
      "$folder_name" "$size_bytes" "$MAX_WASM_BYTES" >&2
  fi
}

TARGETS=""
COUNT=0

if [ "$#" -gt 0 ]; then
  for arg in "$@"; do
    case "$arg" in
      /*) candidate="$arg" ;;
      *)  candidate="$ROOT_DIR/$arg" ;;
    esac
    if [ ! -d "$candidate" ]; then
      echo "Error: Plugin directory not found: $arg" >&2
      exit 1
    fi
    resolved=$(CDPATH= cd -- "$candidate" && pwd)
    TARGETS="$TARGETS
$resolved"
    COUNT=$((COUNT + 1))
  done
else
  for entry in "$ROOT_DIR"/*; do
    [ -d "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      .*|dist|target|node_modules|output|cli) continue ;;
    esac
    if has_manifest "$entry"; then
      TARGETS="$TARGETS
$entry"
      COUNT=$((COUNT + 1))
    fi
  done
fi

if [ "$COUNT" -eq 0 ]; then
  echo "Error: No plugin directories with a recognised manifest were found." >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

OLD_IFS=$IFS
IFS='
'
for target_dir in $TARGETS; do
  [ -n "$target_dir" ] || continue
  build_target "$target_dir"
done
IFS=$OLD_IFS

printf '\nFinished building %s plugin(s) into dist/.\n' "$COUNT"
