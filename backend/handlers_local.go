package main

import (
	"archive/tar"
	"compress/gzip"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type localRuntimeConfig struct {
	ProjectsDir string `json:"projects_dir"`
}

func (s *Server) localConfigPath() string {
	return filepath.Join(s.storageDir, "local_config.json")
}

func (s *Server) loadLocalConfig() localRuntimeConfig {
	raw, err := os.ReadFile(s.localConfigPath())
	if err != nil {
		return localRuntimeConfig{}
	}
	var cfg localRuntimeConfig
	_ = json.Unmarshal(raw, &cfg)
	cfg.ProjectsDir = strings.TrimSpace(cfg.ProjectsDir)
	return cfg
}

func (s *Server) saveLocalConfig(cfg localRuntimeConfig) error {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.localConfigPath(), append(data, '\n'), 0o600)
}

func (s *Server) getProjectsDir() string {
	s.projectsMu.RLock()
	defer s.projectsMu.RUnlock()
	return s.projectsDir
}

func (s *Server) setProjectsDir(dir string) {
	s.projectsMu.Lock()
	defer s.projectsMu.Unlock()
	s.projectsDir = dir
}

func expandUserHome(rawPath string) string {
	p := strings.TrimSpace(rawPath)
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil && home != "" {
			if p == "~" {
				return home
			}
			return filepath.Join(home, p[2:])
		}
	}
	return p
}

var safeProjectsParamRegex = regexp.MustCompile(`[^a-zA-Z0-9_./~ -]`)

func requestBaseURL(r *http.Request) string {
	scheme := "http"
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		scheme = strings.Split(proto, ",")[0]
	} else if r.TLS != nil {
		scheme = "https"
	} else if strings.Contains(strings.ToLower(r.Host), "dupe.ing") {
		scheme = "https"
	}
	host := strings.TrimSpace(r.Host)
	if host == "" {
		host = "127.0.0.1:8080"
	}
	return fmt.Sprintf("%s://%s", strings.TrimSpace(scheme), host)
}

func addFileToTar(tw *tar.Writer, srcPath, archiveName string, mode int64) error {
	f, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return err
	}
	hdr := &tar.Header{
		Name:    filepath.ToSlash(archiveName),
		Size:    info.Size(),
		Mode:    mode,
		ModTime: info.ModTime(),
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err = io.Copy(tw, f)
	return err
}

func (s *Server) handleLocalBundle(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentUser(r); !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	exePath, err := os.Executable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server executable unavailable")
		return
	}
	if resolved, rErr := filepath.EvalSymlinks(exePath); rErr == nil {
		exePath = resolved
	}

	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("Content-Disposition", `attachment; filename="dupe-local-bundle.tar.gz"`)
	w.Header().Set("Cache-Control", "no-store")

	gz := gzip.NewWriter(w)
	defer func() { _ = gz.Close() }()
	tw := tar.NewWriter(gz)
	defer func() { _ = tw.Close() }()

	if err := addFileToTar(tw, exePath, "dupe/backend/server", 0o755); err != nil {
		return
	}

	if s.webDistDir != "" {
		if info, statErr := os.Stat(s.webDistDir); statErr == nil && info.IsDir() {
			_ = filepath.WalkDir(s.webDistDir, func(path string, d fs.DirEntry, walkErr error) error {
				if walkErr != nil || d.IsDir() {
					return nil
				}
				rel, relErr := filepath.Rel(s.webDistDir, path)
				if relErr != nil {
					return nil
				}
				return addFileToTar(tw, path, filepath.Join("dupe/web/dist", rel), 0o644)
			})
		}
	}

	if s.extractScript != "" {
		if _, statErr := os.Stat(s.extractScript); statErr == nil {
			_ = addFileToTar(tw, s.extractScript, "dupe/scripts/extract_meta.py", 0o644)
			reqTxt := filepath.Join(filepath.Dir(s.extractScript), "requirements.txt")
			if _, reqErr := os.Stat(reqTxt); reqErr == nil {
				_ = addFileToTar(tw, reqTxt, "dupe/scripts/requirements.txt", 0o644)
			}
		}
	}
}

