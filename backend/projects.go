package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

var projectSlugRegex = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

type LinkedCodeRepo struct {
	Subdir    string `json:"subdir,omitempty"`
	RemoteURL string `json:"remote_url"`
	Branch    string `json:"branch,omitempty"`
}

type ProjectConfig struct {
	ID             string           `json:"id"`
	Name           string           `json:"name"`
	FolderName     string           `json:"folder_name"`
	OverleafRemote string           `json:"overleaf_remote"`
	CodeRemote     string           `json:"code_remote,omitempty"`
	CodeRepos      []LinkedCodeRepo `json:"code_repos,omitempty"`
	LinkedPaperIDs []string         `json:"linked_paper_ids"`
	LinkAllPapers  bool             `json:"link_all_papers"`
	PendingPush    bool             `json:"pending_push"`
	LastSyncedAt   *string          `json:"last_synced_at,omitempty"`
	UpdatedAt      time.Time        `json:"updated_at"`
}

type ProjectTreeEntry struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	GitStatus string `json:"git_status,omitempty"`
	ModTime   string `json:"mod_time,omitempty"`
	SHA256    string `json:"sha256,omitempty"`
}

type RefIndexEntry struct {
	PaperID         string   `json:"paper_id"`
	BibtexKey       string   `json:"bibtex_key"`
	Title           string   `json:"title"`
	Authors         string   `json:"authors"`
	PublicationYear *int     `json:"publication_year"`
	DOI             string   `json:"doi"`
	Tags            []string `json:"tags"`
}

func sanitizeProjectFolderName(name string) string {
	trimmed := strings.TrimSpace(name)
	slug := strings.Trim(projectSlugRegex.ReplaceAllString(strings.ToLower(trimmed), "-"), "-")
	if slug == "" {
		return "project"
	}
	return slug
}

func normalizeOverleafRemote(rawRemote, gitToken string) string {
	cleaned := strings.TrimSpace(rawRemote)
	if strings.HasPrefix(strings.ToLower(cleaned), "git clone ") {
		cleaned = strings.TrimSpace(cleaned[len("git clone "):])
	}
	fields := strings.Fields(cleaned)
	if len(fields) > 0 {
		cleaned = fields[len(fields)-1]
	}
	token := strings.TrimSpace(gitToken)
	if token != "" && strings.Contains(cleaned, "git.overleaf.com/") {
		cleaned = strings.Replace(cleaned, "https://git@git.overleaf.com/", "https://git:"+token+"@git.overleaf.com/", 1)
		if !strings.Contains(cleaned, "@git.overleaf.com/") {
			cleaned = strings.Replace(cleaned, "https://git.overleaf.com/", "https://git:"+token+"@git.overleaf.com/", 1)
		}
	}
	return cleaned
}

func (s *Server) userProjectsRoot(userID int) string {
	if s.mode == "local" {
		return s.getProjectsDir()
	}
	return filepath.Join(s.storageDir, "projects", fmt.Sprintf("user_%d", userID))
}

func readProjectConfig(projectDir string) (ProjectConfig, error) {
	cfgPath := filepath.Join(projectDir, ".dupe", "project.json")
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		return ProjectConfig{}, err
	}
	var cfg ProjectConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return ProjectConfig{}, err
	}
	cfg.FolderName = filepath.Base(projectDir)
	if cfg.LinkedPaperIDs == nil {
		cfg.LinkedPaperIDs = []string{}
	}
	return cfg, nil
}

func writeProjectConfig(projectDir string, cfg ProjectConfig) error {
	dupeDir := filepath.Join(projectDir, ".dupe")
	if err := os.MkdirAll(dupeDir, 0o755); err != nil {
		return err
	}
	cfg.UpdatedAt = time.Now().UTC()
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dupeDir, "project.json"), append(data, '\n'), 0o644)
}

func initGitRepoIfNeeded(ctx context.Context, dir, username string) {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		return
	}
	_, _ = runGitCommand(ctx, dir, "init", "-b", "main")
	if username == "" {
		username = "dupe"
	}
	_, _ = runGitCommand(ctx, dir, "config", "user.name", username)
	_, _ = runGitCommand(ctx, dir, "config", "user.email", username+"@dupe.local")
}

func commitAllIfDirty(ctx context.Context, dir, message string) (bool, string, error) {
	status, err := runGitCommand(ctx, dir, "status", "--porcelain")
	if err != nil {
		return false, "", err
	}
	if strings.TrimSpace(status) == "" {
		sha, _ := runGitCommand(ctx, dir, "rev-parse", "HEAD")
		return false, sha, nil
	}
	if _, err := runGitCommand(ctx, dir, "add", "-A"); err != nil {
		return false, "", err
	}
	if _, err := runGitCommand(ctx, dir, "commit", "-m", message); err != nil {
		return false, "", err
	}
	sha, _ := runGitCommand(ctx, dir, "rev-parse", "HEAD")
	return true, sha, nil
}

var commentTargetBacktickRegex = regexp.MustCompile("`([^`]+)`")

func parseAndReconcileComments(projDir string, prependOpenBlock string) ([]string, []string, string) {
	return parseCommentsInternal(projDir, prependOpenBlock, true)
}

func readCommentsWithoutWriting(projDir string) ([]string, []string) {
	open, addressed, _ := parseCommentsInternal(projDir, "", false)
	return open, addressed
}

func parseCommentsInternal(projDir string, prependOpenBlock string, writeToDisk bool) ([]string, []string, string) {
	commentsPath := filepath.Join(projDir, "notes", "comments.md")
	rawBytes, _ := os.ReadFile(commentsPath)
	raw := strings.ReplaceAll(string(rawBytes), "\r\n", "\n")

	var openBlocks []string
	var addressedBlocks []string
	var customLines []string
	if strings.TrimSpace(prependOpenBlock) != "" {
		openBlocks = append(openBlocks, strings.TrimSpace(prependOpenBlock))
	}

	lines := strings.Split(raw, "\n")
	var currentBlock []string
	currentIsOpen := true
	inBlock := false

	flushBlock := func() {
		if !inBlock || len(currentBlock) == 0 {
			return
		}
		blockText := strings.TrimSpace(strings.Join(currentBlock, "\n"))
		if blockText == "" {
			return
		}
		isOpen := currentIsOpen
		if isOpen {
			// Auto-resolve if the quoted text in a local project file was modified or removed.
			firstLine := currentBlock[0]
			var quoteLines []string
			for _, l := range currentBlock[1:] {
				trimmed := strings.TrimSpace(l)
				if strings.HasPrefix(trimmed, ">") {
					q := strings.TrimSpace(strings.TrimPrefix(trimmed, ">"))
					q = strings.Trim(q, "\"")
					if q != "" {
						quoteLines = append(quoteLines, q)
					}
				}
			}
			quoteText := strings.TrimSpace(strings.Join(quoteLines, "\n"))
			quoteText = strings.TrimSuffix(quoteText, "…")
			quoteText = strings.TrimSpace(quoteText)
			if matches := commentTargetBacktickRegex.FindStringSubmatch(firstLine); len(matches) > 1 && len(quoteText) >= 8 {
				targetRel := strings.TrimSpace(matches[1])
				if (strings.HasPrefix(targetRel, "paper/") || strings.HasPrefix(targetRel, "notes/")) && targetRel != "notes/comments.md" {
					if targetAbs, err := safeJoin(projDir, targetRel); err == nil {
						if fileBytes, readErr := os.ReadFile(targetAbs); readErr == nil {
							normFile := strings.Join(strings.Fields(string(fileBytes)), " ")
							normQuote := strings.Join(strings.Fields(quoteText), " ")
							if !strings.Contains(normFile, normQuote) {
								isOpen = false
								blockText = "- [x] " + strings.TrimPrefix(blockText, "- [ ] ")
							}
						}
					}
				}
			}
		}
		if isOpen {
			openBlocks = append(openBlocks, blockText)
		} else {
			if strings.HasPrefix(blockText, "- [ ] ") {
				blockText = "- [x] " + strings.TrimPrefix(blockText, "- [ ] ")
			}
			addressedBlocks = append(addressedBlocks, blockText)
		}
		currentBlock = nil
		inBlock = false
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "- [ ] ") {
			flushBlock()
			inBlock = true
			currentIsOpen = true
			currentBlock = []string{trimmed}
			continue
		}
		if strings.HasPrefix(trimmed, "- [x] ") || strings.HasPrefix(trimmed, "- [X] ") {
			flushBlock()
			inBlock = true
			currentIsOpen = false
			currentBlock = []string{"- [x] " + strings.TrimSpace(trimmed[6:])}
			continue
		}
		if trimmed == "# Project Comments & Annotations" ||
			trimmed == "## Open Comments" ||
			trimmed == "## Addressed Comments" ||
			trimmed == "## Notes" ||
			trimmed == "_No open comments._" ||
			trimmed == "_No addressed comments yet._" {
			flushBlock()
			continue
		}
		if inBlock {
			if trimmed == "" || strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "\t") || strings.HasPrefix(trimmed, ">") || strings.HasPrefix(trimmed, "**Comment:**") {
				currentBlock = append(currentBlock, line)
				continue
			}
			flushBlock()
		}
		if trimmed != "" {
			customLines = append(customLines, line)
		}
	}
	flushBlock()

	var b strings.Builder
	b.WriteString("# Project Comments & Annotations\n\n")
	if len(customLines) > 0 {
		b.WriteString("## Notes\n\n")
		for _, cl := range customLines {
			b.WriteString(cl + "\n")
		}
		b.WriteString("\n")
	}
	b.WriteString("## Open Comments\n\n")
	if len(openBlocks) == 0 {
		b.WriteString("_No open comments._\n\n")
	} else {
		for _, blk := range openBlocks {
			b.WriteString(blk + "\n\n")
		}
	}
	b.WriteString("## Addressed Comments\n\n")
	if len(addressedBlocks) == 0 {
		b.WriteString("_No addressed comments yet._\n")
	} else {
		for _, blk := range addressedBlocks {
			b.WriteString(blk + "\n\n")
		}
	}

	formatted := strings.TrimRight(b.String(), "\n") + "\n"
	if writeToDisk && (len(openBlocks) > 0 || len(addressedBlocks) > 0 || len(customLines) > 0 || len(rawBytes) > 0) {
		if len(rawBytes) > 0 && strings.TrimSpace(string(rawBytes)) != strings.TrimSpace(formatted) {
			histDir := filepath.Join(projDir, ".dupe", "notes_history")
			_ = os.MkdirAll(histDir, 0o755)
			stamp := time.Now().UTC().Format("20060102T150405Z")
			_ = os.WriteFile(filepath.Join(histDir, fmt.Sprintf("comments.md.%s.bak.md", stamp)), rawBytes, 0o644)
		}
		_ = os.MkdirAll(filepath.Join(projDir, "notes"), 0o755)
		_ = os.WriteFile(commentsPath, []byte(formatted), 0o644)
	}
	return openBlocks, addressedBlocks, formatted
}

func summarizeGitRepoContext(ctx context.Context, dir, label string) string {
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		return ""
	}
	logOut, _ := runGitCommand(ctx, dir, "log", "-n", "5", "--oneline")
	statusOut, _ := runGitCommand(ctx, dir, "status", "-s")
	if strings.TrimSpace(logOut) == "" && strings.TrimSpace(statusOut) == "" {
		return ""
	}
	var b strings.Builder
	b.WriteString(fmt.Sprintf("- **%s**:\n", label))
	if strings.TrimSpace(logOut) != "" {
		for _, l := range strings.Split(strings.TrimSpace(logOut), "\n") {
			b.WriteString(fmt.Sprintf("  - commit `%s`\n", strings.TrimSpace(l)))
		}
	}
	if strings.TrimSpace(statusOut) != "" {
		for _, l := range strings.Split(strings.TrimSpace(statusOut), "\n") {
			b.WriteString(fmt.Sprintf("  - status `%s`\n", strings.TrimSpace(l)))
		}
	}
	return b.String()
}

var latexSectionRegex = regexp.MustCompile(`\\section\*?\{([^}]+)\}`)
var latexAbstractRegex = regexp.MustCompile(`(?s)\\begin\{abstract\}(.*?)\\end\{abstract\}`)

func cleanLatexSnippetForSummary(raw string) string {
	var kept []string
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "%") {
			continue
		}
		if idx := strings.Index(trimmed, " %"); idx != -1 {
			trimmed = strings.TrimSpace(trimmed[:idx])
		}
		if trimmed != "" {
			kept = append(kept, trimmed)
		}
	}
	joined := strings.Join(kept, " ")
	joined = strings.Join(strings.Fields(joined), " ")
	if len(joined) > 650 {
		joined = strings.TrimSpace(joined[:650]) + "…"
	}
	return joined
}

func extractPaperSummaryFromDisk(projectDir string) (string, []string, []string, []string) {
	paperDir := filepath.Join(projectDir, "paper")
	abstractText := ""
	if absBytes, err := os.ReadFile(filepath.Join(paperDir, "abstract.tex")); err == nil {
		abstractText = cleanLatexSnippetForSummary(string(absBytes))
	}

	var sections []string
	seenSec := make(map[string]bool)
	if entries, err := os.ReadDir(paperDir); err == nil {
		for _, de := range entries {
			if de.IsDir() || !strings.HasSuffix(de.Name(), ".tex") {
				continue
			}
			rawBytes, rErr := os.ReadFile(filepath.Join(paperDir, de.Name()))
			if rErr != nil {
				continue
			}
			txt := string(rawBytes)
			if abstractText == "" {
				if m := latexAbstractRegex.FindStringSubmatch(txt); len(m) > 1 {
					abstractText = cleanLatexSnippetForSummary(m[1])
				}
			}
			for _, m := range latexSectionRegex.FindAllStringSubmatch(txt, -1) {
				sec := strings.TrimSpace(m[1])
				if sec != "" && !seenSec[sec] {
					seenSec[sec] = true
					sections = append(sections, sec)
				}
			}
		}
	}

	var noteNames []string
	notesDir := filepath.Join(projectDir, "notes")
	if entries, err := os.ReadDir(notesDir); err == nil {
		for _, de := range entries {
			if !de.IsDir() && strings.HasSuffix(de.Name(), ".md") && de.Name() != "comments.md" && de.Name() != agentsUserNoteName {
				noteNames = append(noteNames, "notes/"+de.Name())
			}
		}
	}
	sort.Strings(noteNames)

	var artifactNames []string
	artifactsDir := filepath.Join(notesDir, "artifacts")
	if entries, err := os.ReadDir(artifactsDir); err == nil {
		for _, de := range entries {
			if !de.IsDir() && strings.HasSuffix(de.Name(), ".md") {
				artifactNames = append(artifactNames, "notes/artifacts/"+de.Name())
			}
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(artifactNames)))
	return abstractText, sections, noteNames, artifactNames
}

const (
	agentsUserStartMarker = "<!-- dupe:user-description:start -->"
	agentsUserEndMarker   = "<!-- dupe:user-description:end -->"
	agentsUserPlaceholder = "Add your project description, goals, or custom agent instructions here. `dupe` preserves everything inside these markers across regenerations."
	// The user section is mirrored into notes/ because only notes/ is synced between machines;
	// AGENTS.md itself is regenerated locally on every machine.
	agentsUserNoteName = "AGENTS.user.md"
)

