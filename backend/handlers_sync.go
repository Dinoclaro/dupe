package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var sha256HexRegex = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

type SyncPaperRecord struct {
	ID              string     `json:"id"`
	Title           string     `json:"title"`
	Authors         string     `json:"authors"`
	PublicationYear *int       `json:"publication_year"`
	DOI             string     `json:"doi"`
	BibtexKey       string     `json:"bibtex_key"`
	BibtexRaw       string     `json:"bibtex_raw"`
	FileHash        string     `json:"file_hash"`
	IsShared        bool       `json:"is_shared"`
	Tags            []string   `json:"tags"`
	UpdatedAt       time.Time  `json:"updated_at"`
	DeletedAt       *time.Time `json:"deleted_at,omitempty"`
}

type SyncHighlightRecord struct {
	ID           string          `json:"id"`
	PaperID      string          `json:"paper_id"`
	PageNumber   int             `json:"page_number"`
	SelectedText string          `json:"selected_text"`
	Comment      string          `json:"comment"`
	ColorHex     string          `json:"color_hex"`
	Coordinates  json.RawMessage `json:"coordinates"`
	UpdatedAt    time.Time       `json:"updated_at"`
	DeletedAt    *time.Time      `json:"deleted_at,omitempty"`
}

type LibraryChangesResponse struct {
	ServerTime time.Time             `json:"server_time"`
	Papers     []SyncPaperRecord     `json:"papers"`
	Highlights []SyncHighlightRecord `json:"highlights"`
}

type LibrarySyncBatchRequest struct {
	Papers     []SyncPaperRecord     `json:"papers"`
	Highlights []SyncHighlightRecord `json:"highlights"`
}

type LibrarySyncBatchResponse struct {
	AppliedPapers     int       `json:"applied_papers"`
	AppliedHighlights int       `json:"applied_highlights"`
	ServerTime        time.Time `json:"server_time"`
}

func (s *Server) handleLibraryChanges(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	since := time.Unix(0, 0).UTC()
	if rawSince := strings.TrimSpace(r.URL.Query().Get("since")); rawSince != "" {
		parsed, err := time.Parse(time.RFC3339, rawSince)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid 'since' timestamp; use RFC3339")
			return
		}
		since = parsed
	}

	const papersQuery = `
		SELECT p.id, p.title, p.authors, p.publication_year, p.doi, p.bibtex_key, p.bibtex_raw,
		       p.file_hash, p.is_shared, p.updated_at, p.deleted_at,
		       COALESCE(
		           ARRAY_AGG(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL AND pt.deleted_at IS NULL),
		           '{}'
		       ) AS tags
		FROM papers p
		LEFT JOIN paper_tags pt ON pt.paper_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		WHERE (p.owner_id = $1 OR p.is_shared = TRUE)
		  AND p.updated_at > $2
		GROUP BY p.id
		ORDER BY p.updated_at ASC
	`
	pRows, err := s.db.Query(r.Context(), papersQuery, claims.UserID, since)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to query paper changes")
		return
	}
	defer pRows.Close()

	papers := make([]SyncPaperRecord, 0)
	for pRows.Next() {
		var rec SyncPaperRecord
		if err := pRows.Scan(
			&rec.ID, &rec.Title, &rec.Authors, &rec.PublicationYear, &rec.DOI,
			&rec.BibtexKey, &rec.BibtexRaw, &rec.FileHash, &rec.IsShared,
			&rec.UpdatedAt, &rec.DeletedAt, &rec.Tags,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan paper change")
			return
		}
		papers = append(papers, rec)
	}

	const highlightsQuery = `
		SELECT id, paper_id, page_number, selected_text, comment, color_hex, coordinates, updated_at, deleted_at
		FROM highlights
		WHERE user_id = $1 AND updated_at > $2
		ORDER BY updated_at ASC
	`
	hRows, err := s.db.Query(r.Context(), highlightsQuery, claims.UserID, since)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to query highlight changes")
		return
	}
	defer hRows.Close()

	highlights := make([]SyncHighlightRecord, 0)
	for hRows.Next() {
		var h SyncHighlightRecord
		if err := hRows.Scan(
			&h.ID, &h.PaperID, &h.PageNumber, &h.SelectedText, &h.Comment,
			&h.ColorHex, &h.Coordinates, &h.UpdatedAt, &h.DeletedAt,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan highlight change")
			return
		}
		highlights = append(highlights, h)
	}

	writeJSON(w, http.StatusOK, LibraryChangesResponse{
		ServerTime: time.Now().UTC(),
		Papers:     papers,
		Highlights: highlights,
	})
}