func (s *Server) handleLocalSetupScript(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	baseURL := requestBaseURL(r)
	rawToken := extractBearerToken(r)
	if rawToken == "" {
		if issued, err := issueToken(s.jwtSecret, claims.UserID, claims.Username, time.Now().UTC()); err == nil {
			rawToken = issued
		}
	}

	rawProjects := strings.TrimSpace(r.URL.Query().Get("projects"))
	rawProjects = safeProjectsParamRegex.ReplaceAllString(rawProjects, "")
	if rawProjects == "" {
		rawProjects = "$HOME/dupe_projects"
	} else if rawProjects == "~" {
		rawProjects = "$HOME"
	} else if strings.HasPrefix(rawProjects, "~/") {
		rawProjects = "$HOME/" + rawProjects[2:]
	}

	enableAutostart := r.URL.Query().Get("autostart") != "0"
	enableSync := r.URL.Query().Get("sync") != "0" && rawToken != ""

	var syncFlags string
	if enableSync {
		syncFlags = fmt.Sprintf(`--sync-url %q --sync-token %q`, baseURL, rawToken)
	}
	autostartFlag := "0"
	if enableAutostart {
		autostartFlag = "1"
	}

	script := fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail

BASE_URL=%q
TOKEN=%q
PROJECTS_DIR="%s"
INSTALL_DIR="$HOME/.local/share/dupe"
STORAGE_DIR="$INSTALL_DIR/storage"
BIN_DIR="$HOME/.local/bin"
AUTOSTART=%s

echo "==> Installing dupe local mode into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$STORAGE_DIR" "$PROJECTS_DIR" "$BIN_DIR"

TMP_TAR="$(mktemp)"
trap 'rm -f "$TMP_TAR"' EXIT
curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/local/bundle.tar.gz" -o "$TMP_TAR"
tar -xzf "$TMP_TAR" -C "$HOME/.local/share"
chmod +x "$INSTALL_DIR/backend/server"

if ! command -v tectonic >/dev/null 2>&1 && [ ! -x "$BIN_DIR/tectonic" ]; then
  if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ]; then
    echo "==> Installing Tectonic LaTeX engine (0.15.0) into $BIN_DIR..."
    TECT_TMP="$(mktemp -d)"
    if curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz" -o "$TECT_TMP/tectonic.tar.gz"; then
      tar -xzf "$TECT_TMP/tectonic.tar.gz" -C "$TECT_TMP"
      install -m 0755 "$TECT_TMP/tectonic" "$BIN_DIR/tectonic" || true
    else
      echo "Warning: Could not download tectonic automatically; draft preview still works."
    fi
    rm -rf "$TECT_TMP"
  fi
fi