// resolveUserDescription returns the user section for AGENTS.md and keeps the synced
// notes/AGENTS.user.md mirror up to date. Whichever copy was modified last wins.
func resolveUserDescription(projectDir string) string {
	agentsPath := filepath.Join(projectDir, "AGENTS.md")
	notePath := filepath.Join(projectDir, "notes", agentsUserNoteName)

	agentsDesc := extractUserDescriptionFromAgentsMD(projectDir)
	if agentsDesc == agentsUserPlaceholder {
		agentsDesc = ""
	}

	noteRaw, noteErr := os.ReadFile(notePath)
	if noteErr != nil {
		if agentsDesc != "" {
			_ = os.MkdirAll(filepath.Dir(notePath), 0o755)
			_ = os.WriteFile(notePath, []byte(agentsDesc+"\n"), 0o644)
		}
		return agentsDesc
	}
	noteDesc := strings.TrimSpace(string(noteRaw))

	if agentsDesc != "" && agentsDesc != noteDesc {
		agentsStat, aErr := os.Stat(agentsPath)
		noteStat, nErr := os.Stat(notePath)
		if aErr == nil && nErr == nil && agentsStat.ModTime().After(noteStat.ModTime()) {
			_ = os.WriteFile(notePath, []byte(agentsDesc+"\n"), 0o644)
			return agentsDesc
		}
	}
	return noteDesc
}

func extractUserDescriptionFromAgentsMD(projectDir string) string {
	raw, err := os.ReadFile(filepath.Join(projectDir, "AGENTS.md"))
	if err != nil {
		return ""
	}
	text := string(raw)
	startIdx := strings.Index(text, agentsUserStartMarker)
	if startIdx == -1 {
		return ""
	}
	rest := text[startIdx+len(agentsUserStartMarker):]
	endIdx := strings.Index(rest, agentsUserEndMarker)
	if endIdx == -1 {
		return ""
	}
	return strings.TrimSpace(rest[:endIdx])
}

func collectLinkedSubdirTargets(parentDir string) []string {
	var targets []string
	if target, err := os.Readlink(parentDir); err == nil {
		targets = append(targets, target)
		return targets
	}
	entries, err := os.ReadDir(parentDir)
	if err != nil {
		return targets
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		subPath := filepath.Join(parentDir, entry.Name())
		if target, linkErr := os.Readlink(subPath); linkErr == nil {
			targets = append(targets, entry.Name()+" -> "+target)
			continue
		}
		if info, statErr := os.Stat(subPath); statErr == nil && info.IsDir() {
			if _, gitErr := os.Stat(filepath.Join(subPath, ".git")); gitErr == nil {
				targets = append(targets, entry.Name()+"/")
			}
		}
	}
	return targets
}

func summarizeContainerGitContext(ctx context.Context, parentDir, containerName string) string {
	var out strings.Builder
	out.WriteString(summarizeGitRepoContext(ctx, parentDir, containerName+"/"))
	if _, linkErr := os.Readlink(parentDir); linkErr == nil {
		return out.String()
	}
	entries, err := os.ReadDir(parentDir)
	if err != nil {
		return out.String()
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		subPath := filepath.Join(parentDir, entry.Name())
		if info, statErr := os.Stat(subPath); statErr == nil && info.IsDir() {
			out.WriteString(summarizeGitRepoContext(ctx, subPath, containerName+"/"+entry.Name()+"/"))
		}
	}
	return out.String()
}

type codeRepoHint struct {
	Subdir    string
	RemoteURL string
	Branch    string
}

func sanitizeRemoteURLForDocs(raw string) string {
	cleaned := strings.TrimSpace(raw)
	if strings.HasPrefix(cleaned, "https://") || strings.HasPrefix(cleaned, "http://") {
		if idx := strings.Index(cleaned, "://"); idx != -1 {
			scheme := cleaned[:idx+3]
			rest := cleaned[idx+3:]
			if at := strings.Index(rest, "@"); at != -1 {
				slash := strings.Index(rest, "/")
				if slash == -1 || at < slash {
					return scheme + rest[at+1:]
				}
			}
		}
	}
	return cleaned
}

func readGitBranchForRepo(ctx context.Context, repoDir string) string {
	out, err := runGitCommand(ctx, repoDir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return ""
	}
	branch := strings.TrimSpace(out)
	if branch == "" || branch == "HEAD" {
		return ""
	}
	return branch
}

func collectDiskCodeRepos(ctx context.Context, projectDir string) []LinkedCodeRepo {
	seen := make(map[string]bool)
	var repos []LinkedCodeRepo
	addRepo := func(subdir, remote, branch string) {
		clean := sanitizeRemoteURLForDocs(remote)
		if clean == "" {
			return
		}
		key := subdir + "|" + clean
		if seen[key] {
			return
		}
		seen[key] = true
		repos = append(repos, LinkedCodeRepo{
			Subdir:    subdir,
			RemoteURL: clean,
			Branch:    strings.TrimSpace(branch),
		})
	}

	codeDir := filepath.Join(projectDir, "code")
	if out, err := runGitCommand(ctx, codeDir, "remote", "get-url", "origin"); err == nil {
		addRepo("", out, readGitBranchForRepo(ctx, codeDir))
	}
	if entries, err := os.ReadDir(codeDir); err == nil {
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			subPath := filepath.Join(codeDir, entry.Name())
			if info, statErr := os.Stat(subPath); statErr == nil && info.IsDir() {
				if out, err := runGitCommand(ctx, subPath, "remote", "get-url", "origin"); err == nil {
					addRepo(entry.Name(), out, readGitBranchForRepo(ctx, subPath))
				}
			}
		}
	}
	sort.Slice(repos, func(i, j int) bool {
		return repos[i].Subdir < repos[j].Subdir
	})
	return repos
}

func codeReposEqual(a, b []LinkedCodeRepo) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func syncCodeReposMetadataFromDisk(ctx context.Context, projectDir string, cfg *ProjectConfig) bool {
	diskRepos := collectDiskCodeRepos(ctx, projectDir)
	if len(diskRepos) == 0 {
		return false
	}
	changed := !codeReposEqual(cfg.CodeRepos, diskRepos)
	cfg.CodeRepos = diskRepos
	if len(diskRepos) == 1 && diskRepos[0].Subdir == "" && cfg.CodeRemote == "" {
		cfg.CodeRemote = diskRepos[0].RemoteURL
		changed = true
	}
	return changed
}

func collectCodeRepoCloneHints(ctx context.Context, projectDir string, cfg ProjectConfig) []codeRepoHint {
	seen := make(map[string]bool)
	var hints []codeRepoHint
	addHint := func(subdir, remote, branch string) {
		clean := sanitizeRemoteURLForDocs(remote)
		if clean == "" {
			return
		}
		key := subdir + "|" + clean
		if seen[key] {
			return
		}
		seen[key] = true
		hints = append(hints, codeRepoHint{
			Subdir:    subdir,
			RemoteURL: clean,
			Branch:    strings.TrimSpace(branch),
		})
	}

	for _, r := range collectDiskCodeRepos(ctx, projectDir) {
		addHint(r.Subdir, r.RemoteURL, r.Branch)
	}
	for _, r := range cfg.CodeRepos {
		addHint(r.Subdir, r.RemoteURL, r.Branch)
	}
	if strings.TrimSpace(cfg.CodeRemote) != "" && len(hints) == 0 {
		addHint("", cfg.CodeRemote, "")
	}
	return hints
}

func cloneCodeReposIfEmpty(ctx context.Context, projectDir string, repos []LinkedCodeRepo, username string) {
	if len(repos) == 0 {
		return
	}
	codeDir := filepath.Join(projectDir, "code")
	if entries, err := os.ReadDir(codeDir); err == nil {
		for _, e := range entries {
			if !strings.HasPrefix(e.Name(), ".") {
				return
			}
		}
	}
	for _, repo := range repos {
		if strings.TrimSpace(repo.RemoteURL) == "" {
			continue
		}
		targetDir := codeDir
		if repo.Subdir != "" {
			if strings.Contains(repo.Subdir, "/") || strings.Contains(repo.Subdir, "\\") || strings.Contains(repo.Subdir, "..") {
				continue
			}
			targetDir = filepath.Join(codeDir, repo.Subdir)
		}
		if _, err := os.Stat(filepath.Join(targetDir, ".git")); err == nil {
			continue
		}
		if _, err := cloneGitRepoIntoDir(ctx, targetDir, repo.RemoteURL, username); err == nil && repo.Branch != "" {
			_, _ = runGitCommand(ctx, targetDir, "checkout", repo.Branch)
		}
	}
}

func writeSetupSection(ctx context.Context, b *strings.Builder, projectDir string, cfg ProjectConfig, syncRemoteURL string) {
	projectsDir := filepath.Dir(projectDir)
	projectsArg := "~/dupe_projects"
	if homeDir, err := os.UserHomeDir(); err == nil && homeDir != "" {
		if rel, rErr := filepath.Rel(homeDir, projectsDir); rErr == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, "..") && !strings.Contains(rel, "dupe/storage/projects") {
			projectsArg = "~/" + filepath.ToSlash(rel)
		}
	}
	projectRelPath := projectsArg + "/" + cfg.FolderName
	codeHints := collectCodeRepoCloneHints(ctx, projectDir, cfg)
	cleanRemote := strings.TrimRight(strings.TrimSpace(syncRemoteURL), "/")

	b.WriteString("\n## 5. New Laptop Setup\n\n")
	b.WriteString("Run these commands on a new Linux or macOS laptop to set up this project and the VS Code extension.\n\n")
	if cleanRemote != "" {
		b.WriteString("### 1. Install `dupe` Daemon and Sync Project Data\n\n")
		b.WriteString("```bash\n")
		b.WriteString(fmt.Sprintf("printf \"Username on %s: \" && read -r DUPE_USER\n", cleanRemote))
		b.WriteString("printf \"Password for %s: \" \"$DUPE_USER\" && stty -echo && read -r DUPE_PASS && stty echo && echo\n")
		b.WriteString("TOKEN=$(DUPE_USER=\"$DUPE_USER\" DUPE_PASS=\"$DUPE_PASS\" python3 -c 'import os,json; print(json.dumps({\"username\":os.environ[\"DUPE_USER\"],\"password\":os.environ[\"DUPE_PASS\"]}))' | \\\n")
		b.WriteString(fmt.Sprintf("  curl -fsS -X POST %s/api/auth/login -H 'Content-Type: application/json' --data-binary @- | \\\n", cleanRemote))
		b.WriteString("  python3 -c 'import sys,json; print(json.load(sys.stdin)[\"token\"])')\n")
		b.WriteString("unset DUPE_PASS\n\n")
		b.WriteString("curl -fsSL -H \"Authorization: Bearer $TOKEN\" \\\n")
		b.WriteString(fmt.Sprintf("  \"%s/api/local/setup.sh?projects=%s\" | bash\n", cleanRemote, projectsArg))
		b.WriteString("```\n\n")
		b.WriteString("This script pulls the PDF library, BibTeX entries, `notes/`, and the Overleaf `paper/` repository automatically.\n\n")
	} else {
		b.WriteString("### 1. Install `dupe` Local Binary & `dupe-studio` Extension\n\n")
		b.WriteString("```bash\n")
		b.WriteString("curl -fsSL https://raw.githubusercontent.com/Dinoclaro/dupe/main/install.sh | sh\n")
		b.WriteString(fmt.Sprintf("dupe init %s\n", projectRelPath))
		b.WriteString("```\n\n")
		b.WriteString("This installs `dupe`, Tectonic, Python PDF extraction, MCP configuration, and the `dupe-studio` VS Code extension from GitHub Releases.\n\n")
	}

	stepNum := 2
	if len(codeHints) > 0 {
		b.WriteString(fmt.Sprintf("### %d. Clone Linked Code Repositories\n\n", stepNum))
		b.WriteString("```bash\n")
		b.WriteString(fmt.Sprintf("mkdir -p %s/code && cd %s/code\n", projectRelPath, projectRelPath))
		for _, hint := range codeHints {
			branchFlag := ""
			if hint.Branch != "" {
				branchFlag = "-b " + hint.Branch + " "
			}
			if hint.Subdir == "" {
				b.WriteString(fmt.Sprintf("git clone %s%s .\n", branchFlag, hint.RemoteURL))
			} else {
				b.WriteString(fmt.Sprintf("git clone %s%s %s\n", branchFlag, hint.RemoteURL, hint.Subdir))
			}
		}
		b.WriteString("```\n\n")
		stepNum++
	}

	b.WriteString(fmt.Sprintf("### %d. Open in VS Code\n\n", stepNum))
	b.WriteString("```bash\n")
	b.WriteString(fmt.Sprintf("code %s\n", projectRelPath))
	b.WriteString("```\n\n")
	b.WriteString(fmt.Sprintf("When VS Code opens `%s`, click **Trust Folder** (or trust `%s`) so all tasks and full workspace features are enabled.\n\n", projectRelPath, projectsArg))
}

func buildProjectAgentsMD(ctx context.Context, projectDir string, cfg ProjectConfig, refs []RefIndexEntry, isLocalMode bool) string {
	return buildProjectAgentsMDWithSync(ctx, projectDir, cfg, refs, isLocalMode, "")
}

