# dupe

`dupe` (Dino's Ultimate Paper Editor) is a local-first research workspace. It combines a SHA-256 PDF library, automatic BibTeX extraction, Overleaf Git sync, Markdown brain notes, Tectonic LaTeX compilation, Draw.io diagrams, an MCP server, and the `dupe-studio` VS Code extension.

## Installing on macOS and Linux

### Standalone Installer

Run the installer script to install the latest GitHub Release on macOS (`darwin-arm64` or `darwin-amd64`) or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Dinoclaro/dupe/main/install.sh | bash
```

Pass `--autostart` to install and start the background daemon at login (`io.dupe.local` LaunchAgent on macOS or `dupe-local.service` on Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/Dinoclaro/dupe/main/install.sh | bash -s -- --autostart
```

The installer sets up these components:

- Installs `dupe` into `~/.local/share/dupe/backend/server` and symlinks `~/.local/bin/dupe`.
- Removes the macOS quarantine attribute from installed binaries.
- Installs Tectonic into `~/.local/bin/tectonic` if missing.
- Creates `~/.local/share/dupe/.venv` with `PyMuPDF` for PDF metadata and text extraction.
- Registers the `dupe` MCP server in `~/.gemini/config/mcp_config.json` and `~/.claude.json`.
- Installs Herdr templates, skills, `dupe-vscode` mod, and `dupe-herdr`.
- Installs `dupe-studio-latest.vsix` when the `code` CLI is available.

### Synced Laptop Setup

To sync projects and the PDF library from a hosted `dupe` server, authenticate and run the server setup script:

```bash
printf "Username on https://dupe.ing: " && read -r DUPE_USER
printf "Password for %s: " "$DUPE_USER" && stty -echo && read -r DUPE_PASS && stty echo && echo
TOKEN=$(DUPE_USER="$DUPE_USER" DUPE_PASS="$DUPE_PASS" python3 -c 'import os,json; print(json.dumps({"username":os.environ["DUPE_USER"],"password":os.environ["DUPE_PASS"]}))' | \
  curl -fsS -X POST https://dupe.ing/api/auth/login -H 'Content-Type: application/json' --data-binary @- | \
  python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
unset DUPE_PASS

curl -fsSL -H "Authorization: Bearer $TOKEN" \
  "https://dupe.ing/api/local/setup.sh?projects=~/dupe_projects" | bash
```

This script pulls the server bundle, configures `--sync-url` and `--sync-token`, warms the Tectonic cache, and starts the background service. Run `dupe update --force` afterward to install `dupe-studio-latest.vsix` if you install VS Code later.

### Homebrew Formula

`Formula/dupe.rb` defines the Homebrew formula for macOS and Linux. Install from a local clone and finish setup:

```bash
brew install ./Formula/dupe.rb
brew services start dupe
dupe update --force --no-restart
```

## Updating on macOS and Linux

### CLI Self-Update

Check for a newer GitHub Release:

```bash
dupe update --check
```

Update the binary, web UI, scripts, Herdr files, `dupe-studio` VS Code extension, and background daemon:

```bash
dupe update
```

`dupe update` verifies `SHA256SUMS.txt` and atomically replaces files in `~/.local/share/dupe`. On macOS, it clears `com.apple.quarantine` and restarts the `io.dupe.local` LaunchAgent. For Homebrew installs, `dupe update` runs `brew update` and `brew upgrade dupe`, installs the `.vsix` extension, updates Herdr files, and runs `brew services restart dupe`.

Useful flags:

- `dupe update --version v0.4.6` installs a specific release tag.
- `dupe update --force` reinstalls the current release, including `.vsix` and Herdr files.
- `dupe update --no-restart` skips restarting the background daemon.

Reload VS Code (`Developer: Reload Window`) after `dupe update` updates `dupe-studio`.

### VS Code Update Flow

The `dupe-studio` extension checks GitHub Releases on startup when `dupe.autoCheckUpdates` is enabled.

1. Run **`dupe: Check for Updates`** from the VS Code Command Palette.
2. Click **Update Now** to invoke `POST /api/local/update` on the local daemon.
3. Click **Reload Window** when prompted to activate the updated extension.

### Local Web UI Update Flow

In local mode, the web UI displays a top-bar update button when a newer release exists. Clicking it triggers `POST /api/local/update`, restarts the daemon, and reloads the page.

### Re-Running the Installer

Re-running `install.sh` updates the installed bundle, Herdr config, and `dupe-studio` extension, and restarts `io.dupe.local` if the plist exists:

```bash
curl -fsSL https://raw.githubusercontent.com/Dinoclaro/dupe/main/install.sh | bash
```

### Updating Project Repos and Service Logs on macOS

Update a synced project workspace, Overleaf `paper/`, and cloned `code/` repositories from a terminal:

```bash
git -C ~/dupe_projects/<project> pull
git -C ~/dupe_projects/<project>/paper pull
git -C ~/dupe_projects/<project>/code/<repo> pull
```

Inspect or restart the macOS LaunchAgent when troubleshooting:

```bash
launchctl print "gui/$(id -u)/io.dupe.local"
launchctl kickstart -k "gui/$(id -u)/io.dupe.local"
tail -f ~/Library/Logs/dupe-local.log
```

## Local Workspace Usage

Initialize an existing directory as a `dupe` project:

```bash
cd ~/my-paper && dupe init
```

Start the local studio server manually if you do not run it as a background service:

```bash
dupe serve --mode local --projects ~/dupe_projects
```

Each project folder keeps `paper/` (Overleaf Git repo with `dupe_references.bib` and `figures/`), `code/` (linked code repos), `notes/` (curated Obsidian-style notes, `MOC.md`, `artifacts/`, `concepts/`), `diagrams/`, `refs/`, and `.dupe/brain/` (gitignored agent blackboard).

## Releasing and Hosted Deployment

### Cutting a Release

Run the release script on a clean `main` branch:

```bash
./scripts/release.sh patch
./scripts/release.sh v0.4.6 --deploy-server
```

`scripts/release.sh` bumps `vscode-extension/package.json`, runs Go, web, and extension checks, tags `vX.Y.Z`, and pushes to `origin`. GitHub Actions builds cross-platform bundles, packages `dupe-studio-latest.vsix`, generates `SHA256SUMS.txt`, publishes the GitHub Release, and updates `Formula/dupe.rb`. Passing `--deploy-server` deploys the Linux server via `scripts/deploy_remote.sh`.

### Exposing Hosted Mode with Cloudflare Tunnel

Cloudflare Tunnel connects a hosted `dupe` server to `https://dupe.ing` without inbound firewall ports.

1. Add `dupe.ing` in Cloudflare and update domain nameservers.
2. Install `cloudflared` on the Linux host and run `cloudflared tunnel login`.
3. Create the tunnel with `cloudflared tunnel create dupe-home`.
4. Route DNS with `cloudflared tunnel route dns dupe-home dupe.ing`.
5. Configure `~/.cloudflared/config.yml` to forward `dupe.ing` to `http://127.0.0.1:8080`.
6. Install the service with `sudo cloudflared --config ~/.cloudflared/config.yml service install` and `sudo systemctl enable --now cloudflared`.
7. Add a Self-hosted Cloudflare Zero Trust Access application for `dupe.ing`.

### Hosted Server Service Management

Hosted mode runs on PostgreSQL 16 and user `systemd` units (`dupe.service` and `dupe-tunnel.service`):

```bash
systemctl --user status dupe.service dupe-tunnel.service
journalctl --user -u dupe.service -u dupe-tunnel.service -f
docker compose up -d
```

Create or update a hosted user password:

```bash
cd backend && ./server --create-user <username> --password "<new-password>"
```

Rebuild and restart a hosted server from source:

```bash
cd web && npm run build
cd ../backend && go build -o ./server .
systemctl --user restart dupe.service
```

## Development Checks

Run all repository checks before committing code changes:

```bash
cd backend && go vet ./... && go test ./...
cd ../web && npm run build && npm test
cd ../vscode-extension && npm run build && npm test
```
