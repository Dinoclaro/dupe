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

func TestLocalModeFolderWizardAndSymlink(t *testing.T) {
	ctx := context.Background()
	hostedDir := t.TempDir()
	hostedDB, err := initSQLiteDB(ctx, filepath.Join(hostedDir, "hosted.db"))
	if err != nil {
		t.Fatalf("initSQLiteDB hosted: %v", err)
	}
	defer hostedDB.Close()

	hostedSrv := &Server{
		db:          hostedDB,
		jwtSecret:   []byte("test-secret-at-least-16-bytes-long"),
		storageDir:  hostedDir,
		projectsDir: filepath.Join(hostedDir, "projects"),
		mode:        "hosted",
	}
	hostedHandler := hostedSrv.routes()
	token, _ := issueToken(hostedSrv.jwtSecret, 1, "dino", time.Now().UTC())

	// Hosted mode MUST reject local filesystem browse
	browseHostedReq := httptest.NewRequest(http.MethodGet, "/api/local/browse", nil)
	browseHostedReq.Header.Set("Authorization", "Bearer "+token)
	browseHostedRec := httptest.NewRecorder()
	hostedHandler.ServeHTTP(browseHostedRec, browseHostedReq)
	if browseHostedRec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for hosted /api/local/browse, got %d", browseHostedRec.Code)
	}

	// Hosted mode generates personalized setup.sh
	setupReq := httptest.NewRequest(http.MethodGet, "/api/local/setup.sh?projects=~/mimic_projects&autostart=1", nil)
	setupReq.Header.Set("Authorization", "Bearer "+token)
	setupReq.Host = "dupe.ing"
	setupRec := httptest.NewRecorder()
	hostedHandler.ServeHTTP(setupRec, setupReq)
	if setupRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for setup.sh, got %d", setupRec.Code)
	}
	setupBody := setupRec.Body.String()
	if !strings.Contains(setupBody, "$HOME/mimic_projects") || !strings.Contains(setupBody, "bundle.tar.gz") {
		t.Fatalf("unexpected setup.sh content: %s", setupBody)
	}

	// Local mode supports browse, set projects-root, and symlink linking
	localDir := t.TempDir()
	localDB, err := initSQLiteDB(ctx, filepath.Join(localDir, "local.db"))
	if err != nil {
		t.Fatalf("initSQLiteDB local: %v", err)
	}
	defer localDB.Close()
	_ = createOrUpdateUser(ctx, localDB, "local", "local-mode-implicit-user", "#FFEB3B")

	localSrv := &Server{
		db:          localDB,
		jwtSecret:   []byte("test-secret-at-least-16-bytes-long"),
		storageDir:  localDir,
		projectsDir: filepath.Join(localDir, "initial_projects"),
		mode:        "local",
	}
	localHandler := localSrv.routes()

	chosenRoot := filepath.Join(t.TempDir(), "mimic_workspace")
	rootReq := httptest.NewRequest(http.MethodPost, "/api/local/projects-root", strings.NewReader(`{"projects_dir":"`+chosenRoot+`"}`))
	rootReq.Header.Set("Content-Type", "application/json")
	rootRec := httptest.NewRecorder()
	localHandler.ServeHTTP(rootRec, rootReq)
	if rootRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for projects-root, got %d: %s", rootRec.Code, rootRec.Body.String())
	}
	if localSrv.getProjectsDir() != chosenRoot {
		t.Fatalf("expected projectsDir=%q, got %q", chosenRoot, localSrv.getProjectsDir())
	}

	// Existing LaTeX folder on disk gets symlinked into paper/ without moving source files
	existingTexDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(existingTexDir, "mimic.tex"), []byte(`\documentclass{article}\begin{document}Mimic\end{document}`), 0o644)

	linkPayload, _ := json.Marshal(map[string]string{
		"name":        "dinoMimic",
		"source_path": existingTexDir,
		"link_mode":   "symlink_paper",
	})
	linkReq := httptest.NewRequest(http.MethodPost, "/api/local/link-folder", bytes.NewReader(linkPayload))
	linkReq.Header.Set("Content-Type", "application/json")
	linkRec := httptest.NewRecorder()
	localHandler.ServeHTTP(linkRec, linkReq)
	if linkRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for link-folder, got %d: %s", linkRec.Code, linkRec.Body.String())
	}

	linkedPaperPath := filepath.Join(chosenRoot, "dinomimic", "paper")
	fi, lErr := os.Lstat(linkedPaperPath)
	if lErr != nil || fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected %s to be a symlink, err=%v", linkedPaperPath, lErr)
	}
	tree, treeErr := collectProjectTree(ctx, filepath.Join(chosenRoot, "dinomimic"))
	if treeErr != nil {
		t.Fatalf("collectProjectTree failed: %v", treeErr)
	}
	foundMimic := false
	for _, e := range tree {
		if e.Path == "paper/mimic.tex" {
			foundMimic = true
		}
	}
	if !foundMimic {
		t.Fatalf("expected paper/mimic.tex in symlinked tree, got %+v", tree)
	}

	var linkedCfg ProjectConfig
	_ = json.Unmarshal(linkRec.Body.Bytes(), &linkedCfg)

	existingCodeDir := t.TempDir()
	_ = os.WriteFile(filepath.Join(existingCodeDir, "Cargo.toml"), []byte("[package]\nname=\"mimic\"\n"), 0o644)
	_, hasTexFlag, hasCodeFlag, _ := inspectDirFlags(existingCodeDir)
	if hasTexFlag || !hasCodeFlag {
		t.Fatalf("expected hasTex=false, hasCode=true, got tex=%v code=%v", hasTexFlag, hasCodeFlag)
	}

	attachPayload, _ := json.Marshal(map[string]string{
		"source_path":       existingCodeDir,
		"link_mode":         "symlink_code",
		"target_project_id": linkedCfg.ID,
	})
	attachReq := httptest.NewRequest(http.MethodPost, "/api/local/link-folder", bytes.NewReader(attachPayload))
	attachReq.Header.Set("Content-Type", "application/json")
	attachRec := httptest.NewRecorder()
	localHandler.ServeHTTP(attachRec, attachReq)
	if attachRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for attach symlink_code, got %d: %s", attachRec.Code, attachRec.Body.String())
	}
	codeTarget, readLinkErr := os.Readlink(filepath.Join(chosenRoot, "dinomimic", "code"))
	if readLinkErr != nil || codeTarget != existingCodeDir {
		t.Fatalf("expected code symlink -> %q, got %q (err=%v)", existingCodeDir, codeTarget, readLinkErr)
	}
}

