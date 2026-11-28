#!/usr/bin/env bash
set -euo pipefail

# Standalone local-first installer for dupe + dupe-studio from GitHub Releases.
REPO="${DUPE_REPO:-Dinoclaro/dupe}"
VERSION="${DUPE_VERSION:-latest}"
INSTALL_DIR="${DUPE_INSTALL_DIR:-$HOME/.local/share/dupe}"
BIN_DIR="${DUPE_BIN_DIR:-$HOME/.local/bin}"
STORAGE_DIR="${DUPE_STORAGE_DIR:-$INSTALL_DIR/storage_local}"
PROJECTS_DIR="${DUPE_PROJECTS_DIR:-$HOME/dupe_projects}"
AUTOSTART="${DUPE_AUTOSTART:-0}"

for arg in "$@"; do
  case "$arg" in
    --autostart) AUTOSTART="1" ;;
  esac
done

gh_curl() {
  local tok="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
  if [ -n "$tok" ]; then
    curl -fsSL -H "Authorization: Bearer $tok" "$@"
  else
    curl -fsSL "$@"
  fi
}

OS_RAW="$(uname -s)"
case "$OS_RAW" in
  Linux) OS_NAME="linux" ;;
  Darwin) OS_NAME="darwin" ;;
  *) echo "Unsupported OS: $OS_RAW" >&2; exit 1 ;;
esac

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH_NAME="amd64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) echo "Unsupported architecture: $ARCH_RAW" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  BASE_DL="https://github.com/$REPO/releases/latest/download"
else
  BASE_DL="https://github.com/$REPO/releases/download/$VERSION"
fi

echo "==> Installing dupe ($OS_NAME/$ARCH_NAME, release: $VERSION) into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$STORAGE_DIR" "$PROJECTS_DIR" "$BIN_DIR"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

TAR_URL="$BASE_DL/dupe-${OS_NAME}-${ARCH_NAME}.tar.gz"
gh_curl "$TAR_URL" -o "$TMP_DIR/dupe.tar.gz"
rm -rf "$INSTALL_DIR/web/dist"
tar -xzf "$TMP_DIR/dupe.tar.gz" -C "$(dirname "$INSTALL_DIR")"
chmod +x "$INSTALL_DIR/backend/server"
if [ "$OS_NAME" = "darwin" ]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/backend/server" >/dev/null 2>&1 || true
fi

ln -sf "$INSTALL_DIR/backend/server" "$BIN_DIR/dupe"

if ! command -v tectonic >/dev/null 2>&1 && [ ! -x "$BIN_DIR/tectonic" ]; then
  case "$OS_NAME-$ARCH_NAME" in
    linux-amd64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz" ;;
    linux-arm64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-aarch64-unknown-linux-musl.tar.gz" ;;
    darwin-arm64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-aarch64-apple-darwin.tar.gz" ;;
    darwin-amd64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.15.0/tectonic-0.15.0-x86_64-apple-darwin.tar.gz" ;;
    *) TECT_URL="" ;;
  esac
  if [ -n "$TECT_URL" ]; then
    echo "==> Installing Tectonic LaTeX engine into $BIN_DIR..."
    if curl -fsSL "$TECT_URL" -o "$TMP_DIR/tectonic.tar.gz"; then
      tar -xzf "$TMP_DIR/tectonic.tar.gz" -C "$TMP_DIR"
      install -m 0755 "$TMP_DIR/tectonic" "$BIN_DIR/tectonic" || true
      if [ "$OS_NAME" = "darwin" ]; then
        xattr -d com.apple.quarantine "$BIN_DIR/tectonic" >/dev/null 2>&1 || true
      fi
    fi
  fi
fi

PYTHON_BIN_VAL="python3"
if command -v python3 >/dev/null 2>&1; then
  if [ ! -x "$INSTALL_DIR/.venv/bin/python3" ]; then
    python3 -m venv "$INSTALL_DIR/.venv" >/dev/null 2>&1 || true
  fi
  if [ -x "$INSTALL_DIR/.venv/bin/python3" ]; then
    PYTHON_BIN_VAL="$INSTALL_DIR/.venv/bin/python3"
    if ! "$PYTHON_BIN_VAL" -c "import fitz" >/dev/null 2>&1 && [ -f "$INSTALL_DIR/scripts/requirements.txt" ]; then
      echo "==> Installing Python PDF dependencies (PyMuPDF)..."
      "$PYTHON_BIN_VAL" -m pip install -q -r "$INSTALL_DIR/scripts/requirements.txt" || true
    fi
  fi
fi

