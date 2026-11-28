package main

import (
	"archive/tar"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const defaultDupeRepo = "Dinoclaro/dupe"

type githubReleaseAsset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Size               int64  `json:"size"`
}

type releaseMetadata struct {
	TagName     string               `json:"tag_name"`
	Name        string               `json:"name"`
	HTMLURL     string               `json:"html_url"`
	Body        string               `json:"body"`
	PublishedAt string               `json:"published_at"`
	Assets      []githubReleaseAsset `json:"assets"`
}

type UpdateCheckResult struct {
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version"`
	UpdateAvailable bool   `json:"update_available"`
	ReleaseURL      string `json:"release_url"`
	ReleaseNotes    string `json:"release_notes,omitempty"`
	InstallMethod   string `json:"install_method"`
	CheckedAt       string `json:"checked_at"`
}

type UpdateApplyResult struct {
	Status           string `json:"status"`
	PreviousVersion  string `json:"previous_version"`
	Version          string `json:"version"`
	Method           string `json:"method"`
	ExtensionUpdated bool   `json:"extension_updated"`
	HerdrUpdated     bool   `json:"herdr_updated"`
	Restarting       bool   `json:"restarting"`
	Message          string `json:"message"`
}

type updateOptions struct {
	TargetVersion string
	CheckOnly     bool
	Force         bool
	NoRestart     bool
	InsideHTTP    bool
	InstallDir    string
	BinDir        string
	CurrentVer    string
}

func normalizeSemver(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" || strings.EqualFold(v, "dev") {
		return "dev"
	}
	if !strings.HasPrefix(v, "v") && !strings.HasPrefix(v, "V") {
		return "v" + v
	}
	return "v" + v[1:]
}

func parseSemverParts(raw string) ([3]int, bool) {
	v := strings.TrimSpace(raw)
	if v == "" || strings.EqualFold(v, "dev") {
		return [3]int{}, false
	}
	v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
	if idx := strings.IndexAny(v, "+-"); idx >= 0 {
		v = v[:idx]
	}
	parts := strings.Split(v, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i := 0; i < len(parts); i++ {
		n, err := strconv.Atoi(parts[i])
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

// compareSemver returns -1 if a < b, 0 if equal, 1 if a > b.
func compareSemver(a, b string) int {
	pa, okA := parseSemverParts(a)
	pb, okB := parseSemverParts(b)
	if !okA && !okB {
		return 0
	}
	if !okA {
		return -1
	}
	if !okB {
		return 1
	}
	for i := 0; i < 3; i++ {
		if pa[i] < pb[i] {
			return -1
		}
		if pa[i] > pb[i] {
			return 1
		}
	}
	return 0
}

func githubAPIBaseURL() string {
	if custom := strings.TrimSpace(os.Getenv("DUPE_GITHUB_API")); custom != "" {
		return strings.TrimRight(custom, "/")
	}
	return "https://api.github.com"
}

func githubTokenFromEnv() string {
	if tok := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); tok != "" {
		return tok
	}
	return strings.TrimSpace(os.Getenv("GH_TOKEN"))
}

func newGitHubRequest(ctx context.Context, url, accept string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "dupe-updater/"+normalizeSemver(appVersion))
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	if tok := githubTokenFromEnv(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req, nil
}

func fetchGitHubRelease(ctx context.Context, client *http.Client, targetVersion string) (*releaseMetadata, error) {
	repo := envOrDefault("DUPE_REPO", defaultDupeRepo)
	apiBase := githubAPIBaseURL()
	cleanVer := strings.TrimSpace(targetVersion)
	var endpoint string
	if cleanVer == "" || strings.EqualFold(cleanVer, "latest") {
		endpoint = fmt.Sprintf("%s/repos/%s/releases/latest", apiBase, repo)
	} else {
		tag := normalizeSemver(cleanVer)
		endpoint = fmt.Sprintf("%s/repos/%s/releases/tags/%s", apiBase, repo, tag)
	}
	req, err := newGitHubRequest(ctx, endpoint, "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("release lookup failed (%s): %s", resp.Status, strings.TrimSpace(string(body)))
	}
	var rel releaseMetadata
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("decode release metadata: %w", err)
	}
	if strings.TrimSpace(rel.TagName) == "" {
		return nil, fmt.Errorf("release metadata missing tag_name")
	}
	return &rel, nil
}

func parseSHA256Sums(raw string) map[string]string {
	out := make(map[string]string)
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		sum := strings.ToLower(fields[0])
		name := strings.TrimPrefix(fields[len(fields)-1], "*")
		name = filepath.Base(name)
		if len(sum) == 64 && name != "" {
			out[name] = sum
		}
	}
	return out
}