func TestAgentsUserSectionMultiSymlinkAndURLImport(t *testing.T) {
	ctx := context.Background()
	localDir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(localDir, "pdfs"), 0o755)
	localDB, err := initSQLiteDB(ctx, filepath.Join(localDir, "local.db"))
	if err != nil {
		t.Fatalf("initSQLiteDB: %v", err)
	}
	defer localDB.Close()
	_ = createOrUpdateUser(ctx, localDB, "local", "local-mode-implicit-user", "#FFEB3B")

	projectsRoot := filepath.Join(t.TempDir(), "projects")
	_ = os.MkdirAll(projectsRoot, 0o755)

	srv := &Server{
		db:          localDB,
		jwtSecret:   []byte("test-secret-at-least-16-bytes-long"),
		storageDir:  localDir,
		projectsDir: projectsRoot,
		mode:        "local",
		offlineMeta: true,
	}
	handler := srv.routes()

	// 1. Create a project and customize the preserved AGENTS.md user description block
	cfg, projDir, err := srv.createProjectOnDisk(ctx, 1, "local", "Multi Repo Study", "", "", true)
	if err != nil {
		t.Fatalf("createProjectOnDisk: %v", err)
	}
	agentsPath := filepath.Join(projDir, "AGENTS.md")
	initialAgents, err := os.ReadFile(agentsPath)
	if err != nil {
		t.Fatalf("read initial AGENTS.md: %v", err)
	}
	customBlock := agentsUserStartMarker + "\nCustom robot hardware & benchmark rules.\n" + agentsUserEndMarker
	updatedAgents := strings.Replace(
		string(initialAgents),
		agentsUserStartMarker+"\nAdd your project description, goals, or custom agent instructions here. `dupe` preserves everything inside these markers across regenerations.\n"+agentsUserEndMarker,
		customBlock,
		1,
	)
	_ = os.WriteFile(agentsPath, []byte(updatedAgents), 0o644)

	if err := srv.regenerateProjectArtifacts(ctx, projDir, 1, cfg); err != nil {
		t.Fatalf("regenerateProjectArtifacts: %v", err)
	}
	afterAgents, _ := os.ReadFile(agentsPath)
	if !strings.Contains(string(afterAgents), "Custom robot hardware & benchmark rules.") {
		t.Fatalf("expected user description block to survive regeneration, got:\n%s", string(afterAgents))
	}
	if !strings.Contains(string(afterAgents), "## 5. New Laptop Setup") || !strings.Contains(string(afterAgents), "/api/local/setup.sh?projects=") {
		t.Fatalf("expected AGENTS.md to include laptop setup section, got:\n%s", string(afterAgents))
	}

	// 2. Link multiple code repos and a paper subdir via as_subdir: true
	repoA := t.TempDir()
	repoB := t.TempDir()
	paperSub := t.TempDir()
	_ = os.WriteFile(filepath.Join(paperSub, "icra.tex"), []byte(`\documentclass{article}\begin{document}ICRA\end{document}`), 0o644)

	for _, body := range []map[string]any{
		{"name": "firmware", "source_path": repoA, "link_mode": "symlink_code", "target_project_id": cfg.ID, "as_subdir": true},
		{"name": "policy", "source_path": repoB, "link_mode": "symlink_code", "target_project_id": cfg.ID, "as_subdir": true},
		{"name": "icra2027", "source_path": paperSub, "link_mode": "symlink_paper", "target_project_id": cfg.ID, "as_subdir": true},
	} {
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, "/api/local/link-folder", bytes.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("link-folder %v failed: %d %s", body["name"], rec.Code, rec.Body.String())
		}
	}

	if gotA, err := os.Readlink(filepath.Join(projDir, "code", "firmware")); err != nil || gotA != repoA {
		t.Fatalf("expected code/firmware -> %q, got %q (err=%v)", repoA, gotA, err)
	}
	if gotB, err := os.Readlink(filepath.Join(projDir, "code", "policy")); err != nil || gotB != repoB {
		t.Fatalf("expected code/policy -> %q, got %q (err=%v)", repoB, gotB, err)
	}
	if gotP, err := os.Readlink(filepath.Join(projDir, "paper", "icra2027")); err != nil || gotP != paperSub {
		t.Fatalf("expected paper/icra2027 -> %q, got %q (err=%v)", paperSub, gotP, err)
	}
	_ = os.Remove(filepath.Join(projDir, "paper", "main.tex"))
	if foundRoot := findProjectRootTex(filepath.Join(projDir, "paper"), ""); foundRoot != "icra2027/icra.tex" {
		t.Fatalf("expected findProjectRootTex to find icra2027/icra.tex, got %q", foundRoot)
	}

	// 3. Import paper from HTML landing page containing citation_pdf_url
	if got := normalizePaperImportURL("2401.12345"); got != "https://arxiv.org/pdf/2401.12345.pdf" {
		t.Fatalf("unexpected arxiv normalization: %q", got)
	}
	mockSite := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/paper.pdf" {
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF-1.4\n% mock pdf bytes\n"))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte(`<html><head><meta name="citation_pdf_url" content="/paper.pdf"></head></html>`))
	}))
	defer mockSite.Close()

	impPayload, _ := json.Marshal(map[string]any{"url": mockSite.URL + "/article", "skip_network": true})
	impReq := httptest.NewRequest(http.MethodPost, "/api/papers/import-url", bytes.NewReader(impPayload))
	impReq.Header.Set("Content-Type", "application/json")
	impRec := httptest.NewRecorder()
	handler.ServeHTTP(impRec, impReq)
	if impRec.Code != http.StatusCreated {
		t.Fatalf("expected 201 for import-url, got %d: %s", impRec.Code, impRec.Body.String())
	}
	var imported Paper
	if err := json.Unmarshal(impRec.Body.Bytes(), &imported); err != nil {
		t.Fatalf("decode imported paper: %v", err)
	}
	if imported.FileHash == "" {
		t.Fatalf("expected valid file_hash on imported paper")
	}

	// 4. Verify multi-OS setup script supports macOS (launchd) and Linux (systemd)
	sReq := httptest.NewRequest(http.MethodGet, "/api/local/setup.sh?projects=~/dupe_pele", nil)
	sRec := httptest.NewRecorder()
	handler.ServeHTTP(sRec, sReq)
	if sRec.Code != http.StatusOK {
		t.Fatalf("expected 200 for /api/local/setup.sh, got %d", sRec.Code)
	}
	scriptBody := sRec.Body.String()
	for _, want := range []string{"darwin-arm64", "io.dupe.local.plist", "tectonic-0.15.0-aarch64-apple-darwin.tar.gz", "dupe-local.service"} {
		if !strings.Contains(scriptBody, want) {
			t.Fatalf("expected setup.sh to contain %q", want)
		}
	}
}

