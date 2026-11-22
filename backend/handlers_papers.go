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
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	maxUploadSize       = 500 << 20 // 500 MB per upload request
	extractMetaTimeout  = 15 * time.Second
	pdfMagicHeader      = "%PDF-"
)

var nonAlnumRegex = regexp.MustCompile(`[^a-z0-9]+`)

type Paper struct {
	ID              string    `json:"id"`
	OwnerID         int       `json:"owner_id"`
	Title           string    `json:"title"`
	Authors         string    `json:"authors"`
	PublicationYear *int      `json:"publication_year"`
	DOI             string    `json:"doi"`
	BibtexKey       string    `json:"bibtex_key"`
	BibtexRaw       string    `json:"bibtex_raw"`
	FilePath        string    `json:"file_path"`
	FileHash        string    `json:"file_hash"`
	IsShared        bool      `json:"is_shared"`
	Tags            []string  `json:"tags"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type extractedMeta struct {
	Title           string `json:"title"`
	Authors         string `json:"authors"`
	PublicationYear *int   `json:"publication_year"`
	DOI             string `json:"doi"`
	BibtexKey       string `json:"bibtex_key"`
	BibtexRaw       string `json:"bibtex_raw"`
}

func fallbackMetadata(filename string) extractedMeta {
	stem := strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename))
	if stem == "" {
		stem = "Untitled Paper"
	}
	slug := strings.Trim(nonAlnumRegex.ReplaceAllString(strings.ToLower(stem), ""), "")
	if slug == "" {
		slug = "paper"
	}
	if len(slug) > 16 {
		slug = slug[:16]
	}
	key := fmt.Sprintf("unknownnd%s", slug)
	raw := fmt.Sprintf("@misc{%s,\n  title = {%s},\n  author = {Unknown},\n}", key, stem)
	return extractedMeta{
		Title:     stem,
		Authors:   "Unknown",
		BibtexKey: key,
		BibtexRaw: raw,
	}
}

func (s *Server) runExtractMeta(ctx context.Context, pdfPath, originalFilename string, forceOffline bool) (extractedMeta, error) {
	ctxTimeout, cancel := context.WithTimeout(ctx, extractMetaTimeout)
	defer cancel()

	args := []string{s.extractScript, pdfPath, "--filename", originalFilename}
	if s.offlineMeta || forceOffline {
		args = append(args, "--offline")
	}

	cmd := exec.CommandContext(ctxTimeout, s.pythonBin, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return fallbackMetadata(originalFilename), fmt.Errorf("extract_meta.py failed: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}

	var meta extractedMeta
	if err := json.Unmarshal(stdout.Bytes(), &meta); err != nil {
		return fallbackMetadata(originalFilename), fmt.Errorf("decode extract_meta.py output: %w", err)
	}
	if strings.TrimSpace(meta.Title) == "" {
		fb := fallbackMetadata(originalFilename)
		meta.Title = fb.Title
	}
	if strings.TrimSpace(meta.BibtexKey) == "" || strings.TrimSpace(meta.BibtexRaw) == "" {
		fb := fallbackMetadata(meta.Title)
		if meta.BibtexKey == "" {
			meta.BibtexKey = fb.BibtexKey
		}
		if meta.BibtexRaw == "" {
			meta.BibtexRaw = fb.BibtexRaw
		}
	}
	return meta, nil
}

func (s *Server) saveUploadedPDF(src io.Reader) (string, string, error) {
	pdfsDir := filepath.Join(s.storageDir, "pdfs")
	if err := os.MkdirAll(pdfsDir, 0o755); err != nil {
		return "", "", fmt.Errorf("create pdfs directory: %w", err)
	}

	header := make([]byte, len(pdfMagicHeader))
	if _, err := io.ReadFull(src, header); err != nil {
		return "", "", fmt.Errorf("file is too short to be a valid PDF")
	}
	if string(header) != pdfMagicHeader {
		return "", "", fmt.Errorf("file does not start with %%PDF- header")
	}

	tmpFile, err := os.CreateTemp(pdfsDir, "upload-*.tmp")
	if err != nil {
		return "", "", fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	hasher := sha256.New()
	multiWriter := io.MultiWriter(tmpFile, hasher)

	if _, err := multiWriter.Write(header); err != nil {
		_ = tmpFile.Close()
		return "", "", fmt.Errorf("write PDF header: %w", err)
	}
	if _, err := io.Copy(multiWriter, src); err != nil {
		_ = tmpFile.Close()
		return "", "", fmt.Errorf("stream PDF content: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return "", "", fmt.Errorf("close temp file: %w", err)
	}

	fileHash := hex.EncodeToString(hasher.Sum(nil))
	relPath := filepath.Join("pdfs", fileHash+".pdf")
	finalPath := filepath.Join(s.storageDir, relPath)

	if _, err := os.Stat(finalPath); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(tmpPath, finalPath); err != nil {
			return "", "", fmt.Errorf("move PDF into storage: %w", err)
		}
	}

	return relPath, fileHash, nil
}

func (s *Server) storePaperFromReader(ctx context.Context, userID int, src io.Reader, filename string, isShared, skipNetwork bool) (Paper, error) {
	relPath, fileHash, saveErr := s.saveUploadedPDF(src)
	if saveErr != nil {
		return Paper{}, fmt.Errorf("invalid PDF %s: %w", filename, saveErr)
	}

	var existing Paper
	const checkDupQuery = `
		SELECT id, owner_id, title, authors, publication_year, doi, bibtex_key, bibtex_raw,
		       file_path, file_hash, is_shared, updated_at
		FROM papers
		WHERE owner_id = $1 AND file_hash = $2 AND deleted_at IS NULL
		LIMIT 1
	`
	err := s.db.QueryRow(ctx, checkDupQuery, userID, fileHash).Scan(
		&existing.ID,
		&existing.OwnerID,
		&existing.Title,
		&existing.Authors,
		&existing.PublicationYear,
		&existing.DOI,
		&existing.BibtexKey,
		&existing.BibtexRaw,
		&existing.FilePath,
		&existing.FileHash,
		&existing.IsShared,
		&existing.UpdatedAt,
	)
	if err == nil {
		existing.Tags = []string{}
		return existing, nil
	}

	absPath := filepath.Join(s.storageDir, relPath)
	meta, _ := s.runExtractMeta(ctx, absPath, filename, skipNetwork)

	var created Paper
	const insertQuery = `
		INSERT INTO papers (
			owner_id, title, authors, publication_year, doi,
			bibtex_key, bibtex_raw, file_path, file_hash, is_shared
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, owner_id, title, authors, publication_year, doi,
		          bibtex_key, bibtex_raw, file_path, file_hash, is_shared, updated_at
	`
	err = s.db.QueryRow(
		ctx,
		insertQuery,
		userID,
		meta.Title,
		meta.Authors,
		meta.PublicationYear,
		meta.DOI,
		meta.BibtexKey,
		meta.BibtexRaw,
		relPath,
		fileHash,
		isShared,
	).Scan(
		&created.ID,
		&created.OwnerID,
		&created.Title,
		&created.Authors,
		&created.PublicationYear,
		&created.DOI,
		&created.BibtexKey,
		&created.BibtexRaw,
		&created.FilePath,
		&created.FileHash,
		&created.IsShared,
		&created.UpdatedAt,
	)
	if err != nil {
		return Paper{}, fmt.Errorf("failed to store paper metadata: %w", err)
	}
	created.Tags = []string{}
	return created, nil
}

func (s *Server) handleUploadPapers(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(32 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "failed to parse multipart form")
		return
	}

	var fileHeaders []*multipart.FileHeader
	if r.MultipartForm != nil {
		fileHeaders = append(fileHeaders, r.MultipartForm.File["file"]...)
		fileHeaders = append(fileHeaders, r.MultipartForm.File["files"]...)
	}
	if len(fileHeaders) == 0 {
		writeError(w, http.StatusBadRequest, "at least one PDF file is required under field 'file' or 'files'")
		return
	}

	isShared := strings.EqualFold(r.FormValue("is_shared"), "true")
	skipNetwork := strings.EqualFold(r.FormValue("skip_network"), "true")
	var uploaded []Paper

	for _, fh := range fileHeaders {
		src, err := fh.Open()
		if err != nil {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("open %s: %v", fh.Filename, err))
			return
		}
		paper, storeErr := s.storePaperFromReader(r.Context(), claims.UserID, src, fh.Filename, isShared, skipNetwork)
		_ = src.Close()
		if storeErr != nil {
			status := http.StatusBadRequest
			if strings.Contains(storeErr.Error(), "store paper metadata") {
				status = http.StatusInternalServerError
			}
			writeError(w, status, storeErr.Error())
			return
		}
		uploaded = append(uploaded, paper)
	}

	if len(uploaded) == 1 {
		writeJSON(w, http.StatusCreated, uploaded[0])
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"papers": uploaded})
}

var (
	bareArxivIDRegex     = regexp.MustCompile(`^(?:arXiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$`)
	citationMetaPDFRegex = regexp.MustCompile(`(?is)<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)["']`)
	citationMetaAltRegex = regexp.MustCompile(`(?is)<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_pdf_url["']`)
)

func normalizePaperImportURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if m := bareArxivIDRegex.FindStringSubmatch(trimmed); len(m) > 1 {
		return "https://arxiv.org/pdf/" + m[1] + ".pdf"
	}
	if strings.HasPrefix(trimmed, "10.") && strings.Contains(trimmed, "/") {
		return "https://doi.org/" + trimmed
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return trimmed
	}
	host := strings.ToLower(parsed.Hostname())
	if (host == "arxiv.org" || host == "www.arxiv.org") && strings.HasPrefix(parsed.Path, "/abs/") {
		idPart := strings.TrimPrefix(parsed.Path, "/abs/")
		return "https://arxiv.org/pdf/" + strings.TrimSuffix(idPart, ".pdf") + ".pdf"
	}
	if host == "openreview.net" && strings.HasPrefix(parsed.Path, "/forum") {
		parsed.Path = "/pdf"
		return parsed.String()
	}
	return trimmed
}

func fetchPDFOrCitationURL(ctx context.Context, targetURL string) ([]byte, string, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	fetchOnce := func(rawURL string) ([]byte, string, string, error) {
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil, "", "", fmt.Errorf("invalid URL scheme (expected http or https)")
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if err != nil {
			return nil, "", "", err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; dupe/1.0)")
		resp, err := client.Do(req)
		if err != nil {
			return nil, "", "", err
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode >= 400 {
			return nil, "", "", fmt.Errorf("remote returned HTTP %d", resp.StatusCode)
		}
		limited := io.LimitReader(resp.Body, 100<<20)
		data, err := io.ReadAll(limited)
		if err != nil {
			return nil, "", "", err
		}
		finalName := filepath.Base(resp.Request.URL.Path)
		if finalName == "" || finalName == "/" || finalName == "." {
			finalName = "imported.pdf"
		}
		if !strings.HasSuffix(strings.ToLower(finalName), ".pdf") {
			finalName += ".pdf"
		}
		return data, resp.Header.Get("Content-Type"), finalName, nil
	}

	data, _, name, err := fetchOnce(targetURL)
	if err != nil {
		return nil, "", err
	}
	if len(data) >= len(pdfMagicHeader) && string(data[:len(pdfMagicHeader)]) == pdfMagicHeader {
		return data, name, nil
	}

	htmlSnippet := string(data)
	if len(htmlSnippet) > 256*1024 {
		htmlSnippet = htmlSnippet[:256*1024]
	}
	pdfLink := ""
	if m := citationMetaPDFRegex.FindStringSubmatch(htmlSnippet); len(m) > 1 {
		pdfLink = m[1]
	} else if m := citationMetaAltRegex.FindStringSubmatch(htmlSnippet); len(m) > 1 {
		pdfLink = m[1]
	}
	if pdfLink == "" {
		return nil, "", fmt.Errorf("URL did not return a PDF directly (no citation_pdf_url found); download the PDF and upload it from disk")
	}

	baseParsed, _ := url.Parse(targetURL)
	relParsed, relErr := url.Parse(strings.TrimSpace(pdfLink))
	if relErr == nil && baseParsed != nil {
		pdfLink = baseParsed.ResolveReference(relParsed).String()
	}
	pdfData, _, pdfName, err2 := fetchOnce(pdfLink)
	if err2 != nil {
		return nil, "", err2
	}
	if len(pdfData) < len(pdfMagicHeader) || string(pdfData[:len(pdfMagicHeader)]) != pdfMagicHeader {
		return nil, "", fmt.Errorf("resolved citation PDF link did not return a valid PDF")
	}
	return pdfData, pdfName, nil
}

func (s *Server) handleImportPaperURL(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		URL         string `json:"url"`
		IsShared    bool   `json:"is_shared"`
		SkipNetwork bool   `json:"skip_network"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	normalized := normalizePaperImportURL(req.URL)
	if normalized == "" {
		writeError(w, http.StatusBadRequest, "url, arXiv ID, or DOI is required")
		return
	}

	ctxTimeout, cancel := context.WithTimeout(r.Context(), 35*time.Second)
	defer cancel()

	pdfBytes, filename, fetchErr := fetchPDFOrCitationURL(ctxTimeout, normalized)
	if fetchErr != nil {
		writeError(w, http.StatusBadGateway, fetchErr.Error())
		return
	}

	paper, storeErr := s.storePaperFromReader(r.Context(), claims.UserID, bytes.NewReader(pdfBytes), filename, req.IsShared, req.SkipNetwork)
	if storeErr != nil {
		writeError(w, http.StatusInternalServerError, storeErr.Error())
		return
	}
	writeJSON(w, http.StatusCreated, paper)
}

func (s *Server) handleListPapers(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	const query = `
		SELECT p.id, p.owner_id, p.title, p.authors, p.publication_year, p.doi,
		       p.bibtex_key, p.bibtex_raw, p.file_path, p.file_hash, p.is_shared, p.updated_at,
		       COALESCE(
		           ARRAY_AGG(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL AND pt.deleted_at IS NULL),
		           '{}'
		       ) AS tags
		FROM papers p
		LEFT JOIN paper_tags pt ON pt.paper_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		WHERE p.deleted_at IS NULL
		  AND (p.owner_id = $1 OR p.is_shared = TRUE)
		GROUP BY p.id
		ORDER BY p.updated_at DESC
	`
	rows, err := s.db.Query(r.Context(), query, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to query papers")
		return
	}
	defer rows.Close()

	papers := make([]Paper, 0)
	for rows.Next() {
		var p Paper
		if err := rows.Scan(
			&p.ID,
			&p.OwnerID,
			&p.Title,
			&p.Authors,
			&p.PublicationYear,
			&p.DOI,
			&p.BibtexKey,
			&p.BibtexRaw,
			&p.FilePath,
			&p.FileHash,
			&p.IsShared,
			&p.UpdatedAt,
			&p.Tags,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan paper row")
			return
		}
		papers = append(papers, p)
	}

	writeJSON(w, http.StatusOK, papers)
}

func (s *Server) handleGetPaper(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	paperID := r.PathValue("id")
	if !isValidUUID(paperID) {
		writeError(w, http.StatusBadRequest, "invalid paper UUID")
		return
	}

	const query = `
		SELECT p.id, p.owner_id, p.title, p.authors, p.publication_year, p.doi,
		       p.bibtex_key, p.bibtex_raw, p.file_path, p.file_hash, p.is_shared, p.updated_at,
		       COALESCE(
		           ARRAY_AGG(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL AND pt.deleted_at IS NULL),
		           '{}'
		       ) AS tags
		FROM papers p
		LEFT JOIN paper_tags pt ON pt.paper_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		WHERE p.id = $1
		  AND p.deleted_at IS NULL
		  AND (p.owner_id = $2 OR p.is_shared = TRUE)
		GROUP BY p.id
	`
	var p Paper
	err := s.db.QueryRow(r.Context(), query, paperID, claims.UserID).Scan(
		&p.ID,
		&p.OwnerID,
		&p.Title,
		&p.Authors,
		&p.PublicationYear,
		&p.DOI,
		&p.BibtexKey,
		&p.BibtexRaw,
		&p.FilePath,
		&p.FileHash,
		&p.IsShared,
		&p.UpdatedAt,
		&p.Tags,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "paper not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch paper")
		return
	}

	writeJSON(w, http.StatusOK, p)
}

type updatePaperRequest struct {
	Title           *string  `json:"title"`
	Authors         *string  `json:"authors"`
	PublicationYear *int     `json:"publication_year"`
	DOI             *string  `json:"doi"`
	BibtexKey       *string  `json:"bibtex_key"`
	BibtexRaw       *string  `json:"bibtex_raw"`
	IsShared        *bool    `json:"is_shared"`
	Tags            []string `json:"tags"`
}

func (s *Server) handleUpdatePaper(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	paperID := r.PathValue("id")
	if !isValidUUID(paperID) {
		writeError(w, http.StatusBadRequest, "invalid paper UUID")
		return
	}

	var req updatePaperRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	const updateQuery = `
		UPDATE papers
		SET title = COALESCE($3, title),
		    authors = COALESCE($4, authors),
		    publication_year = COALESCE($5, publication_year),
		    doi = COALESCE($6, doi),
		    bibtex_key = COALESCE($7, bibtex_key),
		    bibtex_raw = COALESCE($8, bibtex_raw),
		    is_shared = COALESCE($9, is_shared),
		    updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
		RETURNING id, owner_id, title, authors, publication_year, doi,
		          bibtex_key, bibtex_raw, file_path, file_hash, is_shared, updated_at
	`
	var updated Paper
	err := s.db.QueryRow(
		r.Context(),
		updateQuery,
		paperID,
		claims.UserID,
		req.Title,
		req.Authors,
		req.PublicationYear,
		req.DOI,
		req.BibtexKey,
		req.BibtexRaw,
		req.IsShared,
	).Scan(
		&updated.ID,
		&updated.OwnerID,
		&updated.Title,
		&updated.Authors,
		&updated.PublicationYear,
		&updated.DOI,
		&updated.BibtexKey,
		&updated.BibtexRaw,
		&updated.FilePath,
		&updated.FileHash,
		&updated.IsShared,
		&updated.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "paper not found or not owned by user")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update paper")
		return
	}

	if req.Tags != nil {
		if err := s.replacePaperTags(r.Context(), paperID, req.Tags); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to update paper tags")
			return
		}
		updated.Tags = req.Tags
	} else {
		updated.Tags = []string{}
	}

	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) replacePaperTags(ctx context.Context, paperID string, tags []string) error {
	const softDeleteOld = `
		UPDATE paper_tags
		SET deleted_at = NOW(), updated_at = NOW()
		WHERE paper_id = $1
	`
	if _, err := s.db.Exec(ctx, softDeleteOld, paperID); err != nil {
		return err
	}

	for _, rawTag := range tags {
		tagName := strings.TrimSpace(rawTag)
		if tagName == "" {
			continue
		}
		var tagID string
		const upsertTag = `
			INSERT INTO tags (name, updated_at)
			VALUES ($1, NOW())
			ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
			RETURNING id
		`
		if err := s.db.QueryRow(ctx, upsertTag, tagName).Scan(&tagID); err != nil {
			return err
		}
		const linkTag = `
			INSERT INTO paper_tags (paper_id, tag_id, updated_at, deleted_at)
			VALUES ($1, $2, NOW(), NULL)
			ON CONFLICT (paper_id, tag_id)
			DO UPDATE SET updated_at = NOW(), deleted_at = NULL
		`
		if _, err := s.db.Exec(ctx, linkTag, paperID, tagID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) handleDeletePaper(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	paperID := r.PathValue("id")
	if !isValidUUID(paperID) {
		writeError(w, http.StatusBadRequest, "invalid paper UUID")
		return
	}

	const query = `
		UPDATE papers
		SET deleted_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
	`
	tag, err := s.db.Exec(r.Context(), query, paperID, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete paper")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "paper not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleStreamPaperFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	paperID := r.PathValue("id")
	if !isValidUUID(paperID) {
		writeError(w, http.StatusBadRequest, "invalid paper UUID")
		return
	}

	var relPath, title string
	const query = `
		SELECT file_path, title
		FROM papers
		WHERE id = $1 AND deleted_at IS NULL AND (owner_id = $2 OR is_shared = TRUE)
	`
	err := s.db.QueryRow(r.Context(), query, paperID, claims.UserID).Scan(&relPath, &title)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "paper not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database query failed")
		return
	}

	fullPath, err := safeJoin(s.storageDir, relPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	f, err := os.Open(fullPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "PDF file missing on disk")
		return
	}
	defer func() { _ = f.Close() }()

	stat, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to stat PDF file")
		return
	}

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", paperID+".pdf"))
	http.ServeContent(w, r, paperID+".pdf", stat.ModTime(), f)
}

func (s *Server) handleReextractPaper(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	paperID := r.PathValue("id")
	if !isValidUUID(paperID) {
		writeError(w, http.StatusBadRequest, "invalid paper UUID")
		return
	}

	var relPath, currentTitle string
	const selectQuery = `
		SELECT file_path, title
		FROM papers
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
	`
	err := s.db.QueryRow(r.Context(), selectQuery, paperID, claims.UserID).Scan(&relPath, &currentTitle)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "paper not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "database query failed")
		return
	}

	fullPath, err := safeJoin(s.storageDir, relPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	meta, err := s.runExtractMeta(r.Context(), fullPath, currentTitle, false)
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	var updated Paper
	const updateQuery = `
		UPDATE papers
		SET title = $3,
		    authors = $4,
		    publication_year = $5,
		    doi = $6,
		    bibtex_key = $7,
		    bibtex_raw = $8,
		    updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
		RETURNING id, owner_id, title, authors, publication_year, doi,
		          bibtex_key, bibtex_raw, file_path, file_hash, is_shared, updated_at
	`
	err = s.db.QueryRow(
		r.Context(),
		updateQuery,
		paperID,
		claims.UserID,
		meta.Title,
		meta.Authors,
		meta.PublicationYear,
		meta.DOI,
		meta.BibtexKey,
		meta.BibtexRaw,
	).Scan(
		&updated.ID,
		&updated.OwnerID,
		&updated.Title,
		&updated.Authors,
		&updated.PublicationYear,
		&updated.DOI,
		&updated.BibtexKey,
		&updated.BibtexRaw,
		&updated.FilePath,
		&updated.FileHash,
		&updated.IsShared,
		&updated.UpdatedAt,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to save extracted metadata")
		return
	}
	updated.Tags = []string{}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) collectUserBibtex(ctx context.Context, userID int) (string, int, error) {
	const query = `
		SELECT bibtex_key, bibtex_raw
		FROM papers
		WHERE deleted_at IS NULL
		  AND (owner_id = $1 OR is_shared = TRUE)
		  AND bibtex_raw <> ''
		ORDER BY bibtex_key ASC, updated_at DESC
	`
	rows, err := s.db.Query(ctx, query, userID)
	if err != nil {
		return "", 0, err
	}
	defer rows.Close()

	seenKeys := make(map[string]bool)
	var entries []string
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			return "", 0, err
		}
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		if key != "" && seenKeys[key] {
			continue
		}
		if key != "" {
			seenKeys[key] = true
		}
		entries = append(entries, trimmed)
	}

	header := "% Generated by dupe (Dino's Ultimate Paper Editor)\n\n"
	return header + strings.Join(entries, "\n\n") + "\n", len(entries), nil
}

func (s *Server) handleExportBibtex(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	bibContent, _, err := s.collectUserBibtex(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to assemble BibTeX library")
		return
	}

	w.Header().Set("Content-Type", "application/x-bibtex; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="references.bib"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(bibContent))
}