func downloadFileToTemp(ctx context.Context, client *http.Client, fileURL, destPath string) (string, error) {
	req, err := newGitHubRequest(ctx, fileURL, "application/octet-stream")
	if err != nil {
		return "", err
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s failed: %s", fileURL, resp.Status)
	}
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		_ = f.Close()
		return "", err
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func fetchReleaseSHA256Sums(ctx context.Context, client *http.Client, rel *releaseMetadata) (map[string]string, error) {
	for _, asset := range rel.Assets {
		if asset.Name == "SHA256SUMS.txt" {
			req, err := newGitHubRequest(ctx, asset.BrowserDownloadURL, "text/plain")
			if err != nil {
				return nil, err
			}
			resp, err := client.Do(req)
			if err != nil {
				return nil, err
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("download SHA256SUMS.txt failed: %s", resp.Status)
			}
			data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			if err != nil {
				return nil, err
			}
			return parseSHA256Sums(string(data)), nil
		}
	}
	return nil, nil
}

func resolveDupeInstallPaths() (installDir, binDir, exePath string, isHomebrew bool) {
	home, _ := os.UserHomeDir()
	defaultInstall := envOrDefault("DUPE_INSTALL_DIR", filepath.Join(home, ".local", "share", "dupe"))
	defaultBin := envOrDefault("DUPE_BIN_DIR", filepath.Join(home, ".local", "bin"))

	rawExe, err := os.Executable()
	if err != nil {
		return defaultInstall, defaultBin, "", false
	}
	resolved := rawExe
	if r, rErr := filepath.EvalSymlinks(rawExe); rErr == nil {
		resolved = r
	}
	slash := filepath.ToSlash(resolved)
	if strings.Contains(slash, "/Cellar/dupe/") {
		return filepath.Dir(filepath.Dir(resolved)), filepath.Dir(rawExe), resolved, true
	}
	if strings.HasSuffix(slash, "/backend/server") {
		return filepath.Dir(filepath.Dir(resolved)), defaultBin, resolved, false
	}
	return defaultInstall, defaultBin, resolved, false
}

func findReleaseAsset(rel *releaseMetadata, name string) (githubReleaseAsset, bool) {
	for _, asset := range rel.Assets {
		if asset.Name == name {
			return asset, true
		}
	}
	return githubReleaseAsset{}, false
}

func extractTarGzSafe(archivePath, stageDir string) error {
	f, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer func() { _ = gz.Close() }()

	tr := tar.NewReader(gz)
	absStage, err := filepath.Abs(stageDir)
	if err != nil {
		return err
	}

	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		clean := filepath.Clean(hdr.Name)
		if filepath.IsAbs(clean) || clean == "." || strings.HasPrefix(clean, "..") {
			continue
		}
		target := filepath.Join(absStage, clean)
		rel, rErr := filepath.Rel(absStage, target)
		if rErr != nil || strings.HasPrefix(rel, "..") {
			return fmt.Errorf("unsafe archive entry: %s", hdr.Name)
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			mode := os.FileMode(hdr.Mode & 0o777)
			if mode == 0 {
				mode = 0o644
			}
			out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				_ = out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		}
	}
	return nil
}

func copyFileAtomic(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if runtime.GOOS == "darwin" {
		_ = exec.Command("xattr", "-d", "com.apple.quarantine", tmp).Run()
	}
	return os.Rename(tmp, dst)
}