func buildProjectAgentsMDWithSync(ctx context.Context, projectDir string, cfg ProjectConfig, refs []RefIndexEntry, isLocalMode bool, syncRemoteURL string) string {
	openComments, addressedComments := readCommentsWithoutWriting(projectDir)
	customSummaryBytes, _ := os.ReadFile(filepath.Join(projectDir, ".dupe", "summary.md"))
	customSummary := strings.TrimSpace(string(customSummaryBytes))
	userDescription := resolveUserDescription(projectDir)
	abstractText, sections, noteNames, artifactNames := extractPaperSummaryFromDisk(projectDir)
	codeTargets := collectLinkedSubdirTargets(filepath.Join(projectDir, "code"))
	paperTargets := collectLinkedSubdirTargets(filepath.Join(projectDir, "paper"))

	var b strings.Builder
	b.WriteString(fmt.Sprintf("# AGENTS.md — %s\n\n", cfg.Name))
	b.WriteString(fmt.Sprintf("Generated by `dupe` (updated %s). Read this file before editing the project.\n\n", time.Now().UTC().Format("2006-01-02 15:04 UTC")))

	b.WriteString("## User Project Description\n\n")
	b.WriteString(agentsUserStartMarker + "\n")
	if userDescription != "" {
		b.WriteString(userDescription + "\n")
	} else {
		b.WriteString(agentsUserPlaceholder + "\n")
	}
	b.WriteString(agentsUserEndMarker + "\n\n")

	b.WriteString("## 1. Project Summary\n\n")
	if customSummary != "" {
		b.WriteString(customSummary + "\n\n")
	}
	if abstractText != "" {
		b.WriteString(fmt.Sprintf("**Manuscript Abstract:** %s\n\n", abstractText))
	}
	if len(sections) > 0 {
		b.WriteString(fmt.Sprintf("**Manuscript Sections:** %s\n\n", strings.Join(sections, " · ")))
	}
	b.WriteString(fmt.Sprintf("- **Project Name:** %s (`%s/`)\n", cfg.Name, cfg.FolderName))
	if strings.TrimSpace(cfg.OverleafRemote) != "" {
		b.WriteString(fmt.Sprintf("- **Manuscript Remote (`paper/`):** `%s`\n", cfg.OverleafRemote))
	}
	if strings.TrimSpace(cfg.CodeRemote) != "" {
		b.WriteString(fmt.Sprintf("- **Code Remote (`code/`):** `%s`\n", cfg.CodeRemote))
	}
	if len(paperTargets) > 0 {
		b.WriteString(fmt.Sprintf("- **Linked Paper Repos (`paper/`):** %s\n", strings.Join(paperTargets, ", ")))
	}
	if len(codeTargets) > 0 {
		b.WriteString(fmt.Sprintf("- **Linked Code Repos (`code/`):** %s\n", strings.Join(codeTargets, ", ")))
	}
	b.WriteString(fmt.Sprintf("- **Linked Reference Papers:** %d\n", len(refs)))
	if len(noteNames) > 0 {
		b.WriteString(fmt.Sprintf("- **Active Notes:** %s\n", strings.Join(noteNames, ", ")))
	}
	if len(artifactNames) > 0 {
		limit := len(artifactNames)
		if limit > 8 {
			limit = 8
		}
		b.WriteString(fmt.Sprintf("- **Recent Agent Artifacts:** %s\n", strings.Join(artifactNames[:limit], ", ")))
	}
	b.WriteString("\n")

	b.WriteString("## 2. Project Structure\n\n")
	b.WriteString("- `paper/`: Overleaf-linked LaTeX repository or linked paper subdirectories (`dupe_references.bib`, `figures/`).\n")
	b.WriteString("- `code/`: Linked code repository or subdirectories (edited in VS Code).\n")
	b.WriteString("- `notes/`: Curated human brain (`notes/concepts/<slug>.md`, `notes/comments.md`, research notes).\n")
	b.WriteString("- `notes/artifacts/`: Living feature/release documents (`<topic-or-release>.md`, updated in place rather than date-stamped one-offs).\n")
	b.WriteString("- `.dupe/brain/`: Gitignored agent blackboard (`topics/<slug>.md`) for messy brainstorming, hypotheses, and swarm handoffs.\n")
	b.WriteString("- `scratch/`: Temporary test scripts and experimental files inside this project (gitignored; never use `~/scratch` or `/tmp`).\n")
	b.WriteString("- `refs/index.json`: Metadata and BibTeX keys for linked reference papers.\n")
	b.WriteString("- `refs/text/<bibtex_key>.md`: Extracted full text of each reference paper.\n\n")

	b.WriteString("## 3. Rules for Agents\n\n")
	b.WriteString("- Edit LaTeX manuscripts in `paper/` and curated research notes in `notes/`.\n")
	b.WriteString("- Enforce project-local scratch: put all temporary scripts, logs, and experimental outputs in `<project>/scratch/`, never `~/scratch` or `/tmp`.\n")
	b.WriteString("- **Two-Zone Brain & Zero-Bloat Discipline:**\n")
	b.WriteString("  - Simple/routine tasks need NO new notes or artifacts: finish cleanly and give a brief summary in the terminal.\n")
	b.WriteString("  - Only use `.dupe/brain/` (`agent_brain_post` / `agent_brain_read`) when a task benefits from deeper brainstorming or multi-agent handoffs.\n")
	b.WriteString("  - Name living docs descriptively by feature or release (`notes/artifacts/<topic>.md`, updated in place — no date prefixes).\n")
	b.WriteString("  - Keep human-facing notes concise (<= 150 lines / <= 8 KB), preferring Mermaid diagrams over long prose and weaving `[[concept]]` or `[[paper:<bibtex_key>]]` naturally inline; never append manual link-list footers or filler tables (the Brain UI graphs links automatically).\n")
	b.WriteString("  - When a real finding matters, give a short terminal summary + direct links to the living artifact (or concept / blackboard if created).\n")
	b.WriteString("- Check **Open Comments** below (and `notes/comments.md`) for user annotations and tasks.\n")
	b.WriteString("- When you address an open comment (`- [ ]`), mark it `- [x]` and move it under `## Addressed Comments` in `notes/comments.md`.\n")
	b.WriteString("- When you address items in `notes/changes.md` or other feedback notes in `notes/`, mark them `- [x]` and move them under `## Addressed` at the bottom of that file.\n")
	b.WriteString("- Periodically update `.dupe/summary.md` (or call `update_project_summary`) with a concise 3-5 sentence summary of the project goal, current progress, and active focus.\n")
	b.WriteString("- Edit only inside `<!-- dupe:user-description:start -->` ... `<!-- dupe:user-description:end -->` in `AGENTS.md` (mirrored to the synced `notes/AGENTS.user.md`; the most recently edited copy wins); `dupe` regenerates all other sections, `paper/dupe_references.bib`, and `refs/`.\n")
	b.WriteString("- Cite linked papers in LaTeX with `\\cite{<bibtex_key>}` and in Markdown notes with `[[paper:<bibtex_key>]]`.\n\n")

	b.WriteString("## 4. Current Context\n\n")
	b.WriteString("### Open Comments (`notes/comments.md`)\n\n")
	if len(openComments) == 0 {
		b.WriteString("No open comments.\n\n")
	} else {
		limit := len(openComments)
		if limit > 10 {
			limit = 10
		}
		for i := 0; i < limit; i++ {
			b.WriteString(openComments[i] + "\n\n")
		}
	}

	if len(addressedComments) > 0 {
		b.WriteString("### Recently Addressed Comments\n\n")
		limit := len(addressedComments)
		if limit > 5 {
			limit = 5
		}
		for i := 0; i < limit; i++ {
			b.WriteString(addressedComments[i] + "\n\n")
		}
	}

	b.WriteString("### Recent Git Activity\n\n")
	paperGit := summarizeContainerGitContext(ctx, filepath.Join(projectDir, "paper"), "paper")
	codeGit := summarizeContainerGitContext(ctx, filepath.Join(projectDir, "code"), "code")
	rootGit := summarizeGitRepoContext(ctx, projectDir, "project root (notes)")
	if paperGit == "" && codeGit == "" && rootGit == "" {
		b.WriteString("No Git commits recorded yet.\n\n")
	} else {
		b.WriteString(paperGit + codeGit + rootGit + "\n")
	}

	b.WriteString("### Available Citation Keys\n\n")
	if len(refs) == 0 {
		b.WriteString("No papers linked yet.\n")
	} else {
		b.WriteString("| BibTeX Key | Year | Title | Authors |\n")
		b.WriteString("|---|---|---|---|\n")
		for _, r := range refs {
			yr := ""
			if r.PublicationYear != nil {
				yr = fmt.Sprintf("%d", *r.PublicationYear)
			}
			b.WriteString(fmt.Sprintf("| `%s` | %s | %s | %s |\n", r.BibtexKey, yr, r.Title, r.Authors))
		}
	}
	provResults, _ := checkProjectProvenance(ctx, projectDir)
	if len(provResults) > 0 {
		b.WriteString("\n### Code-to-Paper Provenance\n\n")
		b.WriteString("| Target | Source Script | Commit | Status |\n")
		b.WriteString("|---|---|---|---|\n")
		for _, pr := range provResults {
			shaShort := pr.GitSHA
			if len(shaShort) > 7 {
				shaShort = shaShort[:7]
			}
			b.WriteString(fmt.Sprintf("| `%s` | `%s` | `%s` | %s |\n", pr.TargetPath, pr.SourceScript, shaShort, pr.Status))
		}
		b.WriteString("\n")
	}

	brainGraph := buildProjectBrainGraph(ctx, projectDir, refs, BrainGraphOptions{IncludeAgentBrain: true})
	if brainGraph.Summary.CuratedNoteCount > 0 || brainGraph.Summary.ArtifactCount > 0 || len(brainGraph.Summary.BlackboardTopics) > 0 {
		b.WriteString("\n### Knowledge Brain Status\n\n")
		b.WriteString(fmt.Sprintf("- **Human Brain:** %d curated notes, %d artifacts, %d orphans, %d unresolved `[[links]]`, %d bloated (>%d lines)\n",
			brainGraph.Summary.CuratedNoteCount,
			brainGraph.Summary.ArtifactCount,
			brainGraph.Summary.OrphanCount,
			brainGraph.Summary.GhostCount,
			brainGraph.Summary.BloatedCount,
			curatedBrainMaxLines,
		))
		if len(brainGraph.Summary.TopHubs) > 0 {
			var hubLabels []string
			for i, h := range brainGraph.Summary.TopHubs {
				if i >= 5 {
					break
				}
				hubLabels = append(hubLabels, fmt.Sprintf("`%s` (%d)", h.Label, h.Backlinks))
			}
			b.WriteString("- **Top Hubs:** " + strings.Join(hubLabels, ", ") + "\n")
		}
		if len(brainGraph.Summary.Orphans) > 0 {
			limit := len(brainGraph.Summary.Orphans)
			if limit > 5 {
				limit = 5
			}
			b.WriteString("- **Orphan Notes (link these):** " + strings.Join(brainGraph.Summary.Orphans[:limit], ", ") + "\n")
		}
		if len(brainGraph.Summary.BlackboardTopics) > 0 {
			b.WriteString("- **Agent Blackboard Topics (`.dupe/brain/topics/`):** " + strings.Join(brainGraph.Summary.BlackboardTopics, ", ") + "\n")
		}
		b.WriteString("\n")
	}

	writeSetupSection(ctx, &b, projectDir, cfg, syncRemoteURL)
	return b.String()
}

func (s *Server) extractFullTextMarkdownWithErr(ctx context.Context, pdfAbsPath string) (string, error) {
	var cachePath string
	if s.storageDir != "" {
		stem := strings.TrimSuffix(filepath.Base(pdfAbsPath), filepath.Ext(pdfAbsPath))
		if stem != "" {
			cachePath = filepath.Join(s.storageDir, "text", stem+".md")
			if cached, err := os.ReadFile(cachePath); err == nil {
				if trimmed := strings.TrimSpace(string(cached)); trimmed != "" {
					return trimmed, nil
				}
			}
		}
	}

	var pyErrDetail string
	if s.pythonBin != "" && s.extractScript != "" {
		ctxTimeout, cancel := context.WithTimeout(ctx, extractMetaTimeout)
		cmd := exec.CommandContext(ctxTimeout, s.pythonBin, s.extractScript, pdfAbsPath, "--extract-text")
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		runErr := cmd.Run()
		cancel()
		if runErr == nil {
			if text := strings.TrimSpace(stdout.String()); text != "" {
				if cachePath != "" {
					_ = os.MkdirAll(filepath.Dir(cachePath), 0o755)
					_ = os.WriteFile(cachePath, []byte(text+"\n"), 0o644)
				}
				return text, nil
			}
		} else {
			errMsg := strings.TrimSpace(stderr.String())
			if errMsg == "" {
				errMsg = runErr.Error()
			}
			pyErrDetail = fmt.Sprintf("python (%s): %s", s.pythonBin, errMsg)
		}
	} else {
		pyErrDetail = "pythonBin or extractScript not configured"
	}

	if pdftotextBin, lookErr := exec.LookPath("pdftotext"); lookErr == nil {
		ctxTimeout, cancel := context.WithTimeout(ctx, extractMetaTimeout)
		cmd := exec.CommandContext(ctxTimeout, pdftotextBin, "-layout", pdfAbsPath, "-")
		var stdout, stderr bytes.Buffer
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr
		runErr := cmd.Run()
		cancel()
		if runErr == nil {
			if text := strings.TrimSpace(stdout.String()); text != "" {
				if cachePath != "" {
					_ = os.MkdirAll(filepath.Dir(cachePath), 0o755)
					_ = os.WriteFile(cachePath, []byte(text+"\n"), 0o644)
				}
				return text, nil
			}
		}
	}

	return "", fmt.Errorf("PDF text extraction failed (%s); install PyMuPDF (`pip install PyMuPDF`) or poppler (`pdftotext`)", pyErrDetail)
}

func (s *Server) extractFullTextMarkdown(ctx context.Context, pdfAbsPath string) string {
	text, err := s.extractFullTextMarkdownWithErr(ctx, pdfAbsPath)
	if err != nil {
		return ""
	}
	return text
}

func (s *Server) queryLinkedPapersForProject(ctx context.Context, userID int, cfg ProjectConfig) ([]Paper, error) {
	const query = `
		SELECT p.id, p.owner_id, p.title, p.authors, p.publication_year, p.doi,
		       p.bibtex_key, p.bibtex_raw, p.file_path, p.file_hash, p.is_shared, p.updated_at,
		       COALESCE(
		           ARRAY_AGG(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL AND pt.deleted_at IS NULL),
		           '{}'
		       ) AS tags
		FROM papers p
		LEFT JOIN paper_tags pt ON pt.paper_id = p.id
		LEFT JOIN tags t ON t.id = pt.tag_id
		WHERE p.deleted_at IS NULL
		  AND (p.owner_id = $1 OR p.is_shared = TRUE)
		GROUP BY p.id
		ORDER BY p.bibtex_key ASC, p.updated_at DESC
	`
	rows, err := s.db.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	linkedSet := make(map[string]bool, len(cfg.LinkedPaperIDs))
	for _, id := range cfg.LinkedPaperIDs {
		linkedSet[id] = true
	}

	var result []Paper
	for rows.Next() {
		var p Paper
		if err := rows.Scan(
			&p.ID, &p.OwnerID, &p.Title, &p.Authors, &p.PublicationYear, &p.DOI,
			&p.BibtexKey, &p.BibtexRaw, &p.FilePath, &p.FileHash, &p.IsShared, &p.UpdatedAt, &p.Tags,
		); err != nil {
			return nil, err
		}
		if cfg.LinkAllPapers || len(linkedSet) == 0 || linkedSet[p.ID] {
			result = append(result, p)
		}
	}
	return result, nil
}

func writeFileIfChanged(path string, content []byte, perm os.FileMode) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, content) {
		return nil
	}
	return os.WriteFile(path, content, perm)
}

func untrackGitIgnoredFiles(ctx context.Context, repoDir string) {
	if _, err := os.Stat(filepath.Join(repoDir, ".git")); err != nil {
		return
	}
	out, err := runGitCommand(ctx, repoDir, "ls-files", "-c", "-i", "--exclude-standard")
	if err != nil || strings.TrimSpace(out) == "" {
		return
	}
	var tracked []string
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n") {
		p := strings.TrimSpace(line)
		if p != "" {
			tracked = append(tracked, p)
		}
	}
	if len(tracked) == 0 {
		return
	}
	args := append([]string{"rm", "-r", "--cached", "--ignore-unmatch", "--"}, tracked...)
	_, _ = runGitCommand(ctx, repoDir, args...)
}

func appendGitIgnoreEntries(giPath string, required []string) error {
	existingRaw, _ := os.ReadFile(giPath)
	seen := make(map[string]bool)
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(string(existingRaw), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !seen[trimmed] {
			seen[trimmed] = true
			lines = append(lines, trimmed)
		}
	}
	changed := false
	for _, entry := range required {
		if !seen[entry] {
			seen[entry] = true
			lines = append(lines, entry)
			changed = true
		}
	}
	if !changed && len(existingRaw) > 0 {
		return nil
	}
	return writeFileIfChanged(giPath, []byte(strings.Join(lines, "\n")+"\n"), 0o644)
}

func ensureProjectGitIgnore(projectDir string) error {
	required := []string{
		".vscode/",
		".dupe/build/",
		".dupe/notes_history/",
		".dupe/brain/",
		"paper/",
		"code/",
		"scratch/",
		"**/scratch/",
		"refs/*.pdf",
		".venv/",
		"venv/",
		"__pycache__/",
		"*.py[cod]",
		".pytest_cache/",
		"node_modules/",
		".DS_Store",
		"Thumbs.db",
		"*.log",
		"*.aux",
		"*.synctex.gz",
		"*.fdb_latexmk",
		"*.fls",
		"*.blg",
		"*.bbl",
		"*.toc",
		"*.out",
		"*.tmp",
		"*.swp",
	}
	giPath := filepath.Join(projectDir, ".gitignore")
	if err := appendGitIgnoreEntries(giPath, required); err != nil {
		return err
	}
	untrackGitIgnoredFiles(context.Background(), projectDir)
	return nil
}

func ensurePaperGitIgnore(paperDir string) {
	if _, err := os.Stat(paperDir); err != nil {
		return
	}
	_ = appendGitIgnoreEntries(filepath.Join(paperDir, ".gitignore"), []string{
		"*.aux",
		"*.log",
		"*.synctex.gz",
		"*.fdb_latexmk",
		"*.fls",
		"scratch/",
		".DS_Store",
	})
	untrackGitIgnoredFiles(context.Background(), paperDir)
}

