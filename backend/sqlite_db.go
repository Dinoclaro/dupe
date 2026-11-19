package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	_ "modernc.org/sqlite"
)

const sqliteUUIDExpr = `(lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))))`

const sqliteSchemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    color_hex TEXT DEFAULT '#FFEB3B',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY DEFAULT ` + sqliteUUIDExpr + `,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    authors TEXT DEFAULT '',
    publication_year INTEGER,
    doi TEXT DEFAULT '',
    bibtex_key TEXT DEFAULT '',
    bibtex_raw TEXT DEFAULT '',
    file_path TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    is_shared BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS highlights (
    id TEXT PRIMARY KEY DEFAULT ` + sqliteUUIDExpr + `,
    paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    page_number INTEGER NOT NULL,
    selected_text TEXT DEFAULT '',
    comment TEXT DEFAULT '',
    color_hex TEXT DEFAULT '#FFEB3B',
    coordinates TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY DEFAULT ` + sqliteUUIDExpr + `,
    name TEXT UNIQUE NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
    tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME,
    PRIMARY KEY (paper_id, tag_id)
);

CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY DEFAULT ` + sqliteUUIDExpr + `,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT DEFAULT '',
    is_shared BOOLEAN DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS backlinks (
    id TEXT PRIMARY KEY DEFAULT ` + sqliteUUIDExpr + `,
    source_doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    target_paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE,
    target_highlight_id TEXT REFERENCES highlights(id) ON DELETE CASCADE,
    target_doc_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);

CREATE TABLE IF NOT EXISTS git_repos (
    id TEXT PRIMARY KEY DEFAULT ` + sqliteUUIDExpr + `,
    owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    remote_url TEXT NOT NULL,
    bib_file_path TEXT DEFAULT 'references.bib',
    figures_dir TEXT DEFAULT 'figures',
    local_path TEXT NOT NULL,
    last_synced_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    deleted_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at);
