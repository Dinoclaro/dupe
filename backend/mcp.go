package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type mcpToolCallParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

func (s *Server) runMCPServer(ctx context.Context, userID int, username string, in io.Reader, out io.Writer) error {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 10*1024*1024)
	enc := json.NewEncoder(out)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req jsonRPCRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			continue
		}
		if len(req.ID) == 0 {
			continue
		}
		resp := s.handleMCPRequest(ctx, userID, username, req)
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (s *Server) handleMCPRequest(ctx context.Context, userID int, username string, req jsonRPCRequest) jsonRPCResponse {
	switch req.Method {
	case "initialize":
		return jsonRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"protocolVersion": "2024-11-05",
				"capabilities": map[string]any{
					"tools": map[string]any{},
				},
				"serverInfo": map[string]any{
					"name":    "dupe-mcp",
					"version": "1.0.0",
				},
			},
		}

	case "tools/list":
		return jsonRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"tools": []map[string]any{
					{
						"name":        "search_papers",
						"description": "Search papers in the dupe library by title, author, BibTeX key, or DOI.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"query": map[string]any{"type": "string", "description": "Search query string"},
							},
							"required": []string{"query"},
						},
					},
					{
						"name":        "get_bibtex",
						"description": "Retrieve the BibTeX entry and metadata for a paper by its bibtex_key.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"key": map[string]any{"type": "string", "description": "BibTeX citation key"},
							},
							"required": []string{"key"},
						},
					},
					{
						"name":        "read_paper",
						"description": "Read the extracted full Markdown text of a paper by its bibtex_key.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"key":     map[string]any{"type": "string", "description": "BibTeX citation key"},
								"section": map[string]any{"type": "string", "description": "Optional section or keyword filter"},
							},
							"required": []string{"key"},
						},
					},
					{
						"name":        "link_paper",
						"description": "Link a paper by bibtex_key to a project and regenerate references.bib and AGENTS.md.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"key":        map[string]any{"type": "string", "description": "BibTeX citation key"},
								"project_id": map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
							"required": []string{"key"},
						},
					},
					{
						"name":        "assign_paper_folder",
						"description": "Assign a paper by its bibtex_key to a PDF Library folder (e.g. 'World Models', 'Core References').",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"key":    map[string]any{"type": "string", "description": "BibTeX citation key"},
								"folder": map[string]any{"type": "string", "description": "Target folder name (empty string to unfile)"},
							},
							"required": []string{"key", "folder"},
						},
					},
					{
						"name":        "update_project_summary",
						"description": "Save a concise agent-authored project summary to .dupe/summary.md and regenerate AGENTS.md.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"summary":    map[string]any{"type": "string", "description": "3-5 sentence summary of project goals, recent progress, and active focus"},
								"project_id": map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
							"required": []string{"summary"},
						},
					},
				},
			},
		}

	case "tools/call":
		var params mcpToolCallParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return jsonRPCResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &jsonRPCError{Code: -32602, Message: "invalid tool call params"},
			}
		}
		textOut, isErr := s.executeMCPTool(ctx, userID, username, params.Name, params.Arguments)
		return jsonRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]any{
				"content": []map[string]any{
					{"type": "text", "text": textOut},
				},
				"isError": isErr,
			},
		}

	default:
		return jsonRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &jsonRPCError{Code: -32601, Message: "method not found: " + req.Method},
		}
	}
}