func (s *Server) regenerateProjectArtifacts(ctx context.Context, projectDir string, userID int, cfg ProjectConfig) error {
	papers, err := s.queryLinkedPapersForProject(ctx, userID, cfg)
	if err != nil {
		return err
	}

	paperDir := filepath.Join(projectDir, "paper")
	figuresDir := filepath.Join(paperDir, "figures")
	codeDir := filepath.Join(projectDir, "code")
	notesDir := filepath.Join(projectDir, "notes")
	artifactsDir := filepath.Join(notesDir, "artifacts")
	scratchDir := filepath.Join(projectDir, "scratch")
	refsTextDir := filepath.Join(projectDir, "refs", "text")

	for _, d := range []string{paperDir, figuresDir, codeDir, notesDir, artifactsDir, scratchDir, refsTextDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	_ = ensureProjectGitIgnore(projectDir)
	_ = ensureAgentBrainInitialized(projectDir)

	var bibEntries []string
	seenKeys := make(map[string]bool)
	refsIndex := make([]RefIndexEntry, 0, len(papers))

	for _, p := range papers {
		key := strings.TrimSpace(p.BibtexKey)
		if key == "" {
			key = "paper_" + p.ID[:8]
		}
		if !seenKeys[key] && strings.TrimSpace(p.BibtexRaw) != "" {
			seenKeys[key] = true
			bibEntries = append(bibEntries, strings.TrimSpace(p.BibtexRaw))
		}
		refsIndex = append(refsIndex, RefIndexEntry{
			PaperID:         p.ID,
			BibtexKey:       key,
			Title:           p.Title,
			Authors:         p.Authors,
			PublicationYear: p.PublicationYear,
			DOI:             p.DOI,
			Tags:            p.Tags,
		})

		refMdPath := filepath.Join(refsTextDir, key+".md")
		if _, err := os.Stat(refMdPath); errors.Is(err, os.ErrNotExist) {
			header := fmt.Sprintf("# %s\n\n- **Authors:** %s\n- **BibTeX Key:** `%s`\n- **DOI:** %s\n\n", p.Title, p.Authors, key, p.DOI)
			bodyText := ""
			if len(papers) <= 5 {
				if pdfAbsPath, joinErr := safeJoin(s.storageDir, p.FilePath); joinErr == nil {
					bodyText = s.extractFullTextMarkdown(ctx, pdfAbsPath)
				}
			}
			if bodyText == "" {
				bodyText = "_Full text available via dupe MCP `read_paper` tool._"
			}
			_ = os.WriteFile(refMdPath, []byte(header+bodyText+"\n"), 0o644)
		}
	}

	bibContent := "% Generated by dupe from linked project papers\n\n" + strings.Join(bibEntries, "\n\n") + "\n"
	if err := writeFileIfChanged(filepath.Join(paperDir, "dupe_references.bib"), []byte(bibContent), 0o644); err != nil {
		return err
	}
	gitInfoDir := filepath.Join(paperDir, ".git", "info")
	if infoStat, statErr := os.Stat(gitInfoDir); statErr == nil && infoStat.IsDir() {
		excludePath := filepath.Join(gitInfoDir, "exclude")
		existingExclude, _ := os.ReadFile(excludePath)
		if !strings.Contains(string(existingExclude), "dupe_references.bib") {
			extraExclude := "\ndupe_references.bib\n*.synctex.gz\nTUptm.fd\nTUphv.fd\nTUpcr.fd\n"
			_ = os.WriteFile(excludePath, append(existingExclude, []byte(extraExclude)...), 0o644)
		}
	}

	idxBytes, err := json.MarshalIndent(refsIndex, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileIfChanged(filepath.Join(projectDir, "refs", "index.json"), append(idxBytes, '\n'), 0o644); err != nil {
		return err
	}

	if syncCodeReposMetadataFromDisk(ctx, projectDir, &cfg) {
		_ = writeProjectConfig(projectDir, cfg)
	}

	syncRemoteURL := s.loadRemoteSyncConfig().RemoteURL
	agentsMD := buildProjectAgentsMDWithSync(ctx, projectDir, cfg, refsIndex, s.mode == "local", syncRemoteURL)
	if err := writeFileIfChanged(filepath.Join(projectDir, "AGENTS.md"), []byte(agentsMD), 0o644); err != nil {
		return err
	}

	return nil
}

func (s *Server) initProjectInDir(ctx context.Context, userID int, username, rawDir string) (ProjectConfig, string, error) {
	absDir, err := filepath.Abs(expandUserHome(rawDir))
	if err != nil {
		return ProjectConfig{}, "", err
	}
	if err := os.MkdirAll(absDir, 0o755); err != nil {
		return ProjectConfig{}, "", err
	}

	cfg, readErr := readProjectConfig(absDir)
	if readErr != nil {
		projID := ""
		if s.db != nil {
			_ = s.db.QueryRow(ctx, "SELECT gen_random_uuid()::text").Scan(&projID)
		}
		if projID == "" || !isValidUUID(projID) {
			projID = fmt.Sprintf("00000000-0000-4000-8000-%012d", time.Now().UnixNano()%1000000000000)
		}
		paperRemote, _ := runGitCommand(ctx, filepath.Join(absDir, "paper"), "remote", "get-url", "origin")
		cfg = ProjectConfig{
			ID:             projID,
			Name:           filepath.Base(absDir),
			FolderName:     filepath.Base(absDir),
			OverleafRemote: sanitizeRemoteURLForDocs(paperRemote),
			LinkedPaperIDs: []string{},
			LinkAllPapers:  true,
		}
		if err := writeProjectConfig(absDir, cfg); err != nil {
			return ProjectConfig{}, "", err
		}
	}

	if err := ensureProjectGitIgnore(absDir); err != nil {
		return ProjectConfig{}, "", err
	}
	if err := s.regenerateProjectArtifacts(ctx, absDir, userID, cfg); err != nil {
		return ProjectConfig{}, "", err
	}
	initGitRepoIfNeeded(ctx, absDir, username)
	initGitRepoIfNeeded(ctx, filepath.Join(absDir, "paper"), username)

	// Remember parent folder in local_config.json so `dupe serve` discovers it automatically.
	parentRoot := filepath.Dir(absDir)
	lc := s.loadLocalConfig()
	if lc.ProjectsDir == "" {
		lc.ProjectsDir = parentRoot
	}
	lc.RecentProjectsDirs = appendUniqueDir(lc.RecentProjectsDirs, parentRoot)
	_ = s.saveLocalConfig(lc)

	if updatedCfg, cfgErr := readProjectConfig(absDir); cfgErr == nil {
		cfg = updatedCfg
	}
	return cfg, absDir, nil
}

func (s *Server) ensureDefaultProject(ctx context.Context, userID int, username string) (ProjectConfig, string, error) {
	root := s.userProjectsRoot(userID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return ProjectConfig{}, "", err
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return ProjectConfig{}, "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		projDir := filepath.Join(root, entry.Name())
		if cfg, err := readProjectConfig(projDir); err == nil {
			return cfg, projDir, nil
		}
	}

	return s.createProjectOnDisk(ctx, userID, username, "Default Paper Project", "", "", true)
}

func cloneGitRepoIntoDir(ctx context.Context, targetDir, remoteURL, username string) (string, error) {
	clean := strings.TrimSpace(remoteURL)
	if clean == "" {
		return "", nil
	}
	if _, err := runGitCommand(ctx, "", "clone", "--", clean, targetDir); err != nil {
		_ = os.RemoveAll(targetDir)
		sshURL := githubHTTPSFallbackToSSH(clean)
		if sshURL == "" {
			return clean, err
		}
		if _, sshErr := runGitCommand(ctx, "", "clone", "--", sshURL, targetDir); sshErr != nil {
			_ = os.RemoveAll(targetDir)
			return clean, err
		}
		clean = sshURL
	}
	initGitRepoIfNeeded(ctx, targetDir, username)
	return clean, nil
}

func (s *Server) createProjectOnDisk(
	ctx context.Context,
	userID int,
	username, name, overleafRemote, codeRemote string,
	linkAll bool,
) (ProjectConfig, string, error) {
	return s.createProjectOnDiskWithID(ctx, userID, username, "", "", name, overleafRemote, codeRemote, linkAll)
}

func (s *Server) createProjectOnDiskWithID(
	ctx context.Context,
	userID int,
	username, explicitID, explicitFolder, name, overleafRemote, codeRemote string,
	linkAll bool,
) (ProjectConfig, string, error) {
	root := s.userProjectsRoot(userID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return ProjectConfig{}, "", err
	}

	folderSlug := sanitizeProjectFolderName(name)
	cleanExplicitFolder := strings.TrimSpace(explicitFolder)
	if cleanExplicitFolder != "" && !strings.Contains(cleanExplicitFolder, "/") && !strings.Contains(cleanExplicitFolder, "\\") && !strings.Contains(cleanExplicitFolder, "..") && cleanExplicitFolder != "." {
		folderSlug = cleanExplicitFolder
	}
	projDir := filepath.Join(root, folderSlug)
	for suffix := 2; ; suffix++ {
		if _, err := os.Stat(projDir); errors.Is(err, os.ErrNotExist) {
			break
		}
		projDir = filepath.Join(root, fmt.Sprintf("%s-%d", folderSlug, suffix))
	}

	projID := strings.TrimSpace(explicitID)
	if projID == "" || !isValidUUID(projID) {
		if err := s.db.QueryRow(ctx, "SELECT gen_random_uuid()::text").Scan(&projID); err != nil {
			projID = fmt.Sprintf("00000000-0000-4000-8000-%012d", time.Now().UnixNano()%1000000000000)
		}
	}

	cfg := ProjectConfig{
		ID:             projID,
		Name:           strings.TrimSpace(name),
		FolderName:     filepath.Base(projDir),
		OverleafRemote: normalizeOverleafRemote(overleafRemote, ""),
		CodeRemote:     strings.TrimSpace(codeRemote),
		LinkedPaperIDs: []string{},
		LinkAllPapers:  linkAll,
	}

	paperDir := filepath.Join(projDir, "paper")
	if cfg.OverleafRemote != "" {
		if err := os.MkdirAll(projDir, 0o755); err != nil {
			return ProjectConfig{}, "", err
		}
		if resolved, cloneErr := cloneGitRepoIntoDir(ctx, paperDir, cfg.OverleafRemote, username); cloneErr == nil {
			cfg.OverleafRemote = resolved
		}
	}

	if s.mode == "local" && cfg.CodeRemote != "" {
		if err := os.MkdirAll(projDir, 0o755); err != nil {
			return ProjectConfig{}, "", err
		}
		codeDir := filepath.Join(projDir, "code")
		if resolved, cloneErr := cloneGitRepoIntoDir(ctx, codeDir, cfg.CodeRemote, username); cloneErr == nil {
			cfg.CodeRemote = resolved
		}
	}

	if err := writeProjectConfig(projDir, cfg); err != nil {
		return ProjectConfig{}, "", err
	}
	if err := ensureProjectGitIgnore(projDir); err != nil {
		return ProjectConfig{}, "", err
	}

	if err := s.regenerateProjectArtifacts(ctx, projDir, userID, cfg); err != nil {
		return ProjectConfig{}, "", err
	}

	hasTexFile := false
	if dirEntries, err := os.ReadDir(paperDir); err == nil {
		for _, de := range dirEntries {
			if !de.IsDir() && strings.HasSuffix(de.Name(), ".tex") {
				hasTexFile = true
				break
			}
		}
	}
	mainTexPath := filepath.Join(paperDir, "main.tex")
	if !hasTexFile {
		defaultTex := fmt.Sprintf(`\documentclass{article}
\title{%s}
\author{%s}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Manuscript managed in dupe with automatic BibTeX and Overleaf Git synchronization.
\end{abstract}

\section{Introduction}
Type @ or \cite{} to insert citations from your PDF library.

\bibliographystyle{plain}
\bibliography{dupe_references}
\end{document}
`, cfg.Name, username)
		_ = os.WriteFile(mainTexPath, []byte(defaultTex), 0o644)
	}

	notesFile := filepath.Join(projDir, "notes", "literature.md")
	if _, err := os.Stat(notesFile); errors.Is(err, os.ErrNotExist) {
		defaultNote := fmt.Sprintf("# %s — Literature Notes\n\nLink papers with `[[paper:bibtex_key]]` and write inline math with $E = mc^2$.\n", cfg.Name)
		_ = os.WriteFile(notesFile, []byte(defaultNote), 0o644)
	}

	initGitRepoIfNeeded(ctx, projDir, username)
	initGitRepoIfNeeded(ctx, paperDir, username)
	_, _, _ = commitAllIfDirty(ctx, projDir, "chore(dupe): initialize project workspace")
	_, _, _ = commitAllIfDirty(ctx, paperDir, "chore(dupe): initialize manuscript")

	return cfg, projDir, nil
}

func (s *Server) lookupProjectDir(ctx context.Context, userID int, projectID, username string) (ProjectConfig, string, error) {
	roots := []string{s.userProjectsRoot(userID)}
	if s.mode == "local" {
		lc := s.loadLocalConfig()
		if lc.ProjectsDir != "" {
			roots = append(roots, lc.ProjectsDir)
		}
		roots = append(roots, lc.RecentProjectsDirs...)
	}
	seenRoots := make(map[string]bool)
	for _, root := range roots {
		cleanRoot := filepath.Clean(root)
		if cleanRoot == "" || cleanRoot == "." || seenRoots[cleanRoot] {
			continue
		}
		seenRoots[cleanRoot] = true
		entries, err := os.ReadDir(cleanRoot)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			projDir := filepath.Join(cleanRoot, entry.Name())
			cfg, cfgErr := readProjectConfig(projDir)
			if cfgErr == nil && (cfg.ID == projectID || entry.Name() == projectID) {
				return cfg, projDir, nil
			}
		}
	}
	if projectID == "default" {
		return s.ensureDefaultProject(ctx, userID, username)
	}
	return ProjectConfig{}, "", os.ErrNotExist
}

func parseGitStatusMap(ctx context.Context, repoDir, prefix string) map[string]string {
	out, err := runGitCommand(ctx, repoDir, "status", "--porcelain")
	if err != nil || strings.TrimSpace(out) == "" {
		return map[string]string{}
	}
	result := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		code := fields[0]
		rel := strings.Trim(fields[len(fields)-1], `"`)
		fullRel := filepath.ToSlash(rel)
		if prefix != "" {
			fullRel = prefix + "/" + fullRel
		}
		if strings.Contains(code, "?") {
			result[fullRel] = "U"
		} else if code != "" {
			result[fullRel] = "M"
		}
	}
	return result
}

func classifyProjectFileKind(relSlash string) string {
	lower := strings.ToLower(relSlash)
	switch {
	case strings.HasSuffix(lower, ".tex"):
		return "tex"
	case strings.HasSuffix(lower, ".bib"):
		return "bib"
	case strings.HasSuffix(lower, ".md"):
		return "markdown"
	case strings.HasSuffix(lower, ".png") || strings.HasSuffix(lower, ".jpg") || strings.HasSuffix(lower, ".jpeg") || strings.HasSuffix(lower, ".gif") || strings.HasSuffix(lower, ".webp") || strings.HasSuffix(lower, ".pdf") || strings.HasSuffix(lower, ".svg"):
		return "asset"
	case strings.HasSuffix(lower, ".json"):
		return "json"
	default:
		return "other"
	}
}

func isIgnoredProjectDirName(name string) bool {
	switch name {
	case ".git", ".dupe", "code", "diagrams", "scratch", "node_modules", "__pycache__", "wandb", "logs", "results", ".vscode", ".github", "build", "dist", "assets":
		return true
	default:
		return strings.HasSuffix(name, ".egg-info")
	}
}

func isBinaryAssetExt(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".pt", ".pth", ".onnx", ".ckpt", ".npz", ".npy", ".pkl", ".usd", ".urdf", ".dae", ".stl", ".obj", ".mp4", ".mov", ".avi", ".pyc", ".so":
		return true
	default:
		return false
	}
}

func isVisibleProjectAsset(relSlash string) bool {
	ext := strings.ToLower(filepath.Ext(relSlash))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".svg":
		return strings.HasPrefix(relSlash, "paper/") || strings.HasPrefix(relSlash, "notes/")
	default:
		return true
	}
}

