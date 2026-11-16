package main

import (
	"bytes"
	"context"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPasswordHashAndVerify(t *testing.T) {
	if _, err := hashPassword("short"); err == nil {
		t.Fatal("expected error for short password")
	}
	hash, err := hashPassword("correct-horse-battery")
	if err != nil {
		t.Fatalf("unexpected hash error: %v", err)
	}
	if err := verifyPassword(hash, "correct-horse-battery"); err != nil {
		t.Fatalf("expected password verification to succeed: %v", err)
	}
	if err := verifyPassword(hash, "wrong-password"); err == nil {
		t.Fatal("expected password verification to fail for wrong password")
	}
}

func TestIssueAndParseJWT(t *testing.T) {
	secret := []byte("0123456789abcdef0123456789abcdef")
	now := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)

	token, err := issueToken(secret, 42, "dino", now)
	if err != nil {
		t.Fatalf("issueToken failed: %v", err)
	}
	claims, err := parseToken(secret, token)
	if err != nil {
		t.Fatalf("parseToken failed: %v", err)
	}
	if claims.UserID != 42 || claims.Username != "dino" {
		t.Fatalf("unexpected claims: %+v", claims)
	}

	if _, err := parseToken([]byte("wrong-secret-key-0123456789abcdef"), token); err == nil {
		t.Fatal("expected parseToken to fail with wrong secret")
	}
}

func TestSafeJoinPreventsTraversal(t *testing.T) {
	base := t.TempDir()

	valid, err := safeJoin(base, "figures/arch.svg")
	if err != nil {
		t.Fatalf("expected valid path, got error: %v", err)
	}
	if !strings.HasPrefix(valid, base) {
		t.Fatalf("expected path inside %s, got %s", base, valid)
	}

	invalidPaths := []string{
		"",
		".",
		"../secret.txt",
		"figures/../../etc/passwd",
		"/etc/passwd",
	}
	for _, p := range invalidPaths {
		if _, err := safeJoin(base, p); err == nil {
			t.Fatalf("expected safeJoin to reject %q", p)
		}
	}
}

func TestSaveUploadedPDFDeduplicatesBySHA256(t *testing.T) {
	storageDir := t.TempDir()
	srv := &Server{storageDir: storageDir}

	pdfBytes := []byte("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n")

	createMultipartFile := func(content []byte) multipart.File {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		part, err := writer.CreateFormFile("file", "paper.pdf")
		if err != nil {
			t.Fatalf("CreateFormFile: %v", err)
		}
		_, _ = part.Write(content)
		_ = writer.Close()

		req := httptest.NewRequest(http.MethodPost, "/api/papers/upload", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		if err := req.ParseMultipartForm(10 << 20); err != nil {
			t.Fatalf("ParseMultipartForm: %v", err)
		}
		f, _, err := req.FormFile("file")
		if err != nil {
			t.Fatalf("FormFile: %v", err)
		}
		return f
	}

	f1 := createMultipartFile(pdfBytes)
	relPath1, hash1, err := srv.saveUploadedPDF(f1)
	_ = f1.Close()
	if err != nil {
		t.Fatalf("first upload failed: %v", err)
	}

	f2 := createMultipartFile(pdfBytes)
	relPath2, hash2, err := srv.saveUploadedPDF(f2)
	_ = f2.Close()
	if err != nil {
		t.Fatalf("second upload failed: %v", err)
	}

	if hash1 != hash2 || relPath1 != relPath2 {
		t.Fatalf("expected identical hashes and paths, got (%s, %s) vs (%s, %s)", hash1, relPath1, hash2, relPath2)
	}

	entries, err := os.ReadDir(filepath.Join(storageDir, "pdfs"))
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 deduplicated PDF file on disk, found %d", len(entries))
	}

	badFile := createMultipartFile([]byte("not a pdf file"))
	_, _, err = srv.saveUploadedPDF(badFile)
	_ = badFile.Close()
	if err == nil {
		t.Fatal("expected non-PDF file to be rejected")
	}
}

func TestFallbackMetadataProducesValidBibtex(t *testing.T) {
	meta := fallbackMetadata("2024_Attention_Mechanism.pdf")
	if meta.Title != "2024_Attention_Mechanism" {
		t.Fatalf("unexpected title: %s", meta.Title)
	}
	if !strings.HasPrefix(meta.BibtexRaw, "@misc{") {
		t.Fatalf("unexpected bibtex_raw: %s", meta.BibtexRaw)
	}
}

func TestRunExtractMetaFallbackWhenFileMissing(t *testing.T) {
	srv := &Server{
		pythonBin:     resolveDefaultPath("../.venv/bin/python3", "python3"),
		extractScript: "../scripts/extract_meta.py",
		offlineMeta:   true,
	}
	meta, err := srv.runExtractMeta(context.Background(), "/nonexistent/paper.pdf", "My_Paper_2025.pdf")
	if err == nil {
		t.Fatal("expected error for missing PDF path")
	}
	if meta.Title != "My_Paper_2025" {
		t.Fatalf("expected fallback title My_Paper_2025, got %s", meta.Title)
	}
}

