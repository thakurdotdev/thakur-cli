#!/usr/bin/env bash
#
# Build standalone thakurcode executables with `bun build --compile`.
#
# Each target embeds the Bun runtime + the entire workspace (engine, tools,
# providers, Ink TUI) into one file — no Bun install needed on the target
# machine. Cross-compilation happens from any host; the ripgrep integration
# automatically degrades to a system `rg` on PATH when the optional
# @vscode/ripgrep platform binary is not present in the bundle.
#
# Output: dist/thakurcode-<os>-<arch>[.exe] (~90-100 MB each).
# Also symlinks/copies harness-<os>-<arch>[.exe] for backwards compatibility.
# NOTE: --bytecode is deliberately NOT used — Bun bytecode does not support
# the top-level await in the CLI entry (index.ts uses await parseAsync).

set -euo pipefail

cd "$(dirname "$0")/.."

ENTRY="packages/cli/src/index.ts"
OUT="dist"
mkdir -p "$OUT"

TARGETS=(
  "bun-linux-x64:thakurcode-linux-x64:"
  "bun-linux-arm64:thakurcode-linux-arm64:"
  "bun-darwin-x64:thakurcode-darwin-x64:"
  "bun-darwin-arm64:thakurcode-darwin-arm64:"
  "bun-windows-x64:thakurcode-windows-x64:.exe"
)

SELECTED="${1:-all}"

build_one() {
  local target="$1"
  local name="$2"
  local ext="$3"
  local legacy_name="${name/thakurcode-/harness-}"
  echo "→ building ${name}${ext} (${target})"
  bun build --compile \
    --target="$target" \
    --outfile="$OUT/$name" \
    "$ENTRY"
  
  # Also provide harness-* link/copy for backward compatibility
  cp -f "$OUT/$name$ext" "$OUT/$legacy_name$ext"
  
  ls -lh "$OUT/$name$ext"
}

for spec in "${TARGETS[@]}"; do
  IFS=":" read -r target name ext <<< "$spec"
  if [[ "$SELECTED" == "all" || "$SELECTED" == "$target" || "$SELECTED" == "$name" ]]; then
    build_one "$target" "$name" "$ext"
  fi
done

# Generate SHA256 checksums if shasum or sha256sum is available
cd "$OUT"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum thakurcode-* > checksums.txt 2>/dev/null || true
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 thakurcode-* > checksums.txt 2>/dev/null || true
fi
cd - >/dev/null

echo "done — binaries in $OUT/"
