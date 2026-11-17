#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
REMOTE_HOST="${1:-dinoclaro}"
TUNNEL_ID="49104743-700f-424a-80a1-4189931eb32b"

echo "1. Stopping local tunnel service on laptop..."
systemctl --user disable --now dupe-tunnel.service 2>/dev/null || true

echo "2. Building frontend and static Go server binary..."
cd /home/dino/dupe/web
npm run build
cd /home/dino/dupe/backend
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ./server .

echo "3. Syncing repository and build artifacts to ${REMOTE_HOST}:~/dupe..."
rsync -az --delete \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude 'storage' \
  --exclude 'web/node_modules' \
  /home/dino/dupe/ "${REMOTE_HOST}:/home/dinoclaro/dupe/"

echo "4. Copying Cloudflare Tunnel credentials to ${REMOTE_HOST}:~/.cloudflared..."
ssh "${REMOTE_HOST}" "mkdir -p ~/.cloudflared ~/.local/bin ~/.config/systemd/user ~/dupe/storage/pdfs ~/dupe/storage/repos"
scp -q "/home/dino/.cloudflared/cert.pem" "${REMOTE_HOST}:/home/dinoclaro/.cloudflared/cert.pem"
scp -q "/home/dino/.cloudflared/${TUNNEL_ID}.json" "${REMOTE_HOST}:/home/dinoclaro/.cloudflared/${TUNNEL_ID}.json"

echo "5. Provisioning PostgreSQL 16, Python environment, cloudflared, and systemd services on ${REMOTE_HOST}..."
ssh "${REMOTE_HOST}" bash -s <<'EOF'
set -euo pipefail

TUNNEL_ID="49104743-700f-424a-80a1-4189931eb32b"
CONDA_BIN="$HOME/miniforge3/bin/conda"
ENV_DIR="$HOME/miniforge3/envs/dupe"
PGDATA="$HOME/dupe/storage/pgdata"

if [[ ! -x "$HOME/.local/bin/cloudflared" ]]; then
  echo "Downloading standalone cloudflared binary..."
  curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$HOME/.local/bin/cloudflared"
  chmod +x "$HOME/.local/bin/cloudflared"
fi

if [[ ! -d "$ENV_DIR" ]]; then
  echo "Creating conda environment with PostgreSQL 16 and Python 3.12..."
  "$CONDA_BIN" create -y -p "$ENV_DIR" -c conda-forge postgresql=16 python=3.12 pip
fi

"$ENV_DIR/bin/pip" install -q -r "$HOME/dupe/scripts/requirements.txt"

if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
  echo "Initializing PostgreSQL data directory at $PGDATA..."
  "$ENV_DIR/bin/initdb" -D "$PGDATA" -U dupe --auth=trust --encoding=UTF8 --locale=C
fi

cat > "$HOME/.cloudflared/config.yml" <<CFEOF
tunnel: ${TUNNEL_ID}
credentials-file: /home/dinoclaro/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: dupe.ing
    service: http://127.0.0.1:8080
    originRequest:
      noTLSVerify: true
  - hostname: www.dupe.ing
    service: http://127.0.0.1:8080
    originRequest:
      noTLSVerify: true
  - service: http_status:404
CFEOF

cat > "$HOME/.config/systemd/user/dupe-postgres.service" <<PGEO
[Unit]
Description=PostgreSQL 16 for dupe
After=network.target

[Service]
Type=simple
ExecStart=${ENV_DIR}/bin/postgres -D ${PGDATA} -k /tmp -h 127.0.0.1 -p 5432
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
PGEO

cat > "$HOME/.config/systemd/user/dupe.service" <<SVCEOF
[Unit]
Description=dupe (Dino's Ultimate Paper Editor) Server
After=network.target dupe-postgres.service
Requires=dupe-postgres.service

[Service]
Type=simple
WorkingDirectory=/home/dinoclaro/dupe/backend
Environment="ADDR=0.0.0.0:8080"
Environment="DATABASE_URL=postgres://dupe:dupe_dev_password@127.0.0.1:5432/dupe?sslmode=disable"
Environment="STORAGE_DIR=/home/dinoclaro/dupe/storage"
Environment="PYTHON_BIN=${ENV_DIR}/bin/python3"
Environment="EXTRACT_SCRIPT=/home/dinoclaro/dupe/scripts/extract_meta.py"
Environment="WEB_DIST_DIR=/home/dinoclaro/dupe/web/dist"
Environment="PATH=${ENV_DIR}/bin:/home/dinoclaro/.local/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/dinoclaro/dupe/backend/server
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
SVCEOF

cat > "$HOME/.config/systemd/user/dupe-tunnel.service" <<TUNEOF
[Unit]
Description=Cloudflare Tunnel for dupe.ing on dinoclaro
After=network-online.target dupe.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/home/dinoclaro/.local/bin/cloudflared tunnel --no-autoupdate --config /home/dinoclaro/.cloudflared/config.yml run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
TUNEOF

systemctl --user daemon-reload
systemctl --user enable --now dupe-postgres.service
sleep 2

"$ENV_DIR/bin/psql" -h 127.0.0.1 -p 5432 -U dupe -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = 'dupe'" | grep -q 1 || \
  "$ENV_DIR/bin/createdb" -h 127.0.0.1 -p 5432 -U dupe dupe

systemctl --user enable --now dupe.service
systemctl --user enable --now dupe-tunnel.service
sleep 2

cd "$HOME/dupe/backend"
DATABASE_URL="postgres://dupe:dupe_dev_password@127.0.0.1:5432/dupe?sslmode=disable" ./server --create-user dino --password "dino-dev-password"

systemctl --user status dupe-postgres.service dupe.service dupe-tunnel.service --no-pager
EOF
