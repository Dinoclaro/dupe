package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type ProvenanceEntry struct {
	TargetPath   string `json:"target_path"`
	SourceScript string `json:"source_script"`
	Command      string `json:"command,omitempty"`
	GitRepo      string `json:"git_repo,omitempty"`
	GitSHA       string `json:"git_sha,omitempty"`
	TargetSHA256 string `json:"target_sha256,omitempty"`
	Notes        string `json:"notes,omitempty"`
	RecordedAt   string `json:"recorded_at"`
}

type ProvenanceCheckResult struct {
	ProvenanceEntry
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

func provenanceFilePath(projDir string) string {
	return filepath.Join(projDir, ".dupe", "provenance.json")
}

func readProvenanceEntries(projDir string) ([]ProvenanceEntry, error) {
	raw, err := os.ReadFile(provenanceFilePath(projDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var entries []ProvenanceEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, err
	}
	return entries, nil
}

func writeProvenanceEntries(projDir string, entries []ProvenanceEntry) error {
	if err := os.MkdirAll(filepath.Join(projDir, ".dupe"), 0o755); err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].TargetPath < entries[j].TargetPath
	})
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	return writeFileIfChanged(provenanceFilePath(projDir), append(data, '\n'), 0o644)
}

func resolveGitRepoForProjectFile(projDir, relSlash string) (string, string) {
	parts := strings.Split(filepath.ToSlash(filepath.Clean(relSlash)), "/")
	for i := len(parts) - 1; i >= 1; i-- {
		candidateRel := strings.Join(parts[:i], "/")
		candidateAbs, err := safeJoin(projDir, candidateRel)
		if err != nil {
			continue
		}
		if _, statErr := os.Stat(filepath.Join(candidateAbs, ".git")); statErr == nil {
			relInRepo := strings.Join(parts[i:], "/")
			return candidateRel, relInRepo
		}
	}
	if _, statErr := os.Stat(filepath.Join(projDir, ".git")); statErr == nil {
		return ".", relSlash
	}
	return "", ""
}

func recordProjectProvenance(ctx context.Context, projDir string, entry ProvenanceEntry) (ProvenanceEntry, error) {
	targetClean := filepath.ToSlash(filepath.Clean(strings.TrimSpace(entry.TargetPath)))
	sourceClean := filepath.ToSlash(filepath.Clean(strings.TrimSpace(entry.SourceScript)))
	if targetClean == "" || targetClean == "." || sourceClean == "" || sourceClean == "." {
		return ProvenanceEntry{}, fmt.Errorf("target_path and source_script are required")
	}
	targetAbs, err := safeJoin(projDir, targetClean)
	if err != nil {
		return ProvenanceEntry{}, fmt.Errorf("invalid target_path: %w", err)
	}
	if _, err := safeJoin(projDir, sourceClean); err != nil {
		return ProvenanceEntry{}, fmt.Errorf("invalid source_script: %w", err)
	}

	entry.TargetPath = targetClean
	entry.SourceScript = sourceClean
	if sum := computeFileSHA256Hex(targetAbs); sum != "" {
		entry.TargetSHA256 = sum
	}
	if strings.TrimSpace(entry.GitRepo) == "" {
		repoRel, _ := resolveGitRepoForProjectFile(projDir, sourceClean)
		entry.GitRepo = repoRel
	}
	if entry.GitRepo != "" && strings.TrimSpace(entry.GitSHA) == "" {
		repoAbs := projDir
		if entry.GitRepo != "." {
			if joined, jErr := safeJoin(projDir, entry.GitRepo); jErr == nil {
				repoAbs = joined
			}
		}
		if sha, shaErr := runGitCommand(ctx, repoAbs, "rev-parse", "HEAD"); shaErr == nil {
			entry.GitSHA = strings.TrimSpace(sha)
		}
	}
	entry.RecordedAt = time.Now().UTC().Format(time.RFC3339)

	existing, err := readProvenanceEntries(projDir)
	if err != nil {
		return ProvenanceEntry{}, err
	}
	replaced := false
	for i := range existing {
		if existing[i].TargetPath == entry.TargetPath {
			existing[i] = entry
			replaced = true
			break
		}
	}
	if !replaced {
		existing = append(existing, entry)
	}
	if err := writeProvenanceEntries(projDir, existing); err != nil {
		return ProvenanceEntry{}, err
	}
	return entry, nil
}