func TestEndToEndUploadAndGitSync(t *testing.T) {
	dbURL := envOrDefault("DATABASE_URL", "postgres://dupe:dupe_dev_password@127.0.0.1:5432/dupe?sslmode=disable")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	pool, err := initDB(ctx, dbURL)
	if err != nil {
		t.Skipf("skipping integration test because database is unavailable: %v", err)
	}
	defer pool.Close()

	testUser := "testuser_e2e"
	testPass := "strong-password-123"
	if err := createOrUpdateUser(ctx, pool, testUser, testPass, "#FFEB3B"); err != nil {
		t.Fatalf("createOrUpdateUser: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM users WHERE username = $1", testUser)
	}()

	storageDir := t.TempDir()
	pythonBin := resolveDefaultPath("../.venv/bin/python3", "python3")
	srv := &Server{
		db:            pool,
		jwtSecret:     []byte("test-jwt-secret-key-at-least-32-bytes"),
		storageDir:    storageDir,
		pythonBin:     pythonBin,
		extractScript: "../scripts/extract_meta.py",
		offlineMeta:   true,
	}
	ts := httptest.NewServer(srv.routes())
	defer ts.Close()

	// 1. Login
	loginBody := strings.NewReader(`{"username":"testuser_e2e","password":"strong-password-123"}`)
	resp, err := http.Post(ts.URL+"/api/auth/login", "application/json", loginBody)
	if err != nil {
		t.Fatalf("login request failed: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on login, got %d", resp.StatusCode)
	}
	var loginRes loginResponse
	if err := json.NewDecoder(resp.Body).Decode(&loginRes); err != nil {
		t.Fatalf("decode login response: %v", err)
	}

	// 2. Generate a real sample PDF via PyMuPDF and upload it
	samplePDFPath := filepath.Join(t.TempDir(), "attention.pdf")
	genCmd := exec.Command(pythonBin, "-c", `
import fitz
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 72), "Attention Is All You Need", fontsize=18)
page.insert_text((72, 110), "Ashish Vaswani, Noam Shazeer (2017)", fontsize=12)
page.insert_text((72, 140), "DOI: 10.48550/arXiv.1706.03762", fontsize=10)
doc.set_metadata({"author": "Ashish Vaswani, Noam Shazeer"})
doc.save("`+samplePDFPath+`")
doc.close()
`)
	if out, err := genCmd.CombinedOutput(); err != nil {
		t.Fatalf("generate sample PDF: %v (%s)", err, string(out))
	}
	pdfData, err := os.ReadFile(samplePDFPath)
	if err != nil {
		t.Fatalf("read sample PDF: %v", err)
	}

	var uploadBuf bytes.Buffer
	mw := multipart.NewWriter(&uploadBuf)
	fw, err := mw.CreateFormFile("file", "attention.pdf")
	if err != nil {
		t.Fatalf("CreateFormFile: %v", err)
	}
	_, _ = fw.Write(pdfData)
	_ = mw.Close()

	uploadReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/papers/upload", &uploadBuf)
	uploadReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	uploadReq.Header.Set("Content-Type", mw.FormDataContentType())
	uploadResp, err := http.DefaultClient.Do(uploadReq)
	if err != nil {
		t.Fatalf("upload request failed: %v", err)
	}
	defer func() { _ = uploadResp.Body.Close() }()
	if uploadResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 on upload, got %d", uploadResp.StatusCode)
	}
	var uploadedPaper Paper
	if err := json.NewDecoder(uploadResp.Body).Decode(&uploadedPaper); err != nil {
		t.Fatalf("decode uploaded paper: %v", err)
	}
	if uploadedPaper.BibtexKey != "vaswani2017attention" {
		t.Fatalf("expected bibtex_key vaswani2017attention, got %s", uploadedPaper.BibtexKey)
	}

	// 3. Create a bare remote git repository to simulate GitHub/Overleaf remote
	bareRemote := filepath.Join(t.TempDir(), "overleaf-paper.git")
	if _, err := runGitCommand(ctx, "", "init", "--bare", bareRemote); err != nil {
		t.Fatalf("git init --bare: %v", err)
	}

	createRepoBody, _ := json.Marshal(createRepoRequest{
		Name:        "my-overleaf-paper",
		RemoteURL:   bareRemote,
		BibFilePath: "references.bib",
		FiguresDir:  "figures",
	})
	repoReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/repos", bytes.NewReader(createRepoBody))
	repoReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	repoReq.Header.Set("Content-Type", "application/json")
	repoResp, err := http.DefaultClient.Do(repoReq)
	if err != nil {
		t.Fatalf("create repo request failed: %v", err)
	}
	defer func() { _ = repoResp.Body.Close() }()
	if repoResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 on create repo, got %d", repoResp.StatusCode)
	}
	var createdRepo GitRepo
	if err := json.NewDecoder(repoResp.Body).Decode(&createdRepo); err != nil {
		t.Fatalf("decode created repo: %v", err)
	}

	// 4. Sync the repository (writes references.bib, commits, and pushes to remote)
	syncReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/repos/"+createdRepo.ID+"/sync", strings.NewReader(`{}`))
	syncReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	syncReq.Header.Set("Content-Type", "application/json")
	syncResp, err := http.DefaultClient.Do(syncReq)
	if err != nil {
		t.Fatalf("sync repo request failed: %v", err)
	}
	defer func() { _ = syncResp.Body.Close() }()
	if syncResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on sync repo, got %d", syncResp.StatusCode)
	}
	var syncRes syncRepoResponse
	if err := json.NewDecoder(syncResp.Body).Decode(&syncRes); err != nil {
		t.Fatalf("decode sync response: %v", err)
	}
	if !syncRes.Committed || syncRes.BibEntries != 1 {
		t.Fatalf("expected committed=true and bib_entries=1, got %+v", syncRes)
	}
}