func copyDirContents(srcDir, dstDir string) error {
	return filepath.WalkDir(srcDir, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return os.MkdirAll(dstDir, 0o755)
		}
		target := filepath.Join(dstDir, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode() & 0o777
		if mode == 0 {
			mode = 0o644
		}
		return copyFileAtomic(path, target, mode)
	})
}

func replaceDirAtomic(srcDir, dstDir string) error {
	if err := os.MkdirAll(filepath.Dir(dstDir), 0o755); err != nil {
		return err
	}
	tmpNew := dstDir + ".new"
	tmpBak := dstDir + ".bak"
	_ = os.RemoveAll(tmpNew)
	_ = os.RemoveAll(tmpBak)
	if err := copyDirContents(srcDir, tmpNew); err != nil {
		_ = os.RemoveAll(tmpNew)
		return err
	}
	if _, err := os.Stat(dstDir); err == nil {
		if err := os.Rename(dstDir, tmpBak); err != nil {
			_ = os.RemoveAll(tmpNew)
			return err
		}
	}
	if err := os.Rename(tmpNew, dstDir); err != nil {
		if _, bErr := os.Stat(tmpBak); bErr == nil {
			_ = os.Rename(tmpBak, dstDir)
		}
		return err
	}
	_ = os.RemoveAll(tmpBak)
	return nil
}

func installExtractedBundle(stageDupeDir, installDir, binDir string) (herdrUpdated bool, err error) {
	srcServer := filepath.Join(stageDupeDir, "backend", "server")
	if _, statErr := os.Stat(srcServer); statErr != nil {
		return false, fmt.Errorf("release archive missing backend/server")
	}
	dstServer := filepath.Join(installDir, "backend", "server")
	if err := copyFileAtomic(srcServer, dstServer, 0o755); err != nil {
		return false, fmt.Errorf("install server binary: %w", err)
	}

	if binDir != "" {
		_ = os.MkdirAll(binDir, 0o755)
		linkPath := filepath.Join(binDir, "dupe")
		_ = os.Remove(linkPath)
		_ = os.Symlink(dstServer, linkPath)
	}

	srcWebDist := filepath.Join(stageDupeDir, "web", "dist")
	if info, sErr := os.Stat(srcWebDist); sErr == nil && info.IsDir() {
		if err := replaceDirAtomic(srcWebDist, filepath.Join(installDir, "web", "dist")); err != nil {
			return false, fmt.Errorf("install web/dist: %w", err)
		}
	}

	srcScripts := filepath.Join(stageDupeDir, "scripts")
	if info, sErr := os.Stat(srcScripts); sErr == nil && info.IsDir() {
		if err := copyDirContents(srcScripts, filepath.Join(installDir, "scripts")); err != nil {
			return false, fmt.Errorf("install scripts: %w", err)
		}
		venvPython := filepath.Join(installDir, ".venv", "bin", "python3")
		reqFile := filepath.Join(installDir, "scripts", "requirements.txt")
		if _, pyErr := os.Stat(venvPython); pyErr == nil {
			if _, rErr := os.Stat(reqFile); rErr == nil {
				if err := exec.Command(venvPython, "-c", "import fitz").Run(); err != nil {
					_ = exec.Command(venvPython, "-m", "pip", "install", "-q", "-r", reqFile).Run()
				}
			}
		}
	}

	srcHerdr := filepath.Join(stageDupeDir, "herdr")
	if info, sErr := os.Stat(srcHerdr); sErr == nil && info.IsDir() {
		dstHerdr := filepath.Join(installDir, "herdr")
		if err := copyDirContents(srcHerdr, dstHerdr); err != nil {
			return false, fmt.Errorf("install herdr: %w", err)
		}
		installer := filepath.Join(dstHerdr, "install_herdr_dupe.sh")
		if _, iErr := os.Stat(installer); iErr == nil {
			if runErr := exec.Command("bash", installer).Run(); runErr == nil {
				herdrUpdated = true
			}
		}
	}
	return herdrUpdated, nil
}

func resolveVSCodeCLI() string {
	if p, err := exec.LookPath("code"); err == nil {
		return p
	}
	if runtime.GOOS == "darwin" {
		macCode := "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
		if _, err := os.Stat(macCode); err == nil {
			return macCode
		}
	}
	return ""
}

