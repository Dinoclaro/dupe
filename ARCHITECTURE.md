# ARCHITECTURE.md — Dino's Ultimate Paper Editor

## 1. Project Overview & Philosophy
This project is a self-hosted, multi-user academic research and writing workspace (combining Zotero + Obsidian + Overleaf + Excalidraw), designed for ~10–50 users running on a home Linux server (2015 Intel Core i7, 300 GB storage).

### Core Architectural Tenets (STRICT RULES FOR AI AGENTS)
1. **Laptop-First Academic Studio:** Phases 1–4 focus strictly on the **Desktop/Laptop Split-Pane Web Application** and **Chrome Web Clipper**. Mobile/iPad offline PWA support is deferred to Phase 5 (though database schemas must remain offline-ready from Day 1).
2. **Client-Side Compute Offloading:** The Linux server has an older CPU (2015 Core i7). Offload all heavy computation—PDF rendering (`PDF.js`), Markdown/KaTeX parsing, diagram rendering (`Excalidraw`), and academic typesetting (**WASM Typst / SwiftLaTeX** inside Web Workers)—directly to the user's laptop browser. The Linux server strictly handles auth, PostgreSQL CRUD, file storage, and lightweight Python DOI/metadata scraping.
3. **Network Agnostic (`localhost:8080`):** The Go backend listens on `127.0.0.1:8080`. External HTTPS is handled transparently via `tailscale serve` (initial dev) or `cloudflared` (Cloudflare Tunnel for friends). Frontend API calls MUST use relative paths (`/api/...`).
4. **Future-Proof Data Model:** Even though Laptop mode reads/writes directly to the REST API, all database tables MUST use client-generated `UUID` primary keys, `updated_at` timestamps, and `deleted_at` soft-deletes so the Phase 5 iPad offline sync engine requires zero schema changes.

---

## 2. Monorepo Directory Structure
```text
/
├── ARCHITECTURE.md          # Master architecture & AI agent rules
├── CONTRIBUTION.md          # Code quality, execution tiers, and review rules
├── GEMINI.md                # Agent entrypoint and writing standards
├── AGENTS.md                # Agent entrypoint (synchronized with GEMINI.md)
├── docker-compose.yml       # PostgreSQL 16 service
├── .air.toml                # Hot-reload config for Go development
├── backend/                 # Go 1.22+ HTTP Server
│   ├── go.mod
│   ├── main.go              # Entrypoint, CLI flags (--create-user), router
│   ├── db.go                # pgxpool connection & schema initialization
│   ├── auth.go              # JWT middleware & bcrypt password hashing
│   ├── handlers_papers.go   # PDF upload, streaming, metadata endpoints
│   ├── handlers_git.go      # GitHub/Overleaf repo clone, .bib/figure write, commit & push
│   ├── handlers_docs.go     # CRUD for Markdown notes, diagrams, and LaTeX/Typst files
│   ├── handlers_sync.go     # (Deferred to Phase 5) Batch sync for offline devices
│   └── schema.sql           # Declarative PostgreSQL schema
├── scripts/                 # Python 3 helper scripts (invoked by Go via os/exec)
│   ├── requirements.txt     # PyMuPDF (fitz), requests, bibtexparser
│   └── extract_meta.py      # Extracts DOI, title, authors, and BibTeX from PDFs/URLs
├── storage/                 # Local disk mount for PDFs and Git repos (gitignored)
│   ├── pdfs/                # Stored as <paper_uuid>.pdf (deduplicated via SHA256)
│   └── repos/               # Cloned Overleaf-linked GitHub repos (<repo_uuid>/)
├── web/                     # Vite + React + TypeScript Frontend
│   └── src/
│       ├── api/             # REST client with JWT header injection
│       ├── workers/         # Web Workers for client-side WASM LaTeX/Typst compilation
│       ├── components/
│       │   ├── Workspace/   # Resizable split-pane layout manager (VS Code / Obsidian style)
│       │   ├── Library/     # Paper list, tag filters, BibTeX export
│       │   ├── Reader/      # PDF.js canvas + normalized bounding-box highlight overlay
│       │   ├── Editor/      # CodeMirror 6 (Markdown + KaTeX + LaTeX/Typst syntax)
│       │   └── Diagram/     # Embedded Excalidraw / Draw.io canvas
│       └── App.tsx
└── extension/               # Manifest V3 Chrome Web Clipper
    ├── manifest.json
    ├── popup.html
    └── popup.js             # Scrapes active tab PDF/DOI & POSTs to configurable Server URL
```

