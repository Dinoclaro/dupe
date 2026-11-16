CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Users
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    color_hex VARCHAR(7) DEFAULT '#FFEB3B',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Papers (PDFs and Metadata)
CREATE TABLE IF NOT EXISTS papers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    authors TEXT DEFAULT '',
    publication_year INT,
    doi TEXT DEFAULT '',
    bibtex_key TEXT DEFAULT '',
    bibtex_raw TEXT DEFAULT '',
    file_path TEXT NOT NULL,
    file_hash CHAR(64) NOT NULL,
    is_shared BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 3. Highlights and Annotations (PDF.js Overlay)
CREATE TABLE IF NOT EXISTS highlights (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    page_number INT NOT NULL,
    selected_text TEXT DEFAULT '',
    comment TEXT DEFAULT '',
    color_hex VARCHAR(7) DEFAULT '#FFEB3B',
    coordinates JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 4. Tags and Paper-Tag Join Table
CREATE TABLE IF NOT EXISTS tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ,
    PRIMARY KEY (paper_id, tag_id)
);

-- 5. Documents (Markdown Notes, Excalidraw Diagrams, LaTeX/Typst Source)
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    doc_type VARCHAR(20) NOT NULL CHECK (doc_type IN ('markdown', 'diagram', 'latex', 'typst')),
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    is_shared BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 6. Bidirectional Backlinks (Links between Notes, Papers, and Highlights)
CREATE TABLE IF NOT EXISTS backlinks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    target_paper_id UUID REFERENCES papers(id) ON DELETE CASCADE,
    target_highlight_id UUID REFERENCES highlights(id) ON DELETE CASCADE,
    target_doc_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

-- 7. Linked Git Repositories (Overleaf-GitHub Bridge)
CREATE TABLE IF NOT EXISTS git_repos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id INT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    bib_file_path TEXT DEFAULT 'references.bib',
    figures_dir TEXT DEFAULT 'figures',
    local_path TEXT NOT NULL,
    last_synced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at);
CREATE INDEX IF NOT EXISTS idx_papers_hash ON papers(file_hash);
CREATE INDEX IF NOT EXISTS idx_highlights_updated ON highlights(updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_git_repos_updated ON git_repos(updated_at);
