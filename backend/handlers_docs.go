package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Document struct {
	ID        string    `json:"id"`
	OwnerID   int       `json:"owner_id"`
	DocType   string    `json:"doc_type"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	IsShared  bool      `json:"is_shared"`
	UpdatedAt time.Time `json:"updated_at"`
}

func isValidDocType(docType string) bool {
	switch docType {
	case "markdown", "diagram", "latex", "typst":
		return true
	default:
		return false
	}
}

func (s *Server) handleListDocs(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	docTypeFilter := strings.TrimSpace(r.URL.Query().Get("doc_type"))
	const query = `
		SELECT id, owner_id, doc_type, title, content, is_shared, updated_at
		FROM documents
		WHERE deleted_at IS NULL
		  AND (owner_id = $1 OR is_shared = TRUE)
		  AND ($2 = '' OR doc_type = $2)
		ORDER BY updated_at DESC
	`
	rows, err := s.db.Query(r.Context(), query, claims.UserID, docTypeFilter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list documents")
		return
	}
	defer rows.Close()

	docs := make([]Document, 0)
	for rows.Next() {
		var d Document
		if err := rows.Scan(&d.ID, &d.OwnerID, &d.DocType, &d.Title, &d.Content, &d.IsShared, &d.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan document")
			return
		}
		docs = append(docs, d)
	}
	writeJSON(w, http.StatusOK, docs)
}

type upsertDocRequest struct {
	ID       string `json:"id"`
	DocType  string `json:"doc_type"`
	Title    string `json:"title"`
	Content  string `json:"content"`
	IsShared bool   `json:"is_shared"`
}

func (s *Server) handleCreateDoc(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req upsertDocRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 10<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !isValidDocType(req.DocType) {
		writeError(w, http.StatusBadRequest, "doc_type must be markdown, diagram, latex, or typst")
		return
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		writeError(w, http.StatusBadRequest, "title is required")
		return
	}

	var doc Document
	if req.ID != "" {
		if !isValidUUID(req.ID) {
			writeError(w, http.StatusBadRequest, "invalid document UUID")
			return
		}
		const queryWithID = `
			INSERT INTO documents (id, owner_id, doc_type, title, content, is_shared)
			VALUES ($1, $2, $3, $4, $5, $6)
			RETURNING id, owner_id, doc_type, title, content, is_shared, updated_at
		`
		err := s.db.QueryRow(r.Context(), queryWithID, req.ID, claims.UserID, req.DocType, title, req.Content, req.IsShared).Scan(
			&doc.ID, &doc.OwnerID, &doc.DocType, &doc.Title, &doc.Content, &doc.IsShared, &doc.UpdatedAt,
		)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create document")
			return
		}
	} else {
		const queryNoID = `
			INSERT INTO documents (owner_id, doc_type, title, content, is_shared)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, owner_id, doc_type, title, content, is_shared, updated_at
		`
		err := s.db.QueryRow(r.Context(), queryNoID, claims.UserID, req.DocType, title, req.Content, req.IsShared).Scan(
			&doc.ID, &doc.OwnerID, &doc.DocType, &doc.Title, &doc.Content, &doc.IsShared, &doc.UpdatedAt,
		)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to create document")
			return
		}
	}

	writeJSON(w, http.StatusCreated, doc)
}

func (s *Server) handleGetDoc(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	docID := r.PathValue("id")
	if !isValidUUID(docID) {
		writeError(w, http.StatusBadRequest, "invalid document UUID")
		return
	}

	var doc Document
	const query = `
		SELECT id, owner_id, doc_type, title, content, is_shared, updated_at
		FROM documents
		WHERE id = $1 AND deleted_at IS NULL AND (owner_id = $2 OR is_shared = TRUE)
	`
	err := s.db.QueryRow(r.Context(), query, docID, claims.UserID).Scan(
		&doc.ID, &doc.OwnerID, &doc.DocType, &doc.Title, &doc.Content, &doc.IsShared, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to fetch document")
		return
	}

	writeJSON(w, http.StatusOK, doc)
}

type updateDocRequest struct {
	Title    *string `json:"title"`
	Content  *string `json:"content"`
	IsShared *bool   `json:"is_shared"`
}

func (s *Server) handleUpdateDoc(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	docID := r.PathValue("id")
	if !isValidUUID(docID) {
		writeError(w, http.StatusBadRequest, "invalid document UUID")
		return
	}

	var req updateDocRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 10<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	var doc Document
	const query = `
		UPDATE documents
		SET title = COALESCE($3, title),
		    content = COALESCE($4, content),
		    is_shared = COALESCE($5, is_shared),
		    updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
		RETURNING id, owner_id, doc_type, title, content, is_shared, updated_at
	`
	err := s.db.QueryRow(r.Context(), query, docID, claims.UserID, req.Title, req.Content, req.IsShared).Scan(
		&doc.ID, &doc.OwnerID, &doc.DocType, &doc.Title, &doc.Content, &doc.IsShared, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update document")
		return
	}

	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) handleDeleteDoc(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	docID := r.PathValue("id")
	if !isValidUUID(docID) {
		writeError(w, http.StatusBadRequest, "invalid document UUID")
		return
	}

	const query = `
		UPDATE documents
		SET deleted_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
	`
	tag, err := s.db.Exec(r.Context(), query, docID, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete document")
		return
	}
	if tag.RowsAffected() == 0 {
		writeError(w, http.StatusNotFound, "document not found")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