func installVSCodeExtensionAsset(ctx context.Context, client *http.Client, rel *releaseMetadata, sums map[string]string, tmpDir string) bool {
	codeCLI := resolveVSCodeCLI()
	if codeCLI == "" {
		return false
	}
	asset, ok := findReleaseAsset(rel, "dupe-studio-latest.vsix")
	if !ok {
		return false
	}
	vsixPath := filepath.Join(tmpDir, "dupe-studio.vsix")
	actualSHA, err := downloadFileToTemp(ctx, client, asset.BrowserDownloadURL, vsixPath)
	if err != nil {
		return false
	}
	if expected, hasSum := sums[asset.Name]; hasSum && !strings.EqualFold(actualSHA, expected) {
		return false
	}
	cmd := exec.CommandContext(ctx, codeCLI, "--install-extension", vsixPath, "--force")
	return cmd.Run() == nil
}

func daemonRestartCommand() *exec.Cmd {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		plistPath := filepath.Join(home, "Library", "LaunchAgents", "io.dupe.local.plist")
		if _, err := os.Stat(plistPath); err == nil {
			domainTarget := fmt.Sprintf("gui/%d/io.dupe.local", os.Getuid())
			script := fmt.Sprintf(
				`sleep 0.4; launchctl kickstart -k %q >/dev/null 2>&1 || { launchctl bootout gui/%d %q >/dev/null 2>&1 || true; launchctl bootstrap gui/%d %q >/dev/null 2>&1; }`,
				domainTarget, os.Getuid(), plistPath, os.Getuid(), plistPath,
			)
			return exec.Command("sh", "-c", script)
		}
	case "linux":
		if exec.Command("systemctl", "--user", "cat", "dupe-local.service").Run() == nil {
			return exec.Command("sh", "-c", "sleep 0.4; systemctl --user restart dupe-local.service")
		}
	}
	return nil
}

func restartInstalledDaemonSync() bool {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		plistPath := filepath.Join(home, "Library", "LaunchAgents", "io.dupe.local.plist")
		if _, err := os.Stat(plistPath); err == nil {
			domainTarget := fmt.Sprintf("gui/%d/io.dupe.local", os.Getuid())
			if exec.Command("launchctl", "kickstart", "-k", domainTarget).Run() == nil {
				return true
			}
			_ = exec.Command("launchctl", "bootout", fmt.Sprintf("gui/%d", os.Getuid()), plistPath).Run()
			return exec.Command("launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), plistPath).Run() == nil
		}
	case "linux":
		if exec.Command("systemctl", "--user", "cat", "dupe-local.service").Run() == nil {
			return exec.Command("systemctl", "--user", "restart", "dupe-local.service").Run() == nil
		}
	}
	return false
}

func checkForReleaseUpdate(ctx context.Context, client *http.Client, currentVer, targetVer string) (*UpdateCheckResult, *releaseMetadata, error) {
	rel, err := fetchGitHubRelease(ctx, client, targetVer)
	if err != nil {
		return nil, nil, err
	}
	_, _, _, isBrew := resolveDupeInstallPaths()
	method := "binary"
	if isBrew {
		method = "homebrew"
	}
	cur := normalizeSemver(currentVer)
	latest := normalizeSemver(rel.TagName)
	avail := compareSemver(cur, latest) < 0
	return &UpdateCheckResult{
		CurrentVersion:  cur,
		LatestVersion:   latest,
		UpdateAvailable: avail,
		ReleaseURL:      rel.HTMLURL,
		ReleaseNotes:    strings.TrimSpace(rel.Body),
		InstallMethod:   method,
		CheckedAt:       time.Now().UTC().Format(time.RFC3339),
	}, rel, nil
}