func (s *Server) handleLibrarySync(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var batch LibrarySyncBatchRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 10<<20)).Decode(&batch); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	appliedPapers := 0
	for _, p := range batch.Papers {
		if !isValidUUID(p.ID) || !sha256HexRegex.MatchString(strings.TrimSpace(p.FileHash)) {
			continue
		}
		updatedAt := p.UpdatedAt
		if updatedAt.IsZero() {
			updatedAt = time.Now().UTC()
		}
		hashLower := strings.ToLower(strings.TrimSpace(p.FileHash))
		relPath := filepath.Join("pdfs", hashLower+".pdf")

		const upsertPaper = `
			INSERT INTO papers (
				id, owner_id, title, authors, publication_year, doi,
				bibtex_key, bibtex_raw, file_path, file_hash, is_shared, updated_at, deleted_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			ON CONFLICT (id) DO UPDATE
			SET title = EXCLUDED.title,
			    authors = EXCLUDED.authors,
			    publication_year = EXCLUDED.publication_year,
			    doi = EXCLUDED.doi,
			    bibtex_key = EXCLUDED.bibtex_key,
			    bibtex_raw = EXCLUDED.bibtex_raw,
			    is_shared = EXCLUDED.is_shared,
			    updated_at = EXCLUDED.updated_at,
			    deleted_at = EXCLUDED.deleted_at
			WHERE papers.owner_id = $2 AND papers.updated_at <= EXCLUDED.updated_at
		`
		tag, err := s.db.Exec(
			r.Context(),
			upsertPaper,
			p.ID,
			claims.UserID,
			p.Title,
			p.Authors,
			p.PublicationYear,
			p.DOI,
			p.BibtexKey,
			p.BibtexRaw,
			relPath,
			hashLower,
			p.IsShared,
			updatedAt,
			p.DeletedAt,
		)
		if err == nil && tag.RowsAffected() > 0 {
			appliedPapers++
			if p.Tags != nil {
				_ = s.replacePaperTags(r.Context(), p.ID, p.Tags)
			}
		}
	}

	appliedHighlights := 0
	for _, h := range batch.Highlights {
		if !isValidUUID(h.ID) || !isValidUUID(h.PaperID) {
			continue
		}
		updatedAt := h.UpdatedAt
		if updatedAt.IsZero() {
			updatedAt = time.Now().UTC()
		}
		coords := h.Coordinates
		if len(coords) == 0 {
			coords = json.RawMessage(`[]`)
		}
		const upsertHighlight = `
			INSERT INTO highlights (
				id, paper_id, user_id, page_number, selected_text, comment,
				color_hex, coordinates, updated_at, deleted_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (id) DO UPDATE
			SET page_number = EXCLUDED.page_number,
			    selected_text = EXCLUDED.selected_text,
			    comment = EXCLUDED.comment,
			    color_hex = EXCLUDED.color_hex,
			    coordinates = EXCLUDED.coordinates,
			    updated_at = EXCLUDED.updated_at,
			    deleted_at = EXCLUDED.deleted_at
			WHERE highlights.user_id = $3 AND highlights.updated_at <= EXCLUDED.updated_at
		`
		tag, err := s.db.Exec(
			r.Context(),
			upsertHighlight,
			h.ID,
			h.PaperID,
			claims.UserID,
			h.PageNumber,
			h.SelectedText,
			h.Comment,
			h.ColorHex,
			coords,
			updatedAt,
			h.DeletedAt,
		)
		if err == nil && tag.RowsAffected() > 0 {
			appliedHighlights++
		}
	}

	writeJSON(w, http.StatusOK, LibrarySyncBatchResponse{
		AppliedPapers:     appliedPapers,
		AppliedHighlights: appliedHighlights,
		ServerTime:        time.Now().UTC(),
	})
}

func (s *Server) handleUploadPaperBlob(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentUser(r); !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	expectedHash := strings.ToLower(strings.TrimSpace(r.PathValue("sha256")))
	if !sha256HexRegex.MatchString(expectedHash) {
		writeError(w, http.StatusBadRequest, "invalid SHA-256 hash")
		return
	}

	pdfsDir := filepath.Join(s.storageDir, "pdfs")
	if err := os.MkdirAll(pdfsDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create pdfs directory")
		return
	}

	finalPath := filepath.Join(pdfsDir, expectedHash+".pdf")
	if _, err := os.Stat(finalPath); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"file_hash": expectedHash,
			"skipped":   true,
		})
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	tmpFile, err := os.CreateTemp(pdfsDir, "blob-*.tmp")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create temp file")
		return
	}
	tmpPath := tmpFile.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmpFile, hasher), r.Body); err != nil {
		_ = tmpFile.Close()
		writeError(w, http.StatusBadRequest, "failed to stream PDF blob")
		return
	}
	_ = tmpFile.Close()

	actualHash := hex.EncodeToString(hasher.Sum(nil))
	if actualHash != expectedHash {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("SHA-256 mismatch: expected %s, got %s", expectedHash, actualHash))
		return
	}

	if _, err := os.Stat(finalPath); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(tmpPath, finalPath); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to store PDF blob")
			return
		}
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"file_hash": expectedHash,
		"skipped":   false,
	})
}
