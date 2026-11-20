package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
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
	meta, err := srv.runExtractMeta(context.Background(), "/nonexistent/paper.pdf", "My_Paper_2025.pdf", true)
	if err == nil {
		t.Fatal("expected error for missing PDF path")
	}
	if meta.Title != "My_Paper_2025" {
		t.Fatalf("expected fallback title My_Paper_2025, got %s", meta.Title)
	}
}

func TestEndToEndUploadAndGitSync(t *testing.T) {
	allowLocalGitRemotesForTesting = true
	defer func() { allowLocalGitRemotesForTesting = false }()
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
		projectsDir:   filepath.Join(storageDir, "projects"),
		mode:          "hosted",
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

	// 5. Phase 3: Create Project Folder, verify AGENTS.md + refs/text + Git diff status & revert
	createProjReq, _ := http.NewRequest(
		http.MethodPost,
		ts.URL+"/api/projects",
		strings.NewReader(`{"name":"Phase 3 Test Project","overleaf_remote":"`+bareRemote+`"}`),
	)
	createProjReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	createProjReq.Header.Set("Content-Type", "application/json")
	createProjResp, err := http.DefaultClient.Do(createProjReq)
	if err != nil {
		t.Fatalf("create project failed: %v", err)
	}
	defer func() { _ = createProjResp.Body.Close() }()
	if createProjResp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201 on create project, got %d", createProjResp.StatusCode)
	}
	var projCfg ProjectConfig
	if err := json.NewDecoder(createProjResp.Body).Decode(&projCfg); err != nil {
		t.Fatalf("decode project config: %v", err)
	}

	// Modify paper/main.tex and verify Git Status badge 'M' and head_content diff
	writeProjFileBody := `{"path":"paper/main.tex","content":"\\documentclass{article}\n\\begin{document}\nEdited line \\cite{vaswani2017attention}\n\\end{document}\n"}`
	writeProjReq, _ := http.NewRequest(
		http.MethodPut,
		ts.URL+"/api/projects/"+projCfg.ID+"/file",
		strings.NewReader(writeProjFileBody),
	)
	writeProjReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	writeProjReq.Header.Set("Content-Type", "application/json")
	writeProjResp, err := http.DefaultClient.Do(writeProjReq)
	if err != nil {
		t.Fatalf("write project file failed: %v", err)
	}
	_ = writeProjResp.Body.Close()

	treeReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/projects/"+projCfg.ID+"/tree", nil)
	treeReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	treeResp, err := http.DefaultClient.Do(treeReq)
	if err != nil {
		t.Fatalf("get project tree failed: %v", err)
	}
	defer func() { _ = treeResp.Body.Close() }()
	var treeData struct {
		Files []ProjectTreeEntry `json:"files"`
	}
	if err := json.NewDecoder(treeResp.Body).Decode(&treeData); err != nil {
		t.Fatalf("decode tree: %v", err)
	}
	foundModifiedMainTex := false
	foundExtractedRefMd := false
	for _, f := range treeData.Files {
		if f.Path == "paper/main.tex" && f.GitStatus == "M" {
			foundModifiedMainTex = true
		}
		if f.Path == "refs/text/vaswani2017attention.md" {
			foundExtractedRefMd = true
		}
	}
	if !foundModifiedMainTex {
		t.Fatalf("expected paper/main.tex to have GitStatus 'M' in tree: %+v", treeData.Files)
	}
	if !foundExtractedRefMd {
		t.Fatalf("expected refs/text/vaswani2017attention.md in tree: %+v", treeData.Files)
	}

	// 6. Phase 4: Library Changes API
	changesReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/library/changes?since=2020-01-01T00:00:00Z", nil)
	changesReq.Header.Set("Authorization", "Bearer "+loginRes.Token)
	changesResp, err := http.DefaultClient.Do(changesReq)
	if err != nil {
		t.Fatalf("library changes request failed: %v", err)
	}
	defer func() { _ = changesResp.Body.Close() }()
	var changesData LibraryChangesResponse
	if err := json.NewDecoder(changesResp.Body).Decode(&changesData); err != nil {
		t.Fatalf("decode library changes: %v", err)
	}
	if len(changesData.Papers) == 0 {
		t.Fatal("expected at least 1 paper in library changes response")
	}

	// 7. Phase 5: MCP Server stdio protocol (initialize, tools/list, search_papers, get_bibtex, read_paper)
	mcpInput := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_bibtex","arguments":{"key":"vaswani2017attention"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_paper","arguments":{"key":"vaswani2017attention"}}}`,
	}, "\n") + "\n"
	var mcpOutput bytes.Buffer
	if err := srv.runMCPServer(ctx, loginRes.User.ID, loginRes.User.Username, strings.NewReader(mcpInput), &mcpOutput); err != nil {
		t.Fatalf("runMCPServer failed: %v", err)
	}
	mcpLines := strings.Split(strings.TrimSpace(mcpOutput.String()), "\n")
	if len(mcpLines) != 4 {
		t.Fatalf("expected 4 MCP responses, got %d: %s", len(mcpLines), mcpOutput.String())
	}
	if !strings.Contains(mcpLines[2], "@article{vaswani2017attention") {
		t.Fatalf("expected get_bibtex MCP response to contain BibTeX, got %s", mcpLines[2])
	}
	if !strings.Contains(mcpLines[3], "Attention Is All You Need") {
		t.Fatalf("expected read_paper MCP response to contain paper text, got %s", mcpLines[3])
	}
}

func TestCommentsAndGatherContext(t *testing.T) {
	projDir := t.TempDir()
	paperDir := filepath.Join(projDir, "paper")
	notesDir := filepath.Join(projDir, "notes")
	_ = os.MkdirAll(paperDir, 0o755)
	_ = os.MkdirAll(notesDir, 0o755)

	mainTex := filepath.Join(paperDir, "main.tex")
	_ = os.WriteFile(mainTex, []byte("\\section{Intro}\nWe evaluate on three benchmarks.\n"), 0o644)

	newBlock := "- [ ] **[2026-11-19 13:00] `paper/main.tex` (line 2)**\n  > \"We evaluate on three benchmarks.\"\n  **Comment:** Add the fourth ablation benchmark."
	open, addressed, md := parseAndReconcileComments(projDir, newBlock)
	if len(open) != 1 || len(addressed) != 0 {
		t.Fatalf("expected 1 open and 0 addressed comments, got open=%d addressed=%d", len(open), len(addressed))
	}
	if !strings.Contains(md, "## Open Comments") || !strings.Contains(md, "Add the fourth ablation benchmark.") {
		t.Fatalf("unexpected comments.md: %s", md)
	}

	// Modify the quoted text in paper/main.tex and verify auto-resolution
	_ = os.WriteFile(mainTex, []byte("\\section{Intro}\nWe evaluate on four ablation benchmarks.\n"), 0o644)
	open2, addressed2, _ := parseAndReconcileComments(projDir, "")
	if len(open2) != 0 || len(addressed2) != 1 {
		t.Fatalf("expected auto-resolved comment (0 open, 1 addressed), got open=%d addressed=%d", len(open2), len(addressed2))
	}

	cfg := ProjectConfig{
		ID:             "11111111-1111-4111-8111-111111111111",
		Name:           "Test Paper",
		FolderName:     "test-paper",
		OverleafRemote: "git@github.com:user/paper.git",
		CodeRemote:     "git@github.com:user/code.git",
	}
	agentsMD := buildProjectAgentsMD(context.Background(), projDir, cfg, nil, true)
	for _, section := range []string{
		"## 1. Project Summary",
		"## 2. Project Structure",
		"## 3. Rules for Agents",
		"## 4. Current Context",
		"### Recently Addressed Comments",
	} {
		if !strings.Contains(agentsMD, section) {
			t.Fatalf("expected AGENTS.md to contain %q, got:\n%s", section, agentsMD)
		}
	}
}

func TestSecurityAllowlistRateLimitAndSQLiteSync(t *testing.T) {
	allowLocalGitRemotesForTesting = false

	validRemotes := []string{
		"https://github.com/Dinoclaro/dupe.git",
		"git@github.com:Dinoclaro/dupe.git",
		"https://git.overleaf.com/654321abcdef",
		"https://git:olp_token123@git.overleaf.com/654321abcdef",
	}
	for _, u := range validRemotes {
		if err := validateRemoteURL(u); err != nil {
			t.Fatalf("expected valid remote URL %q, got error: %v", u, err)
		}
	}

	invalidRemotes := []string{
		"/etc/passwd",
		"file:///home/dino/repo",
		"ext::sh -c touch%20/tmp/pwn",
		"http://127.0.0.1:8080/repo.git",
		"https://github.com/../../etc/passwd",
		"-u ./payload",
	}
	for _, u := range invalidRemotes {
		if err := validateRemoteURL(u); err == nil {
			t.Fatalf("expected invalid remote URL %q to be rejected", u)
		}
	}

	// Verify login rate limiter blocks after 8 failures and clears on success
	testIP := "203.0.113.99"
	now := time.Now().UTC()
	clearLoginFailures(testIP)
	for i := 0; i < 8; i++ {
		if !checkLoginRateLimit(testIP, now) {
			t.Fatalf("expected rate limit to allow attempt %d", i+1)
		}
		recordLoginFailure(testIP, now)
	}
	if checkLoginRateLimit(testIP, now) {
		t.Fatal("expected IP to be locked out after 8 failed login attempts")
	}
	clearLoginFailures(testIP)
	if !checkLoginRateLimit(testIP, now) {
		t.Fatal("expected IP lockout to clear after clearLoginFailures")
	}

	// Verify local SQLite mode <-> hosted SQLite server sync cycle
	ctx := context.Background()
	hostedDir := t.TempDir()
	hostedDB, err := initSQLiteDB(ctx, filepath.Join(hostedDir, "hosted.db"))
	if err != nil {
		t.Fatalf("initSQLiteDB hosted: %v", err)
	}
	defer hostedDB.Close()
	_ = createOrUpdateUser(ctx, hostedDB, "dino", "strong-password-123", "#FFEB3B")

	hostedSrv := &Server{
		db:          hostedDB,
		jwtSecret:   []byte("test-secret-at-least-16-bytes-long"),
		storageDir:  hostedDir,
		projectsDir: filepath.Join(hostedDir, "projects"),
		mode:        "hosted",
	}
	_ = os.MkdirAll(filepath.Join(hostedDir, "pdfs"), 0o755)
	ts := httptest.NewServer(hostedSrv.routes())
	defer ts.Close()

	localDir := t.TempDir()
	localDB, err := initSQLiteDB(ctx, filepath.Join(localDir, "local.db"))
	if err != nil {
		t.Fatalf("initSQLiteDB local: %v", err)
	}
	defer localDB.Close()
	_ = createOrUpdateUser(ctx, localDB, "local", "local-mode-implicit-user", "#FFEB3B")
	_ = os.MkdirAll(filepath.Join(localDir, "pdfs"), 0o755)

	localSrv := &Server{
		db:          localDB,
		jwtSecret:   []byte("test-secret-at-least-16-bytes-long"),
		storageDir:  localDir,
		projectsDir: filepath.Join(localDir, "projects"),
		mode:        "local",
	}

	// Insert a paper & PDF blob on the local client and sync to the hosted server
	samplePDF := []byte("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n")
	sum := sha256.Sum256(samplePDF)
	hash := hex.EncodeToString(sum[:])
	_ = os.WriteFile(filepath.Join(localDir, "pdfs", hash+".pdf"), samplePDF, 0o644)
	paperID := "22222222-2222-4222-8222-222222222222"
	_, err = localDB.Exec(
		ctx,
		`INSERT INTO papers (id, owner_id, title, authors, bibtex_key, bibtex_raw, file_path, file_hash, updated_at)
		 VALUES ($1, 1, 'Sync Paper', 'Dino', 'dino2026sync', '@article{dino2026sync}', $2, $3, $4)`,
		paperID, "pdfs/"+hash+".pdf", hash, time.Now().UTC(),
	)
	if err != nil {
		t.Fatalf("insert local paper: %v", err)
	}

	token, _ := issueToken(hostedSrv.jwtSecret, 1, "dino", time.Now().UTC())
	summary, err := localSrv.runRemoteSyncCycle(ctx, RemoteSyncConfig{
		RemoteURL: ts.URL,
		Username:  "dino",
		Token:     token,
	})
	if err != nil {
		t.Fatalf("runRemoteSyncCycle failed: %v", err)
	}
	if summary["pushed_papers"] != 1 || summary["uploaded_blobs"] != 1 {
		t.Fatalf("expected 1 pushed paper and 1 uploaded blob, got %+v", summary)
	}
	if _, err := os.Stat(filepath.Join(hostedDir, "pdfs", hash+".pdf")); err != nil {
		t.Fatalf("expected PDF blob to exist on hosted server: %v", err)
	}
}

func TestParseTectonicDiagnosticsAndGzip(t *testing.T) {
	rawLog := strings.Join([]string{
		`(./experiments.tex`,
		`LaTeX Warning: Citation 'tarasov2022corl' on page 7 undefined on input line 148.`,
		`warning: experiments:159: Underfull \hbox (badness 4846) in paragraph at lines 158--159`,
		`! Undefined control sequence.`,
		`l.165 \undefinedcommandtest`,
		`error: ./experiments.tex:165: Undefined control sequence`,
		`error: halted on potentially-recoverable error as specified`,
		`warning: internal consistency problem when checking if conference_101719.bbl changed`,
	}, "\n")

	errs, warns := parseTectonicDiagnostics(rawLog, "conference_101719.tex")
	if len(errs) != 1 {
		t.Fatalf("expected 1 filtered error, got %d: %+v", len(errs), errs)
	}
	if errs[0].File != "experiments.tex" || errs[0].Line != 165 || errs[0].Context != `\undefinedcommandtest` {
		t.Fatalf("unexpected error diagnostic: %+v", errs[0])
	}
	if len(warns) != 2 {
		t.Fatalf("expected 2 warnings (citation + typography), got %d: %+v", len(warns), warns)
	}
	if warns[0].Category != "reference" || warns[0].Line != 148 || warns[0].File != "experiments.tex" {
		t.Fatalf("expected citation warning on experiments.tex:148, got %+v", warns[0])
	}
	if warns[1].Category != "typography" {
		t.Fatalf("expected typography warning category, got %+v", warns[1])
	}

	// Verify gzipMiddleware compresses JSON and skips PDFs
	handler := gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/projects/1/compiled.pdf" {
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF-1.4\n..."))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"hello":"world","data":"` + strings.Repeat("a", 200) + `"}`))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/projects/1/tree", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected gzip Content-Encoding on JSON, got %q", rec.Header().Get("Content-Encoding"))
	}
	gz, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader failed: %v", err)
	}
	decoded, _ := io.ReadAll(gz)
	_ = gz.Close()
	if !strings.Contains(string(decoded), `"hello":"world"`) {
		t.Fatalf("unexpected gunzipped body: %s", string(decoded))
	}

	pdfReq := httptest.NewRequest(http.MethodGet, "/api/projects/1/compiled.pdf", nil)
	pdfReq.Header.Set("Accept-Encoding", "gzip")
	pdfRec := httptest.NewRecorder()
	handler.ServeHTTP(pdfRec, pdfReq)
	if pdfRec.Header().Get("Content-Encoding") != "" {
		t.Fatalf("expected PDF to bypass gzip, got %q", pdfRec.Header().Get("Content-Encoding"))
	}
}





