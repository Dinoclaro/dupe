package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const gitCmdTimeout = 30 * time.Second

type GitRepo struct {
	ID           string     `json:"id"`
	OwnerID      int        `json:"owner_id"`
	Name         string     `json:"name"`
	RemoteURL    string     `json:"remote_url"`
	BibFilePath  string     `json:"bib_file_path"`
	FiguresDir   string     `json:"figures_dir"`
	LocalPath    string     `json:"local_path"`
	LastSyncedAt *time.Time `json:"last_synced_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

var allowLocalGitRemotesForTesting = false

var allowedRemoteURLRegex = regexp.MustCompile(`^(https://([a-zA-Z0-9._:-]+@)?(github\.com|git\.overleaf\.com)/[a-zA-Z0-9._/-]+|git@github\.com:[a-zA-Z0-9._/-]+)$`)

func runGitCommand(ctx context.Context, dir string, args ...string) (string, error) {
	ctxTimeout, cancel := context.WithTimeout(ctx, gitCmdTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctxTimeout, "git", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	allowProto := "GIT_ALLOW_PROTOCOL=https:ssh"
	if allowLocalGitRemotesForTesting {
		allowProto = "GIT_ALLOW_PROTOCOL=file:https:ssh"
	}
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", allowProto)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errMsg := strings.TrimSpace(stderr.String())
		if errMsg == "" {
			errMsg = strings.TrimSpace(stdout.String())
		}
		return "", fmt.Errorf("git %s: %w (%s)", strings.Join(args, " "), err, errMsg)
	}
	return strings.TrimSpace(stdout.String()), nil
}

func validateRemoteURL(rawURL string) error {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return fmt.Errorf("remote_url is required")
	}
	if strings.HasPrefix(trimmed, "-") {
		return fmt.Errorf("remote_url must not start with '-'")
	}
	cleaned := normalizeOverleafRemote(trimmed, "")
	if allowLocalGitRemotesForTesting && (filepath.IsAbs(cleaned) || strings.HasPrefix(cleaned, "file://")) {
		return nil
	}
	if strings.Contains(cleaned, "..") || !allowedRemoteURLRegex.MatchString(cleaned) {
		return fmt.Errorf("remote_url must be a GitHub (https://github.com/... or git@github.com:...) or Overleaf (https://git.overleaf.com/...) URL")
	}
	return nil
}

func githubHTTPSFallbackToSSH(rawURL string) string {
	trimmed := strings.TrimSpace(rawURL)
	const prefix = "https://github.com/"
	if strings.HasPrefix(trimmed, prefix) {
		rest := strings.TrimPrefix(trimmed, prefix)
		rest = strings.TrimPrefix(rest, "/")
		if !strings.HasSuffix(rest, ".git") {
			rest += ".git"
		}
		return "git@github.com:" + rest
	}
	return ""
}

type createRepoRequest struct {
	Name        string `json:"name"`
	RemoteURL   string `json:"remote_url"`
	BibFilePath string `json:"bib_file_path"`
	FiguresDir  string `json:"figures_dir"`
}

func (s *Server) handleListRepos(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	const query = `
		SELECT id, owner_id, name, remote_url, bib_file_path, figures_dir, local_path, last_synced_at, updated_at
		FROM git_repos
		WHERE owner_id = $1 AND deleted_at IS NULL
		ORDER BY updated_at DESC
	`
	rows, err := s.db.Query(r.Context(), query, claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list git repositories")
		return
	}
	defer rows.Close()

	repos := make([]GitRepo, 0)
	for rows.Next() {
		var repo GitRepo
		if err := rows.Scan(
			&repo.ID,
			&repo.OwnerID,
			&repo.Name,
			&repo.RemoteURL,
			&repo.BibFilePath,
			&repo.FiguresDir,
			&repo.LocalPath,
			&repo.LastSyncedAt,
			&repo.UpdatedAt,
		); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to scan git repository")
			return
		}
		repos = append(repos, repo)
	}

	writeJSON(w, http.StatusOK, repos)
}

