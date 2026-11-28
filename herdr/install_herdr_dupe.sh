#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

HC_CFG_DIR="$HOME/.config/herdr-core"
HERDR_APP_CFG="$HOME/.config/herdr-app"
BIN_DIR="$HOME/.local/bin"

mkdir -p "$HC_CFG_DIR/templates" "$HERDR_APP_CFG/mods/dupe-vscode" "$BIN_DIR"

if [ ! -f "$HC_CFG_DIR/config.toml" ]; then
  cp "$SCRIPT_DIR/config.toml" "$HC_CFG_DIR/config.toml"
fi

cp "$SCRIPT_DIR"/templates/*.md "$HC_CFG_DIR/templates/"
cp "$SCRIPT_DIR/mods/dupe-vscode/mod.json" "$HERDR_APP_CFG/mods/dupe-vscode/mod.json"
cp "$SCRIPT_DIR/mods/dupe-vscode/link.js" "$HERDR_APP_CFG/mods/dupe-vscode/link.js"
install -m 0755 "$SCRIPT_DIR/bin/dupe-herdr" "$BIN_DIR/dupe-herdr"

HC_BIN="$(command -v hc || command -v herdr-core || true)"
HERDR_APP_BIN="$(command -v herdr-app || true)"
if [ -z "$HERDR_APP_BIN" ] && [ -x "/Applications/Herdr.app/Contents/MacOS/herdr-app" ]; then
  HERDR_APP_BIN="/Applications/Herdr.app/Contents/MacOS/herdr-app"
fi

if [ -n "$HC_BIN" ]; then
  for dir in "$HOME/.claude/skills/herdr-core" "$HOME/.gemini/config/skills/herdr-core"; do
    mkdir -p "$dir"
    {
      printf '%s\n' '---' 'name: herdr-core' 'description: Manage persistent background terminals, child coding agents, and multi-machine execution via hc (herdr-core).' '---' ''
      "$HC_BIN" --skill
    } > "$dir/SKILL.md"
  done
fi

if [ -n "$HERDR_APP_BIN" ]; then
  for dir in "$HOME/.claude/skills/herdr-app" "$HOME/.gemini/config/skills/herdr-app"; do
    mkdir -p "$dir"
    {
      printf '%s\n' '---' 'name: herdr-app' 'description: Inspect and arrange Herdr spaces, tabs, split panes, and UI layout via herdr-app.' '---' ''
      "$HERDR_APP_BIN" --skill
    } > "$dir/SKILL.md"
  done
  "$HERDR_APP_BIN" check "$HERDR_APP_CFG/mods/dupe-vscode" || true
  if "$HERDR_APP_BIN" status >/dev/null 2>&1; then
    if [ ! -f "$HERDR_APP_CFG/layouts/dupe.json" ]; then
      "$HERDR_APP_BIN" do layout.clone --name main --as dupe >/dev/null 2>&1 || true
    fi
    if [ -f "$HERDR_APP_CFG/layouts/dupe.json" ]; then
      python3 - "$HERDR_APP_CFG/layouts/dupe.json" <<'PY' || true
import json, sys
p = sys.argv[1]
with open(p, "r", encoding="utf-8") as fh:
    d = json.load(fh)
lh = d.get("link_handlers") or []
if "dupe-vscode" not in lh:
    lh.insert(0, "dupe-vscode")
d["link_handlers"] = lh
with open(p, "w", encoding="utf-8") as fh:
    json.dump(d, fh, indent=2)
    fh.write("\n")
PY
      "$HERDR_APP_BIN" do layout.switch --name dupe >/dev/null 2>&1 || true
    fi
  fi
fi

echo "==> Installed dupe Herdr templates, dupe-vscode mod, skills, and dupe-herdr."
