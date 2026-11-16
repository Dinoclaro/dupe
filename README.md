# dupe

`dupe` (Dino's Ultimate Paper Editor) is a self-hosted, VS Code-style academic paper studio. It combines a SHA-256 deduplicated PDF library, automatic BibTeX extraction, an Overleaf-GitHub repository bridge, an embedded Draw.io diagram studio with LaTeX math support, a CodeMirror 6 LaTeX editor with live preview, and a full-page server PTY terminal.

## Accessing `dupe` from Another Laptop

The `dupe` server and PostgreSQL 16 database run persistently on `dinolaptop`.

### 1. Access via Tailscale (Recommended from Anywhere)

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

`dupe` runs as a user `systemd` service (`~/.config/systemd/user/dupe.service`) backed by `dupe_postgres` in Docker.

```bash
# Check server status and logs
systemctl --user status dupe.service
journalctl --user -u dupe.service -f

# Restart the server after code updates
cd /home/dino/dupe/web && npm run build
cd /home/dino/dupe/backend && go build -o ./server .
systemctl --user restart dupe.service

# Ensure PostgreSQL container is running
cd /home/dino/dupe && docker compose up -d
```
