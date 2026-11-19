package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
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

type RemoteSyncConfig struct {
	RemoteURL    string `json:"remote_url"`
	Username     string `json:"username,omitempty"`
	Token        string `json:"token,omitempty"`
	LastSyncedAt string `json:"last_synced_at,omitempty"`
}

func (s *Server) remoteSyncConfigPath() string {
	return filepath.Join(s.storageDir, "remote_sync.json")
}

func (s *Server) loadRemoteSyncConfig() RemoteSyncConfig {
	raw, err := os.ReadFile(s.remoteSyncConfigPath())
	if err != nil {
		return RemoteSyncConfig{}
	}
	var cfg RemoteSyncConfig
	_ = json.Unmarshal(raw, &cfg)
	cfg.RemoteURL = strings.TrimRight(strings.TrimSpace(cfg.RemoteURL), "/")
	return cfg
}

func (s *Server) saveRemoteSyncConfig(cfg RemoteSyncConfig) error {
	cfg.RemoteURL = strings.TrimRight(strings.TrimSpace(cfg.RemoteURL), "/")
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.remoteSyncConfigPath(), append(data, '\n'), 0o600)
}

func (s *Server) startBackgroundRemoteSync(ctx context.Context) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Initial sync after startup if configured
	if cfg := s.loadRemoteSyncConfig(); cfg.RemoteURL != "" && cfg.Token != "" {
		if _, err := s.runRemoteSyncCycle(ctx, cfg); err != nil {
			slog.Warn("initial remote sync failed", "remote_url", cfg.RemoteURL, "error", err)
		}
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cfg := s.loadRemoteSyncConfig()
			if cfg.RemoteURL != "" && cfg.Token != "" {
				if _, err := s.runRemoteSyncCycle(ctx, cfg); err != nil {
					slog.Warn("periodic remote sync failed", "remote_url", cfg.RemoteURL, "error", err)
				}
			}
		}
	}
}

func (s *Server) handleGetRemoteSyncStatus(w http.ResponseWriter, _ *http.Request) {
	cfg := s.loadRemoteSyncConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":           s.mode,
		"remote_url":     cfg.RemoteURL,
		"username":       cfg.Username,
		"has_token":      cfg.Token != "",
		"last_synced_at": cfg.LastSyncedAt,
	})
}