func TestTwoWayProjectNotesSyncExcludesDiagrams(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	// Setup simulated hosted server
	hostedStorage := t.TempDir()
	hostedDB, err := initSQLiteDB(ctx, filepath.Join(hostedStorage, "library.db"))
	if err != nil {
		t.Fatalf("init hosted sqlite: %v", err)
	}
	defer hostedDB.Close()
	_ = createOrUpdateUser(ctx, hostedDB, "alice", "strong-password-123", "#FFEB3B")

	jwtSecret := []byte("test-secret-at-least-32-bytes-long")
	hostedSrv := &Server{
		db:          hostedDB,
		jwtSecret:   jwtSecret,
		storageDir:  hostedStorage,
		projectsDir: filepath.Join(hostedStorage, "projects"),
		mode:        "hosted",
		offlineMeta: true,
	}
	ts := httptest.NewServer(hostedSrv.routes())
	defer ts.Close()

	token, err := issueToken(jwtSecret, 1, "alice", time.Now().UTC())
	if err != nil {
		t.Fatalf("issueToken: %v", err)
	}

	// Setup simulated laptop local server
	localStorage := t.TempDir()
	localDB, err := initSQLiteDB(ctx, filepath.Join(localStorage, "library.db"))
	if err != nil {
		t.Fatalf("init local sqlite: %v", err)
	}
	defer localDB.Close()
	_ = createOrUpdateUser(ctx, localDB, "local", "local-mode-implicit-user", "#FFEB3B")

	localProjectsRoot := t.TempDir()
	localSrv := &Server{
		db:          localDB,
		jwtSecret:   jwtSecret,
		storageDir:  localStorage,
		projectsDir: localProjectsRoot,
		mode:        "local",
		offlineMeta: true,
	}

	cfg, localProjDir, err := localSrv.createProjectOnDisk(ctx, 1, "local", "Robot Study", "", "", true)
	if err != nil {
		t.Fatalf("createProjectOnDisk: %v", err)
	}

	// Verify diagrams/ is not scaffolded on creation
	if _, err := os.Stat(filepath.Join(localProjDir, "diagrams")); !os.IsNotExist(err) {
		t.Fatalf("expected diagrams/ directory not to be created, stat err=%v", err)
	}

	// Create a local note and a leftover diagrams/ file (which must NOT sync)
	localNotePath := filepath.Join(localProjDir, "notes", "laptop-ideas.md")
	_ = os.WriteFile(localNotePath, []byte("# Laptop Ideas\n\nFirst draft from VS Code.\n"), 0o644)
	_ = os.MkdirAll(filepath.Join(localProjDir, "diagrams"), 0o755)
	_ = os.WriteFile(filepath.Join(localProjDir, "diagrams", "ignored.drawio.svg"), []byte("<svg/>"), 0o644)

	syncCfg := RemoteSyncConfig{RemoteURL: ts.URL, Token: token}
	res1, err := localSrv.runRemoteSyncCycle(ctx, syncCfg)
	if err != nil {
		t.Fatalf("first sync failed: %v", err)
	}
	if res1["synced_projects"] != 1 {
		t.Fatalf("expected 1 synced project, got %v", res1["synced_projects"])
	}

	remoteProjDir := filepath.Join(hostedStorage, "projects", "user_1", cfg.FolderName)
	if got, err := os.ReadFile(filepath.Join(remoteProjDir, "notes", "laptop-ideas.md")); err != nil || !strings.Contains(string(got), "First draft from VS Code") {
		t.Fatalf("expected laptop-ideas.md to be pushed to hosted, err=%v got=%q", err, string(got))
	}
	if _, err := os.Stat(filepath.Join(remoteProjDir, "diagrams", "ignored.drawio.svg")); !os.IsNotExist(err) {
		t.Fatalf("expected diagrams file not to sync, stat err=%v", err)
	}

	// Create a phone note on hosted and edit existing note on hosted
	_ = os.WriteFile(filepath.Join(remoteProjDir, "notes", "phone-note.md"), []byte("# Phone Note\n\nWritten on iPad.\n"), 0o644)
	_ = os.WriteFile(filepath.Join(remoteProjDir, "notes", "laptop-ideas.md"), []byte("# Laptop Ideas\n\nEdited on phone.\n"), 0o644)

	if _, err := localSrv.runRemoteSyncCycle(ctx, syncCfg); err != nil {
		t.Fatalf("second sync failed: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(localProjDir, "notes", "phone-note.md")); err != nil || !strings.Contains(string(got), "Written on iPad") {
		t.Fatalf("expected phone-note.md to be pulled locally, err=%v got=%q", err, string(got))
	}
	if got, err := os.ReadFile(localNotePath); err != nil || !strings.Contains(string(got), "Edited on phone") {
		t.Fatalf("expected remote edit to laptop-ideas.md to pull locally, err=%v got=%q", err, string(got))
	}

	// Delete phone-note.md locally and verify it deletes remotely on next sync
	_ = os.Remove(filepath.Join(localProjDir, "notes", "phone-note.md"))
	if _, err := localSrv.runRemoteSyncCycle(ctx, syncCfg); err != nil {
		t.Fatalf("third sync failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(remoteProjDir, "notes", "phone-note.md")); !os.IsNotExist(err) {
		t.Fatalf("expected local deletion of phone-note.md to propagate to hosted, stat err=%v", err)
	}
}