func (s *Server) handleCreateRepo(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req createRepoRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := validateRemoteURL(req.RemoteURL); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = filepath.Base(strings.TrimSuffix(req.RemoteURL, ".git"))
	}
	bibPath := strings.TrimSpace(req.BibFilePath)
	if bibPath == "" {
		bibPath = "references.bib"
	}
	figuresDir := strings.TrimSpace(req.FiguresDir)
	if figuresDir == "" {
		figuresDir = "figures"
	}
	if _, err := safeJoin("/virtual-root", bibPath); err != nil {
		writeError(w, http.StatusBadRequest, "invalid bib_file_path")
		return
	}
	if _, err := safeJoin("/virtual-root", figuresDir); err != nil {
		writeError(w, http.StatusBadRequest, "invalid figures_dir")
		return
	}

	var repoID string
	if err := s.db.QueryRow(r.Context(), "SELECT gen_random_uuid()::text").Scan(&repoID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate repository UUID")
		return
	}

	relLocalPath := filepath.Join("repos", repoID)
	absLocalPath, err := safeJoin(s.storageDir, relLocalPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid repository storage path")
		return
	}
	if err := os.MkdirAll(filepath.Dir(absLocalPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create repos directory")
		return
	}

	remoteURL := strings.TrimSpace(req.RemoteURL)
	if _, err := runGitCommand(r.Context(), "", "clone", "--", remoteURL, absLocalPath); err != nil {
		_ = os.RemoveAll(absLocalPath)
		sshFallback := githubHTTPSFallbackToSSH(remoteURL)
		if sshFallback == "" {
			writeError(w, http.StatusBadGateway, fmt.Sprintf("git clone failed: %v", err))
			return
		}
		if _, sshErr := runGitCommand(r.Context(), "", "clone", "--", sshFallback, absLocalPath); sshErr != nil {
			_ = os.RemoveAll(absLocalPath)
			writeError(w, http.StatusBadGateway, fmt.Sprintf("git clone failed: %v", sshErr))
			return
		}
		remoteURL = sshFallback
	}

	_, _ = runGitCommand(r.Context(), absLocalPath, "config", "user.name", claims.Username)
	_, _ = runGitCommand(r.Context(), absLocalPath, "config", "user.email", claims.Username+"@dupe.local")

	var created GitRepo
	const insertQuery = `
		INSERT INTO git_repos (id, owner_id, name, remote_url, bib_file_path, figures_dir, local_path)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, owner_id, name, remote_url, bib_file_path, figures_dir, local_path, last_synced_at, updated_at
	`
	err = s.db.QueryRow(
		r.Context(),
		insertQuery,
		repoID,
		claims.UserID,
		name,
		remoteURL,
		bibPath,
		figuresDir,
		relLocalPath,
	).Scan(
		&created.ID,
		&created.OwnerID,
		&created.Name,
		&created.RemoteURL,
		&created.BibFilePath,
		&created.FiguresDir,
		&created.LocalPath,
		&created.LastSyncedAt,
		&created.UpdatedAt,
	)
	if err != nil {
		_ = os.RemoveAll(absLocalPath)
		writeError(w, http.StatusInternalServerError, "failed to store git repository record")
		return
	}

	writeJSON(w, http.StatusCreated, created)
}

type syncRepoRequest struct {
	CommitMessage string `json:"commit_message"`
}

type syncRepoResponse struct {
	Repo        GitRepo   `json:"repo"`
	BibEntries  int       `json:"bib_entries"`
	Committed   bool      `json:"committed"`
	CommitSHA   string    `json:"commit_sha,omitempty"`
	SyncedAt    time.Time `json:"synced_at"`
}

func (s *Server) lookupOwnedRepo(ctx context.Context, repoID string, userID int) (GitRepo, string, error) {
	var repo GitRepo
	const query = `
		SELECT id, owner_id, name, remote_url, bib_file_path, figures_dir, local_path, last_synced_at, updated_at
		FROM git_repos
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
	`
	err := s.db.QueryRow(ctx, query, repoID, userID).Scan(
		&repo.ID,
		&repo.OwnerID,
		&repo.Name,
		&repo.RemoteURL,
		&repo.BibFilePath,
		&repo.FiguresDir,
		&repo.LocalPath,
		&repo.LastSyncedAt,
		&repo.UpdatedAt,
	)
	if err != nil {
		return GitRepo{}, "", err
	}
	absPath, err := safeJoin(s.storageDir, repo.LocalPath)
	if err != nil {
		return GitRepo{}, "", err
	}
	return repo, absPath, nil
}

