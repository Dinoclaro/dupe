package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type pgxQuerier interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Server struct {
	db            pgxQuerier
	jwtSecret     []byte
	storageDir    string
	pythonBin     string
	extractScript string
	webDistDir    string
	offlineMeta   bool
}

func isValidUUID(value string) bool {
	return uuidRegex.MatchString(strings.TrimSpace(value))
}

func safeJoin(baseDir, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" {
		return "", fmt.Errorf("empty relative path")
	}
	absBase, err := filepath.Abs(baseDir)
	if err != nil {
		return "", err
	}
	cleanedRel := filepath.Clean(relPath)
	if filepath.IsAbs(cleanedRel) || strings.HasPrefix(cleanedRel, "..") {
		return "", fmt.Errorf("path escapes base directory")
	}
	target := filepath.Join(absBase, cleanedRel)
	relToBase, err := filepath.Rel(absBase, target)
	if err != nil || strings.HasPrefix(relToBase, "..") || relToBase == "." {
		return "", fmt.Errorf("path escapes base directory")
	}
	return target, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	var one int
	if err := s.db.QueryRow(r.Context(), "SELECT 1").Scan(&one); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/me", s.requireAuth(s.handleMe))

	mux.HandleFunc("GET /api/papers", s.requireAuth(s.handleListPapers))
	mux.HandleFunc("POST /api/papers/upload", s.requireAuth(s.handleUploadPapers))
	mux.HandleFunc("GET /api/papers/bibtex", s.requireAuth(s.handleExportBibtex))
	mux.HandleFunc("GET /api/papers/{id}", s.requireAuth(s.handleGetPaper))
	mux.HandleFunc("PATCH /api/papers/{id}", s.requireAuth(s.handleUpdatePaper))
	mux.HandleFunc("DELETE /api/papers/{id}", s.requireAuth(s.handleDeletePaper))
	mux.HandleFunc("GET /api/papers/{id}/file", s.requireAuth(s.handleStreamPaperFile))
	mux.HandleFunc("POST /api/papers/{id}/reextract", s.requireAuth(s.handleReextractPaper))

	mux.HandleFunc("GET /api/repos", s.requireAuth(s.handleListRepos))
	mux.HandleFunc("POST /api/repos", s.requireAuth(s.handleCreateRepo))
	mux.HandleFunc("POST /api/repos/{id}/sync", s.requireAuth(s.handleSyncRepo))
	mux.HandleFunc("GET /api/repos/{id}/files", s.requireAuth(s.handleListRepoFiles))
	mux.HandleFunc("GET /api/repos/{id}/file", s.requireAuth(s.handleReadRepoFile))
	mux.HandleFunc("PUT /api/repos/{id}/file", s.requireAuth(s.handleWriteRepoFile))
	mux.HandleFunc("DELETE /api/repos/{id}", s.requireAuth(s.handleDeleteRepo))

	mux.HandleFunc("GET /api/docs", s.requireAuth(s.handleListDocs))
	mux.HandleFunc("POST /api/docs", s.requireAuth(s.handleCreateDoc))
	mux.HandleFunc("GET /api/docs/{id}", s.requireAuth(s.handleGetDoc))
	mux.HandleFunc("PATCH /api/docs/{id}", s.requireAuth(s.handleUpdateDoc))
	mux.HandleFunc("PUT /api/docs/{id}", s.requireAuth(s.handleUpdateDoc))
	mux.HandleFunc("DELETE /api/docs/{id}", s.requireAuth(s.handleDeleteDoc))

	mux.HandleFunc("GET /api/terminal/ws", s.requireAuth(s.handleTerminalWS))

	if s.webDistDir != "" {
		if info, err := os.Stat(s.webDistDir); err == nil && info.IsDir() {
			fileServer := http.FileServer(http.Dir(s.webDistDir))
			mux.Handle("/", fileServer)
		}
	}

	return mux
}

func envOrDefault(key, fallback string) string {
	if val := strings.TrimSpace(os.Getenv(key)); val != "" {
		return val
	}
	return fallback
}

func resolveDefaultPath(candidates ...string) string {
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return candidates[0]
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	createUser := flag.String("create-user", "", "Create or update a user account and exit")
	password := flag.String("password", "", "Password for --create-user")
	colorHex := flag.String("color", "#FFEB3B", "Highlight color hex for --create-user")
	addrFlag := flag.String("addr", "", "HTTP listen address (default 0.0.0.0:8080)")
	flag.Parse()

	databaseURL := envOrDefault("DATABASE_URL", "postgres://dupe:dupe_dev_password@127.0.0.1:5432/dupe?sslmode=disable")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := initDB(ctx, databaseURL)
	if err != nil {
		slog.Error("database initialization failed", "error", err)
		os.Exit(1)
	}
	defer pool.Close()

	if *createUser != "" {
		if err := createOrUpdateUser(ctx, pool, *createUser, *password, *colorHex); err != nil {
			slog.Error("failed to create user", "username", *createUser, "error", err)
			os.Exit(1)
		}
		slog.Info("user provisioned", "username", *createUser)
		return
	}

	jwtSecret := envOrDefault("JWT_SECRET", "dev-local-jwt-secret-change-in-production-32b")
	if len(jwtSecret) < 16 {
		slog.Error("JWT_SECRET must be at least 16 bytes")
		os.Exit(1)
	}

	storageDir := envOrDefault("STORAGE_DIR", resolveDefaultPath("../storage", "./storage"))
	if err := os.MkdirAll(filepath.Join(storageDir, "pdfs"), 0o755); err != nil {
		slog.Error("failed to initialize storage pdfs directory", "error", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Join(storageDir, "repos"), 0o755); err != nil {
		slog.Error("failed to initialize storage repos directory", "error", err)
		os.Exit(1)
	}

	pythonBin := envOrDefault("PYTHON_BIN", resolveDefaultPath("../.venv/bin/python3", "./.venv/bin/python3", "python3"))
	extractScript := envOrDefault("EXTRACT_SCRIPT", resolveDefaultPath("../scripts/extract_meta.py", "./scripts/extract_meta.py"))
	webDistDir := envOrDefault("WEB_DIST_DIR", resolveDefaultPath("../web/dist", "./web/dist"))
	listenAddr := *addrFlag
	if listenAddr == "" {
		listenAddr = envOrDefault("ADDR", "0.0.0.0:8080")
	}

	srv := &Server{
		db:            pool,
		jwtSecret:     []byte(jwtSecret),
		storageDir:    storageDir,
		pythonBin:     pythonBin,
		extractScript: extractScript,
		webDistDir:    webDistDir,
	}

	httpServer := &http.Server{
		Addr:              listenAddr,
		Handler:           srv.routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("dupe backend listening", "addr", listenAddr, "storage_dir", storageDir)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("http server error", "error", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
