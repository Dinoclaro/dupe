# dupe

`dupe` (Dino's Ultimate Paper Editor) is a self-hosted, VS Code-style academic paper studio. It combines a SHA-256 deduplicated PDF library, automatic BibTeX extraction, an Overleaf-GitHub repository bridge, an embedded Draw.io diagram studio with LaTeX math support, a CodeMirror 6 LaTeX editor with live preview, and a full-page server PTY terminal.

## Exposing `dupe.ing` with Cloudflare Tunnel and Zero Trust

Cloudflare Tunnel connects the server to `https://dupe.ing` without inbound firewall ports or client VPN software.

### 1. Activate `dupe.ing` in Cloudflare

1. Open `https://dash.cloudflare.com` and click **Add a domain**.
2. Enter `dupe.ing` and select the **Free** plan.
3. Copy the two Cloudflare nameservers from the dashboard.
4. Set those two nameservers at your domain registrar.
5. Wait until Cloudflare marks `dupe.ing` as **Active**.

### 2. Install `cloudflared` on Ubuntu 24.04

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
```

### 3. Authenticate and Create the Tunnel

1. Authenticate `cloudflared` with your Cloudflare account:
   ```bash
   cloudflared tunnel login
   ```
   Open the printed URL in a browser and authorize `dupe.ing`.
2. Create the tunnel:
   ```bash
   cloudflared tunnel create dupe-home
   ```
   Record the `<TUNNEL-UUID>` and the credentials path in `~/.cloudflared/<TUNNEL-UUID>.json`.

### 4. Route DNS and Configure Ingress

1. Route `dupe.ing` and `www.dupe.ing` to the tunnel:
   ```bash
   cloudflared tunnel route dns dupe-home dupe.ing
   cloudflared tunnel route dns dupe-home www.dupe.ing
   ```
2. Create `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <TUNNEL-UUID>
   credentials-file: /home/dino/.cloudflared/<TUNNEL-UUID>.json

   ingress:
     - hostname: dupe.ing
       service: http://127.0.0.1:8080
     - hostname: www.dupe.ing
       service: http://127.0.0.1:8080
     - service: http_status:404
   ```

### 5. Run `cloudflared` as a System Service

Test the tunnel first:

```bash
cloudflared tunnel run dupe-home
```

Install and start the background service:

```bash
sudo cloudflared --config /home/dino/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
```

### 6. Enable Cloudflare Zero Trust Access

1. Open `https://one.dash.cloudflare.com`.
2. Navigate to **Access** -> **Applications** -> **Add an application** -> **Self-hosted**.
3. Set **Application name** to `dupe` and **Application domain** to `dupe.ing`.
4. Create an **Allow** policy and add your personal Gmail and work email under **Include** -> **Emails**.
5. Save the application. Cloudflare challenges every visitor before forwarding traffic to the server.

## Accessing `dupe` on a Local Network or Tailscale

The `dupe` server and PostgreSQL 16 database run persistently on `dinolaptop`.

### 1. Access via Tailscale (Personal Devices)

Ensure Tailscale is connected on your second laptop (`dinos-macbook-pro`), then open your browser to:

- **Tailscale IP URL:** `http://100.70.96.97:8080`
- **Tailscale MagicDNS URL:** `http://dinolaptop:8080`

Optional HTTPS via Tailscale Serve:

```bash
sudo tailscale serve --bg 8080
```

### 2. Access on the Same Wi-Fi / LAN

- **Local Network URL:** `http://192.168.1.56:8080`
- **On the Server Itself:** `http://127.0.0.1:8080`

### 3. Login Credentials

- **Username:** `dino`
- **Password:** `dino-dev-password`

To change your password or add another user account on the server:

```bash
cd /home/dino/dupe/backend
./server --create-user dino --password "your-new-password"
```

## Workflow Guide

1. **Upload PDFs and Generate BibTeX (Top-Left `PDF LIBRARY`):**
   - Click **`+ PDF`** to upload one or more paper PDFs.
   - The server deduplicates files by SHA-256 in `storage/pdfs/` and runs `scripts/extract_meta.py` (`PyMuPDF` + Crossref/arXiv) to generate a deterministic `@bibtex_key` and BibTeX entry.
   - Click a paper to open its PDF in the main viewer, click **`◫`** to open it in the right split, or drag the paper directly into your `.tex` file to insert `\cite{key}`.
2. **Link Your Overleaf Project via GitHub (Bottom-Left `LATEX PROJECT`):**
   - Create your project in Overleaf and enable the **GitHub Sync** integration in Overleaf.
   - In `dupe`, click **`Git`** in the `LATEX PROJECT` header and paste your GitHub repository URL (`https://github.com/<user>/<repo>.git` or `git@github.com:<user>/<repo>.git`).
   - Click **`Sync & Push`** at any time to write `references.bib`, commit your `.tex` and `figures/` changes, and push to GitHub.
3. **Edit LaTeX and Preview Side-by-Side:**
   - Click any `.tex` file in `LATEX PROJECT` to open the CodeMirror 6 editor in the left group and the **Compiled Paper Preview** in the right split group.
   - Type `@` or `\cite{` in the editor to autocomplete citations from your uploaded PDF library.
4. **Create Academic Diagrams in Draw.io:**
   - Click **`+ Fig`** in `LATEX PROJECT` to create a figure and open the embedded **Draw.io** studio.
   - Wrap equations in `$$...$$` or `\(...\)` inside any box or arrow label to typeset LaTeX math.
   - Click **`Save & Insert \includegraphics`** (or drag the figure from the sidebar into your `.tex` editor) to save `figures/<name>.svg` and insert the `\begin{figure}` block.
5. **Use the Interactive Terminal (`>_ Terminal`):**
   - Click **`>_ Terminal`** (or **`◫ Split Terminal`**) in the top bar to open a full-page `xterm.js` PTY shell running in your project directory.
   - Use the toolbar buttons or type `gemini`, `claude`, or `git` to run AI coding agents directly against your manuscript and PDF library.

## Server Service Management

`dupe` runs as two user `systemd` services (`dupe.service` and `dupe-tunnel.service`) backed by `dupe_postgres` in Docker.

```bash
# Check server and Cloudflare Tunnel status
systemctl --user status dupe.service dupe-tunnel.service
journalctl --user -u dupe.service -u dupe-tunnel.service -f

# Re-run Cloudflare Tunnel provisioning if needed
./scripts/setup_cloudflare_tunnel.sh dupe.ing

# Restart the server after code updates
cd /home/dino/dupe/web && npm run build
cd /home/dino/dupe/backend && go build -o ./server .
systemctl --user restart dupe.service

# Ensure PostgreSQL container is running
cd /home/dino/dupe && docker compose up -d
```

## TODO

- Decide the database for the local-mode library cache. SQLite is the current choice. It means the library schema runs on PostgreSQL and SQLite. Postgres in Docker on the laptop is the alternative.
- Add `--mode local|hosted` and bind the server to `127.0.0.1:8080` by default.
- Disable the PTY terminal in hosted mode and verify WebSocket `Origin` headers in local mode.
- Enforce a GitHub remote URL allowlist (`https://github.com/...` and `git@github.com:...`) and `GIT_ALLOW_PROTOCOL=https:ssh` on Git commands.
- Add login rate limiting and reject the default development `JWT_SECRET` in hosted mode.
- Add a "New project" action and a top-bar project switcher (`?project=<slug>`) to support multiple projects across browser windows.
- Store per-project Git identity (`git_user_name`, `git_user_email`) and sync policy (`local_only` or `synced`) in `.dupe/project.json`.
- Let the user link an Overleaf GitHub repository as `paper/` for both new and existing projects.
- Support nested Obsidian-style Markdown folders in `notes/`.
- Save Draw.io diagram sources in `diagrams/<name>.drawio`, export SVGs to `paper/figures/<name>.svg`, and sync notes and diagrams with the server.