func performSelfUpdate(ctx context.Context, client *http.Client, opts updateOptions) (*UpdateApplyResult, error) {
	currentVer := opts.CurrentVer
	if strings.TrimSpace(currentVer) == "" {
		currentVer = appVersion
	}
	chk, rel, err := checkForReleaseUpdate(ctx, client, currentVer, opts.TargetVersion)
	if err != nil {
		return nil, err
	}
	if !opts.Force && opts.TargetVersion == "" && !chk.UpdateAvailable {
		return &UpdateApplyResult{
			Status:          "up_to_date",
			PreviousVersion: chk.CurrentVersion,
			Version:         chk.LatestVersion,
			Method:          chk.InstallMethod,
			Message:         fmt.Sprintf("dupe is already up to date (%s).", chk.CurrentVersion),
		}, nil
	}

	installDir, binDir, _, isBrew := resolveDupeInstallPaths()
	if opts.InstallDir != "" {
		installDir = opts.InstallDir
		isBrew = false
	}
	if opts.BinDir != "" {
		binDir = opts.BinDir
	}

	tmpDir, err := os.MkdirTemp("", "dupe-update-*")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	sums, _ := fetchReleaseSHA256Sums(ctx, client, rel)

	if isBrew && opts.InstallDir == "" {
		if brewBin, bErr := exec.LookPath("brew"); bErr == nil {
			_ = exec.CommandContext(ctx, brewBin, "update").Run()
			upCmd := exec.CommandContext(ctx, brewBin, "upgrade", "dupe")
			if out, uErr := upCmd.CombinedOutput(); uErr != nil {
				return nil, fmt.Errorf("homebrew upgrade failed: %w (%s)", uErr, strings.TrimSpace(string(out)))
			}
			extUpdated := installVSCodeExtensionAsset(ctx, client, rel, sums, tmpDir)
			herdrUpdated := false
			installer := filepath.Join(installDir, "herdr", "install_herdr_dupe.sh")
			if _, iErr := os.Stat(installer); iErr == nil {
				if exec.Command("bash", installer).Run() == nil {
					herdrUpdated = true
				}
			}
			restarted := false
			if !opts.NoRestart && !opts.InsideHTTP {
				restarted = exec.Command(brewBin, "services", "restart", "dupe").Run() == nil
			}
			return &UpdateApplyResult{
				Status:           "updated",
				PreviousVersion:  chk.CurrentVersion,
				Version:          chk.LatestVersion,
				Method:           "homebrew",
				ExtensionUpdated: extUpdated,
				HerdrUpdated:     herdrUpdated,
				Restarting:       restarted,
				Message:          fmt.Sprintf("Updated dupe via Homebrew to %s.", chk.LatestVersion),
			}, nil
		}
	}

	assetName := fmt.Sprintf("dupe-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	asset, ok := findReleaseAsset(rel, assetName)
	if !ok {
		return nil, fmt.Errorf("release %s missing asset %s", rel.TagName, assetName)
	}
	tarPath := filepath.Join(tmpDir, assetName)
	actualSHA, err := downloadFileToTemp(ctx, client, asset.BrowserDownloadURL, tarPath)
	if err != nil {
		return nil, err
	}
	if expected, hasSum := sums[assetName]; hasSum && !strings.EqualFold(actualSHA, expected) {
		return nil, fmt.Errorf("checksum mismatch for %s (got %s, expected %s)", assetName, actualSHA, expected)
	}

	stageDir := filepath.Join(tmpDir, "extract")
	if err := extractTarGzSafe(tarPath, stageDir); err != nil {
		return nil, fmt.Errorf("extract release bundle: %w", err)
	}
	stageDupe := filepath.Join(stageDir, "dupe")
	herdrUpdated, err := installExtractedBundle(stageDupe, installDir, binDir)
	if err != nil {
		return nil, err
	}
	extUpdated := installVSCodeExtensionAsset(ctx, client, rel, sums, tmpDir)

	restarting := false
	if !opts.NoRestart && !opts.InsideHTTP {
		restarting = restartInstalledDaemonSync()
	}

	return &UpdateApplyResult{
		Status:           "updated",
		PreviousVersion:  chk.CurrentVersion,
		Version:          chk.LatestVersion,
		Method:           "binary",
		ExtensionUpdated: extUpdated,
		HerdrUpdated:     herdrUpdated,
		Restarting:       restarting,
		Message:          fmt.Sprintf("Updated dupe from %s to %s.", chk.CurrentVersion, chk.LatestVersion),
	}, nil
}

func runUpdateCLI(args []string) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	targetVer := fs.String("version", "", "Target release tag (e.g. v0.4.4)")
	checkOnly := fs.Bool("check", false, "Only check if a newer release exists")
	force := fs.Bool("force", false, "Reinstall even if already on target version")
	noRestart := fs.Bool("no-restart", false, "Do not restart the background daemon after updating")
	if err := fs.Parse(args); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	client := &http.Client{Timeout: 60 * time.Second}

	if *checkOnly {
		chk, _, err := checkForReleaseUpdate(ctx, client, appVersion, *targetVer)
		if err != nil {
			return err
		}
		if chk.UpdateAvailable {
			fmt.Printf("Update available: %s -> %s (%s)\n", chk.CurrentVersion, chk.LatestVersion, chk.ReleaseURL)
		} else {
			fmt.Printf("dupe is up to date (%s)\n", chk.CurrentVersion)
		}
		return nil
	}

	res, err := performSelfUpdate(ctx, client, updateOptions{
		TargetVersion: *targetVer,
		Force:         *force,
		NoRestart:     *noRestart,
	})
	if err != nil {
		return err
	}
	fmt.Println(res.Message)
	if res.HerdrUpdated {
		fmt.Println("  - Updated herdr templates and skills")
	}
	if res.ExtensionUpdated {
		fmt.Println("  - Updated dupe-studio VS Code extension")
	}
	if res.Restarting {
		fmt.Println("  - Restarted local dupe daemon")
	}
	return nil
}