func checkProjectProvenance(ctx context.Context, projDir string) ([]ProvenanceCheckResult, error) {
	entries, err := readProvenanceEntries(projDir)
	if err != nil || len(entries) == 0 {
		return nil, err
	}
	results := make([]ProvenanceCheckResult, 0, len(entries))
	for _, entry := range entries {
		res := ProvenanceCheckResult{
			ProvenanceEntry: entry,
			Status:          "up_to_date",
		}
		targetAbs, tErr := safeJoin(projDir, entry.TargetPath)
		if tErr != nil {
			res.Status = "missing_target"
			res.Detail = "invalid target path"
			results = append(results, res)
			continue
		}
		if _, statErr := os.Stat(targetAbs); errors.Is(statErr, os.ErrNotExist) {
			res.Status = "missing_target"
			res.Detail = "target file does not exist on disk"
			results = append(results, res)
			continue
		}
		curSum := computeFileSHA256Hex(targetAbs)
		if entry.TargetSHA256 != "" && curSum != "" && curSum != entry.TargetSHA256 {
			res.Status = "target_modified"
			res.Detail = "target file hash differs from recorded provenance"
			results = append(results, res)
			continue
		}

		repoRel := entry.GitRepo
		relInRepo := ""
		if repoRel == "" {
			repoRel, relInRepo = resolveGitRepoForProjectFile(projDir, entry.SourceScript)
		} else if repoRel == "." {
			relInRepo = entry.SourceScript
		} else {
			relInRepo = strings.TrimPrefix(entry.SourceScript, strings.TrimSuffix(repoRel, "/")+"/")
		}

		if repoRel != "" && relInRepo != "" {
			repoAbs := projDir
			if repoRel != "." {
				if joined, jErr := safeJoin(projDir, repoRel); jErr == nil {
					repoAbs = joined
				}
			}
			if _, gitErr := os.Stat(filepath.Join(repoAbs, ".git")); gitErr == nil {
				if dirty, dErr := runGitCommand(ctx, repoAbs, "status", "--porcelain", "--", relInRepo); dErr == nil && strings.TrimSpace(dirty) != "" {
					res.Status = "source_changed"
					res.Detail = "source_script has uncommitted changes"
					results = append(results, res)
					continue
				}
				if entry.GitSHA != "" {
					if diffOut, diffErr := runGitCommand(ctx, repoAbs, "diff", "--name-only", entry.GitSHA+"..HEAD", "--", relInRepo); diffErr == nil && strings.TrimSpace(diffOut) != "" {
						res.Status = "source_changed"
						res.Detail = "source_script committed after recorded SHA " + entry.GitSHA[:min(7, len(entry.GitSHA))]
						results = append(results, res)
						continue
					}
				}
			}
		}
		results = append(results, res)
	}
	return results, nil
}

func (s *Server) handleGetProjectProvenance(w http.ResponseWriter, r *http.Request) {
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
	results, err := checkProjectProvenance(r.Context(), projDir)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to check provenance")
		return
	}
	if results == nil {
		results = []ProvenanceCheckResult{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": results})
}

func (s *Server) handleRecordProjectProvenance(w http.ResponseWriter, r *http.Request) {
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
	var req ProvenanceEntry
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	saved, err := recordProjectProvenance(r.Context(), projDir, req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	_ = s.regenerateProjectArtifacts(r.Context(), projDir, claims.UserID, cfg)
	writeJSON(w, http.StatusCreated, saved)
}
