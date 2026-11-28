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
	"runtime"
	"sort"
	"strings"
	"time"
)

type localRuntimeConfig struct {
	ProjectsDir        string   `json:"projects_dir"`
	RecentProjectsDirs []string `json:"recent_projects_dirs,omitempty"`
}

func appendUniqueDir(list []string, dir string) []string {
	if strings.TrimSpace(dir) == "" {
		return list
	}
	out := []string{dir}
	for _, item := range list {
		if item != dir && strings.TrimSpace(item) != "" {
			out = append(out, item)
		}
		if len(out) >= 6 {
			break
		}
	}
	return out
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

func normalizeBundleOS(raw string) string {
	clean := strings.ToLower(strings.TrimSpace(raw))
	if clean == "" {
		return runtime.GOOS
	}
	switch clean {
	case "linux":
		return "linux"
	case "darwin", "macos", "osx":
		return "darwin"
	default:
		return ""
	}
}

func normalizeBundleArch(raw string) string {
	clean := strings.ToLower(strings.TrimSpace(raw))
	if clean == "" {
		return runtime.GOARCH
	}
	switch clean {
	case "amd64", "x86_64", "x64":
		return "amd64"
	case "arm64", "aarch64":
		return "arm64"
	default:
		return ""
	}
}

func resolveBundleExecutable(targetOS, targetArch string) (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	if resolved, rErr := filepath.EvalSymlinks(exePath); rErr == nil {
		exePath = resolved
	}
	sibling := filepath.Join(filepath.Dir(exePath), fmt.Sprintf("server-%s-%s", targetOS, targetArch))
	if info, statErr := os.Stat(sibling); statErr == nil && !info.IsDir() {
		return sibling, nil
	}
	if targetOS == runtime.GOOS && targetArch == runtime.GOARCH {
		return exePath, nil
	}
	return "", fmt.Errorf("binary for %s/%s not found", targetOS, targetArch)
}

func (s *Server) handleLocalBundle(w http.ResponseWriter, r *http.Request) {
	if _, ok := currentUser(r); !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	targetOS := normalizeBundleOS(r.URL.Query().Get("os"))
	targetArch := normalizeBundleArch(r.URL.Query().Get("arch"))
	if targetOS == "" || targetArch == "" {
		writeError(w, http.StatusBadRequest, "unsupported os or arch")
		return
	}

	exePath, err := resolveBundleExecutable(targetOS, targetArch)
	if err != nil {
		writeError(w, http.StatusNotFound, err.Error())
		return
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
			herdrDir := filepath.Join(filepath.Dir(filepath.Dir(s.extractScript)), "herdr")
			if hInfo, hErr := os.Stat(herdrDir); hErr == nil && hInfo.IsDir() {
				_ = filepath.WalkDir(herdrDir, func(path string, d fs.DirEntry, walkErr error) error {
					if walkErr != nil || d.IsDir() {
						return nil
					}
					rel, relErr := filepath.Rel(herdrDir, path)
					if relErr != nil {
						return nil
					}
					mode := int64(0o644)
					if strings.HasSuffix(rel, ".sh") || strings.HasPrefix(filepath.ToSlash(rel), "bin/") {
						mode = 0o755
					}
					return addFileToTar(tw, path, filepath.Join("dupe/herdr", rel), mode)
				})
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
	var launchdSyncArgs string
	if enableSync {
		syncFlags = fmt.Sprintf(`--sync-url %q --sync-token %q`, baseURL, rawToken)
		launchdSyncArgs = fmt.Sprintf("    <string>--sync-url</string>\n    <string>%s</string>\n    <string>--sync-token</string>\n    <string>%s</string>", baseURL, rawToken)
	}
	autostartFlag := "0"
	if enableAutostart {
		autostartFlag = "1"
	}
	storageSuffix := sanitizeProjectFolderName(claims.Username)
	if !enableSync {
		storageSuffix = "local"
	}

	script := fmt.Sprintf(`#!/usr/bin/env bash
set -euo pipefail

BASE_URL=%q
TOKEN=%q
PROJECTS_DIR="%s"
INSTALL_DIR="$HOME/.local/share/dupe"
STORAGE_DIR="$INSTALL_DIR/storage_%s"
BIN_DIR="$HOME/.local/bin"
AUTOSTART=%s

OS_RAW="$(uname -s)"
case "$OS_RAW" in
  Linux) OS_NAME="linux" ;;
  Darwin) OS_NAME="darwin" ;;
  *) echo "Unsupported OS: $OS_RAW" >&2; exit 1 ;;
esac

ARCH_RAW="$(uname -m)"
case "$ARCH_RAW" in
  x86_64|amd64) ARCH_NAME="amd64" ;;
  arm64|aarch64) ARCH_NAME="arm64" ;;
  *) echo "Unsupported architecture: $ARCH_RAW" >&2; exit 1 ;;
esac

echo "==> Installing dupe local mode ($OS_NAME/$ARCH_NAME) into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$STORAGE_DIR" "$PROJECTS_DIR" "$BIN_DIR"

TMP_TAR="$(mktemp)"
trap 'rm -f "$TMP_TAR"' EXIT
curl -fsSL -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/local/bundle.tar.gz?os=$OS_NAME&arch=$ARCH_NAME" -o "$TMP_TAR"
tar -xzf "$TMP_TAR" -C "$HOME/.local/share"
chmod +x "$INSTALL_DIR/backend/server"
if [ "$OS_NAME" = "darwin" ]; then
  xattr -d com.apple.quarantine "$INSTALL_DIR/backend/server" >/dev/null 2>&1 || true
fi
ln -sf "$INSTALL_DIR/backend/server" "$BIN_DIR/dupe"

if ! command -v tectonic >/dev/null 2>&1 && [ ! -x "$BIN_DIR/tectonic" ]; then
  TECT_URL=""
  case "$OS_NAME-$ARCH_NAME" in
    linux-amd64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%%400.15.0/tectonic-0.15.0-x86_64-unknown-linux-gnu.tar.gz" ;;
    linux-arm64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%%400.15.0/tectonic-0.15.0-aarch64-unknown-linux-musl.tar.gz" ;;
    darwin-arm64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%%400.15.0/tectonic-0.15.0-aarch64-apple-darwin.tar.gz" ;;
    darwin-amd64) TECT_URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%%400.15.0/tectonic-0.15.0-x86_64-apple-darwin.tar.gz" ;;
  esac
  if [ -n "$TECT_URL" ]; then
    echo "==> Installing Tectonic LaTeX engine (0.15.0) into $BIN_DIR..."
    TECT_TMP="$(mktemp -d)"
    if curl -fsSL "$TECT_URL" -o "$TECT_TMP/tectonic.tar.gz"; then
      tar -xzf "$TECT_TMP/tectonic.tar.gz" -C "$TECT_TMP"
      install -m 0755 "$TECT_TMP/tectonic" "$BIN_DIR/tectonic" || true
      if [ "$OS_NAME" = "darwin" ]; then
        xattr -d com.apple.quarantine "$BIN_DIR/tectonic" >/dev/null 2>&1 || true
      fi
    else
      echo "Warning: Could not download tectonic automatically; draft preview still works."
    fi
    rm -rf "$TECT_TMP"
  fi
fi

PYTHON_BIN_VAL="python3"
if command -v python3 >/dev/null 2>&1; then
  if [ ! -x "$INSTALL_DIR/.venv/bin/python3" ]; then
    echo "==> Setting up Python virtual environment in $INSTALL_DIR/.venv..."
    python3 -m venv "$INSTALL_DIR/.venv" >/dev/null 2>&1 || true
  fi
  if [ -x "$INSTALL_DIR/.venv/bin/python3" ]; then
    PYTHON_BIN_VAL="$INSTALL_DIR/.venv/bin/python3"
    if ! "$PYTHON_BIN_VAL" -c "import fitz" >/dev/null 2>&1 && [ -f "$INSTALL_DIR/scripts/requirements.txt" ]; then
      echo "==> Installing Python PDF dependencies (PyMuPDF)..."
      "$PYTHON_BIN_VAL" -m pip install -q -r "$INSTALL_DIR/scripts/requirements.txt" || echo "Warning: pip install failed; install PyMuPDF or poppler pdftotext for MCP read_paper."
    fi
  fi
fi

TECT_BIN=""
if [ -x "$BIN_DIR/tectonic" ]; then
  TECT_BIN="$BIN_DIR/tectonic"
elif command -v tectonic >/dev/null 2>&1; then
  TECT_BIN="$(command -v tectonic)"
fi
if [ -n "$TECT_BIN" ]; then
  TECT_CACHE_DIR="$HOME/.cache/Tectonic"
  if [ "$OS_NAME" = "darwin" ]; then
    TECT_CACHE_DIR="$HOME/Library/Caches/Tectonic"
  fi
  if [ ! -d "$TECT_CACHE_DIR/formats" ] || [ -z "$(ls -A "$TECT_CACHE_DIR/formats" 2>/dev/null || true)" ]; then
    echo "==> Warming Tectonic LaTeX cache (first-time bundle download)..."
    WARM_TMP="$(mktemp -d)"
    printf '\\documentclass{article}\n\\usepackage{amsmath,amssymb,graphicx,hyperref,tikz}\n\\begin{document}\ndupe warmup\n\\end{document}\n' > "$WARM_TMP/warmup.tex"
    "$TECT_BIN" -X compile --outdir "$WARM_TMP" "$WARM_TMP/warmup.tex" >/dev/null 2>&1 || echo "Warning: Tectonic warmup skipped; first compile will download bundles."
    rm -rf "$WARM_TMP"
  fi
fi

if command -v python3 >/dev/null 2>&1; then
  echo "==> Registering dupe MCP server for Antigravity and Claude Code..."
  DUPE_MCP_CMD="$INSTALL_DIR/backend/server" \
  DUPE_MCP_PROJECTS="$PROJECTS_DIR" \
  DUPE_MCP_STORAGE="$STORAGE_DIR" \
  DUPE_MCP_PYTHON="$PYTHON_BIN_VAL" \
  DUPE_MCP_EXTRACT="$INSTALL_DIR/scripts/extract_meta.py" \
  python3 - <<'PY' || true
import json, os

entry = {
    "command": os.environ["DUPE_MCP_CMD"],
    "args": ["mcp", "--mode", "local", "--projects", os.environ["DUPE_MCP_PROJECTS"]],
    "env": {
        "STORAGE_DIR": os.environ["DUPE_MCP_STORAGE"],
        "PROJECTS_DIR": os.environ["DUPE_MCP_PROJECTS"],
        "PYTHON_BIN": os.environ["DUPE_MCP_PYTHON"],
        "EXTRACT_SCRIPT": os.environ["DUPE_MCP_EXTRACT"],
    },
}

for raw_path in ("~/.gemini/config/mcp_config.json", "~/.claude.json"):
    cfg_path = os.path.expanduser(raw_path)
    os.makedirs(os.path.dirname(cfg_path), exist_ok=True)
    data = {}
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as fh:
                txt = fh.read().strip()
            if txt:
                parsed = json.loads(txt)
                if isinstance(parsed, dict):
                    data = parsed
        except Exception:
            data = {}
    servers = data.get("mcpServers")
    if not isinstance(servers, dict):
        servers = {}
    servers["dupe"] = entry
    data["mcpServers"] = servers
    with open(cfg_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
PY
fi

if [ -x "$INSTALL_DIR/herdr/install_herdr_dupe.sh" ]; then
  bash "$INSTALL_DIR/herdr/install_herdr_dupe.sh" || true
fi

if [ "$AUTOSTART" = "1" ] && [ "$OS_NAME" = "darwin" ]; then
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  PLIST_PATH="$HOME/Library/LaunchAgents/io.dupe.local.plist"
  cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.dupe.local</string>
  <key>WorkingDirectory</key>
  <string>$INSTALL_DIR/backend</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STORAGE_DIR</key>
    <string>$STORAGE_DIR</string>
    <key>PROJECTS_DIR</key>
    <string>$PROJECTS_DIR</string>
    <key>WEB_DIST_DIR</key>
    <string>$INSTALL_DIR/web/dist</string>
    <key>PYTHON_BIN</key>
    <string>$PYTHON_BIN_VAL</string>
    <key>EXTRACT_SCRIPT</key>
    <string>$INSTALL_DIR/scripts/extract_meta.py</string>
    <key>PATH</key>
    <string>$BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/Library/TeX/texbin:/usr/bin:/bin</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>$INSTALL_DIR/backend/server</string>
    <string>serve</string>
    <string>--mode</string>
    <string>local</string>
    <string>--projects</string>
    <string>$PROJECTS_DIR</string>
%s
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/dupe-local.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/dupe-local.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  echo "==> io.dupe.local started! Open http://127.0.0.1:8080 in your browser."
  exit 0
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
Environment="PYTHON_BIN=$PYTHON_BIN_VAL"
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
STORAGE_DIR="$STORAGE_DIR" WEB_DIST_DIR="$INSTALL_DIR/web/dist" PYTHON_BIN="$PYTHON_BIN_VAL" EXTRACT_SCRIPT="$INSTALL_DIR/scripts/extract_meta.py" \
  exec "$INSTALL_DIR/backend/server" serve --mode local --projects "$PROJECTS_DIR" %s
`, baseURL, rawToken, rawProjects, storageSuffix, autostartFlag, launchdSyncArgs, syncFlags, syncFlags)

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
	lc := s.loadLocalConfig()
	recentDirs := appendUniqueDir(lc.RecentProjectsDirs, s.getProjectsDir())
	writeJSON(w, http.StatusOK, map[string]any{
		"mode":                 s.mode,
		"version":              normalizeSemver(appVersion),
		"projects_dir":         s.getProjectsDir(),
		"recent_projects_dirs": recentDirs,
		"storage_dir":          s.storageDir,
		"home_dir":             homeDir,
		"tectonic_available":   tectonicReady,
		"python_available":     pythonReady,
		"sync_remote_url":      syncCfg.RemoteURL,
	})
}

type localBrowseDirEntry struct {
	Name          string `json:"name"`
	Path          string `json:"path"`
	IsDupeProject bool   `json:"is_dupe_project"`
	HasTex        bool   `json:"has_tex"`
	HasCode       bool   `json:"has_code"`
	HasGit        bool   `json:"has_git"`
}

func isCodeMarkerFile(lowerName string) bool {
	switch lowerName {
	case "cargo.toml", "pyproject.toml", "package.json", "cmakelists.txt", "makefile", "setup.py", "go.mod":
		return true
	}
	for _, ext := range []string{".py", ".rs", ".go", ".ts", ".tsx", ".js", ".cpp", ".cc", ".c", ".h"} {
		if strings.HasSuffix(lowerName, ext) {
			return true
		}
	}
	return false
}

func inspectDirFlags(absDir string) (isDupeProject, hasTex, hasCode, hasGit bool) {
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
		lower := strings.ToLower(it.Name())
		if strings.HasSuffix(lower, ".tex") {
			hasTex = true
		} else if isCodeMarkerFile(lower) {
			hasCode = true
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
		if it.IsDir() && (it.Name() == "src" || it.Name() == "code") {
			hasCode = true
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
		isProj, hasTex, hasCode, hasGit := inspectDirFlags(fullPath)
		dirs = append(dirs, localBrowseDirEntry{
			Name:          name,
			Path:          fullPath,
			IsDupeProject: isProj,
			HasTex:        hasTex,
			HasCode:       hasCode,
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
	prevRoot := s.getProjectsDir()
	s.setProjectsDir(cleanDir)
	lc := s.loadLocalConfig()
	recent := appendUniqueDir(appendUniqueDir(lc.RecentProjectsDirs, prevRoot), cleanDir)
	_ = s.saveLocalConfig(localRuntimeConfig{
		ProjectsDir:        cleanDir,
		RecentProjectsDirs: recent,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"projects_dir":         cleanDir,
		"recent_projects_dirs": recent,
	})
}

func generateUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func replaceEmptyOrSymlinkSubdir(targetSubdir, sourcePath string) (int, error) {
	if lstat, err := os.Lstat(targetSubdir); err == nil {
		if lstat.Mode()&os.ModeSymlink != 0 {
			if rmErr := os.Remove(targetSubdir); rmErr != nil {
				return http.StatusInternalServerError, fmt.Errorf("remove previous symlink: %w", rmErr)
			}
		} else if lstat.IsDir() {
			entries, readErr := os.ReadDir(targetSubdir)
			if readErr != nil {
				return http.StatusInternalServerError, readErr
			}
			if len(entries) > 0 {
				return http.StatusConflict, fmt.Errorf("%s already contains files; choose a new project or clean %s first", filepath.Base(targetSubdir), filepath.Base(targetSubdir))
			}
			if rmErr := os.Remove(targetSubdir); rmErr != nil {
				return http.StatusInternalServerError, rmErr
			}
		} else {
			return http.StatusConflict, fmt.Errorf("%s exists and is not a directory", filepath.Base(targetSubdir))
		}
	}
	if err := os.Symlink(sourcePath, targetSubdir); err != nil {
		return http.StatusInternalServerError, fmt.Errorf("symlink failed: %w", err)
	}
	return http.StatusOK, nil
}

func linkSubdirInsideContainer(containerDir, sourcePath, subName string) (string, int, error) {
	if lstat, err := os.Lstat(containerDir); err == nil {
		if lstat.Mode()&os.ModeSymlink != 0 {
			// Migrate a legacy single-repo top-level symlink into <containerDir>/<oldBase>
			oldTarget, readErr := os.Readlink(containerDir)
			if readErr != nil {
				return "", http.StatusInternalServerError, fmt.Errorf("read existing symlink: %w", readErr)
			}
			if rmErr := os.Remove(containerDir); rmErr != nil {
				return "", http.StatusInternalServerError, fmt.Errorf("remove legacy symlink: %w", rmErr)
			}
			if mkErr := os.MkdirAll(containerDir, 0o755); mkErr != nil {
				return "", http.StatusInternalServerError, mkErr
			}
			oldName := sanitizeProjectFolderName(filepath.Base(oldTarget))
			_ = os.Symlink(oldTarget, filepath.Join(containerDir, oldName))
		} else if !lstat.IsDir() {
			return "", http.StatusConflict, fmt.Errorf("%s exists and is not a directory", filepath.Base(containerDir))
		}
	} else if mkErr := os.MkdirAll(containerDir, 0o755); mkErr != nil {
		return "", http.StatusInternalServerError, mkErr
	}

	slug := sanitizeProjectFolderName(subName)
	targetPath := filepath.Join(containerDir, slug)
	if _, statErr := os.Lstat(targetPath); statErr == nil {
		slug = fmt.Sprintf("%s_%d", slug, time.Now().Unix()%1000)
		targetPath = filepath.Join(containerDir, slug)
	}
	if err := os.Symlink(sourcePath, targetPath); err != nil {
		return "", http.StatusInternalServerError, fmt.Errorf("symlink failed: %w", err)
	}
	return targetPath, http.StatusOK, nil
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
		Name            string `json:"name"`
		SourcePath      string `json:"source_path"`
		LinkMode        string `json:"link_mode"` // "symlink_code" | "symlink_paper" | "symlink_project"
		TargetProjectID string `json:"target_project_id,omitempty"`
		AsSubdir        bool   `json:"as_subdir,omitempty"`
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
	root := s.getProjectsDir()
	_ = os.MkdirAll(root, 0o755)

	linkMode := strings.TrimSpace(req.LinkMode)
	if linkMode != "symlink_code" && linkMode != "symlink_paper" && linkMode != "symlink_project" {
		_, hasTex, hasCode, _ := inspectDirFlags(sourcePath)
		if hasCode && !hasTex {
			linkMode = "symlink_code"
		} else {
			linkMode = "symlink_paper"
		}
	}

	if sourcePath == root || strings.HasPrefix(root+string(os.PathSeparator), sourcePath+string(os.PathSeparator)) {
		writeError(w, http.StatusBadRequest, "cannot link the active projects root or a parent directory into itself")
		return
	}

	var projDir string
	var cfg ProjectConfig

	if targetID := strings.TrimSpace(req.TargetProjectID); targetID != "" && linkMode != "symlink_project" {
		existingCfg, existingDir, lookupErr := s.lookupProjectDir(r.Context(), claims.UserID, targetID, claims.Username)
		if lookupErr != nil {
			writeError(w, http.StatusNotFound, "target project not found")
			return
		}
		projDir = existingDir
		cfg = existingCfg
		subdirName := "paper"
		if linkMode == "symlink_code" {
			subdirName = "code"
		}
		containerDir := filepath.Join(projDir, subdirName)
		var linkedPath string
		if req.AsSubdir {
			var linkStatus int
			var symErr error
			linkedPath, linkStatus, symErr = linkSubdirInsideContainer(containerDir, sourcePath, name)
			if symErr != nil {
				writeError(w, linkStatus, symErr.Error())
				return
			}
		} else {
			codeStatus, symErr := replaceEmptyOrSymlinkSubdir(containerDir, sourcePath)
			if symErr != nil {
				writeError(w, codeStatus, symErr.Error())
				return
			}
			linkedPath = containerDir
		}
		_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
		if updatedCfg, readErr := readProjectConfig(projDir); readErr == nil {
			cfg = updatedCfg
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"project":     cfg,
			"linked_path": linkedPath,
			"source_path": sourcePath,
			"mode":        linkMode,
		})
		return
	}

	slug := sanitizeProjectFolderName(name)
	projDir = filepath.Join(root, slug)

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
		subdirName := "paper"
		if linkMode == "symlink_code" {
			subdirName = "code"
		}
		if err := os.Symlink(sourcePath, filepath.Join(projDir, subdirName)); err != nil {
			_ = os.RemoveAll(projDir)
			writeError(w, http.StatusInternalServerError, fmt.Sprintf("symlink %s/ failed: %v", subdirName, err))
			return
		}
		if linkMode == "symlink_code" {
			paperDir := filepath.Join(projDir, "paper")
			_ = os.MkdirAll(filepath.Join(paperDir, "figures"), 0o755)
			mainTex := fmt.Sprintf("\\documentclass{article}\n\\title{%s}\n\\begin{document}\n\\maketitle\n\\section{Introduction}\nStart writing your manuscript here.\n\\bibliographystyle{plain}\n\\bibliography{dupe_references}\n\\end{document}\n", name)
			_ = os.WriteFile(filepath.Join(paperDir, "main.tex"), []byte(mainTex), 0o644)
		}
	}

	var cfgErr error
	cfg, cfgErr = readProjectConfig(projDir)
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