func (s *Server) handleCheckLocalUpdate(w http.ResponseWriter, r *http.Request) {
	if s.mode != "local" {
		writeError(w, http.StatusForbidden, "local update endpoints are disabled in hosted mode")
		return
	}
	forceRefresh := r.URL.Query().Get("refresh") == "1"
	s.updateCacheMu.Lock()
	cached := s.updateCachedResult
	cacheAge := time.Since(s.updateCacheAt)
	s.updateCacheMu.Unlock()

	if !forceRefresh && cached != nil && cacheAge < 6*time.Hour {
		writeJSON(w, http.StatusOK, cached)
		return
	}

	client := &http.Client{Timeout: 15 * time.Second}
	res, _, err := checkForReleaseUpdate(r.Context(), client, appVersion, "")
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	s.updateCacheMu.Lock()
	s.updateCachedResult = res
	s.updateCacheAt = time.Now()
	s.updateCacheMu.Unlock()

	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleApplyLocalUpdate(w http.ResponseWriter, r *http.Request) {
	if s.mode != "local" {
		writeError(w, http.StatusForbidden, "local update endpoints are disabled in hosted mode")
		return
	}
	var payload struct {
		Version string `json:"version"`
		Force   bool   `json:"force"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&payload)
	}

	client := &http.Client{Timeout: 60 * time.Second}
	res, err := performSelfUpdate(r.Context(), client, updateOptions{
		TargetVersion: payload.Version,
		Force:         payload.Force,
		NoRestart:     s.skipUpdateRestart,
		InsideHTTP:    true,
		InstallDir:    s.updateInstallDir,
		BinDir:        s.updateBinDir,
	})
	if err != nil {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}

	s.updateCacheMu.Lock()
	s.updateCachedResult = nil
	s.updateCachedResult = &UpdateCheckResult{
		CurrentVersion:  res.Version,
		LatestVersion:   res.Version,
		UpdateAvailable: false,
		InstallMethod:   res.Method,
		CheckedAt:       time.Now().UTC().Format(time.RFC3339),
	}
	s.updateCacheAt = time.Now()
	s.updateCacheMu.Unlock()

	var restartCmd *exec.Cmd
	if res.Status == "updated" && !s.skipUpdateRestart {
		restartCmd = daemonRestartCommand()
		if restartCmd != nil {
			res.Restarting = true
		}
	}

	writeJSON(w, http.StatusOK, res)

	if restartCmd != nil {
		_ = restartCmd.Start()
	}
}
