#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/linuxbrew/.linuxbrew/bin:$PATH"
DOMAIN="${1:-dupe.ing}"
TUNNEL_NAME="dupe"
CF_DIR="${HOME}/.cloudflared"

mkdir -p "${CF_DIR}"

if [[ ! -f "${CF_DIR}/cert.pem" ]]; then
  echo "Authenticate cloudflared with your Cloudflare account for ${DOMAIN}..."
  cloudflared tunnel login
fi

if ! cloudflared tunnel list | awk '{print $2}' | grep -qx "${TUNNEL_NAME}"; then
  echo "Creating Cloudflare tunnel '${TUNNEL_NAME}'..."
  cloudflared tunnel create "${TUNNEL_NAME}"
fi

TUNNEL_ID="$(cloudflared tunnel list | awk -v name="${TUNNEL_NAME}" '$2 == name {print $1}' | head -n 1)"
if [[ -z "${TUNNEL_ID}" ]]; then
  echo "Failed to resolve tunnel ID for ${TUNNEL_NAME}" >&2
  exit 1
fi

CRED_FILE="${CF_DIR}/${TUNNEL_ID}.json"

cat > "${CF_DIR}/config.yml" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CRED_FILE}

ingress:
  - hostname: ${DOMAIN}
    service: http://127.0.0.1:8080
    originRequest:
      noTLSVerify: true
  - hostname: www.${DOMAIN}
    service: http://127.0.0.1:8080
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF

echo "Routing DNS records for ${DOMAIN} and www.${DOMAIN} to tunnel ${TUNNEL_NAME} (${TUNNEL_ID})..."
cloudflared tunnel route dns --overwrite-dns "${TUNNEL_NAME}" "${DOMAIN}"
cloudflared tunnel route dns --overwrite-dns "${TUNNEL_NAME}" "www.${DOMAIN}"

systemctl --user daemon-reload
systemctl --user enable --now dupe.service
systemctl --user enable --now dupe-tunnel.service

echo "https://${DOMAIN} is now live and routed to local dupe server (127.0.0.1:8080)!"