func (s *Server) executeMCPTool(ctx context.Context, userID int, username, toolName string, args map[string]any) (string, bool) {
	strArg := func(k string) string {
		if v, ok := args[k].(string); ok {
			return strings.TrimSpace(v)
		}
		return ""
	}

	switch toolName {
	case "search_papers":
		q := strings.ToLower(strArg("query"))
		papers, err := s.queryLinkedPapersForProject(ctx, userID, ProjectConfig{LinkAllPapers: true})
		if err != nil {
			return fmt.Sprintf("Failed to search library: %v", err), true
		}
		var matches []Paper
		for _, p := range papers {
			if q == "" ||
				strings.Contains(strings.ToLower(p.Title), q) ||
				strings.Contains(strings.ToLower(p.Authors), q) ||
				strings.Contains(strings.ToLower(p.BibtexKey), q) ||
				strings.Contains(strings.ToLower(p.DOI), q) {
				matches = append(matches, p)
			}
		}
		out, _ := json.MarshalIndent(matches, "", "  ")
		return string(out), false

	case "get_bibtex":
		key := strArg("key")
		papers, err := s.queryLinkedPapersForProject(ctx, userID, ProjectConfig{LinkAllPapers: true})
		if err != nil {
			return fmt.Sprintf("Database error: %v", err), true
		}
		for _, p := range papers {
			if strings.EqualFold(p.BibtexKey, key) {
				return p.BibtexRaw, false
			}
		}
		return fmt.Sprintf("No paper found with bibtex_key %q", key), true

	case "read_paper":
		key := strArg("key")
		section := strings.ToLower(strArg("section"))
		papers, err := s.queryLinkedPapersForProject(ctx, userID, ProjectConfig{LinkAllPapers: true})
		if err != nil {
			return fmt.Sprintf("Database error: %v", err), true
		}
		for _, p := range papers {
			if strings.EqualFold(p.BibtexKey, key) {
				absPath, joinErr := safeJoin(s.storageDir, p.FilePath)
				if joinErr != nil {
					return "Invalid PDF storage path", true
				}
				if _, statErr := os.Stat(absPath); statErr != nil {
					return fmt.Sprintf("# %s\nAuthors: %s\nDOI: %s\n\nError: PDF file is not cached locally at %s (%v). Run library sync first.", p.Title, p.Authors, p.DOI, absPath, statErr), true
				}
				fullText, extractErr := s.extractFullTextMarkdownWithErr(ctx, absPath)
				if extractErr != nil {
					return fmt.Sprintf("# %s\nAuthors: %s\nDOI: %s\n\nError extracting PDF body text: %v", p.Title, p.Authors, p.DOI, extractErr), true
				}
				if fullText == "" {
					return fmt.Sprintf("# %s\nAuthors: %s\nDOI: %s\n\nError: PDF contains no extractable text (may be scanned images without OCR).", p.Title, p.Authors, p.DOI), true
				}
				if section != "" {
					var filtered []string
					for _, para := range strings.Split(fullText, "\n\n") {
						if strings.Contains(strings.ToLower(para), section) {
							filtered = append(filtered, para)
						}
					}
					if len(filtered) > 0 {
						return strings.Join(filtered, "\n\n"), false
					}
				}
				return fullText, false
			}
		}
		return fmt.Sprintf("No paper found with bibtex_key %q", key), true

	case "link_paper":
		key := strArg("key")
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		papers, err := s.queryLinkedPapersForProject(ctx, userID, ProjectConfig{LinkAllPapers: true})
		if err != nil {
			return fmt.Sprintf("Database error: %v", err), true
		}
		var targetPaper *Paper
		for i := range papers {
			if strings.EqualFold(papers[i].BibtexKey, key) {
				targetPaper = &papers[i]
				break
			}
		}
		if targetPaper == nil {
			return fmt.Sprintf("No paper found with bibtex_key %q", key), true
		}

		cfg, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		already := false
		for _, id := range cfg.LinkedPaperIDs {
			if id == targetPaper.ID {
				already = true
				break
			}
		}
		if !already {
			cfg.LinkedPaperIDs = append(cfg.LinkedPaperIDs, targetPaper.ID)
		}
		_ = writeProjectConfig(projDir, cfg)
		if err := s.regenerateProjectArtifacts(ctx, projDir, userID, cfg); err != nil {
			return fmt.Sprintf("Failed to regenerate project artifacts: %v", err), true
		}
		return fmt.Sprintf("Linked @%s (%s) to project %s and regenerated references.bib and %s.", targetPaper.BibtexKey, targetPaper.Title, cfg.Name, filepath.Join("refs", "text", targetPaper.BibtexKey+".md")), false

	case "assign_paper_folder":
		key := strArg("key")
		folder := strArg("folder")
		papers, err := s.queryLinkedPapersForProject(ctx, userID, ProjectConfig{LinkAllPapers: true})
		if err != nil {
			return fmt.Sprintf("Failed to query papers: %v", err), true
		}
		var targetPaper *Paper
		for i := range papers {
			if strings.EqualFold(papers[i].BibtexKey, key) {
				targetPaper = &papers[i]
				break
			}
		}
		if targetPaper == nil {
			return fmt.Sprintf("No paper found with bibtex_key %q", key), true
		}
		nextTags := make([]string, 0, len(targetPaper.Tags)+1)
		for _, t := range targetPaper.Tags {
			if !strings.HasPrefix(t, "folder:") {
				nextTags = append(nextTags, t)
			}
		}
		if folder != "" {
			nextTags = append(nextTags, "folder:"+folder)
		}
		if err := s.replacePaperTags(ctx, targetPaper.ID, nextTags); err != nil {
			return fmt.Sprintf("Failed to update paper folder: %v", err), true
		}
		return fmt.Sprintf("Assigned @%s (%s) to folder %q.", targetPaper.BibtexKey, targetPaper.Title, folder), false

	case "update_project_summary":
		summary := strings.TrimSpace(strArg("summary"))
		if summary == "" {
			return "summary is required", true
		}
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		cfg, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		if err := os.MkdirAll(filepath.Join(projDir, ".dupe"), 0o755); err != nil {
			return fmt.Sprintf("Failed to create .dupe directory: %v", err), true
		}
		if err := os.WriteFile(filepath.Join(projDir, ".dupe", "summary.md"), []byte(summary+"\n"), 0o644); err != nil {
			return fmt.Sprintf("Failed to write .dupe/summary.md: %v", err), true
		}
		if err := s.regenerateProjectArtifacts(ctx, projDir, userID, cfg); err != nil {
			return fmt.Sprintf("Failed to regenerate AGENTS.md: %v", err), true
		}
		return fmt.Sprintf("Updated .dupe/summary.md and regenerated AGENTS.md for project %s.", cfg.Name), false

	default:
		return fmt.Sprintf("Unknown tool: %s", toolName), true
	}
}