func computeFileSHA256Hex(absPath string) string {
	f, err := os.Open(absPath)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

func collectProjectTree(ctx context.Context, projectDir string) ([]ProjectTreeEntry, error) {
	rootStatus := parseGitStatusMap(ctx, projectDir, "")
	paperDir := filepath.Join(projectDir, "paper")
	paperStatus := parseGitStatusMap(ctx, paperDir, "paper")
	rootTexName := findProjectRootTex(paperDir, "")
	compiledRootPDFRel := "paper/" + strings.TrimSuffix(rootTexName, filepath.Ext(rootTexName)) + ".pdf"

	entries := make([]ProjectTreeEntry, 0)
	var walkFolder func(absRoot, relPrefix string, depth int) error
	walkFolder = func(absRoot, relPrefix string, depth int) error {
		if depth > 6 {
			return nil
		}
		dirItems, err := os.ReadDir(absRoot)
		if err != nil {
			return nil
		}
		for _, item := range dirItems {
			name := item.Name()
			if isIgnoredProjectDirName(name) {
				continue
			}
			fullPath := filepath.Join(absRoot, name)
			relSlash := name
			if relPrefix != "" {
				relSlash = relPrefix + "/" + name
			}

			info, statErr := os.Stat(fullPath)
			if statErr != nil {
				continue
			}
			if info.IsDir() {
				if err := walkFolder(fullPath, relSlash, depth+1); err != nil {
					return err
				}
				continue
			}
			if isBinaryAssetExt(name) || !isVisibleProjectAsset(relSlash) || relSlash == compiledRootPDFRel {
				continue
			}
			status := paperStatus[relSlash]
			if status == "" {
				status = rootStatus[relSlash]
			}
			var fileHash string
			if strings.HasPrefix(relSlash, "notes/") && info.Size() <= 20<<20 {
				fileHash = computeFileSHA256Hex(fullPath)
			}
			entries = append(entries, ProjectTreeEntry{
				Path:      relSlash,
				Kind:      classifyProjectFileKind(relSlash),
				GitStatus: status,
				ModTime:   info.ModTime().UTC().Format(time.RFC3339Nano),
				SHA256:    fileHash,
			})
		}
		return nil
	}

	if err := walkFolder(projectDir, "", 0); err != nil {
		return nil, err
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].Path < entries[j].Path
	})
	return entries, nil
}

func readHeadContentForProjectFile(ctx context.Context, projectDir, relSlash string) string {
	if strings.HasPrefix(relSlash, "paper/") {
		subRel := strings.TrimPrefix(relSlash, "paper/")
		out, err := runGitCommand(ctx, filepath.Join(projectDir, "paper"), "show", "HEAD:"+subRel)
		if err == nil {
			return out
		}
		return ""
	}
	out, err := runGitCommand(ctx, projectDir, "show", "HEAD:"+relSlash)
	if err == nil {
		return out
	}
	return ""
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	root := s.userProjectsRoot(claims.UserID)
	if err := os.MkdirAll(root, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create projects directory")
		return
	}
	dirEntries, err := os.ReadDir(root)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read projects directory")
		return
	}

	projects := make([]ProjectConfig, 0)
	for _, d := range dirEntries {
		if !d.IsDir() {
			continue
		}
		if cfg, cfgErr := readProjectConfig(filepath.Join(root, d.Name())); cfgErr == nil {
			projects = append(projects, cfg)
		}
	}
	writeJSON(w, http.StatusOK, projects)
}

type createProjectRequest struct {
	ID             string           `json:"id,omitempty"`
	FolderName     string           `json:"folder_name,omitempty"`
	Name           string           `json:"name"`
	OverleafRemote string           `json:"overleaf_remote"`
	CodeRemote     string           `json:"code_remote"`
	CodeRepos      []LinkedCodeRepo `json:"code_repos,omitempty"`
	LinkAllPapers  *bool            `json:"link_all_papers"`
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req createProjectRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "project name is required")
		return
	}
	if strings.TrimSpace(req.ID) != "" && !isValidUUID(req.ID) {
		writeError(w, http.StatusBadRequest, "invalid project UUID")
		return
	}
	if strings.TrimSpace(req.OverleafRemote) != "" {
		if err := validateRemoteURL(req.OverleafRemote); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if strings.TrimSpace(req.CodeRemote) != "" {
		if err := validateRemoteURL(req.CodeRemote); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	linkAll := true
	if req.LinkAllPapers != nil {
		linkAll = *req.LinkAllPapers
	}

	cfg, projDir, err := s.createProjectOnDiskWithID(
		r.Context(),
		claims.UserID,
		claims.Username,
		req.ID,
		req.FolderName,
		req.Name,
		req.OverleafRemote,
		req.CodeRemote,
		linkAll,
	)
	if err != nil {
		writeError(w, http.StatusInternalServerError, fmt.Sprintf("failed to create project: %v", err))
		return
	}
	if len(req.CodeRepos) > 0 {
		cfg.CodeRepos = req.CodeRepos
		_ = writeProjectConfig(projDir, cfg)
		_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
	}
	writeJSON(w, http.StatusCreated, cfg)
}

type updateProjectRequest struct {
	Name           *string          `json:"name"`
	OverleafRemote *string          `json:"overleaf_remote"`
	OverleafToken  *string          `json:"overleaf_token"`
	CodeRemote     *string          `json:"code_remote"`
	CodeRepos      []LinkedCodeRepo `json:"code_repos,omitempty"`
	LinkedPaperIDs []string         `json:"linked_paper_ids"`
	LinkAllPapers  *bool            `json:"link_all_papers"`
}

func syncOverleafRemoteIntoPaperDir(ctx context.Context, paperDir, remoteURL, username string) (string, error) {
	initGitRepoIfNeeded(ctx, paperDir, username)
	if _, err := runGitCommand(ctx, paperDir, "remote", "set-url", "origin", remoteURL); err != nil {
		_, _ = runGitCommand(ctx, paperDir, "remote", "add", "origin", remoteURL)
	}
	if _, err := runGitCommand(ctx, paperDir, "fetch", "origin"); err != nil {
		sshURL := githubHTTPSFallbackToSSH(remoteURL)
		if sshURL == "" {
			return remoteURL, err
		}
		_, _ = runGitCommand(ctx, paperDir, "remote", "set-url", "origin", sshURL)
		if _, sshErr := runGitCommand(ctx, paperDir, "fetch", "origin"); sshErr != nil {
			return remoteURL, err
		}
		remoteURL = sshURL
	}

	for _, branch := range []string{"master", "main"} {
		if _, err := runGitCommand(ctx, paperDir, "rev-parse", "--verify", "origin/"+branch); err == nil {
			_, _ = runGitCommand(ctx, paperDir, "checkout", "-B", branch, "origin/"+branch)
			break
		}
	}
	return remoteURL, nil
}

func (s *Server) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req updateProjectRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
		cfg.Name = strings.TrimSpace(*req.Name)
	}
	if req.LinkedPaperIDs != nil {
		cfg.LinkedPaperIDs = req.LinkedPaperIDs
	}
	if req.CodeRepos != nil {
		cfg.CodeRepos = req.CodeRepos
	}
	if req.LinkAllPapers != nil {
		cfg.LinkAllPapers = *req.LinkAllPapers
	}
	if req.OverleafRemote != nil {
		token := ""
		if req.OverleafToken != nil {
			token = *req.OverleafToken
		}
		remote := normalizeOverleafRemote(*req.OverleafRemote, token)
		if remote != "" {
			if err := validateRemoteURL(remote); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			paperDir := filepath.Join(projDir, "paper")
			resolvedRemote, fetchErr := syncOverleafRemoteIntoPaperDir(r.Context(), paperDir, remote, claims.Username)
			cfg.OverleafRemote = resolvedRemote
			_ = writeProjectConfig(projDir, cfg)
			if fetchErr != nil {
				writeError(w, http.StatusBadGateway, fmt.Sprintf("Failed to fetch remote (if using git.overleaf.com, provide your Overleaf Git Token 'olp_...' or link via GitHub): %v", fetchErr))
				return
			}
		} else {
			cfg.OverleafRemote = ""
		}
	}
	if req.CodeRemote != nil && s.mode == "local" {
		codeRemote := strings.TrimSpace(*req.CodeRemote)
		if codeRemote != "" {
			if err := validateRemoteURL(codeRemote); err != nil {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			codeDir := filepath.Join(projDir, "code")
			if entries, readErr := os.ReadDir(codeDir); readErr == nil && len(entries) > 0 {
				if _, err := os.Stat(filepath.Join(codeDir, ".git")); err == nil {
					if _, err := runGitCommand(r.Context(), codeDir, "remote", "set-url", "origin", codeRemote); err != nil {
						_, _ = runGitCommand(r.Context(), codeDir, "remote", "add", "origin", codeRemote)
					}
					cfg.CodeRemote = codeRemote
				} else {
					writeError(w, http.StatusConflict, "code/ directory is not empty and not a git repo")
					return
				}
			} else {
				_ = os.RemoveAll(codeDir)
				resolved, cloneErr := cloneGitRepoIntoDir(r.Context(), codeDir, codeRemote, claims.Username)
				if cloneErr != nil {
					_ = os.MkdirAll(codeDir, 0o755)
					writeError(w, http.StatusBadGateway, fmt.Sprintf("Failed to clone code repo: %v", cloneErr))
					return
				}
				cfg.CodeRemote = resolved
			}
		} else {
			cfg.CodeRemote = ""
		}
	}

	if err := writeProjectConfig(projDir, cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write project.json")
		return
	}
	if err := s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to regenerate project files")
		return
	}

	writeJSON(w, http.StatusOK, cfg)
}

var latexCiteKeysRegex = regexp.MustCompile(`\\cite[a-zA-Z*]*\{([^}]+)\}`)
var markdownPaperLinkRegex = regexp.MustCompile(`\[\[paper:([a-zA-Z0-9_:-]+)\]\]`)

func collectProjectCitedBibKeys(projDir string, tree []ProjectTreeEntry) []string {
	seen := make(map[string]bool)
	var keys []string
	for _, entry := range tree {
		if entry.Kind != "tex" && entry.Kind != "markdown" {
			continue
		}
		if entry.Path == "AGENTS.md" || strings.HasPrefix(entry.Path, "refs/") {
			continue
		}
		absPath, err := safeJoin(projDir, entry.Path)
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(absPath)
		if err != nil {
			continue
		}
		text := string(raw)
		for _, m := range latexCiteKeysRegex.FindAllStringSubmatch(text, -1) {
			for _, part := range strings.Split(m[1], ",") {
				k := strings.TrimSpace(part)
				if k != "" && !strings.Contains(k, "<") && !seen[k] {
					seen[k] = true
					keys = append(keys, k)
				}
			}
		}
		for _, m := range markdownPaperLinkRegex.FindAllStringSubmatch(text, -1) {
			k := strings.TrimSpace(m[1])
			if k != "" && !seen[k] {
				seen[k] = true
				keys = append(keys, k)
			}
		}
	}
	sort.Strings(keys)
	return keys
}

func (s *Server) handleGetProjectTree(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
	tree, err := collectProjectTree(r.Context(), projDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read project tree")
		return
	}
	citedKeys := collectProjectCitedBibKeys(projDir, tree)

	paperDir := filepath.Join(projDir, "paper")
	rootTexName := findProjectRootTex(paperDir, "")
	pdfStem := strings.TrimSuffix(rootTexName, filepath.Ext(rootTexName))
	pdfPath := filepath.Join(projDir, ".dupe", "build", pdfStem+".pdf")
	if _, statErr := os.Stat(pdfPath); errors.Is(statErr, os.ErrNotExist) {
		pdfPath = filepath.Join(paperDir, pdfStem+".pdf")
	}
	var compiledPDF map[string]any
	if pdfStat, statErr := os.Stat(pdfPath); statErr == nil && pdfStat.Size() > 0 {
		compiledPDF = map[string]any{
			"available":  true,
			"root_tex":   "paper/" + rootTexName,
			"version":    pdfStat.ModTime().UnixMilli(),
			"size_bytes": pdfStat.Size(),
		}
	} else {
		compiledPDF = map[string]any{
			"available": false,
			"root_tex":  "paper/" + rootTexName,
		}
	}

	codeTargets := collectLinkedSubdirTargets(filepath.Join(projDir, "code"))
	paperTargets := collectLinkedSubdirTargets(filepath.Join(projDir, "paper"))
	codeTarget := strings.Join(codeTargets, ", ")

	writeJSON(w, http.StatusOK, map[string]any{
		"project":       cfg,
		"files":         tree,
		"cited_keys":    citedKeys,
		"compiled_pdf":  compiledPDF,
		"code_target":   codeTarget,
		"code_targets":  codeTargets,
		"paper_targets": paperTargets,
	})
}

func (s *Server) handleReadProjectFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	relFile := strings.TrimSpace(r.URL.Query().Get("path"))
	targetPath, err := safeJoin(projDir, relFile)
	if err != nil || strings.Contains(filepath.ToSlash(relFile), ".git/") {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	contentBytes, err := os.ReadFile(targetPath)
	if errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read file")
		return
	}

	relSlash := filepath.ToSlash(filepath.Clean(relFile))
	headContent := readHeadContentForProjectFile(r.Context(), projDir, relSlash)

	writeJSON(w, http.StatusOK, map[string]any{
		"path":         relSlash,
		"content":      string(contentBytes),
		"head_content": headContent,
	})
}

func (s *Server) handleReadProjectAsset(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	relFile := strings.TrimSpace(r.URL.Query().Get("path"))
	targetPath, err := safeJoin(projDir, relFile)
	if err != nil || strings.Contains(filepath.ToSlash(relFile), ".git/") {
		writeError(w, http.StatusBadRequest, "invalid asset path")
		return
	}

	f, err := os.Open(targetPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}
	defer func() { _ = f.Close() }()

	stat, err := f.Stat()
	if err != nil || stat.IsDir() {
		writeError(w, http.StatusNotFound, "asset not found")
		return
	}

	switch strings.ToLower(filepath.Ext(targetPath)) {
	case ".pdf":
		w.Header().Set("Content-Type", "application/pdf")
	case ".svg":
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
	case ".png":
		w.Header().Set("Content-Type", "image/png")
	case ".jpg", ".jpeg":
		w.Header().Set("Content-Type", "image/jpeg")
	case ".gif":
		w.Header().Set("Content-Type", "image/gif")
	case ".webp":
		w.Header().Set("Content-Type", "image/webp")
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", filepath.Base(targetPath)))
	http.ServeContent(w, r, filepath.Base(targetPath), stat.ModTime(), f)
}

func (s *Server) handleWriteProjectFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req writeRepoFileRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	relFile := strings.TrimSpace(req.Path)
	targetPath, err := safeJoin(projDir, relFile)
	if err != nil || strings.Contains(filepath.ToSlash(relFile), ".git/") {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	var data []byte
	if req.IsBase64 {
		decoded, decErr := base64.StdEncoding.DecodeString(req.Content)
		if decErr != nil {
			writeError(w, http.StatusBadRequest, "invalid base64 content")
			return
		}
		data = decoded
	} else {
		data = []byte(req.Content)
	}

	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create parent directory")
		return
	}

	relSlash := filepath.ToSlash(filepath.Clean(relFile))
	isNoteFile := strings.HasPrefix(relSlash, "notes/")
	if isNoteFile {
		if existingBytes, readErr := os.ReadFile(targetPath); readErr == nil {
			existingTrim := bytes.TrimSpace(existingBytes)
			incomingTrim := bytes.TrimSpace(data)
			// Never allow a 1-line '# title' stub to overwrite an existing populated note unless forced
			if !req.Force && len(existingTrim) > 25 && len(incomingTrim) <= 30 && !bytes.Contains(incomingTrim, []byte("\n")) {
				headContent := readHeadContentForProjectFile(r.Context(), projDir, relSlash)
				writeJSON(w, http.StatusOK, map[string]any{
					"path":         relSlash,
					"bytes":        len(existingBytes),
					"content":      string(existingBytes),
					"head_content": headContent,
					"protected":    true,
				})
				return
			}
			// Snapshot previous version into .dupe/notes_history/ before updating
			if len(existingTrim) > 0 && !bytes.Equal(existingTrim, incomingTrim) {
				histDir := filepath.Join(projDir, ".dupe", "notes_history")
				_ = os.MkdirAll(histDir, 0o755)
				stamp := time.Now().UTC().Format("20060102T150405Z")
				safeBase := strings.ReplaceAll(strings.TrimPrefix(relSlash, "notes/"), "/", "__")
				histPath := filepath.Join(histDir, fmt.Sprintf("%s.%s.bak.md", safeBase, stamp))
				_ = os.WriteFile(histPath, existingBytes, 0o644)
			}
		}
	}

	if err := os.WriteFile(targetPath, data, 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to write file")
		return
	}

	if strings.HasPrefix(relSlash, "paper/") || isNoteFile {
		if agentsStat, statErr := os.Stat(filepath.Join(projDir, "AGENTS.md")); errors.Is(statErr, os.ErrNotExist) || time.Since(agentsStat.ModTime()) > 5*time.Minute {
			_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
		}
	}

	headContent := readHeadContentForProjectFile(r.Context(), projDir, relSlash)
	writeJSON(w, http.StatusOK, map[string]any{
		"path":         relSlash,
		"bytes":        len(data),
		"head_content": headContent,
	})
}