---

## 3. PostgreSQL Database Schema (`backend/schema.sql`)
All entity tables use `UUID` keys, `updated_at`, and `deleted_at` soft-deletes.

```sql
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Users
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    color_hex VARCHAR(7) DEFAULT '#FFEB3B', -- Color-codes highlights on shared papers
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Papers (PDFs & Metadata)
CREATE TABLE papers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    authors TEXT,
    publication_year INT,
    doi TEXT,
    bibtex_key TEXT,
    bibtex_raw TEXT,
    file_path TEXT NOT NULL,         -- Relative path inside /storage/pdfs/
    file_hash CHAR(64),              -- SHA-256 hash to prevent duplicate PDF storage
    is_shared BOOLEAN DEFAULT FALSE, -- True = visible to all authenticated users on server
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 3. Highlights & Annotations (PDF.js Overlay)
CREATE TABLE highlights (
    id UUID PRIMARY KEY,             -- Generated on client via crypto.randomUUID()
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    page_number INT NOT NULL,
    selected_text TEXT,
    comment TEXT,
    color_hex VARCHAR(7),
    coordinates JSONB NOT NULL,      -- Normalized bounding rects (0.0 to 1.0): [{x, y, w, h}]
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 4. Tags & Paper-Tag Join Table
CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE paper_tags (
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (paper_id, tag_id)
);

-- 5. Documents (Markdown Notes, Excalidraw Diagrams, LaTeX/Typst Source)
CREATE TABLE documents (
    id UUID PRIMARY KEY,             -- Generated on client via crypto.randomUUID()
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    doc_type VARCHAR(20) NOT NULL CHECK (doc_type IN ('markdown', 'diagram', 'latex', 'typst')),
    title TEXT NOT NULL,
    content TEXT DEFAULT '',         -- Raw Markdown, Excalidraw JSON/SVG, or LaTeX/Typst source
    is_shared BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 6. Bidirectional Backlinks (Links between Notes, Papers, and Highlights)
CREATE TABLE backlinks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    target_paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    target_highlight_id UUID REFERENCES highlights(id) ON DELETE CASCADE,
    target_doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 7. Linked Git Repositories (Overleaf-GitHub Bridge)
CREATE TABLE git_repos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    remote_url TEXT NOT NULL,        -- GitHub repo URL linked to Overleaf
    bib_file_path TEXT DEFAULT 'references.bib',
    figures_dir TEXT DEFAULT 'figures',
    local_path TEXT NOT NULL,        -- Relative path inside /storage/repos/
    last_synced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_papers_updated ON papers(updated_at);
CREATE INDEX idx_highlights_updated ON highlights(updated_at);
CREATE INDEX idx_documents_updated ON documents(updated_at);
CREATE INDEX idx_git_repos_updated ON git_repos(updated_at);
```

---

## 4. Backend Specification (Go + Python Hybrid)

