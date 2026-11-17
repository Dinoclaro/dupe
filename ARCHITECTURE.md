# ARCHITECTURE.md

## 1. Overview

`dupe` (Dino's Ultimate Paper Editor) is a research and writing workspace. It combines a PDF library, a BibTeX generator, a LaTeX/Typst editor with preview, a diagram tool, and Markdown notes.

The user works in two applications:

- **VS Code** edits code.
- **dupe** handles reading, writing, citations, diagrams, and notes.

Both applications open the same **project folder**. Coding agents read the same folder and get the full context of a paper: code, LaTeX, notes, diagrams, and reference texts.

### Core tenets (strict rules for agents)

1. **A project is a folder.** dupe stores project content as plain files on disk. A database holds only the paper library and user accounts.
2. **One binary, two modes.** The same Go binary runs in **local mode** on a laptop and in **hosted mode** on the home server. Section 3 defines both modes.
3. **Local-first.** Local mode works without an internet connection. Network features queue their work and run when the connection returns.
4. **Client-side compute.** The browser runs PDF rendering (`PDF.js`), Markdown and KaTeX, diagrams, and WASM LaTeX/Typst compilation in Web Workers. The server CPU is a 2015 Core i7.
5. **Relative API paths.** Frontend requests use `/api/...` paths. The app works behind `localhost`, `tailscale serve`, and `cloudflared` without changes.
6. **Sync-ready data.** Library tables use client-generated `UUID` keys, `updated_at` timestamps, and `deleted_at` soft-deletes.

---

## 2. Project folder format

dupe creates and manages this layout. VS Code and agents open the project root.

```text
<project>/
├── AGENTS.md            # dupe generates this: layout, citation keys, rules for agents
├── .dupe/
│   └── project.json     # Project settings: name, Overleaf remote, linked paper UUIDs
├── paper/               # Overleaf-linked GitHub repository (separate git repo)
│   ├── main.tex
│   ├── references.bib   # dupe generates this from the linked papers
│   └── figures/         # dupe exports diagrams here
├── code/                # Code repository (separate git repo, local mode only)
├── notes/               # Markdown notes with [[paper:<bibtex_key>]] links
├── diagrams/            # Excalidraw and draw.io source files
└── refs/
    ├── index.json       # Linked papers: bibtex_key, title, DOI, tags, paper UUID
    └── text/<key>.md    # Extracted full text of each linked PDF for agents
```

Rules:

- `paper/` is its own git repository. Overleaf syncs a complete repository, and code must stay out of it.
- `code/` is its own git repository. The project root ignores it, or it is a git submodule.
- The project root is a git repository. It versions `notes/`, `diagrams/`, `refs/`, and `.dupe/`.
- PDFs stay out of every project repository. The library stores them. `refs/text/` gives agents searchable text.
- dupe regenerates `AGENTS.md`, `references.bib`, `refs/index.json`, and `refs/text/` from the library and the project settings.

---

## 3. Runtime modes

### Local mode (laptop)

```text
dupe serve --mode local --projects ~/research
```

- The server listens on `127.0.0.1:8080` and serves the web UI.
- The server reads and writes project folders under the `--projects` directory.
- The server keeps a **library cache** in `~/.dupe/library/`: `pdfs/<sha256>.pdf` and a SQLite index of paper metadata.
- The server syncs the library cache with a hosted server if the user configures one. Section 5 defines sync.
- The server runs `scripts/extract_meta.py` locally. This needs Python 3 and PyMuPDF on the laptop.
- The server has one implicit user. It requires no login.

### Hosted mode (home server)

```text
dupe serve --mode hosted --addr 127.0.0.1:8080
```

- The server is the source of truth for the paper library. PostgreSQL stores metadata. `storage/pdfs/` stores PDFs.
- The server serves the library sync API to local-mode clients.
- Friends use the web UI in the browser. Each friend owns project folders under `storage/projects/<user_id>/<project>/`.
- Hosted projects contain `paper/`, `notes/`, `diagrams/`, and `refs/`. They contain no `code/` folder.
- The server never exposes a shell. The PTY terminal endpoint exists only in local mode.
- `cloudflared` with Cloudflare Access exposes the server to the internet. Tailscale is an option for personal access.

---

## 4. Offline behavior (local mode)

| Feature | Offline | Notes |
|---|---|---|
| Edit LaTeX, notes, diagrams | Works | Plain files on disk |
| LaTeX/Typst preview | Works | The WASM engine caches TeX packages after first use |
| Read cached PDFs | Works | Papers linked to a project are always cached |
| Read uncached PDFs | Fails | The cache downloads them after reconnect |
| Upload a new PDF | Partial | Text extraction works. Crossref and arXiv lookups queue |
| Library sync | Queues | The outbox sends changes after reconnect |
| Commit to `paper/` | Works | Push to GitHub and Overleaf queues |
| Agent assistance | Fails | Agents need the model API |

The web UI shows the online state and the size of the outbox.

---

## 5. Library sync

The hosted server owns the library. Local mode keeps a cache.

- `GET /api/library/changes?since=<timestamp>` returns papers, tags, and highlights with `updated_at` after the timestamp.
- `POST /api/library/sync` accepts an outbox batch of created, updated, and deleted records.
- `GET /api/papers/{id}/file` streams a PDF. The client verifies the SHA-256 hash.
- `PUT /api/papers/blob/{sha256}` uploads a PDF. The server skips the upload if the hash exists.
- PDF files are immutable. Conflicts occur only on metadata. The record with the later `updated_at` wins.
- Local mode always caches the PDFs of papers that a local project links.

---

## 6. Agents

### Local mode

The user runs any agent (Claude Code, Gemini, Copilot) in VS Code or a terminal on the project folder. dupe adds two things:

- **Generated `AGENTS.md`** describes the project layout and the citation keys.
- **MCP server** (`dupe mcp`, stdio transport) gives agents library tools:
  - `search_papers(query)`
  - `get_bibtex(key)`
  - `read_paper(key, section?)`
  - `link_paper(key)` adds a paper to the project and regenerates `references.bib`.

### Hosted mode

The web UI has an **agent panel**. Each friend supplies their own model API key.

- The server runs the agent in a container per session.
- The container mounts only the current project, read-only.
- The agent has read tools only: read, grep, and glob. Shell and file-write tools are disabled.
- Container network access is limited to the model API host.
- The agent returns edits as diffs. The user accepts or rejects each diff in the editor.
- The server encrypts stored API keys at rest. The UI never displays a stored key.

---

## 7. Storage and backup (hosted mode)

- `storage/pdfs/<sha256>.pdf` stores each PDF once.
- A nightly job runs `pg_dump` and `restic backup` of `storage/` and the dump.
- `restic` encrypts the backup and writes it to Google Drive through an `rclone` remote.
- A weekly job runs `restic check` and re-hashes a sample of PDFs.
- A restore test runs after setup and then every three months.
- Local library caches are an additional copy of every cached PDF.

---

## 8. Repository layout

```text
/
├── ARCHITECTURE.md
├── CONTRIBUTION.md
├── AGENTS.md / GEMINI.md
├── docker-compose.yml       # PostgreSQL 16 for hosted mode
├── backend/                 # Go 1.22+ server, both modes
│   ├── main.go              # Entrypoint, mode flags, router, --create-user
│   ├── auth.go              # JWT and bcrypt (hosted mode)
│   ├── db.go                # pgx pool (hosted) and SQLite cache (local)
│   ├── projects.go          # Project folder create, read, write, regenerate
│   ├── handlers_papers.go   # Upload, stream, metadata
│   ├── handlers_sync.go     # Library sync API
│   ├── handlers_git.go      # Commit and push for paper/ and the project root
│   ├── handlers_terminal.go # PTY terminal (local mode only)
│   ├── mcp.go               # MCP server for agents
│   └── schema.sql
├── scripts/
│   └── extract_meta.py      # DOI, metadata, BibTeX, and full-text extraction
├── deploy/                  # cloudflared config, systemd units, backup scripts
├── web/                     # Vite, React, TypeScript
└── extension/               # Manifest V3 Chrome Web Clipper
```

---

## 9. Database schema (library)

The database holds users, papers, tags, and highlights. Project content lives in project folders. Hosted mode uses PostgreSQL. Local mode uses a SQLite cache with the same tables.

```sql
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    color_hex VARCHAR(7) DEFAULT '#FFEB3B',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE papers (
    id UUID PRIMARY KEY,
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    authors TEXT,
    publication_year INT,
    doi TEXT,
    bibtex_key TEXT,
    bibtex_raw TEXT,
    file_hash CHAR(64) NOT NULL,     -- SHA-256, also the file name in storage/pdfs/
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE highlights (
    id UUID PRIMARY KEY,
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    page_number INT NOT NULL,
    selected_text TEXT,
    comment TEXT,
    color_hex VARCHAR(7),
    coordinates JSONB NOT NULL,      -- Page-normalized rects (0.0 to 1.0)
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE TABLE tags (
    id UUID PRIMARY KEY,
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (owner_id, name)
);

CREATE TABLE paper_tags (
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (paper_id, tag_id)
);

CREATE TABLE projects (              -- Hosted mode only
    id UUID PRIMARY KEY,
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    folder_path TEXT NOT NULL,       -- Relative path inside storage/projects/
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);
```

The `documents`, `backlinks`, and `git_repos` tables are removed. Notes, diagrams, and LaTeX are files. dupe derives backlinks from `[[...]]` links in the files. `.dupe/project.json` stores the Overleaf remote.

---

## 10. Web UI

1. **Split-pane workspace:** library, PDF reader, editor, and diagram canvas in resizable panes. A file tree shows the project folder.
2. **Normalized highlights:** the reader stores page-normalized coordinates (`0.0` to `1.0`).
3. **Citations:** typing `@` in the editor opens autocomplete from the library. Selecting a paper links it to the project.
4. **Typesetting:** a Web Worker compiles LaTeX or Typst with WASM. The worker reads files from `paper/` and caches TeX packages for offline use.

---

## 11. Phased plan

* **Phase 1 (done):** Go server, JWT auth, PDF upload with SHA-256 deduplication, BibTeX extraction, Overleaf git bridge.
* **Phase 2 (done):** Split-pane studio, PDF reader, LaTeX editor, diagram tool.
* **Phase 3 (project folders and local mode):**
  * `--mode` flag and SQLite library cache.
  * A "New project" action in the frontend creates a folder with the complete section 2 layout.
  * The project settings let the user link an Overleaf GitHub repository as `paper/`.
  * The explorer sidebar shows the project folder tree: `paper/`, `code/`, `notes/`, `diagrams/`, and `refs/`.
  * New notes go to `notes/`. New diagrams go to `diagrams/`. Diagram exports go to `paper/figures/`.
  * dupe generates `AGENTS.md`, `references.bib`, and `refs/text/` in each project.
* **Phase 4 (library sync):** sync API, local outbox, PDF cache, offline indicator, TeX package cache.
* **Phase 5 (agent integration):** MCP server for local mode.
* **Phase 6 (hosted mode for friends):** remove the terminal from hosted mode, restrict WebSocket origins, per-user project folders, `cloudflared` with Cloudflare Access, backup jobs.
* **Phase 7 (hosted agent panel):** containerized read-only agents with user-supplied API keys and diff review.
* **Phase 8 (post-MVP):** highlights and backlinks, Chrome Web Clipper, iPad offline PWA.