func (s *Server) handleSyncRepo(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	repoID := r.PathValue("id")
	if !isValidUUID(repoID) {
		writeError(w, http.StatusBadRequest, "invalid repository UUID")
		return
	}

	var req syncRepoRequest
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
	}
	commitMsg := strings.TrimSpace(req.CommitMessage)
	if commitMsg == "" {
		commitMsg = "chore(dupe): sync references.bib and manuscript assets"
	}

	repo, absRepoPath, err := s.lookupOwnedRepo(r.Context(), repoID, claims.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load repository")
		return
	}

	bibContent, entryCount, err := s.collectUserBibtex(r.Context(), claims.UserID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to collect user BibTeX entries")
		return
	}

	targetBibPath, err := safeJoin(absRepoPath, repo.BibFilePath)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid bib_file_path in repository")
		return
	}
	if err := os.MkdirAll(filepath.Dir(targetBibPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create parent directory for .bib file")
		return
	}
	if err := os.WriteFile(targetBibPath, []byte(bibContent), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write .bib file")
		return
	}

	statusOut, err := runGitCommand(r.Context(), absRepoPath, "status", "--porcelain")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	committed := false
	commitSHA := ""
	if statusOut != "" {
		if _, err := runGitCommand(r.Context(), absRepoPath, "add", "-A"); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		if _, err := runGitCommand(r.Context(), absRepoPath, "commit", "-m", commitMsg); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		committed = true
		commitSHA, _ = runGitCommand(r.Context(), absRepoPath, "rev-parse", "HEAD")
	}

	if _, err := runGitCommand(r.Context(), absRepoPath, "rev-parse", "--abbrev-ref", "@{u}"); err == nil {
		if _, err := runGitCommand(r.Context(), absRepoPath, "pull", "--rebase"); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
	}

	if committed {
		if _, err := runGitCommand(r.Context(), absRepoPath, "push", "-u", "origin", "HEAD"); err != nil {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
	}

	const updateSyncQuery = `
		UPDATE git_repos
		SET last_synced_at = NOW(), updated_at = NOW()
		WHERE id = $1
		RETURNING last_synced_at, updated_at
	`
	if err := s.db.QueryRow(r.Context(), updateSyncQuery, repo.ID).Scan(&repo.LastSyncedAt, &repo.UpdatedAt); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to update sync timestamp")
		return
	}

	writeJSON(w, http.StatusOK, syncRepoResponse{
		Repo:       repo,
		BibEntries: entryCount,
		Committed:  committed,
		CommitSHA:  commitSHA,
		SyncedAt:   *repo.LastSyncedAt,
	})
}

func (s *Server) handleListRepoFiles(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	repoID := r.PathValue("id")
	if !isValidUUID(repoID) {
		writeError(w, http.StatusBadRequest, "invalid repository UUID")
		return
	}

	_, absRepoPath, err := s.lookupOwnedRepo(r.Context(), repoID, claims.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load repository")
		return
	}

	files := make([]string, 0)
	walkErr := filepath.WalkDir(absRepoPath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			rel, relErr := filepath.Rel(absRepoPath, path)
			if relErr == nil {
				files = append(files, filepath.ToSlash(rel))
			}
		}
		return nil
	})
	if walkErr != nil {
		writeError(w, http.StatusInternalServerError, "failed to list repository files")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"files": files})
}

func (s *Server) handleReadRepoFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	repoID := r.PathValue("id")
	if !isValidUUID(repoID) {
		writeError(w, http.StatusBadRequest, "invalid repository UUID")
		return
	}
	relFile := strings.TrimSpace(r.URL.Query().Get("path"))
	if relFile == "" {
		writeError(w, http.StatusBadRequest, "query parameter 'path' is required")
		return
	}

	_, absRepoPath, err := s.lookupOwnedRepo(r.Context(), repoID, claims.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load repository")
		return
	}

	targetPath, err := safeJoin(absRepoPath, relFile)
	if err != nil || strings.HasPrefix(filepath.ToSlash(relFile), ".git/") || relFile == ".git" {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	content, err := os.ReadFile(targetPath)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":    relFile,
		"content": string(content),
	})
}

type writeRepoFileRequest struct {
	Path     string `json:"path"`
	Content  string `json:"content"`
	IsBase64 bool   `json:"is_base64"`
	Force    bool   `json:"force,omitempty"`
}

func (s *Server) handleWriteRepoFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	repoID := r.PathValue("id")
	if !isValidUUID(repoID) {
		writeError(w, http.StatusBadRequest, "invalid repository UUID")
		return
	}

	var req writeRepoFileRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	relFile := strings.TrimSpace(req.Path)
	if relFile == "" || strings.HasPrefix(filepath.ToSlash(relFile), ".git/") || relFile == ".git" {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	_, absRepoPath, err := s.lookupOwnedRepo(r.Context(), repoID, claims.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load repository")
		return
	}

	targetPath, err := safeJoin(absRepoPath, relFile)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	var data []byte
	if req.IsBase64 {
		decoded, decErr := base64.StdEncoding.DecodeString(req.Content)
		if decErr != nil {
			writeError(w, http.StatusBadRequest, "invalid base64 content")
			return
		}
		data = decoded
	} else {
		data = []byte(req.Content)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create parent directory")
		return
	}
	if err := os.WriteFile(targetPath, data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write file")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{"path": relFile, "bytes": len(data)})
}

func (s *Server) handleDeleteRepo(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	repoID := r.PathValue("id")
	if !isValidUUID(repoID) {
		writeError(w, http.StatusBadRequest, "invalid repository UUID")
		return
	}

	_, absRepoPath, err := s.lookupOwnedRepo(r.Context(), repoID, claims.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "repository not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to load repository")
		return
	}

	const query = `
		UPDATE git_repos
		SET deleted_at = NOW(), updated_at = NOW()
		WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
	`
	if _, err := s.db.Exec(r.Context(), query, repoID, claims.UserID); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete repository")
		return
	}

	_ = os.RemoveAll(absRepoPath)
	w.WriteHeader(http.StatusNoContent)
}
