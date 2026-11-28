package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var appVersion = "dev"

var uuidRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type pgxQuerier interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type Server struct {
	db                 pgxQuerier
	jwtSecret          []byte
	storageDir         string
	projectsMu         sync.RWMutex
	projectsDir        string
	mode               string
	pythonBin          string
	extractScript      string
	webDistDir         string
	offlineMeta        bool
	updateCacheMu      sync.Mutex
	updateCacheAt      time.Time
	updateCachedResult *UpdateCheckResult
	skipUpdateRestart  bool
	updateInstallDir   string
	updateBinDir       string
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
	if s.mode == "local" {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
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
		"status":  "ok",
		"mode":    mode,
		"version": normalizeSemver(appVersion),
	})
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("OPTIONS /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/local/bundle.tar.gz", s.requireAuth(s.handleLocalBundle))
	mux.HandleFunc("GET /api/local/setup.sh", s.requireAuth(s.handleLocalSetupScript))
	mux.HandleFunc("GET /api/local/status", s.requireAuth(s.handleLocalStatus))
	mux.HandleFunc("GET /api/local/update", s.requireAuth(s.handleCheckLocalUpdate))
	mux.HandleFunc("POST /api/local/update", s.requireAuth(s.handleApplyLocalUpdate))
	mux.HandleFunc("GET /api/local/browse", s.requireAuth(s.handleLocalBrowse))
	mux.HandleFunc("POST /api/local/projects-root", s.requireAuth(s.handleSetLocalProjectsRoot))
	mux.HandleFunc("POST /api/local/link-folder", s.requireAuth(s.handleLinkLocalFolder))
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("POST /api/auth/password", s.requireAuth(s.handleChangePassword))

	mux.HandleFunc("GET /api/papers", s.requireAuth(s.handleListPapers))
	mux.HandleFunc("POST /api/papers/upload", s.requireAuth(s.handleUploadPapers))
	mux.HandleFunc("POST /api/papers/import-url", s.requireAuth(s.handleImportPaperURL))
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
	mux.HandleFunc("GET /api/projects/{id}/asset", s.requireAuth(s.handleReadProjectAsset))
	mux.HandleFunc("PUT /api/projects/{id}/file", s.requireAuth(s.handleWriteProjectFile))
	mux.HandleFunc("DELETE /api/projects/{id}/file", s.requireAuth(s.handleDeleteProjectFile))
	mux.HandleFunc("POST /api/projects/{id}/rename", s.requireAuth(s.handleRenameProjectFile))
	mux.HandleFunc("POST /api/projects/{id}/revert", s.requireAuth(s.handleRevertProjectFile))
	mux.HandleFunc("POST /api/projects/{id}/pull", s.requireAuth(s.handlePullProject))
	mux.HandleFunc("POST /api/projects/{id}/sync", s.requireAuth(s.handleSyncProject))
	mux.HandleFunc("POST /api/projects/{id}/compile", s.requireAuth(s.handleCompileProject))
	mux.HandleFunc("GET /api/projects/{id}/compiled.pdf", s.requireAuth(s.handleStreamCompiledPDF))
	mux.HandleFunc("GET /api/projects/{id}/synctex", s.requireAuth(s.handleSyncTexLookup))
	mux.HandleFunc("GET /api/projects/{id}/synctex-forward", s.requireAuth(s.handleSyncTexForward))
	mux.HandleFunc("GET /api/projects/{id}/search", s.requireAuth(s.handleSearchProject))
	mux.HandleFunc("POST /api/projects/{id}/comments", s.requireAuth(s.handleAddProjectComment))
	mux.HandleFunc("POST /api/projects/{id}/context", s.requireAuth(s.handleGatherProjectContext))
	mux.HandleFunc("GET /api/projects/{id}/provenance", s.requireAuth(s.handleGetProjectProvenance))
	mux.HandleFunc("POST /api/projects/{id}/provenance", s.requireAuth(s.handleRecordProjectProvenance))
	mux.HandleFunc("GET /api/projects/{id}/brain", s.requireAuth(s.handleGetProjectBrain))

	mux.HandleFunc("GET /api/library/changes", s.requireAuth(s.handleLibraryChanges))
	mux.HandleFunc("POST /api/library/sync", s.requireAuth(s.handleLibrarySync))
	mux.HandleFunc("GET /api/library/remote-sync", s.requireAuth(s.handleGetRemoteSyncStatus))
	mux.HandleFunc("POST /api/library/remote-sync", s.requireAuth(s.handleTriggerRemoteSync))
	mux.HandleFunc("PUT /api/papers/blob/{sha256}", s.requireAuth(s.handleUploadPaperBlob))

	if s.webDistDir != "" {
		if info, err := os.Stat(s.webDistDir); err == nil && info.IsDir() {
			fileServer := http.FileServer(http.Dir(s.webDistDir))
			mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if strings.HasPrefix(r.URL.Path, "/assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				} else if r.URL.Path == "/" || strings.HasSuffix(r.URL.Path, ".html") {
					w.Header().Set("Cache-Control", "no-cache")
				}
				fileServer.ServeHTTP(w, r)
			}))
		}
	}

	return gzipMiddleware(mux)
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		gz, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return gz
	},
}