if command -v python3 >/dev/null 2>&1; then
  DUPE_MCP_CMD="$INSTALL_DIR/backend/server" \
  DUPE_MCP_PROJECTS="$PROJECTS_DIR" \
  DUPE_MCP_STORAGE="$STORAGE_DIR" \
  DUPE_MCP_PYTHON="$PYTHON_BIN_VAL" \
  DUPE_MCP_EXTRACT="$INSTALL_DIR/scripts/extract_meta.py" \
  python3 - <<'PY' || true
import json, os

entry = {
    "command": os.environ["DUPE_MCP_CMD"],
    "args": ["mcp", "--mode", "local", "--projects", os.environ["DUPE_MCP_PROJECTS"]],
    "env": {
        "STORAGE_DIR": os.environ["DUPE_MCP_STORAGE"],
        "PROJECTS_DIR": os.environ["DUPE_MCP_PROJECTS"],
        "PYTHON_BIN": os.environ["DUPE_MCP_PYTHON"],
        "EXTRACT_SCRIPT": os.environ["DUPE_MCP_EXTRACT"],
    },
}

for raw_path in ("~/.gemini/config/mcp_config.json", "~/.claude.json"):
    cfg_path = os.path.expanduser(raw_path)
    os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
    data = {}
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                txt = fh.read().strip()
            if txt:
                parsed = json.loads(txt)
                if isinstance(parsed, dict):
                    data = parsed
        except Exception:
            data = {}
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers["dupe"] = entry
    data["mcpServers"] = servers
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
PY
fi

if [ -x "$INSTALL_DIR/herdr/install_herdr_dupe.sh" ]; then
  bash "$INSTALL_DIR/herdr/install_herdr_dupe.sh" || true
fi

CODE_BIN="$(command -v code || echo "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")"
if command -v code >/dev/null 2>&1 || [ -x "$CODE_BIN" ]; then
  echo "==> Installing dupe-studio VS Code extension..."
  if gh_curl "$BASE_DL/dupe-studio-latest.vsix" -o "$TMP_DIR/dupe-studio.vsix"; then
    "$CODE_BIN" --install-extension "$TMP_DIR/dupe-studio.vsix" --force || true
  fi
fi

if [ "$OS_NAME" = "darwin" ] && [ -f "$HOME/Library/LaunchAgents/io.dupe.local.plist" ]; then
  echo "==> Restarting io.dupe.local LaunchAgent..."
  launchctl kickstart -k "gui/$(id -u)/io.dupe.local" >/dev/null 2>&1 || {
    launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.dupe.local.plist" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/io.dupe.local.plist" >/dev/null 2>&1 || true
  }
elif [ "$OS_NAME" = "darwin" ] && [ "$AUTOSTART" = "1" ]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  PLIST_PATH="$HOME/Library/LaunchAgents/io.dupe.local.plist"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.dupe.local</string>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR/backend</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STORAGE_DIR</key>
    <string>$STORAGE_DIR</string>
    <key>PROJECTS_DIR</key>
    <string>$PROJECTS_DIR</string>
    <key>WEB_DIST_DIR</key>
    <string>$INSTALL_DIR/web/dist</string>
    <key>PYTHON_BIN</key>
    <string>$PYTHON_BIN_VAL</string>
    <key>EXTRACT_SCRIPT</key>
    <string>$INSTALL_DIR/scripts/extract_meta.py</string>
    <key>PATH</key>
    <string>$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/backend/server</string>
    <string>serve</string>
    <string>--mode</string>
    <string>local</string>
    <string>--projects</string>
    <string>$PROJECTS_DIR</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/dupe-local.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/dupe-local.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user cat dupe-local.service >/dev/null 2>&1; then
  echo "==> Restarting dupe-local.service..."
  systemctl --user restart dupe-local.service || true
elif [ "$AUTOSTART" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/dupe-local.service" <<UNIT
[Unit]
Description=dupe Local Studio Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/backend
Environment="STORAGE_DIR=$STORAGE_DIR"
Environment="PROJECTS_DIR=$PROJECTS_DIR"
Environment="WEB_DIST_DIR=$INSTALL_DIR/web/dist"
Environment="PYTHON_BIN=$PYTHON_BIN_VAL"
Environment="EXTRACT_SCRIPT=$INSTALL_DIR/scripts/extract_meta.py"
Environment="PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin"
ExecStart=$INSTALL_DIR/backend/server serve --mode local --projects "$PROJECTS_DIR"
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now dupe-local.service
fi

echo "==> Done! ($("$BIN_DIR/dupe" --version 2>/dev/null || echo "installed"))"
echo "Next steps:"
echo "  1. Ensure $BIN_DIR is in PATH"
echo "  2. Initialize a project:   cd ~/my-paper && dupe init"
echo "  3. Future updates:         dupe update"