func isProtectedProjectPath(relSlash string) bool {
	switch relSlash {
	case "", ".", "paper", "notes", "scratch", "refs", "code", "AGENTS.md", ".dupe", ".git", "paper/dupe_references.bib":
		return true
	}
	return strings.HasPrefix(relSlash, ".git/") ||
		strings.HasPrefix(relSlash, ".dupe/") ||
		strings.HasPrefix(relSlash, "refs/") ||
		strings.Contains(relSlash, "/.git/")
}

func (s *Server) handleDeleteProjectFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	relFile := strings.TrimSpace(r.URL.Query().Get("path"))
	relSlash := filepath.ToSlash(filepath.Clean(relFile))
	if isProtectedProjectPath(relSlash) {
		writeError(w, http.StatusBadRequest, "cannot delete protected project path")
		return
	}
	targetAbs, err := safeJoin(projDir, relSlash)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}
	if _, err := os.Stat(targetAbs); errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "file not found")
		return
	}
	if err := os.RemoveAll(targetAbs); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete file")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type renameProjectFileRequest struct {
	OldPath string `json:"old_path"`
	NewPath string `json:"new_path"`
}

func (s *Server) handleRenameProjectFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req renameProjectFileRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	oldSlash := filepath.ToSlash(filepath.Clean(strings.TrimSpace(req.OldPath)))
	newSlash := filepath.ToSlash(filepath.Clean(strings.TrimSpace(req.NewPath)))
	if isProtectedProjectPath(oldSlash) || isProtectedProjectPath(newSlash) {
		writeError(w, http.StatusBadRequest, "cannot rename protected project path")
		return
	}
	oldAbs, errOld := safeJoin(projDir, oldSlash)
	newAbs, errNew := safeJoin(projDir, newSlash)
	if errOld != nil || errNew != nil {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}
	if _, err := os.Stat(oldAbs); errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusNotFound, "source file not found")
		return
	}
	if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create destination folder")
		return
	}
	if err := os.Rename(oldAbs, newAbs); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to rename file")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"old_path": oldSlash,
		"new_path": newSlash,
	})
}

type addProjectCommentRequest struct {
	Source   string `json:"source"`
	Location string `json:"location"`
	Quote    string `json:"quote"`
	Comment  string `json:"comment"`
}

func (s *Server) handleAddProjectComment(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req addProjectCommentRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	commentText := strings.TrimSpace(req.Comment)
	if commentText == "" {
		writeError(w, http.StatusBadRequest, "comment is required")
		return
	}
	sourceLabel := strings.TrimSpace(req.Source)
	if sourceLabel == "" {
		sourceLabel = "project"
	}
	locLabel := strings.TrimSpace(req.Location)
	stamp := time.Now().UTC().Format("2006-01-02 15:04")

	header := fmt.Sprintf("- [ ] **[%s] `%s`", stamp, sourceLabel)
	if locLabel != "" {
		header += fmt.Sprintf(" (%s)", locLabel)
	}
	header += "**"

	var block strings.Builder
	block.WriteString(header + "\n")
	quoteText := strings.TrimSpace(req.Quote)
	if quoteText != "" {
		singleLineQuote := strings.Join(strings.Fields(quoteText), " ")
		if len(singleLineQuote) > 280 {
			singleLineQuote = singleLineQuote[:280] + "…"
		}
		block.WriteString(fmt.Sprintf("  > \"%s\"\n", singleLineQuote))
	}
	block.WriteString(fmt.Sprintf("  **Comment:** %s", commentText))

	openBlocks, addressedBlocks, commentsMD := parseAndReconcileComments(projDir, block.String())
	_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
	agentsBytes, _ := os.ReadFile(filepath.Join(projDir, "AGENTS.md"))

	writeJSON(w, http.StatusCreated, map[string]any{
		"comments_md":     commentsMD,
		"agents_md":       string(agentsBytes),
		"open_count":      len(openBlocks),
		"addressed_count": len(addressedBlocks),
	})
}

func (s *Server) handleGatherProjectContext(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	openBlocks, addressedBlocks, commentsMD := parseAndReconcileComments(projDir, "")
	if err := s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to regenerate AGENTS.md")
		return
	}
	agentsBytes, _ := os.ReadFile(filepath.Join(projDir, "AGENTS.md"))

	writeJSON(w, http.StatusOK, map[string]any{
		"comments_md":     commentsMD,
		"agents_md":       string(agentsBytes),
		"open_count":      len(openBlocks),
		"addressed_count": len(addressedBlocks),
	})
}

type revertProjectFileRequest struct {
	Path string `json:"path"`
}

func (s *Server) handleRevertProjectFile(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req revertProjectFileRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	relSlash := filepath.ToSlash(filepath.Clean(strings.TrimSpace(req.Path)))
	if _, err := safeJoin(projDir, relSlash); err != nil {
		writeError(w, http.StatusBadRequest, "invalid file path")
		return
	}

	headContent := readHeadContentForProjectFile(r.Context(), projDir, relSlash)
	if headContent == "" {
		writeError(w, http.StatusBadRequest, "file has no committed HEAD version to revert to")
		return
	}

	targetPath, _ := safeJoin(projDir, relSlash)
	if err := os.WriteFile(targetPath, []byte(headContent), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to restore HEAD content")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path":         relSlash,
		"content":      headContent,
		"head_content": headContent,
	})
}

func pullOverleafPaperRepo(ctx context.Context, paperDir, remoteURL, username string) (string, string, error) {
	initGitRepoIfNeeded(ctx, paperDir, username)
	cleanRemote := normalizeOverleafRemote(remoteURL, "")
	if _, err := runGitCommand(ctx, paperDir, "remote", "set-url", "origin", cleanRemote); err != nil {
		_, _ = runGitCommand(ctx, paperDir, "remote", "add", "origin", cleanRemote)
	}

	if _, err := runGitCommand(ctx, paperDir, "fetch", "origin"); err != nil {
		sshURL := githubHTTPSFallbackToSSH(cleanRemote)
		if sshURL == "" {
			return cleanRemote, "", err
		}
		_, _ = runGitCommand(ctx, paperDir, "remote", "set-url", "origin", sshURL)
		if _, sshErr := runGitCommand(ctx, paperDir, "fetch", "origin"); sshErr != nil {
			return cleanRemote, "", err
		}
		cleanRemote = sshURL
	}

	targetBranch := ""
	if headBranch, err := runGitCommand(ctx, paperDir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil && headBranch != "" && headBranch != "HEAD" {
		if _, err := runGitCommand(ctx, paperDir, "rev-parse", "--verify", "origin/"+headBranch); err == nil {
			targetBranch = headBranch
		}
	}
	if targetBranch == "" {
		for _, candidate := range []string{"master", "main"} {
			if _, err := runGitCommand(ctx, paperDir, "rev-parse", "--verify", "origin/"+candidate); err == nil {
				targetBranch = candidate
				break
			}
		}
	}

	if targetBranch != "" {
		if _, err := runGitCommand(ctx, paperDir, "pull", "--rebase", "--autostash", "origin", targetBranch); err != nil {
			_, _ = runGitCommand(ctx, paperDir, "rebase", "--abort")
			return cleanRemote, "", err
		}
	}

	sha, _ := runGitCommand(ctx, paperDir, "rev-parse", "HEAD")
	return cleanRemote, sha, nil
}

func (s *Server) handlePullProject(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}
	if strings.TrimSpace(cfg.OverleafRemote) == "" {
		writeError(w, http.StatusBadRequest, "no Overleaf remote configured for this project")
		return
	}

	paperDir := filepath.Join(projDir, "paper")
	prevSHA, _ := runGitCommand(r.Context(), paperDir, "rev-parse", "HEAD")

	resolvedRemote, newSHA, pullErr := pullOverleafPaperRepo(r.Context(), paperDir, cfg.OverleafRemote, claims.Username)
	if pullErr != nil {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("git pull failed: %v", pullErr))
		return
	}
	cfg.OverleafRemote = resolvedRemote
	nowStr := time.Now().UTC().Format(time.RFC3339)
	cfg.LastSyncedAt = &nowStr
	_ = writeProjectConfig(projDir, cfg)

	writeJSON(w, http.StatusOK, map[string]any{
		"project":        cfg,
		"pulled":         true,
		"updated":        newSHA != "" && newSHA != prevSHA,
		"paper_sha":      newSHA,
		"last_synced_at": nowStr,
	})
}

func (s *Server) handleSyncProject(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req syncRepoRequest
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
	}
	commitMsg := strings.TrimSpace(req.CommitMessage)
	if commitMsg == "" {
		commitMsg = "chore(dupe): sync dupe_references.bib, notes, and manuscript"
	}

	if err := s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to regenerate project artifacts")
		return
	}

	paperDir := filepath.Join(projDir, "paper")
	initGitRepoIfNeeded(r.Context(), projDir, claims.Username)
	initGitRepoIfNeeded(r.Context(), paperDir, claims.Username)
	_ = ensureProjectGitIgnore(projDir)
	ensurePaperGitIgnore(paperDir)

	rootCommitted, rootSHA, _ := commitAllIfDirty(r.Context(), projDir, commitMsg)
	paperCommitted, paperSHA, _ := commitAllIfDirty(r.Context(), paperDir, commitMsg)

	pushed := false
	pushWarning := ""
	if cfg.OverleafRemote != "" {
		resolvedRemote, _, pullErr := pullOverleafPaperRepo(r.Context(), paperDir, cfg.OverleafRemote, claims.Username)
		cfg.OverleafRemote = resolvedRemote
		if pullErr != nil {
			cfg.PendingPush = true
			pushWarning = pullErr.Error()
		} else if _, pushErr := runGitCommand(r.Context(), paperDir, "push", "-u", "origin", "HEAD"); pushErr != nil {
			cfg.PendingPush = true
			pushWarning = pushErr.Error()
		} else {
			cfg.PendingPush = false
			pushed = true
			paperSHA, _ = runGitCommand(r.Context(), paperDir, "rev-parse", "HEAD")
		}
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)
	cfg.LastSyncedAt = &nowStr
	_ = writeProjectConfig(projDir, cfg)

	writeJSON(w, http.StatusOK, map[string]any{
		"project":        cfg,
		"committed":      rootCommitted || paperCommitted,
		"root_sha":       rootSHA,
		"paper_sha":      paperSHA,
		"pushed":         pushed,
		"pending_push":   cfg.PendingPush,
		"push_warning":   pushWarning,
		"last_synced_at": nowStr,
	})
}

type LatexDiagnostic struct {
	Level    string `json:"level"`
	File     string `json:"file"`
	Line     int    `json:"line,omitempty"`
	Message  string `json:"message"`
	Context  string `json:"context,omitempty"`
	Source   string `json:"source,omitempty"`
	Category string `json:"category,omitempty"`
}

type CompileProjectResponse struct {
	Success      bool              `json:"success"`
	FailureKind  string            `json:"failure_kind"`
	RootTex      string            `json:"root_tex"`
	PdfAvailable bool              `json:"pdf_available"`
	DurationMs   int64             `json:"duration_ms"`
	Errors       []LatexDiagnostic `json:"errors"`
	Warnings     []LatexDiagnostic `json:"warnings"`
	RawLog       string            `json:"raw_log"`
}

var (
	tectonicDiagRegex    = regexp.MustCompile(`^(error|warning):\s*(?:([^:\s]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_/-]+):(\d+):)?\s*(.+)$`)
	texErrorLineRegex    = regexp.MustCompile(`^l\.(\d+)\s*(.*)$`)
	latexInputLineRegex  = regexp.MustCompile(`on input line (\d+)\.?`)
	texParenOpenRegex    = regexp.MustCompile(`\(([A-Za-z0-9_./-]+\.[A-Za-z0-9]+|[A-Za-z0-9_/-]+)`)
	texFontSubWarnRegex  = regexp.MustCompile(`Font shape .* undefined|Some font shapes were not available`)
)

func normalizeDiagFile(rawFile, rootTexName string) string {
	clean := strings.TrimSpace(rawFile)
	clean = strings.TrimPrefix(clean, "./")
	clean = filepath.ToSlash(clean)
	if clean == "" {
		return rootTexName
	}
	base := filepath.Base(clean)
	if !strings.Contains(base, ".") {
		clean += ".tex"
	}
	return clean
}

func classifyDiagnosticCategory(msg, source string) string {
	lower := strings.ToLower(msg)
	if source == "compiler" {
		return "system"
	}
	if strings.Contains(lower, "underfull \\") || strings.Contains(lower, "overfull \\") {
		return "typography"
	}
	if strings.Contains(lower, "citation") || strings.Contains(lower, "reference") ||
		strings.Contains(lower, "undefined references") || strings.Contains(lower, "multiply-defined labels") ||
		source == "bibtex" {
		return "reference"
	}
	if strings.Contains(lower, "file `") || strings.Contains(lower, ".sty") || strings.Contains(lower, "font shape") {
		return "package"
	}
	return "syntax"
}