CREATE INDEX IF NOT EXISTS idx_papers_hash ON papers(file_hash);
CREATE INDEX IF NOT EXISTS idx_highlights_updated ON highlights(updated_at);
CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at);
CREATE INDEX IF NOT EXISTS idx_git_repos_updated ON git_repos(updated_at);
`

var arrayAggRegex = regexp.MustCompile(`(?is)COALESCE\(\s*ARRAY_AGG\(([^)]+)\)\s*FILTER\s*\(\s*WHERE\s*([^)]+)\)\s*,\s*'\{\}'\s*\)`)

type sqliteQuerier struct {
	db *sql.DB
}

func initSQLiteDB(ctx context.Context, dbPath string) (*sqliteQuerier, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", dbPath, err)
	}
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if _, err := db.ExecContext(ctx, sqliteSchemaSQL); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply sqlite schema: %w", err)
	}
	return &sqliteQuerier{db: db}, nil
}

func (s *sqliteQuerier) Close() {
	if s != nil && s.db != nil {
		_ = s.db.Close()
	}
}

func rewritePGToSQLite(query string) string {
	q := arrayAggRegex.ReplaceAllString(query, "COALESCE(GROUP_CONCAT(DISTINCT CASE WHEN $2 THEN t.name END), '')")
	q = strings.ReplaceAll(q, "gen_random_uuid()::text", sqliteUUIDExpr)
	q = strings.ReplaceAll(q, "::text", "")
	q = strings.ReplaceAll(q, "NOW()", "CURRENT_TIMESTAMP")
	return q
}

func (s *sqliteQuerier) Exec(ctx context.Context, sqlStr string, arguments ...any) (pgconn.CommandTag, error) {
	res, err := s.db.ExecContext(ctx, rewritePGToSQLite(sqlStr), arguments...)
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	affected, _ := res.RowsAffected()
	return pgconn.NewCommandTag(fmt.Sprintf("UPDATE %d", affected)), nil
}

func (s *sqliteQuerier) Query(ctx context.Context, sqlStr string, args ...any) (pgx.Rows, error) {
	rows, err := s.db.QueryContext(ctx, rewritePGToSQLite(sqlStr), args...)
	if err != nil {
		return nil, err
	}
	return &sqliteRows{rows: rows}, nil
}

func (s *sqliteQuerier) QueryRow(ctx context.Context, sqlStr string, args ...any) pgx.Row {
	rows, err := s.db.QueryContext(ctx, rewritePGToSQLite(sqlStr), args...)
	return &sqliteRow{rows: rows, err: err}
}

type sqliteRow struct {
	rows *sql.Rows
	err  error
}

func (r *sqliteRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	defer func() {
		if r.rows != nil {
			_ = r.rows.Close()
		}
	}()
	if !r.rows.Next() {
		if err := r.rows.Err(); err != nil {
			return err
		}
		return pgx.ErrNoRows
	}
	return scanSQLiteRow(r.rows, dest...)
}

type sqliteRows struct {
	rows *sql.Rows
}

func (r *sqliteRows) Close()                                       { _ = r.rows.Close() }
func (r *sqliteRows) Err() error                                   { return r.rows.Err() }
func (r *sqliteRows) CommandTag() pgconn.CommandTag                { return pgconn.CommandTag{} }
func (r *sqliteRows) FieldDescriptions() []pgconn.FieldDescription { return nil }
func (r *sqliteRows) Next() bool                                   { return r.rows.Next() }
func (r *sqliteRows) Scan(dest ...any) error                       { return scanSQLiteRow(r.rows, dest...) }
func (r *sqliteRows) Values() ([]any, error)                       { return nil, nil }
func (r *sqliteRows) RawValues() [][]byte                          { return nil }
func (r *sqliteRows) Conn() *pgx.Conn                              { return nil }

func parseSQLiteTime(raw string) (time.Time, error) {
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05",
		"2006-01-02T15:04:05Z",
	} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("cannot parse time %q", raw)
}

func scanSQLiteRow(rows *sql.Rows, dest ...any) error {
	proxies := make([]any, len(dest))
	post := make([]func() error, 0)

	for i, d := range dest {
		switch target := d.(type) {
		case *[]string:
			var raw sql.NullString
			proxies[i] = &raw
			post = append(post, func() error {
				if !raw.Valid || strings.TrimSpace(raw.String) == "" || raw.String == "{}" {
					*target = []string{}
					return nil
				}
				parts := strings.Split(raw.String, ",")
				out := make([]string, 0, len(parts))
				for _, p := range parts {
					if trimmed := strings.TrimSpace(p); trimmed != "" {
						out = append(out, trimmed)
					}
				}
				*target = out
				return nil
			})
		case *time.Time:
			var raw any
			proxies[i] = &raw
			post = append(post, func() error {
				switch v := raw.(type) {
				case time.Time:
					*target = v.UTC()
				case string:
					t, err := parseSQLiteTime(v)
					if err != nil {
						return err
					}
					*target = t
				case []byte:
					t, err := parseSQLiteTime(string(v))
					if err != nil {
						return err
					}
					*target = t
				case nil:
					*target = time.Time{}
				}
				return nil
			})
		case **time.Time:
			var raw any
			proxies[i] = &raw
			post = append(post, func() error {
				switch v := raw.(type) {
				case nil:
					*target = nil
				case time.Time:
					tv := v.UTC()
					*target = &tv
				case string:
					if strings.TrimSpace(v) == "" {
						*target = nil
						return nil
					}
					t, err := parseSQLiteTime(v)
					if err != nil {
						return err
					}
					*target = &t
				case []byte:
					s := strings.TrimSpace(string(v))
					if s == "" {
						*target = nil
						return nil
					}
					t, err := parseSQLiteTime(s)
					if err != nil {
						return err
					}
					*target = &t
				}
				return nil
			})
		default:
			proxies[i] = d
		}
	}

	if err := rows.Scan(proxies...); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return pgx.ErrNoRows
		}
		return err
	}
	for _, fn := range post {
		if err := fn(); err != nil {
			return err
		}
	}
	return nil
}
