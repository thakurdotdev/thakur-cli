#!/usr/bin/env bash
#
# thakurcode installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/thakurdotdev/thakur-cli/main/install.sh | bash
#
# Environment variables:
#   THAKURCODE_INSTALL_DIR : Directory to install thakurcode (default: ~/.thakurcode/bin)
#   GITHUB_REPO            : GitHub repository in owner/repo format (default: thakurdotdev/thakur-cli)
#   THAKURCODE_VERSION     : Version or tag to install (default: latest)
#   THAKURCODE_DOWNLOAD_URL: Direct URL to download binary from

set -euo pipefail

# ANSI color helpers
if [ -t 1 ]; then
  BOLD="\033[1m"
  CYAN="\033[36m"
  GREEN="\033[32m"
  YELLOW="\033[33m"
  RED="\033[31m"
  DIM="\033[2m"
  RESET="\033[0m"
else
  BOLD=""
  CYAN=""
  GREEN=""
  YELLOW=""
  RED=""
  DIM=""
  RESET=""
fi

log_info() {
  echo -e "${CYAN}→${RESET} $*"
}

log_success() {
  echo -e "${GREEN}✓${RESET} $*"
}

log_warn() {
  echo -e "${YELLOW}!${RESET} $*"
}

log_error() {
  echo -e "${RED}✗${RESET} $*" >&2
}