func parseTectonicDiagnostics(rawLog, rootTexName string) ([]LatexDiagnostic, []LatexDiagnostic) {
	errorsList := make([]LatexDiagnostic, 0)
	warningsList := make([]LatexDiagnostic, 0)
	seen := make(map[string]bool)
	lineContext := make(map[int]string)

	lines := strings.Split(rawLog, "\n")
	for _, rawLine := range lines {
		trimmed := strings.TrimSpace(rawLine)
		if lm := texErrorLineRegex.FindStringSubmatch(trimmed); lm != nil {
			var ln int
			_, _ = fmt.Sscanf(lm[1], "%d", &ln)
			snippet := strings.TrimSpace(lm[2])
			if ln > 0 && snippet != "" {
				lineContext[ln] = snippet
			}
		}
	}

	activeFile := rootTexName
	var pendingBangError string
	addDiag := func(d LatexDiagnostic) {
		d.File = normalizeDiagFile(d.File, rootTexName)
		if d.Context == "" && d.Line > 0 {
			d.Context = lineContext[d.Line]
		}
		if d.Category == "" {
			d.Category = classifyDiagnosticCategory(d.Message, d.Source)
		}
		normMsg := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(d.Message)), ".")
		dedupKey := fmt.Sprintf("%s|%s|%d|%s", d.Level, d.File, d.Line, normMsg)
		if seen[dedupKey] {
			return
		}
		seen[dedupKey] = true
		if d.Level == "error" {
			errorsList = append(errorsList, d)
		} else {
			warningsList = append(warningsList, d)
		}
	}

	for i := 0; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}

		if strings.HasPrefix(line, "(") {
			if pm := texParenOpenRegex.FindStringSubmatch(line); pm != nil {
				cand := strings.TrimPrefix(pm[1], "./")
				if !strings.HasSuffix(cand, ".aux") && !strings.HasSuffix(cand, ".out") && !strings.HasSuffix(cand, ".fd") {
					activeFile = normalizeDiagFile(cand, rootTexName)
				}
			}
		}

		if strings.HasPrefix(line, "! ") {
			pendingBangError = strings.TrimSpace(strings.TrimPrefix(line, "! "))
			continue
		}
		if pendingBangError != "" {
			if lm := texErrorLineRegex.FindStringSubmatch(line); lm != nil {
				var ln int
				_, _ = fmt.Sscanf(lm[1], "%d", &ln)
				addDiag(LatexDiagnostic{
					Level:   "error",
					File:    activeFile,
					Line:    ln,
					Message: pendingBangError,
					Context: strings.TrimSpace(lm[2]),
					Source:  "latex",
				})
				pendingBangError = ""
				continue
			}
		}

		if strings.HasPrefix(line, "LaTeX Warning:") {
			msg := strings.TrimSpace(strings.TrimPrefix(line, "LaTeX Warning:"))
			if texFontSubWarnRegex.MatchString(msg) {
				continue
			}
			// Merge multi-line wrapped LaTeX warnings
			if i+1 < len(lines) {
				nextTrim := strings.TrimSpace(lines[i+1])
				if nextTrim != "" && !strings.HasPrefix(nextTrim, "LaTeX ") && !strings.HasPrefix(nextTrim, "warning:") && !strings.HasPrefix(nextTrim, "error:") && (strings.Contains(nextTrim, "input line") || nextTrim == ".") {
					msg = strings.TrimSpace(msg + " " + nextTrim)
					i++
				}
			}
			lineNum := 0
			if lm := latexInputLineRegex.FindStringSubmatch(msg); lm != nil {
				_, _ = fmt.Sscanf(lm[1], "%d", &lineNum)
			}
			addDiag(LatexDiagnostic{
				Level:   "warning",
				File:    activeFile,
				Line:    lineNum,
				Message: msg,
				Source:  "latex",
			})
			continue
		}

		if strings.HasPrefix(line, "Warning--") {
			addDiag(LatexDiagnostic{
				Level:    "warning",
				File:     rootTexName,
				Message:  strings.TrimSpace(strings.TrimPrefix(line, "Warning--")),
				Source:   "bibtex",
				Category: "reference",
			})
			continue
		}

		m := tectonicDiagRegex.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		level := m[1]
		file := strings.TrimSpace(m[2])
		lineNum := 0
		if m[3] != "" {
			_, _ = fmt.Sscanf(m[3], "%d", &lineNum)
		}
		msg := strings.TrimSpace(m[4])
		if msg == "" ||
			strings.HasPrefix(msg, "warnings were issued by the TeX engine") ||
			strings.HasPrefix(msg, "TeX rerun seems needed") ||
			strings.HasPrefix(msg, "halted on potentially-recoverable error") ||
			strings.HasPrefix(msg, "internal consistency problem") {
			continue
		}
		if strings.HasPrefix(msg, "Invalid UTF-8 byte or sequence") && strings.HasSuffix(file, ".sty") {
			continue
		}
		diagSource := "latex"
		if strings.Contains(strings.ToLower(msg), "bibtex") || strings.HasSuffix(file, ".bib") {
			diagSource = "bibtex"
		}
		if file == "" {
			file = activeFile
		}
		if level == "error" && pendingBangError != "" && strings.Contains(pendingBangError, msg) {
			pendingBangError = ""
		}
		addDiag(LatexDiagnostic{
			Level:   level,
			File:    file,
			Line:    lineNum,
			Message: msg,
			Source:  diagSource,
		})
	}
	if pendingBangError != "" {
		addDiag(LatexDiagnostic{
			Level:   "error",
			File:    activeFile,
			Message: pendingBangError,
			Source:  "latex",
		})
	}
	return errorsList, warningsList
}

func findProjectRootTex(paperDir, preferredRel string) string {
	cleanedPref := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(preferredRel)), "paper/")
	if cleanedPref != "" && strings.HasSuffix(cleanedPref, ".tex") {
		if data, err := os.ReadFile(filepath.Join(paperDir, cleanedPref)); err == nil {
			if strings.Contains(string(data), "\\documentclass") {
				return cleanedPref
			}
		}
	}

	entries, err := os.ReadDir(paperDir)
	if err != nil {
		return "main.tex"
	}
	prefStem := strings.TrimSuffix(filepath.Base(cleanedPref), ".tex")
	var fallbackTex string
	var docClassFallback string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tex") {
			continue
		}
		if fallbackTex == "" {
			fallbackTex = e.Name()
		}
		data, readErr := os.ReadFile(filepath.Join(paperDir, e.Name()))
		if readErr == nil && strings.Contains(string(data), "\\documentclass") {
			content := string(data)
			if prefStem != "" && (strings.Contains(content, "\\input{"+prefStem) || strings.Contains(content, "\\include{"+prefStem)) {
				return e.Name()
			}
			if e.Name() != "main.tex" {
				return e.Name()
			}
			docClassFallback = e.Name()
		}
	}
	if docClassFallback != "" {
		return docClassFallback
	}
	if fallbackTex != "" {
		return fallbackTex
	}
	// Check depth-1 subdirectories inside paper/ (e.g. symlinked multi-paper repos)
	for _, e := range entries {
		subPath := filepath.Join(paperDir, e.Name())
		info, statErr := os.Stat(subPath)
		if statErr != nil || !info.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if subRoot := findProjectRootTex(subPath, strings.TrimPrefix(cleanedPref, e.Name()+"/")); subRoot != "main.tex" {
			return filepath.ToSlash(filepath.Join(e.Name(), subRoot))
		}
	}
	return "main.tex"
}

func resolveTectonicBinary() string {
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".local", "bin", "tectonic"),
		"/opt/homebrew/bin/tectonic",
		"/usr/local/bin/tectonic",
		"/home/dinoclaro/.local/bin/tectonic",
		"/home/dino/.local/bin/tectonic",
		"/home/linuxbrew/.linuxbrew/bin/tectonic",
		"tectonic",
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			return c
		}
	}
	return "tectonic"
}

func isTectonicCacheCold() bool {
	home, _ := os.UserHomeDir()
	var dirs []string
	if xdg := strings.TrimSpace(os.Getenv("XDG_CACHE_HOME")); xdg != "" {
		dirs = append(dirs, filepath.Join(xdg, "Tectonic"))
	}
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, ".cache", "Tectonic"),
			filepath.Join(home, "Library", "Caches", "Tectonic"),
		)
	}
	for _, d := range dirs {
		formatsDir := filepath.Join(d, "formats")
		if entries, err := os.ReadDir(formatsDir); err == nil && len(entries) > 0 {
			return false
		}
	}
	return true
}

type compileProjectRequest struct {
	Target string `json:"target"`
}

func writeTectonicFontBridges(paperDir string) func() {
	bridges := map[string]string{
		"TUptm.fd": `\ProvidesFile{TUptm.fd}[2020/01/01 TU Times Roman font definitions for IEEEtran]
\DeclareFontFamily{TU}{ptm}{}
\DeclareFontShape{TU}{ptm}{m}{n}{<-> "[texgyretermes-regular.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{ptm}{m}{it}{<-> "[texgyretermes-italic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{ptm}{m}{sl}{<-> "[texgyretermes-italic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{ptm}{m}{sc}{<-> "[texgyretermes-regular.otf]:mapping=tex-text;+smcp"}{}
\DeclareFontShape{TU}{ptm}{bx}{n}{<-> "[texgyretermes-bold.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{ptm}{bx}{it}{<-> "[texgyretermes-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{ptm}{bx}{sl}{<-> "[texgyretermes-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{ptm}{bx}{sc}{<-> "[texgyretermes-bold.otf]:mapping=tex-text;+smcp"}{}
\DeclareFontShape{TU}{ptm}{b}{n}{<-> ssub * ptm/bx/n}{}
\DeclareFontShape{TU}{ptm}{b}{it}{<-> ssub * ptm/bx/it}{}
\DeclareFontShape{TU}{ptm}{b}{sl}{<-> ssub * ptm/bx/sl}{}
\DeclareFontShape{TU}{ptm}{b}{sc}{<-> ssub * ptm/bx/sc}{}
\DeclareFontShape{TU}{ptm}{l}{n}{<-> ssub * ptm/m/n}{}
\DeclareFontShape{TU}{ptm}{c}{n}{<-> ssub * ptm/m/n}{}
`,
		"TUphv.fd": `\ProvidesFile{TUphv.fd}[2020/01/01 TU Helvetica font definitions for IEEEtran]
\DeclareFontFamily{TU}{phv}{}
\DeclareFontShape{TU}{phv}{m}{n}{<-> "[texgyreheros-regular.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{m}{it}{<-> "[texgyreheros-italic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{m}{sl}{<-> "[texgyreheros-italic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{m}{sc}{<-> "[texgyreheros-regular.otf]:mapping=tex-text;+smcp"}{}
\DeclareFontShape{TU}{phv}{bx}{n}{<-> "[texgyreheros-bold.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{bx}{it}{<-> "[texgyreheros-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{bx}{sl}{<-> "[texgyreheros-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{bx}{sc}{<-> "[texgyreheros-bold.otf]:mapping=tex-text;+smcp"}{}
\DeclareFontShape{TU}{phv}{b}{n}{<-> "[texgyreheros-bold.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{b}{it}{<-> "[texgyreheros-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{phv}{b}{sl}{<-> "[texgyreheros-bolditalic.otf]:mapping=tex-text;"}{}
`,
		"TUpcr.fd": `\ProvidesFile{TUpcr.fd}[2020/01/01 TU Courier font definitions for IEEEtran]
\DeclareFontFamily{TU}{pcr}{}
\DeclareFontShape{TU}{pcr}{m}{n}{<-> "[texgyrecursor-regular.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{m}{it}{<-> "[texgyrecursor-italic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{m}{sl}{<-> "[texgyrecursor-italic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{m}{sc}{<-> "[texgyrecursor-regular.otf]:mapping=tex-text;+smcp"}{}
\DeclareFontShape{TU}{pcr}{bx}{n}{<-> "[texgyrecursor-bold.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{bx}{it}{<-> "[texgyrecursor-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{bx}{sl}{<-> "[texgyrecursor-bolditalic.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{b}{n}{<-> "[texgyrecursor-bold.otf]:mapping=tex-text;"}{}
\DeclareFontShape{TU}{pcr}{b}{it}{<-> "[texgyrecursor-bolditalic.otf]:mapping=tex-text;"}{}
`,
	}
	var created []string
	for name, body := range bridges {
		p := filepath.Join(paperDir, name)
		if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
			if writeErr := os.WriteFile(p, []byte(body), 0o644); writeErr == nil {
				created = append(created, p)
			}
		}
	}
	return func() {
		for _, p := range created {
			_ = os.Remove(p)
		}
	}
}

func (s *Server) handleCompileProject(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	var req compileProjectRequest
	if r.Body != nil {
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req)
	}

	_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)

	paperDir := filepath.Join(projDir, "paper")
	rootTexName := findProjectRootTex(paperDir, req.Target)
	rootTexPath := filepath.Join(paperDir, rootTexName)
	if _, err := os.Stat(rootTexPath); errors.Is(err, os.ErrNotExist) {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("root LaTeX file %q not found", rootTexName))
		return
	}

	started := time.Now()
	coldCache := isTectonicCacheCold()
	compileTimeout := 60 * time.Second
	if coldCache {
		compileTimeout = 300 * time.Second
	}
	ctxTimeout, cancel := context.WithTimeout(r.Context(), compileTimeout)
	defer cancel()

	texWorkDir := filepath.Dir(rootTexPath)
	cleanupBridges := writeTectonicFontBridges(texWorkDir)
	defer cleanupBridges()

	buildDir := filepath.Join(projDir, ".dupe", "build")
	_ = os.MkdirAll(buildDir, 0o755)

	tectonicBin := resolveTectonicBinary()
	cmd := exec.CommandContext(ctxTimeout, tectonicBin, "-X", "compile", "--print", "--keep-logs", "--synctex", "--outdir", buildDir, filepath.Base(rootTexPath))
	cmd.Dir = texWorkDir
	var combinedOut bytes.Buffer
	cmd.Stdout = &combinedOut
	cmd.Stderr = &combinedOut

	runErr := cmd.Run()
	durationMs := time.Since(started).Milliseconds()
	rawLog := combinedOut.String()

	pdfStem := strings.TrimSuffix(filepath.Base(rootTexName), filepath.Ext(rootTexName))
	if blgBytes, blgErr := os.ReadFile(filepath.Join(buildDir, pdfStem+".blg")); blgErr == nil {
		blgText := strings.TrimSpace(string(blgBytes))
		if blgText != "" && !strings.Contains(rawLog, blgText) {
			rawLog += "\n--- BibTeX (.blg) ---\n" + blgText
		}
	}

	errs, warns := parseTectonicDiagnostics(rawLog, rootTexName)

	pdfPath := filepath.Join(buildDir, pdfStem+".pdf")
	if _, err := os.Stat(pdfPath); errors.Is(err, os.ErrNotExist) {
		pdfPath = filepath.Join(paperDir, pdfStem+".pdf")
	}
	_, pdfStatErr := os.Stat(pdfPath)
	pdfAvailable := pdfStatErr == nil

	failureKind := "none"
	if runErr != nil || !pdfAvailable {
		isCompilerFault := errors.Is(ctxTimeout.Err(), context.DeadlineExceeded) ||
			errors.Is(runErr, exec.ErrNotFound) ||
			strings.Contains(rawLog, "output directory") ||
			len(errs) == 0
		if isCompilerFault {
			failureKind = "compiler"
		} else {
			failureKind = "latex_code"
		}
	}

	if runErr != nil && len(errs) == 0 {
		msg := fmt.Sprintf("LaTeX compiler failed: %v", runErr)
		if errors.Is(ctxTimeout.Err(), context.DeadlineExceeded) {
			msg = fmt.Sprintf("LaTeX compiler timed out after %ds (first-time Tectonic bundle download or infinite loop; check internet/logs)", int(compileTimeout.Seconds()))
		} else if errors.Is(runErr, exec.ErrNotFound) {
			msg = "Tectonic compiler binary not found on the server"
		}
		errs = append(errs, LatexDiagnostic{
			Level:    "error",
			File:     rootTexName,
			Message:  msg,
			Source:   "compiler",
			Category: "system",
		})
	}

	writeJSON(w, http.StatusOK, CompileProjectResponse{
		Success:      runErr == nil && pdfAvailable,
		FailureKind:  failureKind,
		RootTex:      "paper/" + rootTexName,
		PdfAvailable: pdfAvailable,
		DurationMs:   durationMs,
		Errors:       errs,
		Warnings:     warns,
		RawLog:       rawLog,
	})
}

func (s *Server) handleStreamCompiledPDF(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	paperDir := filepath.Join(projDir, "paper")
	rootTexName := findProjectRootTex(paperDir, r.URL.Query().Get("target"))
	pdfStem := strings.TrimSuffix(rootTexName, filepath.Ext(rootTexName))
	pdfPath := filepath.Join(projDir, ".dupe", "build", pdfStem+".pdf")
	if _, err := os.Stat(pdfPath); errors.Is(err, os.ErrNotExist) {
		pdfPath = filepath.Join(paperDir, pdfStem+".pdf")
	}

	f, err := os.Open(pdfPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "compiled PDF not found; click Recompile first")
		return
	}
	defer func() { _ = f.Close() }()

	stat, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to stat compiled PDF")
		return
	}

	etag := fmt.Sprintf(`"%x-%x"`, stat.Size(), stat.ModTime().UnixNano())
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Disposition", fmt.Sprintf("inline; filename=%q", pdfStem+".pdf"))
	http.ServeContent(w, r, pdfStem+".pdf", stat.ModTime(), f)
}

