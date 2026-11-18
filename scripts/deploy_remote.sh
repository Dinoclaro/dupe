#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:$PATH"

echo "[1/3] Building and testing frontend (web/)..."
cd "$REPO_ROOT/web"
npm test
npm run build

echo "[2/3] Building Linux amd64 backend binary (backend/server)..."
cd "$REPO_ROOT/backend"
go vet ./...
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ./server .

# Automatically pick direct SSH ('dinoclaro') if reachable, otherwise use Cloudflare Tunnel ('ssh.dupe.ing')
SSH_TARGET="dinoclaro"
SSH_OPTS="-o ConnectTimeout=4"
if ! ssh $SSH_OPTS "$SSH_TARGET" 'true' 2>/dev/null; then
  CLOUDFLARED_BIN="$(command -v cloudflared || true)"
  if [[ -z "$CLOUDFLARED_BIN" ]]; then
    echo "ERROR: Direct SSH to 'dinoclaro' failed and 'cloudflared' is not installed." >&2
    echo "Install cloudflared (e.g. 'brew install cloudflared' or 'winget install Cloudflare.cloudflared') to deploy via ssh.dupe.ing." >&2
    exit 1
  fi
  SSH_TARGET="dinoclaro@ssh.dupe.ing"
  SSH_OPTS="-o StrictHostKeyChecking=accept-new -o ProxyCommand=\"$CLOUDFLARED_BIN access ssh --hostname %h\""
  echo "[3/3] Deploying over Cloudflare SSH Tunnel (ssh.dupe.ing)..."
else
  echo "[3/3] Deploying over direct SSH (dinoclaro)..."
fi

eval "ssh $SSH_OPTS $SSH_TARGET 'systemctl --user stop dupe.service'"
eval "rsync -avz -e 'ssh $SSH_OPTS' --exclude '.git' --exclude '.venv' --exclude 'storage' --exclude 'web/node_modules' '$REPO_ROOT/' '$SSH_TARGET:/home/dinoclaro/dupe/'"
eval "ssh $SSH_OPTS $SSH_TARGET 'systemctl --user start dupe.service && sleep 1 && systemctl --user status dupe.service --no-pager'"

rm -f "$REPO_ROOT/backend/server"
echo "Deployment to https://dupe.ing complete!"