### Go HTTP Server (`backend/`)
* **Routing & DB:** Go 1.22+ standard `net/http` `ServeMux` + `github.com/jackc/pgx/v5/pgxpool` with raw SQL.
* **CLI User Management:** `./server --create-user <username> --password <pass>` hashes the password with `bcrypt` and inserts the user. No public sign-up endpoint.
* **Authentication:** `POST /api/auth/login` returns a 90-day signed JWT.
* **Python Integration (`scripts/extract_meta.py`):** On `POST /api/papers/upload`, Go saves the PDF to `/storage/pdfs/<uuid>.pdf` and runs `python3 scripts/extract_meta.py` via `os/exec` (15s timeout). The Python script extracts DOI/metadata via `PyMuPDF`, queries Crossref/arXiv, generates a `bibtex_key` and raw BibTeX entry, and prints JSON to `stdout` for Go to store in Postgres.
* **Overleaf-GitHub Bridge (`backend/handlers_git.go`):** Users link an Overleaf project's GitHub repository URL. The Go backend clones the repository into `/storage/repos/<repo_uuid>/`, writes the aggregated `references.bib` from `papers.bibtex_raw`, writes exported Excalidraw figures (`.svg`/`.pdf`/`.png`) and edited `.tex` files into the working tree, and executes `git pull --rebase`, `git commit`, and `git push` so Overleaf pulls updates directly from GitHub.

---

## 5. Client-Side Compute & Laptop Studio Architecture (`web/`)

1. **Split-Pane Workspace:** Users can open a Library view, PDF Reader (`PDF.js`), Markdown/LaTeX Editor (`CodeMirror 6`), and Diagram Canvas (`Excalidraw`) side-by-side in resizable panes.
2. **Normalized PDF Highlights:** Never store pixel coordinates. Convert `DOMRect` selection coordinates into page-normalized percentages (`0.0` to `1.0`) so highlights scale across any monitor size.
3. **Citations & Backlinks:** Typing `@` in the Markdown or LaTeX/Typst editor triggers an autocomplete dropdown fed by the user's `papers` list (inserting `@bibtex_key`). Clicking a highlight in `PDF.js` copies a `[[highlight:uuid]]` reference link.
4. **Client-Side Typesetting (Web Worker + WASM):**
   * Inline equations in Markdown render instantaneously on the client via **KaTeX**.
   * Full paper compilation runs inside a dedicated browser **Web Worker** (`web/src/workers/`) using a WebAssembly compiler (**Typst.ts WASM** or **SwiftLaTeX WASM**), combining the document's source text, exported SVG diagrams, and a virtual `.bib` file assembled from the user's `papers.bibtex_raw` column.

---

## 6. Phased Execution Plan (MVP-First)
* **Phase 1 (MVP Part 1 - Backend, PDF Library, BibTeX & GitHub/Overleaf Bridge):** `docker-compose.yml` (Postgres 16), `schema.sql`, Go server with JWT auth, `--create-user` CLI flag, `.air.toml`, PDF upload/storage with SHA-256 deduplication, `scripts/extract_meta.py` to generate BibTeX entries for all uploaded PDFs, and `handlers_git.go` to clone an Overleaf-linked GitHub repo, write `references.bib`, and commit/push changes.
* **Phase 2 (MVP Part 2 - Split-Pane Studio, Diagram Tool & LaTeX Editor):** Split-pane React UI, Library dashboard with BibTeX management and `PDF.js` viewer, embedded `Excalidraw` diagram canvas that saves figures into the linked GitHub repo (`figures/`), `CodeMirror 6` LaTeX editor with `@citation` autocomplete backed by the generated `.bib` entries, and optional client-side WASM LaTeX preview (`SwiftLaTeX` / `Typst`).
* **Phase 3 (Markdown Note-Taker, Highlights & Backlinks):** Normalized bounding-box PDF highlighting (`0.0` to `1.0`), Markdown notes with inline `KaTeX`, and bidirectional `[[highlight:uuid]]` backlinks.
* **Phase 4 (Desktop Chrome Clipper):** Manifest V3 extension to clip PDFs and metadata from arXiv, IEEE, and PubMed to the Go backend.
* **Phase 5 (Future iPad Offline PWA):** Add Safari `manifest.json`, Service Worker, `Dexie.js` (`IndexedDB`), offline PDF cache toggle, and `POST /api/sync` outbox synchronization.