type SearchMatchItem struct {
	Category string `json:"category"` // "pdf" | "latex" | "notes" | "code"
	Path     string `json:"path"`
	Title    string `json:"title"`
	PaperID  string `json:"paper_id,omitempty"`
	BibKey   string `json:"bibtex_key,omitempty"`
	Line     int    `json:"line,omitempty"`
	Snippet  string `json:"snippet"`
	Kind     string `json:"kind"`
}

func categorizeProjectPath(relSlash string) string {
	switch {
	case strings.HasPrefix(relSlash, "paper/"):
		return "latex"
	case strings.HasPrefix(relSlash, "code/"):
		return "code"
	case strings.HasPrefix(relSlash, "notes/") || relSlash == "AGENTS.md":
		return "notes"
	case strings.HasPrefix(relSlash, "refs/"):
		return "pdf"
	default:
		return "notes"
	}
}

func (s *Server) handleSearchProject(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	cfg, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	rawQuery := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(rawQuery) < 2 {
		writeJSON(w, http.StatusOK, map[string]any{"results": []SearchMatchItem{}})
		return
	}
	qLower := strings.ToLower(rawQuery)
	results := make([]SearchMatchItem, 0, 80)
	const maxPerCategory = 50
	catCounts := map[string]int{
		"pdf":   0,
		"latex": 0,
		"notes": 0,
		"code":  0,
	}

	// 1. Search PDF Library metadata (title, authors, bibtex_key, doi, tags)
	papers, _ := s.queryLinkedPapersForProject(r.Context(), claims.UserID, cfg)
	paperByBibKey := make(map[string]Paper, len(papers))
	matchedPaperMeta := make(map[string]bool)
	for _, p := range papers {
		paperByBibKey[p.BibtexKey] = p
		if catCounts["pdf"] >= maxPerCategory {
			continue
		}
		haystack := strings.ToLower(p.Title + " " + p.Authors + " " + p.BibtexKey + " " + p.DOI + " " + strings.Join(p.Tags, " "))
		if strings.Contains(haystack, qLower) {
			yr := ""
			if p.PublicationYear != nil {
				yr = fmt.Sprintf(" (%d)", *p.PublicationYear)
			}
			results = append(results, SearchMatchItem{
				Category: "pdf",
				Path:     "pdf:" + p.ID,
				Title:    p.Title,
				PaperID:  p.ID,
				BibKey:   p.BibtexKey,
				Snippet:  fmt.Sprintf("@%s%s — %s", p.BibtexKey, yr, p.Authors),
				Kind:     "pdf",
			})
			catCounts["pdf"]++
			matchedPaperMeta[p.ID] = true
		}
	}

	// 2. Search across Project Files (LaTeX in paper/, Notes in notes/, Code in code/, and PDF text in refs/text/)
	treeEntries, _ := collectProjectTree(r.Context(), projDir)
	for _, entry := range treeEntries {
		if entry.Path == "refs/index.json" || entry.Kind == "asset" {
			continue
		}
		isRefText := strings.HasPrefix(entry.Path, "refs/text/") && strings.HasSuffix(entry.Path, ".md")
		cat := categorizeProjectPath(entry.Path)
		if isRefText {
			cat = "pdf"
		}
		if catCounts[cat] >= maxPerCategory {
			continue
		}
		fileKind := entry.Kind

		// Check filename match first (for non-ref-text files)
		if !isRefText && strings.Contains(strings.ToLower(entry.Path), qLower) {
			results = append(results, SearchMatchItem{
				Category: cat,
				Path:     entry.Path,
				Title:    filepath.Base(entry.Path),
				Snippet:  entry.Path,
				Kind:     fileKind,
			})
			catCounts[cat]++
			if catCounts[cat] >= maxPerCategory {
				continue
			}
		}

		fullPath, joinErr := safeJoin(projDir, entry.Path)
		if joinErr != nil {
			continue
		}
		info, statErr := os.Stat(fullPath)
		if statErr != nil || info.Size() > (2<<20) {
			continue
		}
		rawBytes, readErr := os.ReadFile(fullPath)
		if readErr != nil {
			continue
		}
		lines := strings.Split(string(rawBytes), "\n")
		matchesInFile := 0
		for lineIdx, lineText := range lines {
			if strings.Contains(strings.ToLower(lineText), qLower) {
				snippet := strings.TrimSpace(lineText)
				if len(snippet) > 140 {
					snippet = snippet[:140] + "…"
				}
				if isRefText {
					bibKey := strings.TrimSuffix(filepath.Base(entry.Path), ".md")
					if p, exists := paperByBibKey[bibKey]; exists {
						if matchedPaperMeta[p.ID] && matchesInFile >= 1 {
							break
						}
						results = append(results, SearchMatchItem{
							Category: "pdf",
							Path:     "pdf:" + p.ID,
							Title:    p.Title,
							PaperID:  p.ID,
							BibKey:   p.BibtexKey,
							Line:     lineIdx + 1,
							Snippet:  snippet,
							Kind:     "pdf",
						})
						catCounts["pdf"]++
						matchesInFile++
						if matchesInFile >= 2 || catCounts["pdf"] >= maxPerCategory {
							break
						}
					}
					continue
				}
				results = append(results, SearchMatchItem{
					Category: cat,
					Path:     entry.Path,
					Title:    filepath.Base(entry.Path),
					Line:     lineIdx + 1,
					Snippet:  snippet,
					Kind:     fileKind,
				})
				catCounts[cat]++
				matchesInFile++
				if matchesInFile >= 5 || catCounts[cat] >= maxPerCategory {
					break
				}
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}

var synctexNodeRegex = regexp.MustCompile(`^[hvgk$([][0-9]+,[0-9]+:-?[0-9]+,-?[0-9]+`)

type parsedSyncTex struct {
	lines    []string
	inputMap map[int]string
}

func loadSyncTexData(projDir, paperDir, rootTexName string) (*parsedSyncTex, int, error) {
	pdfStem := strings.TrimSuffix(rootTexName, filepath.Ext(rootTexName))
	synctexPath := filepath.Join(projDir, ".dupe", "build", pdfStem+".synctex.gz")
	if _, err := os.Stat(synctexPath); errors.Is(err, os.ErrNotExist) {
		synctexPath = filepath.Join(paperDir, pdfStem+".synctex.gz")
	}

	f, err := os.Open(synctexPath)
	if err != nil {
		return nil, http.StatusNotFound, fmt.Errorf("SyncTeX data not found; click Recompile first")
	}
	defer func() { _ = f.Close() }()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("failed to read SyncTeX archive")
	}
	defer func() { _ = gz.Close() }()

	rawBytes, err := io.ReadAll(gz)
	if err != nil {
		return nil, http.StatusInternalServerError, fmt.Errorf("failed to decompress SyncTeX data")
	}

	inputMap := make(map[int]string)
	absPaperDir, _ := filepath.Abs(paperDir)
	lines := strings.Split(string(rawBytes), "\n")
	for _, line := range lines {
		if !strings.HasPrefix(line, "Input:") {
			continue
		}
		rest := strings.TrimPrefix(line, "Input:")
		colonIdx := strings.IndexByte(rest, ':')
		if colonIdx <= 0 {
			continue
		}
		id, idErr := strconv.Atoi(rest[:colonIdx])
		if idErr != nil {
			continue
		}
		fullInputPath := strings.TrimSpace(rest[colonIdx+1:])
		if fullInputPath == "" {
			continue
		}
		cleanInput := filepath.Clean(fullInputPath)
		ext := strings.ToLower(filepath.Ext(cleanInput))
		if ext != ".tex" && ext != ".bib" {
			continue
		}
		relToPaper := filepath.Base(cleanInput)
		if absPaperDir != "" {
			if rel, relErr := filepath.Rel(absPaperDir, cleanInput); relErr == nil && !strings.HasPrefix(rel, "..") {
				relToPaper = filepath.ToSlash(rel)
			}
		}
		if _, statErr := os.Stat(filepath.Join(paperDir, relToPaper)); statErr == nil {
			inputMap[id] = "paper/" + relToPaper
		}
	}
	return &parsedSyncTex{lines: lines, inputMap: inputMap}, http.StatusOK, nil
}

func parseSyncTexNodeLine(line string) (tag byte, inputID, lineNum int, xVal, yVal, wVal float64, ok bool) {
	if !synctexNodeRegex.MatchString(line) {
		return 0, 0, 0, 0, 0, 0, false
	}
	tag = line[0]
	parts := strings.Split(line[1:], ":")
	if len(parts) < 2 {
		return 0, 0, 0, 0, 0, 0, false
	}
	idLine := strings.Split(parts[0], ",")
	xy := strings.Split(parts[1], ",")
	if len(idLine) < 2 || len(xy) < 2 {
		return 0, 0, 0, 0, 0, 0, false
	}
	var err1, err2, err3, err4 error
	inputID, err1 = strconv.Atoi(idLine[0])
	lineNum, err2 = strconv.Atoi(idLine[1])
	xVal, err3 = strconv.ParseFloat(xy[0], 64)
	yVal, err4 = strconv.ParseFloat(xy[1], 64)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || lineNum < 1 {
		return 0, 0, 0, 0, 0, 0, false
	}
	if len(parts) >= 3 {
		whd := strings.Split(parts[2], ",")
		if len(whd) >= 1 {
			wVal, _ = strconv.ParseFloat(whd[0], 64)
		}
	}
	return tag, inputID, lineNum, xVal, yVal, wVal, true
}

func (s *Server) handleSyncTexLookup(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	pageNum, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if pageNum < 1 {
		pageNum = 1
	}
	xRatio, _ := strconv.ParseFloat(r.URL.Query().Get("x"), 64)
	yRatio, _ := strconv.ParseFloat(r.URL.Query().Get("y"), 64)
	if xRatio < 0 || xRatio > 1 {
		xRatio = 0.5
	}
	if yRatio < 0 || yRatio > 1 {
		yRatio = 0.5
	}

	pageWidthPt := 612.0
	pageHeightPt := 792.0
	if wPt, parseErr := strconv.ParseFloat(r.URL.Query().Get("w"), 64); parseErr == nil && wPt > 50 && wPt < 3000 {
		pageWidthPt = wPt
	}
	if hPt, parseErr := strconv.ParseFloat(r.URL.Query().Get("h"), 64); parseErr == nil && hPt > 50 && hPt < 3000 {
		pageHeightPt = hPt
	}

	paperDir := filepath.Join(projDir, "paper")
	rootTexName := findProjectRootTex(paperDir, r.URL.Query().Get("target"))
	st, statusCode, loadErr := loadSyncTexData(projDir, paperDir, rootTexName)
	if loadErr != nil {
		writeError(w, statusCode, loadErr.Error())
		return
	}

	targetX := xRatio * pageWidthPt * 65536.0
	targetY := yRatio * pageHeightPt * 65536.0

	pageMarker := fmt.Sprintf("{%d", pageNum)
	inTargetPage := false
	bestPath := "paper/" + rootTexName
	bestLine := 1
	bestScore := math.MaxFloat64

	for _, line := range st.lines {
		if !inTargetPage {
			if strings.TrimSpace(line) == pageMarker {
				inTargetPage = true
			}
			continue
		}
		if strings.HasPrefix(line, "}") {
			break
		}
		tag, inputID, lineNum, xVal, yVal, wVal, parsedOK := parseSyncTexNodeLine(line)
		if !parsedOK {
			continue
		}
		relPath, exists := st.inputMap[inputID]
		if !exists {
			continue
		}

		// Weight vertical distance 4.5x so the exact line in a two-column layout wins
		dy := math.Abs(yVal - targetY)
		dx := math.Abs(xVal - targetX)
		if wVal > 0 {
			if targetX >= xVal && targetX <= xVal+wVal {
				dx = 0
			} else if targetX > xVal+wVal {
				dx = targetX - (xVal + wVal)
			}
		}
		score := dy*4.5 + dx
		if tag == '[' {
			score += 80.0 * 65536.0
		}
		if score < bestScore {
			bestScore = score
			bestPath = relPath
			bestLine = lineNum
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"path": bestPath,
		"line": bestLine,
		"page": pageNum,
	})
}

func (s *Server) handleSyncTexForward(w http.ResponseWriter, r *http.Request) {
	claims, ok := currentUser(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	projectID := r.PathValue("id")
	_, projDir, err := s.lookupProjectDir(r.Context(), claims.UserID, projectID, claims.Username)
	if err != nil {
		writeError(w, http.StatusNotFound, "project not found")
		return
	}

	reqFile := filepath.ToSlash(strings.TrimSpace(r.URL.Query().Get("file")))
	if reqFile == "" {
		writeError(w, http.StatusBadRequest, "file parameter required")
		return
	}
	if !strings.HasPrefix(reqFile, "paper/") {
		reqFile = "paper/" + strings.TrimPrefix(reqFile, "./")
	}
	targetLine, _ := strconv.Atoi(r.URL.Query().Get("line"))
	if targetLine < 1 {
		targetLine = 1
	}

	pageWidthPt := 612.0
	pageHeightPt := 792.0
	if wPt, parseErr := strconv.ParseFloat(r.URL.Query().Get("w"), 64); parseErr == nil && wPt > 50 && wPt < 3000 {
		pageWidthPt = wPt
	}
	if hPt, parseErr := strconv.ParseFloat(r.URL.Query().Get("h"), 64); parseErr == nil && hPt > 50 && hPt < 3000 {
		pageHeightPt = hPt
	}

	paperDir := filepath.Join(projDir, "paper")
	rootTexName := findProjectRootTex(paperDir, r.URL.Query().Get("target"))
	st, statusCode, loadErr := loadSyncTexData(projDir, paperDir, rootTexName)
	if loadErr != nil {
		writeError(w, statusCode, loadErr.Error())
		return
	}

	matchingIDs := make(map[int]bool)
	for id, relPath := range st.inputMap {
		if relPath == reqFile || strings.TrimSuffix(relPath, ".tex") == strings.TrimSuffix(reqFile, ".tex") {
			matchingIDs[id] = true
		}
	}
	if len(matchingIDs) == 0 {
		writeError(w, http.StatusNotFound, "file not present in SyncTeX output; compile first")
		return
	}

	currentPage := 0
	bestPage := 1
	bestXRatio := 0.5
	bestYRatio := 0.2
	bestDist := math.MaxFloat64

	for _, line := range st.lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "{") {
			if p, pErr := strconv.Atoi(trimmed[1:]); pErr == nil && p > 0 {
				currentPage = p
			}
			continue
		}
		if strings.HasPrefix(trimmed, "}") {
			currentPage = 0
			continue
		}
		if currentPage == 0 {
			continue
		}
		tag, inputID, lineNum, xVal, yVal, _, parsedOK := parseSyncTexNodeLine(trimmed)
		if !parsedOK || !matchingIDs[inputID] {
			continue
		}
		dist := math.Abs(float64(lineNum - targetLine))
		if tag == '[' {
			dist += 0.4
		}
		if dist < bestDist {
			bestDist = dist
			bestPage = currentPage
			bestXRatio = math.Max(0.02, math.Min(0.98, xVal/(pageWidthPt*65536.0)))
			bestYRatio = math.Max(0.02, math.Min(0.98, yVal/(pageHeightPt*65536.0)))
			if dist == 0 {
				break
			}
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"page": bestPage,
		"x":    bestXRatio,
		"y":    bestYRatio,
	})
}

