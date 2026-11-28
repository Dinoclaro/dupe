package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"v0.4.3", "v0.4.4", -1},
		{"0.4.4", "v0.4.3", 1},
		{"v0.4.10", "v0.4.9", 1},
		{"v0.4.3", "0.4.3", 0},
		{"dev", "v0.1.0", -1},
		{"dev", "dev", 0},
	}
	for _, tc := range cases {
		if got := compareSemver(tc.a, tc.b); got != tc.want {
			t.Fatalf("compareSemver(%q, %q) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}

func buildSyntheticBundleTarGz(t *testing.T, serverBytes []byte, indexHTML string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	addFile := func(name string, data []byte, mode int64) {
		hdr := &tar.Header{Name: name, Size: int64(len(data)), Mode: mode}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatalf("write header %s: %v", name, err)
		}
		if _, err := tw.Write(data); err != nil {
			t.Fatalf("write body %s: %v", name, err)
		}
	}

	addFile("dupe/backend/server", serverBytes, 0o755)
	addFile("dupe/web/dist/index.html", []byte(indexHTML), 0o644)
	addFile("dupe/scripts/extract_meta.py", []byte("# extract\n"), 0o644)
	addFile("dupe/herdr/templates/dupe-code.md", []byte("# code template\n"), 0o644)

	if err := tw.Close(); err != nil {
		t.Fatalf("close tar: %v", err)
	}
	if err := gz.Close(); err != nil {
		t.Fatalf("close gz: %v", err)
	}
	raw := buf.Bytes()
	sum := sha256.Sum256(raw)
	return raw, hex.EncodeToString(sum[:])
}

func TestSelfUpdateCheckApplyAndChecksumValidation(t *testing.T) {
	tarName := fmt.Sprintf("dupe-%s-%s.tar.gz", runtime.GOOS, runtime.GOARCH)
	goodTar, goodSHA := buildSyntheticBundleTarGz(t, []byte("#!/bin/sh\necho new-binary\n"), "<html>v0.4.4</html>")

	serveChecksum := goodSHA
	var apiSrv *httptest.Server
	apiSrv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/Dinoclaro/dupe/releases/latest":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(releaseMetadata{
				TagName: "v0.4.4",
				HTMLURL: apiSrv.URL + "/releases/v0.4.4",
				Body:    "Release notes for v0.4.4",
				Assets: []githubReleaseAsset{
					{Name: tarName, BrowserDownloadURL: apiSrv.URL + "/download/" + tarName},
					{Name: "SHA256SUMS.txt", BrowserDownloadURL: apiSrv.URL + "/download/SHA256SUMS.txt"},
				},
			})
		case "/download/" + tarName:
			_, _ = w.Write(goodTar)
		case "/download/SHA256SUMS.txt":
			_, _ = fmt.Fprintf(w, "%s  %s\n", serveChecksum, tarName)
		default:
			http.NotFound(w, r)
		}
	}))
	defer apiSrv.Close()

	t.Setenv("DUPE_GITHUB_API", apiSrv.URL)

	prevVer := appVersion
	appVersion = "v0.4.3"
	defer func() { appVersion = prevVer }()

	tmpRoot := t.TempDir()
	installDir := filepath.Join(tmpRoot, "install")
	binDir := filepath.Join(tmpRoot, "bin")
	if err := os.MkdirAll(filepath.Join(installDir, "storage_local"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(installDir, "storage_local", "keep.db"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv := &Server{
		mode:              "local",
		skipUpdateRestart: true,
		updateInstallDir:  installDir,
		updateBinDir:      binDir,
	}

	// Verify check endpoint reports update_available.
	reqChk := httptest.NewRequest(http.MethodGet, "/api/local/update?refresh=1", nil)
	recChk := httptest.NewRecorder()
	srv.handleCheckLocalUpdate(recChk, reqChk)
	if recChk.Code != http.StatusOK {
		t.Fatalf("GET /api/local/update status %d: %s", recChk.Code, recChk.Body.String())
	}
	var chkResp UpdateCheckResult
	if err := json.Unmarshal(recChk.Body.Bytes(), &chkResp); err != nil {
		t.Fatal(err)
	}
	if !chkResp.UpdateAvailable || chkResp.LatestVersion != "v0.4.4" || chkResp.CurrentVersion != "v0.4.3" {
		t.Fatalf("unexpected check response: %+v", chkResp)
	}

	// Verify tampered checksum fails before touching installDir.
	serveChecksum = strings.Repeat("0", 64)
	reqBad := httptest.NewRequest(http.MethodPost, "/api/local/update", strings.NewReader(`{}`))
	recBad := httptest.NewRecorder()
	srv.handleApplyLocalUpdate(recBad, reqBad)
	if recBad.Code == http.StatusOK {
		t.Fatalf("expected checksum mismatch error, got 200")
	}
	if _, err := os.Stat(filepath.Join(installDir, "backend", "server")); !os.IsNotExist(err) {
		t.Fatalf("expected failed update not to create backend/server")
	}

	// Restore valid checksum and apply update via HTTP handler.
	serveChecksum = goodSHA
	reqApply := httptest.NewRequest(http.MethodPost, "/api/local/update", strings.NewReader(`{}`))
	recApply := httptest.NewRecorder()
	srv.handleApplyLocalUpdate(recApply, reqApply)
	if recApply.Code != http.StatusOK {
		t.Fatalf("POST /api/local/update status %d: %s", recApply.Code, recApply.Body.String())
	}
	var applyResp UpdateApplyResult
	if err := json.Unmarshal(recApply.Body.Bytes(), &applyResp); err != nil {
		t.Fatal(err)
	}
	if applyResp.Status != "updated" || applyResp.Version != "v0.4.4" {
		t.Fatalf("unexpected apply response: %+v", applyResp)
	}

	installedBin, err := os.ReadFile(filepath.Join(installDir, "backend", "server"))
	if err != nil || !strings.Contains(string(installedBin), "new-binary") {
		t.Fatalf("server binary was not installed cleanly: err=%v content=%q", err, string(installedBin))
	}
	installedWeb, err := os.ReadFile(filepath.Join(installDir, "web", "dist", "index.html"))
	if err != nil || string(installedWeb) != "<html>v0.4.4</html>" {
		t.Fatalf("web/dist/index.html was not updated: err=%v content=%q", err, string(installedWeb))
	}
	if _, err := os.Stat(filepath.Join(installDir, "storage_local", "keep.db")); err != nil {
		t.Fatalf("expected storage_local/keep.db to be preserved: %v", err)
	}
	linkTarget, err := os.Readlink(filepath.Join(binDir, "dupe"))
	if err != nil || linkTarget != filepath.Join(installDir, "backend", "server") {
		t.Fatalf("expected bin/dupe symlink to backend/server, got %q (err=%v)", linkTarget, err)
	}
}
