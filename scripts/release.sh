#!/usr/bin/env bash
set -euo pipefail

# Bump version, run checks, commit, tag, and push a dupe release (optionally deploying the hosted server).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUMP="${1:-patch}"
DEPLOY_SERVER="0"
for arg in "$@"; do
  case "$arg" in
    --deploy-server) DEPLOY_SERVER="1" ;;
    -h|--help)
      echo "Usage: ./scripts/release.sh [patch|minor|major|vX.Y.Z] [--deploy-server]"
      exit 0
      ;;
  esac
done

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "ERROR: Releases must be cut from 'main' (currently on '$CURRENT_BRANCH')." >&2
  exit 1
fi

NEXT_VER="$(node - "$BUMP" <<'NODE'
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('vscode-extension/package.json', 'utf8'));
const arg = process.argv[2] || 'patch';
const cur = pkg.version.split('.').map(Number);
let next;
if (arg === 'patch') next = [cur[0], cur[1], cur[2] + 1].join('.');
else if (arg === 'minor') next = [cur[0], cur[1] + 1, 0].join('.');
else if (arg === 'major') next = [cur[0] + 1, 0, 0].join('.');
else next = arg.replace(/^v/i, '');
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`Invalid release version: ${arg}`);
  process.exit(1);
}
pkg.version = next;
fs.writeFileSync('vscode-extension/package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log(next);
NODE
)"

TAG="v${NEXT_VER}"
if git rev-parse "$TAG" >/dev/null 2>&1; then
  git checkout -- vscode-extension/package.json
  echo "ERROR: Tag $TAG already exists." >&2
  exit 1
fi

echo "==> Validating backend (Go)..."
(cd backend && go vet ./... && go test ./...)

echo "==> Validating web frontend..."
(cd web && npm test && npm run build)

echo "==> Validating VS Code extension ($NEXT_VER)..."
(cd vscode-extension && npm test && npm run build)

git add vscode-extension/package.json
git commit -m "chore(release): $TAG"
git tag "$TAG"
git push origin main
git push origin "$TAG"

echo "==> Pushed $TAG! GitHub Actions is building release bundles, .vsix, and Formula/dupe.rb."

if [ "$DEPLOY_SERVER" = "1" ]; then
  echo "==> Deploying hosted server..."
  "$REPO_ROOT/scripts/deploy_remote.sh"
fi