type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	wroteHeader bool
	passthrough bool
}

func isCompressiblePath(path string) bool {
	lower := strings.ToLower(path)
	for _, ext := range []string{".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".woff", ".woff2", ".gz", ".zip", ".wasm"} {
		if strings.HasSuffix(lower, ext) {
			return false
		}
	}
	if strings.HasSuffix(lower, "/file") && strings.HasPrefix(lower, "/api/papers/") {
		return false
	}
	return true
}

func (g *gzipResponseWriter) WriteHeader(statusCode int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	ct := strings.ToLower(g.Header().Get("Content-Type"))
	if statusCode == http.StatusNoContent || statusCode == http.StatusNotModified ||
		strings.Contains(ct, "application/pdf") ||
		strings.Contains(ct, "font/") ||
		strings.Contains(ct, "image/png") ||
		strings.Contains(ct, "image/jpeg") ||
		strings.Contains(ct, "image/webp") ||
		g.Header().Get("Content-Encoding") != "" {
		g.passthrough = true
		g.ResponseWriter.WriteHeader(statusCode)
		return
	}
	g.Header().Del("Content-Length")
	g.Header().Set("Content-Encoding", "gzip")
	g.Header().Add("Vary", "Accept-Encoding")
	gz := gzipWriterPool.Get().(*gzip.Writer)
	gz.Reset(g.ResponseWriter)
	g.gz = gz
	g.ResponseWriter.WriteHeader(statusCode)
}

func (g *gzipResponseWriter) Write(p []byte) (int, error) {
	if !g.wroteHeader {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(p))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.passthrough || g.gz == nil {
		return g.ResponseWriter.Write(p)
	}
	return g.gz.Write(p)
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead ||
			!strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") ||
			strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
			!isCompressiblePath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		gw := &gzipResponseWriter{ResponseWriter: w}
		defer func() {
			if gw.gz != nil {
				_ = gw.gz.Close()
				gw.gz.Reset(io.Discard)
				gzipWriterPool.Put(gw.gz)
			}
		}()
		next.ServeHTTP(gw, r)
	})
}

func envOrDefault(key, fallback string) string {
	if val := strings.TrimSpace(os.Getenv(key)); val != "" {
		return val
	}
	return fallback
}

