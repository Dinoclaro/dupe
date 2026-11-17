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
	projectsDir   string
	mode          string
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
	mode := s.mode
	if mode == "" {
		mode = "hosted"
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status": "ok",
		"mode":   mode,
	})
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

	mux.HandleFunc("GET /api/projects", s.requireAuth(s.handleListProjects))
	mux.HandleFunc("POST /api/projects", s.requireAuth(s.handleCreateProject))
	mux.HandleFunc("PATCH /api/projects/{id}", s.requireAuth(s.handleUpdateProject))
	mux.HandleFunc("GET /api/projects/{id}/tree", s.requireAuth(s.handleGetProjectTree))
	mux.HandleFunc("GET /api/projects/{id}/file", s.requireAuth(s.handleReadProjectFile))
	mux.HandleFunc("PUT /api/projects/{id}/file", s.requireAuth(s.handleWriteProjectFile))
	mux.HandleFunc("POST /api/projects/{id}/revert", s.requireAuth(s.handleRevertProjectFile))
	mux.HandleFunc("POST /api/projects/{id}/sync", s.requireAuth(s.handleSyncProject))
	mux.HandleFunc("POST /api/projects/{id}/compile", s.requireAuth(s.handleCompileProject))
	mux.HandleFunc("GET /api/projects/{id}/compiled.pdf", s.requireAuth(s.handleStreamCompiledPDF))
	mux.HandleFunc("GET /api/projects/{id}/search", s.requireAuth(s.handleSearchProject))

	mux.HandleFunc("GET /api/library/changes", s.requireAuth(s.handleLibraryChanges))
	mux.HandleFunc("POST /api/library/sync", s.requireAuth(s.handleLibrarySync))
	mux.HandleFunc("PUT /api/papers/blob/{sha256}", s.requireAuth(s.handleUploadPaperBlob))

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
	modeFlag := flag.String("mode", "", "Runtime mode: local or hosted (default hosted)")
	projectsFlag := flag.String("projects", "", "Projects root directory for local mode")
	mcpFlag := flag.Bool("mcp", false, "Run Model Context Protocol (MCP) server over stdio")

	args := os.Args[1:]
	isMCPSubcmd := false
	if len(args) > 0 && (args[0] == "mcp" || args[0] == "serve") {
		if args[0] == "mcp" {
			isMCPSubcmd = true
		}
		_ = flag.CommandLine.Parse(args[1:])
	} else {
		flag.Parse()
	}
	if *mcpFlag {
		isMCPSubcmd = true
	}

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

	mode := strings.ToLower(strings.TrimSpace(*modeFlag))
	if mode == "" {
		mode = strings.ToLower(envOrDefault("DUPE_MODE", "hosted"))
	}
	if mode != "local" && mode != "hosted" {
		slog.Error("invalid mode; expected local or hosted", "mode", mode)
		os.Exit(1)
	}

	projectsDir := strings.TrimSpace(*projectsFlag)
	if projectsDir == "" {
		projectsDir = envOrDefault("PROJECTS_DIR", filepath.Join(storageDir, "projects"))
	}
	if err := os.MkdirAll(projectsDir, 0o755); err != nil {
		slog.Error("failed to initialize projects directory", "error", err)
		os.Exit(1)
	}

	if mode == "local" {
		_ = createOrUpdateUser(ctx, pool, "local", "local-mode-implicit-user", "#FFEB3B")
	}

	pythonBin := envOrDefault("PYTHON_BIN", resolveDefaultPath("../.venv/bin/python3", "./.venv/bin/python3", "python3"))
	extractScript := envOrDefault("EXTRACT_SCRIPT", resolveDefaultPath("../scripts/extract_meta.py", "./scripts/extract_meta.py"))
	webDistDir := envOrDefault("WEB_DIST_DIR", resolveDefaultPath("../web/dist", "./web/dist"))
	listenAddr := *addrFlag
	if listenAddr == "" {
		defaultAddr := "0.0.0.0:8080"
		if mode == "local" {
			defaultAddr = "127.0.0.1:8080"
		}
		listenAddr = envOrDefault("ADDR", defaultAddr)
	}

	srv := &Server{
		db:            pool,
		jwtSecret:     []byte(jwtSecret),
		storageDir:    storageDir,
		projectsDir:   projectsDir,
		mode:          mode,
		pythonBin:     pythonBin,
		extractScript: extractScript,
		webDistDir:    webDistDir,
	}

	if isMCPSubcmd {
		if err := srv.runMCPServer(ctx, 1, "dino", os.Stdin, os.Stdout); err != nil {
			slog.Error("mcp server error", "error", err)
			os.Exit(1)
		}
		return
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