type triggerRemoteSyncRequest struct {
	RemoteURL string `json:"remote_url"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Token     string `json:"token"`
}

func (s *Server) handleTriggerRemoteSync(w http.ResponseWriter, r *http.Request) {
	var req triggerRemoteSyncRequest
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
	}
	cfg := s.loadRemoteSyncConfig()
	if strings.TrimSpace(req.RemoteURL) != "" {
		cfg.RemoteURL = strings.TrimRight(strings.TrimSpace(req.RemoteURL), "/")
	}
	if strings.TrimSpace(req.Username) != "" {
		cfg.Username = strings.TrimSpace(req.Username)
	}
	if strings.TrimSpace(req.Token) != "" {
		cfg.Token = strings.TrimSpace(req.Token)
	}

	if cfg.RemoteURL == "" {
		writeError(w, http.StatusBadRequest, "remote_url is required (e.g. https://dupe.ing)")
		return
	}

	client := &http.Client{Timeout: 30 * time.Second}
	if strings.TrimSpace(req.Password) != "" && cfg.Username != "" {
		loginBody, _ := json.Marshal(map[string]string{
			"username": cfg.Username,
			"password": req.Password,
		})
		loginReq, err := http.NewRequestWithContext(r.Context(), http.MethodPost, cfg.RemoteURL+"/api/auth/login", bytes.NewReader(loginBody))
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid remote_url")
			return
		}
		loginReq.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(loginReq)
		if err != nil {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("failed to reach remote server: %v", err))
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode != http.StatusOK {
			writeError(w, http.StatusUnauthorized, "remote login failed; check username and password")
			return
		}
		var loginData loginResponse
		if err := json.NewDecoder(resp.Body).Decode(&loginData); err != nil || loginData.Token == "" {
			writeError(w, http.StatusBadGateway, "invalid login response from remote server")
			return
		}
		cfg.Token = loginData.Token
	}

	if cfg.Token == "" {
		writeError(w, http.StatusBadRequest, "token or username+password is required for remote sync")
		return
	}
	_ = s.saveRemoteSyncConfig(cfg)

	summary, err := s.runRemoteSyncCycle(r.Context(), cfg)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func (s *Server) runRemoteSyncCycle(ctx context.Context, cfg RemoteSyncConfig) (map[string]any, error) {
	client := &http.Client{Timeout: 45 * time.Second}
	sinceParam := "1970-01-01T00:00:00Z"
	if cfg.LastSyncedAt != "" {
		sinceParam = cfg.LastSyncedAt
	}

	// 1. Pull library changes from hosted server
	changesURL := fmt.Sprintf("%s/api/library/changes?since=%s", cfg.RemoteURL, url.QueryEscape(sinceParam))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, changesURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch remote library changes: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("remote /api/library/changes returned status %d", resp.StatusCode)
	}
	var remoteChanges LibraryChangesResponse
	if err := json.NewDecoder(resp.Body).Decode(&remoteChanges); err != nil {
		return nil, fmt.Errorf("decode remote library changes: %w", err)
	}

	pulledPapers := 0
	downloadedPDFs := 0
	const upsertPaperSQL = `
		INSERT INTO papers (
			id, owner_id, title, authors, publication_year, doi, bibtex_key, bibtex_raw,
			file_path, file_hash, is_shared, updated_at, deleted_at
		)
		VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
		ON CONFLICT (id) DO UPDATE SET
			title = EXCLUDED.title,
			authors = EXCLUDED.authors,
			publication_year = EXCLUDED.publication_year,
			doi = EXCLUDED.doi,
			bibtex_key = EXCLUDED.bibtex_key,
			bibtex_raw = EXCLUDED.bibtex_raw,
			file_hash = EXCLUDED.file_hash,
			is_shared = EXCLUDED.is_shared,
			updated_at = EXCLUDED.updated_at,
			deleted_at = EXCLUDED.deleted_at
		WHERE papers.updated_at < EXCLUDED.updated_at
	`
	for _, p := range remoteChanges.Papers {
		hash := strings.ToLower(strings.TrimSpace(p.FileHash))
		if !isValidUUID(p.ID) || !sha256HexRegex.MatchString(hash) {
			continue
		}
		relPath := filepath.ToSlash(filepath.Join("pdfs", hash+".pdf"))
		tag, execErr := s.db.Exec(
			ctx,
			upsertPaperSQL,
			p.ID, p.Title, p.Authors, p.PublicationYear, p.DOI, p.BibtexKey, p.BibtexRaw,
			relPath, hash, p.IsShared, p.UpdatedAt, p.DeletedAt,
		)
		if execErr == nil && tag.RowsAffected() > 0 {
			if p.Tags != nil {
				_ = s.replacePaperTags(ctx, p.ID, p.Tags)
			}
			pulledPapers++
		}
		// Ensure PDF file is cached locally if not deleted
		localPDF := filepath.Join(s.storageDir, "pdfs", hash+".pdf")
		if p.DeletedAt == nil {
			if _, statErr := os.Stat(localPDF); errors.Is(statErr, os.ErrNotExist) {
				if s.downloadRemotePDF(ctx, client, cfg, p.ID, hash, localPDF) == nil {
					downloadedPDFs++
				}
			}
		}
	}

	// 2. Push local library changes & PDF blobs to hosted server
	sinceTime, _ := time.Parse(time.RFC3339, sinceParam)
	const localPapersQuery = `
		SELECT p.id, p.title, p.authors, p.publication_year, p.doi, p.bibtex_key, p.bibtex_raw,
		       p.file_hash, p.is_shared, p.updated_at, p.deleted_at,
		       COALESCE(
		           ARRAY_AGG(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL AND pt.deleted_at IS NULL),
		           '{}'
		       ) AS tags
		FROM papers p
		LEFT JOIN paper_tags pt ON pt.paper_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		WHERE p.updated_at > $1
		GROUP BY p.id
	`
	rows, err := s.db.Query(ctx, localPapersQuery, sinceTime)
	var outboxPapers []SyncPaperRecord
	if err == nil {
		for rows.Next() {
			var rec SyncPaperRecord
			if rows.Scan(
				&rec.ID, &rec.Title, &rec.Authors, &rec.PublicationYear, &rec.DOI,
				&rec.BibtexKey, &rec.BibtexRaw, &rec.FileHash, &rec.IsShared,
				&rec.UpdatedAt, &rec.DeletedAt, &rec.Tags,
			) == nil {
				outboxPapers = append(outboxPapers, rec)
			}
		}
		rows.Close()
	}

	uploadedBlobs := 0
	for _, rec := range outboxPapers {
		if rec.DeletedAt == nil {
			localPDF := filepath.Join(s.storageDir, "pdfs", strings.ToLower(rec.FileHash)+".pdf")
			if s.uploadLocalPDFBlob(ctx, client, cfg, strings.ToLower(rec.FileHash), localPDF) == nil {
				uploadedBlobs++
			}
		}
	}

	pushedPapers := 0
	if len(outboxPapers) > 0 {
		batchPayload, _ := json.Marshal(LibrarySyncBatchRequest{Papers: outboxPapers})
		pushReq, reqErr := http.NewRequestWithContext(ctx, http.MethodPost, cfg.RemoteURL+"/api/library/sync", bytes.NewReader(batchPayload))
		if reqErr == nil {
			pushReq.Header.Set("Authorization", "Bearer "+cfg.Token)
			pushReq.Header.Set("Content-Type", "application/json")
			if pushResp, doErr := client.Do(pushReq); doErr == nil {
				var syncRes LibrarySyncBatchResponse
				_ = json.NewDecoder(pushResp.Body).Decode(&syncRes)
				_ = pushResp.Body.Close()
				pushedPapers = syncRes.AppliedPapers
			}
		}
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)
	cfg.LastSyncedAt = nowStr
	_ = s.saveRemoteSyncConfig(cfg)

	return map[string]any{
		"remote_url":      cfg.RemoteURL,
		"pulled_papers":   pulledPapers,
		"downloaded_pdfs": downloadedPDFs,
		"pushed_papers":   pushedPapers,
		"uploaded_blobs":  uploadedBlobs,
		"last_synced_at":  nowStr,
	}, nil
}

func (s *Server) downloadRemotePDF(ctx context.Context, client *http.Client, cfg RemoteSyncConfig, paperID, expectedHash, destPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("%s/api/papers/%s/file", cfg.RemoteURL, paperID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download PDF status %d", resp.StatusCode)
	}
	_ = os.MkdirAll(filepath.Dir(destPath), 0o755)
	tmp, err := os.CreateTemp(filepath.Dir(destPath), "dl-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()

	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hasher), resp.Body); err != nil {
		_ = tmp.Close()
		return err
	}
	_ = tmp.Close()
	if hex.EncodeToString(hasher.Sum(nil)) != expectedHash {
		return fmt.Errorf("downloaded PDF SHA-256 mismatch")
	}
	return os.Rename(tmpName, destPath)
}

func (s *Server) uploadLocalPDFBlob(ctx context.Context, client *http.Client, cfg RemoteSyncConfig, hash, localPath string) error {
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	req, err := http.NewRequestWithContext(ctx, http.MethodPut, fmt.Sprintf("%s/api/papers/blob/%s", cfg.RemoteURL, hash), f)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.Token)
	req.Header.Set("Content-Type", "application/pdf")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("upload blob status %d", resp.StatusCode)
	}
	return nil
}