print_banner() {
  echo -e "${CYAN}${BOLD}"
  cat << 'EOF'
  _   _           _                               _      
 | |_| |__   __ _| | ___   _ _ __ ___ ___   __| | ___ 
 | __| '_ \ / _` | |/ / | | | '__/ __/ _ \ / _` |/ _ \
 | |_| | | | (_| |   <| |_| | | | (_| (_) | (_| |  __/
  \__|_| |_|\__,_|_|\_\\__,_|_|  \___\___/ \__,_|\___|
EOF
  echo -e "${RESET}${DIM}  AI coding harness — multi-model terminal coding agent${RESET}\n"
}

# Detect operating system
detect_os() {
  local u_os
  u_os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$u_os" in
    linux*)
      echo "linux"
      ;;
    darwin*)
      echo "darwin"
      ;;
    msys*|mingw*|cygwin*)
      echo "windows"
      ;;
    *)
      log_error "Unsupported operating system: $u_os"
      exit 1
      ;;
  esac
}

# Detect CPU architecture
detect_arch() {
  local u_arch
  u_arch="$(uname -m)"
  case "$u_arch" in
    x86_64|amd64)
      echo "x64"
      ;;
    arm64|aarch64)
      echo "arm64"
      ;;
    *)
      log_error "Unsupported CPU architecture: $u_arch"
      exit 1
      ;;
  esac
}

# Update user shell configuration file to add directory to PATH
update_shell_path() {
  local bin_dir="$1"
  local path_line="export PATH=\"$bin_dir:\$PATH\""
  local fish_line="set -gx PATH \"$bin_dir\" \$PATH"
  local updated_any=0

  # Check if bin_dir is already in PATH
  case ":$PATH:" in
    *":$bin_dir:"*)
      return 0
      ;;
  esac

  local current_shell
  current_shell="$(basename "${SHELL:-bash}")"

  local profiles=()

  if [ "$current_shell" = "zsh" ] || [ -f "$HOME/.zshrc" ]; then
    profiles+=("$HOME/.zshrc")
  fi

  if [ "$current_shell" = "bash" ] || [ -f "$HOME/.bashrc" ]; then
    profiles+=("$HOME/.bashrc")
  fi

  if [ -f "$HOME/.bash_profile" ]; then
    profiles+=("$HOME/.bash_profile")
  fi

  if [ -f "$HOME/.profile" ]; then
    profiles+=("$HOME/.profile")
  fi

  # Fish shell config
  if [ "$current_shell" = "fish" ] || [ -d "$HOME/.config/fish" ]; then
    local fish_config="$HOME/.config/fish/config.fish"
    mkdir -p "$(dirname "$fish_config")"
    if ! grep -qs "$bin_dir" "$fish_config" 2>/dev/null; then
      echo "" >> "$fish_config"
      echo "# thakurcode CLI" >> "$fish_config"
      echo "$fish_line" >> "$fish_config"
      updated_any=1
    fi
  fi

  for profile in "${profiles[@]}"; do
    if [ -f "$profile" ] && ! grep -qs "$bin_dir" "$profile" 2>/dev/null; then
      echo "" >> "$profile"
      echo "# thakurcode CLI" >> "$profile"
      echo "$path_line" >> "$profile"
      log_success "Added $bin_dir to $profile"
      updated_any=1
    fi
  done

  if [ "$updated_any" -eq 0 ] && [ ! -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.zshrc" ]; then
    echo "" >> "$HOME/.profile"
    echo "# thakurcode CLI" >> "$HOME/.profile"
    echo "$path_line" >> "$HOME/.profile"
    log_success "Added $bin_dir to $HOME/.profile"
  fi
}

TEMP_DIR=""

cleanup() {
  if [ -n "${TEMP_DIR:-}" ] && [ -d "${TEMP_DIR:-}" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

main() {
  print_banner

  local os
  local arch
  os="$(detect_os)"
  arch="$(detect_arch)"

  local ext=""
  if [ "$os" = "windows" ]; then
    ext=".exe"
  fi

  local target_artifact="thakurcode-${os}-${arch}${ext}"
  local install_dir="${THAKURCODE_INSTALL_DIR:-$HOME/.thakurcode/bin}"
  local repo="${GITHUB_REPO:-thakurdotdev/thakur-cli}"
  local version="${THAKURCODE_VERSION:-latest}"
  local target_binary="$install_dir/thakurcode${ext}"
  local legacy_binary="$install_dir/harness${ext}"

  local force=0
  for arg in "$@"; do
    if [ "$arg" = "--force" ] || [ "$arg" = "-f" ]; then
      force=1
    fi
  done
  if [ "${THAKURCODE_FORCE:-0}" = "1" ]; then
    force=1
  fi

  # Check if thakurcode is already installed and check its version
  local installed_version=""
  if [ -x "$target_binary" ]; then
    installed_version="$("$target_binary" --version 2>/dev/null || true)"
    installed_version="$(echo "$installed_version" | tr -d '[:space:]')"
  fi

  # Resolve latest version tag from GitHub if version is "latest"
  local target_tag="$version"
  if [ "$version" = "latest" ]; then
    local resolved_url
    resolved_url="$(curl -sIL -o /dev/null -w "%{url_effective}" "https://github.com/${repo}/releases/latest" 2>/dev/null || true)"
    if [[ "$resolved_url" =~ /tag/(.+) ]]; then
      target_tag="${BASH_REMATCH[1]}"
    fi
  fi

  local clean_installed="${installed_version#v}"
  local clean_target="${target_tag#v}"

  # Skip download if already on the latest / target version
  if [ -n "$clean_installed" ] && [ -n "$clean_target" ] && [ "$clean_target" != "latest" ] && [ "$clean_installed" = "$clean_target" ] && [ "$force" -eq 0 ]; then
    log_success "${BOLD}thakurcode v${clean_installed}${RESET} is already installed and up to date!"
    log_info "Location: ${DIM}${target_binary}${RESET}"

    # Ensure PATH and symlink are present
    update_shell_path "$install_dir"
    if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]] && [ -d "$HOME/.local/bin" ] && [ -w "$HOME/.local/bin" ]; then
      ln -sf "$target_binary" "$HOME/.local/bin/thakurcode" 2>/dev/null || true
      ln -sf "$legacy_binary" "$HOME/.local/bin/harness" 2>/dev/null || true
    fi

    echo ""
    echo -e "Run ${CYAN}${BOLD}thakurcode${RESET} to start."
    echo -e "${DIM}To force re-installation, run with THAKURCODE_FORCE=1 or pass --force${RESET}"
    echo ""
    return 0
  fi

  if [ -n "$clean_installed" ] && [ -n "$clean_target" ] && [ "$clean_target" != "latest" ] && [ "$clean_installed" != "$clean_target" ]; then
    log_info "Upgrading thakurcode: ${BOLD}v${clean_installed}${RESET} → ${BOLD}v${clean_target}${RESET}..."
  fi

  log_info "Detected platform: ${BOLD}${os}-${arch}${RESET}"
  log_info "Installing to: ${BOLD}${install_dir}${RESET}"

  mkdir -p "$install_dir"

  TEMP_DIR="$(mktemp -d)"
  local temp_file="$TEMP_DIR/thakurcode_download"

  local downloaded=0

  # 1. Determine download URL
  local download_url=""
  if [ -n "${THAKURCODE_DOWNLOAD_URL:-}" ]; then
    download_url="$THAKURCODE_DOWNLOAD_URL"
  elif [ "$version" = "latest" ]; then
    download_url="https://github.com/${repo}/releases/latest/download/${target_artifact}"
  else
    download_url="https://github.com/${repo}/releases/download/${version}/${target_artifact}"
  fi

  log_info "Downloading ${target_artifact} (~80 MB, standalone binary)..."

  # Attempt download from URL
  if command -v curl >/dev/null 2>&1; then
    if curl -fL --progress-bar -o "$temp_file" "$download_url"; then
      downloaded=1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q --show-progress -O "$temp_file" "$download_url"; then
      downloaded=1
    fi
  fi

  # Fallback: if download failed (e.g. repo not released on GitHub yet) check local build or bun
  if [ "$downloaded" -eq 0 ]; then
    log_warn "Could not download pre-built release from ${download_url}."

    # Check if local prebuilt binary exists in current working directory / dist
    if [ -f "dist/${target_artifact}" ]; then
      log_info "Using local binary from dist/${target_artifact}"
      cp -f "dist/${target_artifact}" "$temp_file"
      downloaded=1
    elif [ -f "dist/thakurcode${ext}" ] && [ "$os" = "$(detect_os)" ]; then
      log_info "Using local binary from dist/thakurcode${ext}"
      cp -f "dist/thakurcode${ext}" "$temp_file"
      downloaded=1
    elif command -v bun >/dev/null 2>&1 && [ -f "packages/cli/src/index.ts" ]; then
      log_info "Bun detected — compiling standalone executable locally..."
      bun build --compile packages/cli/src/index.ts --outfile "$temp_file"
      downloaded=1
    elif command -v bun >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
      log_info "No GitHub release asset found, but Bun and Git are available."
      log_info "Building standalone thakurcode executable from repository..."
      local clone_dir="$TEMP_DIR/clone"
      if git clone --depth 1 "https://github.com/${repo}.git" "$clone_dir" >/dev/null 2>&1; then
        (
          cd "$clone_dir"
          bun install --frozen-lockfile >/dev/null 2>&1 || bun install >/dev/null 2>&1
          bun build --compile packages/cli/src/index.ts --outfile "$temp_file" >/dev/null 2>&1
        )
        if [ -f "$temp_file" ]; then
          downloaded=1
        fi
      fi
    fi
  fi

  if [ "$downloaded" -eq 0 ]; then
    log_error "Installation failed: Unable to fetch binary."
    echo ""
    echo -e "${YELLOW}No GitHub release asset found for ${repo}.${RESET}"
    echo ""
    echo "To make pre-compiled binaries available for 1-command install via curl:"
    echo "  1. Push a version tag from your repo to trigger the automated GitHub Release build:"
    echo "     git tag v0.1.0"
    echo "     git push origin v0.1.0"
    echo ""
    echo "  2. Or manually create a release at:"
    echo "     https://github.com/${repo}/releases/new"
    echo ""
    echo "  3. Or install Bun (curl -fsSL https://bun.sh/install | bash) to compile on the fly."
    exit 1
  fi

  # Install binary
  mv -f "$temp_file" "$target_binary"
  chmod +x "$target_binary"

  # Backwards compatibility alias
  cp -f "$target_binary" "$legacy_binary" 2>/dev/null || true

  # Also try to symlink into ~/.local/bin if it exists in PATH
  if [[ ":$PATH:" == *":$HOME/.local/bin:"* ]] && [ -d "$HOME/.local/bin" ] && [ -w "$HOME/.local/bin" ]; then
    ln -sf "$target_binary" "$HOME/.local/bin/thakurcode" 2>/dev/null || true
    ln -sf "$legacy_binary" "$HOME/.local/bin/harness" 2>/dev/null || true
    log_success "Symlinked to $HOME/.local/bin/thakurcode"
  fi

  # Update Shell PATH
  update_shell_path "$install_dir"

  log_success "${BOLD}thakurcode${RESET} successfully installed to ${BOLD}${target_binary}${RESET}"

  echo ""
  echo -e "${GREEN}${BOLD}Installation Complete!${RESET}"
  echo ""
  echo "To get started:"
  echo ""
  if [[ ":$PATH:" != *":$install_dir:"* ]] && [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo -e "  ${YELLOW}1. Reload your environment:${RESET}"
    echo -e "     ${BOLD}export PATH=\"$install_dir:\$PATH\"${RESET}  ${DIM}(or restart your terminal)${RESET}"
    echo ""
    echo -e "  ${YELLOW}2. Run thakurcode:${RESET}"
  else
    echo -e "  ${YELLOW}Run thakurcode:${RESET}"
  fi
  echo -e "     ${CYAN}${BOLD}thakurcode${RESET}                   # Start chat REPL"
  echo -e "     ${CYAN}${BOLD}thakurcode auth <provider> <key>${RESET} # Store API key"
  echo -e "     ${CYAN}${BOLD}thakurcode --help${RESET}             # Show all commands and options"
  echo ""
}

main "$@"