func resolveDefaultPath(candidates ...string) string {
	var all []string
	if exePath, err := os.Executable(); err == nil {
		if resolved, rErr := filepath.EvalSymlinks(exePath); rErr == nil {
			exePath = resolved
		}
		exeDir := filepath.Dir(exePath)
		for _, c := range candidates {
			if strings.HasPrefix(c, "../") || strings.HasPrefix(c, "./") {
				all = append(all, filepath.Clean(filepath.Join(exeDir, c)))
			}
		}
	}
	all = append(all, candidates...)
	for _, c := range all {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return candidates[0]
}

func resolveDefaultStorageDir() string {
	if explicit := strings.TrimSpace(os.Getenv("STORAGE_DIR")); explicit != "" {
		return explicit
	}
	// Check standard relative paths and ~/.local/share/dupe/storage_* for standalone -mcp invocations
	candidates := []string{"../storage", "./storage"}
	if exePath, err := os.Executable(); err == nil {
		if resolved, rErr := filepath.EvalSymlinks(exePath); rErr == nil {
			exePath = resolved
		}
		exeDir := filepath.Dir(exePath)
		candidates = append([]string{filepath.Clean(filepath.Join(exeDir, "../storage"))}, candidates...)
		parentDir := filepath.Dir(exeDir)
		if matches, gErr := filepath.Glob(filepath.Join(parentDir, "storage_*")); gErr == nil {
			candidates = append(candidates, matches...)
		}
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && info.IsDir() {
			return c
		}
	}
	return "../storage"
}

func main() {
	rawArgs := os.Args[1:]
	if len(rawArgs) > 0 {
		switch rawArgs[0] {
		case "version", "--version", "-version", "-v":
			fmt.Printf("dupe %s (%s/%s)\n", normalizeSemver(appVersion), runtime.GOOS, runtime.GOARCH)
			return
		case "update":
			if err := runUpdateCLI(rawArgs[1:]); err != nil {
				fmt.Fprintf(os.Stderr, "update failed: %v\n", err)
				os.Exit(1)
			}
			return
		}
	}

	createUser := flag.String("create-user", "", "Create or update a user account and exit")
	password := flag.String("password", "", "Password for --create-user")
	colorHex := flag.String("color", "#FFEB3B", "Highlight color hex for --create-user")
	addrFlag := flag.String("addr", "", "HTTP listen address (default 127.0.0.1:8080)")
	modeFlag := flag.String("mode", "", "Runtime mode: local or hosted (default hosted)")
	projectsFlag := flag.String("projects", "", "Projects root directory for local mode")
	syncURLFlag := flag.String("sync-url", "", "Hosted server URL for local-mode sync (e.g. https://dupe.ing)")
	syncTokenFlag := flag.String("sync-token", "", "Bearer token for hosted server sync")
	mcpFlag := flag.Bool("mcp", false, "Run Model Context Protocol (MCP) server over stdio")

	args := os.Args[1:]
	isMCPSubcmd := false
	isInitSubcmd := false
	var subcmdPositional []string
	if len(args) > 0 && (args[0] == "mcp" || args[0] == "serve" || args[0] == "init") {
		if args[0] == "mcp" {
			isMCPSubcmd = true
		} else if args[0] == "init" {
			isInitSubcmd = true
		}
		_ = flag.CommandLine.Parse(args[1:])
		subcmdPositional = flag.Args()
	} else {
		flag.Parse()
		subcmdPositional = flag.Args()
	}
	if *mcpFlag {
		isMCPSubcmd = true
	}

	logOut := os.Stdout
	if isMCPSubcmd {
		// Keep stdout reserved strictly for JSON-RPC frames in stdio MCP mode.
		logOut = os.Stderr
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(logOut, nil)))

	mode := strings.ToLower(strings.TrimSpace(*modeFlag))
	if mode == "" {
		defaultMode := "local"
		if !isMCPSubcmd && !isInitSubcmd && strings.TrimSpace(os.Getenv("DATABASE_URL")) != "" {
			defaultMode = "hosted"
		}
		mode = strings.ToLower(envOrDefault("DUPE_MODE", defaultMode))
	}
	if mode != "local" && mode != "hosted" {
		slog.Error("invalid mode; expected local or hosted", "mode", mode)
		os.Exit(1)
	}

	storageDir := resolveDefaultStorageDir()
	if err := os.MkdirAll(filepath.Join(storageDir, "pdfs"), 0o755); err != nil {
		slog.Error("failed to initialize storage pdfs directory", "error", err)
		os.Exit(1)
	}
	if err := os.MkdirAll(filepath.Join(storageDir, "repos"), 0o755); err != nil {
		slog.Error("failed to initialize storage repos directory", "error", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var db pgxQuerier
	var closeDB func()
	explicitDBURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))

	if mode == "local" && (explicitDBURL == "" || strings.HasPrefix(explicitDBURL, "sqlite:")) {
		sqlitePath := filepath.Join(storageDir, "library.db")
		if strings.HasPrefix(explicitDBURL, "sqlite:") {
			sqlitePath = strings.TrimPrefix(explicitDBURL, "sqlite:")
		}
		sqDB, sqErr := initSQLiteDB(ctx, sqlitePath)
		if sqErr != nil {
			slog.Error("sqlite initialization failed", "path", sqlitePath, "error", sqErr)
			os.Exit(1)
		}
		db = sqDB
		closeDB = sqDB.Close
		slog.Info("using local sqlite library cache", "path", sqlitePath)
	} else {
		databaseURL := envOrDefault("DATABASE_URL", "postgres://dupe:dupe_dev_password@127.0.0.1:5432/dupe?sslmode=disable")
		pool, pgErr := initDB(ctx, databaseURL)
		if pgErr != nil {
			slog.Error("database initialization failed", "error", pgErr)
			os.Exit(1)
		}
		db = pool
		closeDB = pool.Close
	}
	defer closeDB()

	if *createUser != "" {
		if err := createOrUpdateUser(ctx, db, *createUser, *password, *colorHex); err != nil {
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

	projectsDir := strings.TrimSpace(*projectsFlag)
	if projectsDir == "" {
		projectsDir = strings.TrimSpace(os.Getenv("PROJECTS_DIR"))
	}
	if projectsDir == "" && mode == "local" {
		tmpSrv := &Server{storageDir: storageDir}
		if lc := tmpSrv.loadLocalConfig(); lc.ProjectsDir != "" {
			projectsDir = lc.ProjectsDir
		}
	}
	if projectsDir == "" {
		projectsDir = filepath.Join(storageDir, "projects")
	}
	projectsDir = expandUserHome(projectsDir)
	if err := os.MkdirAll(projectsDir, 0o755); err != nil {
		slog.Error("failed to initialize projects directory", "error", err)
		os.Exit(1)
	}

	if mode == "local" {
		_ = createOrUpdateUser(ctx, db, "local", "local-mode-implicit-user", "#FFEB3B")
	}

	pythonBin := envOrDefault("PYTHON_BIN", resolveDefaultPath("../.venv/bin/python3", "./.venv/bin/python3", "python3"))
	extractScript := envOrDefault("EXTRACT_SCRIPT", resolveDefaultPath("../scripts/extract_meta.py", "./scripts/extract_meta.py"))
	webDistDir := envOrDefault("WEB_DIST_DIR", resolveDefaultPath("../web/dist", "./web/dist"))
	listenAddr := *addrFlag
	if listenAddr == "" {
		listenAddr = envOrDefault("ADDR", "127.0.0.1:8080")
	}

	srv := &Server{
		db:            db,
		jwtSecret:     []byte(jwtSecret),
		storageDir:    storageDir,
		projectsDir:   projectsDir,
		mode:          mode,
		pythonBin:     pythonBin,
		extractScript: extractScript,
		webDistDir:    webDistDir,
	}

	if mode == "local" && !isMCPSubcmd && !isInitSubcmd {
		initSyncURL := strings.TrimSpace(*syncURLFlag)
		if initSyncURL == "" {
			initSyncURL = envOrDefault("DUPE_SYNC_URL", "")
		}
		initSyncToken := strings.TrimSpace(*syncTokenFlag)
		if initSyncToken == "" {
			initSyncToken = envOrDefault("DUPE_SYNC_TOKEN", "")
		}
		if initSyncURL != "" || initSyncToken != "" {
			cfg := srv.loadRemoteSyncConfig()
			if initSyncURL != "" {
				cfg.RemoteURL = strings.TrimRight(initSyncURL, "/")
			}
			if initSyncToken != "" {
				cfg.Token = initSyncToken
			}
			_ = srv.saveRemoteSyncConfig(cfg)
		}
		go srv.startBackgroundRemoteSync(ctx)
	}

	if isInitSubcmd {
		targetDir := "."
		if len(subcmdPositional) > 0 && strings.TrimSpace(subcmdPositional[0]) != "" {
			targetDir = subcmdPositional[0]
		}
		cfg, absProjDir, initErr := srv.initProjectInDir(ctx, 1, "local", targetDir)
		if initErr != nil {
			slog.Error("failed to initialize dupe project", "path", targetDir, "error", initErr)
			os.Exit(1)
		}
		fmt.Printf("Initialized dupe project %q at %s\n", cfg.Name, absProjDir)
		return
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