if [ "$AUTOSTART" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/dupe-local.service" <<UNIT
[Unit]
Description=dupe Local Studio Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR/backend
Environment="STORAGE_DIR=$STORAGE_DIR"
Environment="PROJECTS_DIR=$PROJECTS_DIR"
Environment="WEB_DIST_DIR=$INSTALL_DIR/web/dist"
Environment="EXTRACT_SCRIPT=$INSTALL_DIR/scripts/extract_meta.py"
Environment="PATH=$BIN_DIR:/usr/local/bin:/usr/bin:/bin"
ExecStart=$INSTALL_DIR/backend/server serve --mode local --projects "$PROJECTS_DIR" %s
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now dupe-local.service
  systemctl --user restart dupe-local.service
  echo "==> dupe-local.service started! Open http://127.0.0.1:8080 in your browser."
  exit 0
fi

echo "==> Starting dupe in local mode on http://127.0.0.1:8080 ..."
cd "$INSTALL_DIR/backend"
STORAGE_DIR="$STORAGE_DIR" WEB_DIST_DIR="$INSTALL_DIR/web/dist" EXTRACT_SCRIPT="$INSTALL_DIR/scripts/extract_meta.py" \
  exec "$INSTALL_DIR/backend/server" serve --mode local --projects "$PROJECTS_DIR" %s
`, baseURL, rawToken, rawProjects, autostartFlag, syncFlags, syncFlags)

	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write([]byte(script))
}

func (s *Server) handleLocalStatus(w http.ResponseWriter, r *http.Request) {
	if s.mode != "local" {
		writeError(w, http.StatusForbidden, "local mode endpoints are disabled in hosted mode")
		return
	}
	homeDir, _ := os.UserHomeDir()
	tectonicBin := resolveTectonicBinary()
	_, tectonicPathErr := exec.LookPath(tectonicBin)
	_, tectonicStatErr := os.Stat(tectonicBin)
	tectonicReady := tectonicPathErr == nil || tectonicStatErr == nil

	_, pyPathErr := exec.LookPath(s.pythonBin)
	_, pyStatErr := os.Stat(s.pythonBin)
	pythonReady := pyPathErr == nil || pyStatErr == nil

	syncCfg := s.loadRemoteSyncConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":               s.mode,
		"projects_dir":       s.getProjectsDir(),
		"storage_dir":        s.storageDir,
		"home_dir":           homeDir,
		"tectonic_available": tectonicReady,
		"python_available":   pythonReady,
		"sync_remote_url":    syncCfg.RemoteURL,
	})
}

type localBrowseDirEntry struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	IsDupeProject bool   `json:"is_dupe_project"`
	HasTex        bool   `json:"has_tex"`
	HasGit        bool   `json:"has_git"`
}

func inspectDirFlags(absDir string) (isDupeProject, hasTex, hasGit bool) {
	if _, err := os.Stat(filepath.Join(absDir, ".dupe", "project.json")); err == nil {
		isDupeProject = true
	}
	if _, err := os.Stat(filepath.Join(absDir, ".git")); err == nil {
		hasGit = true
	}
	items, err := os.ReadDir(absDir)
	if err != nil {
		return
	}
	for _, it := range items {
		if strings.HasSuffix(strings.ToLower(it.Name()), ".tex") {
			hasTex = true
			break
		}
		if it.IsDir() && it.Name() == "paper" {
			if sub, subErr := os.ReadDir(filepath.Join(absDir, "paper")); subErr == nil {
				for _, sIt := range sub {
					if strings.HasSuffix(strings.ToLower(sIt.Name()), ".tex") {
						hasTex = true
						break
					}
				}
			}
		}
	}
	return
}

func (s *Server) handleLocalBrowse(w http.ResponseWriter, r *http.Request) {
	if s.mode != "local" {
		writeError(w, http.StatusForbidden, "local filesystem browse is disabled in hosted mode")
		return
	}
	rawPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if rawPath == "" {
		rawPath, _ = os.UserHomeDir()
		if rawPath == "" {
			rawPath = s.getProjectsDir()
		}
	}
	expanded := filepath.Clean(expandUserHome(rawPath))
	info, err := os.Stat(expanded)
	if err != nil || !info.IsDir() {
		expanded = s.getProjectsDir()
	}

	items, err := os.ReadDir(expanded)
	if err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("cannot read directory: %v", err))
		return
	}

	dirs := make([]localBrowseDirEntry, 0)
	for _, item := range items {
		name := item.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		fullPath := filepath.Join(expanded, name)
		st, stErr := os.Stat(fullPath)
		if stErr != nil || !st.IsDir() {
			continue
		}
		isProj, hasTex, hasGit := inspectDirFlags(fullPath)
		dirs = append(dirs, localBrowseDirEntry{
			Name:          name,
			Path:          fullPath,
			IsDupeProject: isProj,
			HasTex:        hasTex,
			HasGit:        hasGit,
		})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})

	parent := filepath.Dir(expanded)
	if parent == expanded {
		parent = ""
	}
	homeDir, _ := os.UserHomeDir()

	writeJSON(w, http.StatusOK, map[string]any{
		"current_path": expanded,
		"parent_path":  parent,
		"home_dir":     homeDir,
		"dirs":         dirs,
	})
}

func (s *Server) handleSetLocalProjectsRoot(w http.ResponseWriter, r *http.Request) {
	if s.mode != "local" {
		writeError(w, http.StatusForbidden, "only available in local mode")
		return
	}
	var req struct {
		ProjectsDir string `json:"projects_dir"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	cleanDir := filepath.Clean(expandUserHome(req.ProjectsDir))
	if cleanDir == "" || cleanDir == "." || !filepath.IsAbs(cleanDir) {
		writeError(w, http.StatusBadRequest, "absolute projects directory path is required (or start with ~/)")
		return
	}
	if err := os.MkdirAll(cleanDir, 0o755); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("cannot create directory: %v", err))
		return
	}
	s.setProjectsDir(cleanDir)
	_ = s.saveLocalConfig(localRuntimeConfig{ProjectsDir: cleanDir})

	writeJSON(w, http.StatusOK, map[string]any{
		"projects_dir": cleanDir,
	})
}

func generateUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (s *Server) handleLinkLocalFolder(w http.ResponseWriter, r *http.Request) {
	if s.mode != "local" {
		writeError(w, http.StatusForbidden, "only available in local mode")
		return
	}
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req struct {
		Name       string `json:"name"`
		SourcePath string `json:"source_path"`
		LinkMode   string `json:"link_mode"` // "symlink_project" | "symlink_paper"
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	sourcePath := filepath.Clean(expandUserHome(req.SourcePath))
	srcInfo, err := os.Stat(sourcePath)
	if err != nil || !srcInfo.IsDir() {
		writeError(w, http.StatusBadRequest, "selected source folder does not exist or is not a directory")
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = filepath.Base(sourcePath)
	}
	slug := sanitizeProjectFolderName(name)
	root := s.getProjectsDir()
	_ = os.MkdirAll(root, 0o755)
	projDir := filepath.Join(root, slug)

	linkMode := strings.TrimSpace(req.LinkMode)
	if linkMode == "" {
		linkMode = "symlink_paper"
	}

	if sourcePath == root || strings.HasPrefix(root+string(os.PathSeparator), sourcePath+string(os.PathSeparator)) {
		writeError(w, http.StatusBadRequest, "cannot link the active projects root or a parent directory into itself")
		return
	}

	if linkMode == "symlink_project" {
		if _, statErr := os.Lstat(projDir); statErr == nil {
			slug = fmt.Sprintf("%s_%d", slug, time.Now().Unix()%1000)
			projDir = filepath.Join(root, slug)
		}
		if err := os.Symlink(sourcePath, projDir); err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("symlink project failed: %v", err))
			return
		}
	} else {
		if _, statErr := os.Stat(projDir); statErr == nil {
			slug = fmt.Sprintf("%s_%d", slug, time.Now().Unix()%1000)
			projDir = filepath.Join(root, slug)
		}
		if err := os.MkdirAll(projDir, 0o755); err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("mkdir project failed: %v", err))
			return
		}
		if err := os.Symlink(sourcePath, filepath.Join(projDir, "paper")); err != nil {
			_ = os.RemoveAll(projDir)
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("symlink paper/ failed: %v", err))
			return
		}
	}

	cfg, cfgErr := readProjectConfig(projDir)
	if cfgErr != nil {
		cfg = ProjectConfig{
			ID:             generateUUIDv4(),
			Name:           name,
			FolderName:     filepath.Base(projDir),
			LinkedPaperIDs: []string{},
			LinkAllPapers:  true,
			UpdatedAt:      time.Now().UTC(),
		}
		if err := writeProjectConfig(projDir, cfg); err != nil {
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to initialize .dupe/project.json: %v", err))
			return
		}
	}

	_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
	writeJSON(w, http.StatusCreated, cfg)
}
