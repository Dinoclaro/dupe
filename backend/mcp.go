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
					{
						"name":        "record_provenance",
						"description": "Record which code script and git commit generated a paper figure, table, or asset.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"target_path":   map[string]any{"type": "string", "description": "Project-relative output path (e.g. paper/figures/fig1.pdf)"},
								"source_script": map[string]any{"type": "string", "description": "Project-relative generating script (e.g. code/repo/plot.py)"},
								"command":       map[string]any{"type": "string", "description": "Optional command used to generate the target"},
								"notes":         map[string]any{"type": "string", "description": "Optional notes"},
								"project_id":    map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
							"required": []string{"target_path", "source_script"},
						},
					},
					{
						"name":        "check_provenance",
						"description": "Verify whether recorded paper figures/assets are up to date with their source scripts and commits.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"project_id": map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
						},
					},
					{
						"name":        "agent_brain_post",
						"description": "Post an agent brainstorm, hypothesis, dead-end, or handoff to the gitignored .dupe/brain/ blackboard (keeps human notes/ uncluttered).",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"topic":      map[string]any{"type": "string", "description": "Blackboard topic slug (e.g. 'sim-bug', 'ablation-plan')"},
								"agent":      map[string]any{"type": "string", "description": "Agent role or terminal name posting this entry"},
								"summary":    map[string]any{"type": "string", "description": "One-line summary"},
								"body":       map[string]any{"type": "string", "description": "Markdown details, hypotheses, commands, or logs"},
								"links":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Optional Obsidian [[wikilinks]] or [[paper:key]] references"},
								"project_id": map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
							"required": []string{"topic", "body"},
						},
					},
					{
						"name":        "agent_brain_read",
						"description": "Read shared agent brainstorming topics from .dupe/brain/blackboard.md or a specific topic shard.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"topic":      map[string]any{"type": "string", "description": "Optional topic slug; omit to read blackboard.md overview"},
								"query":      map[string]any{"type": "string", "description": "Optional keyword filter"},
								"project_id": map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
						},
					},
					{
						"name":        "write_brain_note",
						"description": "Create or update a concise, Obsidian-linked human brain note in notes/ or notes/concepts/, enforcing <= 150 lines / 8 KB anti-bloat limits and required [[wikilinks]].",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"path":       map[string]any{"type": "string", "description": "Project-relative path (e.g. notes/concepts/reward-shaping.md)"},
								"content":    map[string]any{"type": "string", "description": "Markdown note content with YAML frontmatter and [[wikilinks]]"},
								"force":      map[string]any{"type": "boolean", "description": "Bypass anti-bloat check only if explicitly needed"},
								"project_id": map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
							"required": []string{"path", "content"},
						},
					},
					{
						"name":        "agent_brain_promote",
						"description": "Distill a validated insight from .dupe/brain/ into a concise curated note in notes/concepts/<slug>.md.",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"source_topic": map[string]any{"type": "string", "description": "Optional blackboard topic slug being promoted"},
								"concept_slug": map[string]any{"type": "string", "description": "Target slug under notes/concepts/"},
								"content":      map[string]any{"type": "string", "description": "Concise Markdown concept note with frontmatter and [[links]]"},
								"project_id":   map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
							"required": []string{"concept_slug", "content"},
						},
					},
					{
						"name":        "get_brain_graph",
						"description": "Inspect the project's Obsidian knowledge graph (hubs, orphans, unresolved ghost links, bloated notes, or 1-2 hop neighborhood around a node).",
						"inputSchema": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"focus":               map[string]any{"type": "string", "description": "Optional note path, slug, or paper key to inspect neighborhood around"},
								"depth":               map[string]any{"type": "integer", "description": "BFS hop depth when focus is set (default 2)"},
								"include_agent_brain": map[string]any{"type": "boolean", "description": "Include .dupe/brain/ blackboard nodes"},
								"project_id":          map[string]any{"type": "string", "description": "Optional project ID or folder name"},
							},
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
		matches := make([]Paper, 0)
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

	case "record_provenance":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		cfg, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		saved, recErr := recordProjectProvenance(ctx, projDir, ProvenanceEntry{
			TargetPath:   strArg("target_path"),
			SourceScript: strArg("source_script"),
			Command:      strArg("command"),
			Notes:        strArg("notes"),
		})
		if recErr != nil {
			return fmt.Sprintf("Failed to record provenance: %v", recErr), true
		}
		_ = s.regenerateProjectArtifacts(ctx, projDir, userID, cfg)
		out, _ := json.MarshalIndent(saved, "", "  ")
		return string(out), false

	case "check_provenance":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		_, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		results, chkErr := checkProjectProvenance(ctx, projDir)
		if chkErr != nil {
			return fmt.Sprintf("Failed to check provenance: %v", chkErr), true
		}
		if results == nil {
			results = []ProvenanceCheckResult{}
		}
		out, _ := json.MarshalIndent(results, "", "  ")
		return string(out), false

	case "agent_brain_post":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		_, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		var links []string
		if rawLinks, ok := args["links"].([]any); ok {
			for _, item := range rawLinks {
				if sVal, ok2 := item.(string); ok2 && strings.TrimSpace(sVal) != "" {
					links = append(links, sVal)
				}
			}
		}
		relWritten, postErr := postAgentBlackboardEntry(projDir, strArg("topic"), strArg("agent"), strArg("summary"), strArg("body"), links)
		if postErr != nil {
			return fmt.Sprintf("Failed to post to agent brain: %v", postErr), true
		}
		return fmt.Sprintf("Posted agent brainstorm entry to %s (human notes/ kept clean).", relWritten), false

	case "agent_brain_read":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		_, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		text, readErr := readAgentBlackboard(projDir, strArg("topic"), strArg("query"), 250)
		if readErr != nil {
			return readErr.Error(), true
		}
		return text, false

	case "write_brain_note":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		cfg, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		forceFlag, _ := args["force"].(bool)
		writtenRel, wErr := writeCuratedBrainNote(projDir, strArg("path"), strArg("content"), forceFlag)
		if wErr != nil {
			return wErr.Error(), true
		}
		_ = s.regenerateProjectArtifacts(ctx, projDir, userID, cfg)
		return fmt.Sprintf("Saved curated brain note at %s and updated AGENTS.md brain status.", writtenRel), false

	case "agent_brain_promote":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		cfg, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		writtenRel, pErr := promoteBlackboardTopic(projDir, strArg("source_topic"), strArg("concept_slug"), strArg("content"), false)
		if pErr != nil {
			return pErr.Error(), true
		}
		_ = s.regenerateProjectArtifacts(ctx, projDir, userID, cfg)
		return fmt.Sprintf("Promoted brainstorm into curated concept note %s.", writtenRel), false

	case "get_brain_graph":
		projID := strArg("project_id")
		if projID == "" {
			projID = "default"
		}
		cfg, projDir, err := s.lookupProjectDir(ctx, userID, projID, username)
		if err != nil {
			return fmt.Sprintf("Project %q not found: %v", projID, err), true
		}
		papers, _ := s.queryLinkedPapersForProject(ctx, userID, cfg)
		refs := make([]RefIndexEntry, 0, len(papers))
		for _, p := range papers {
			refs = append(refs, RefIndexEntry{
				PaperID:   p.ID,
				BibtexKey: p.BibtexKey,
				Title:     p.Title,
				Tags:      p.Tags,
			})
		}
		includeAgent, _ := args["include_agent_brain"].(bool)
		depth := 2
		if rawDepth, ok := args["depth"].(float64); ok && rawDepth > 0 {
			depth = int(rawDepth)
		}
		graph := buildProjectBrainGraph(ctx, projDir, refs, BrainGraphOptions{
			IncludeAgentBrain: includeAgent,
			Focus:             strArg("focus"),
			Depth:             depth,
		})
		out, _ := json.MarshalIndent(graph, "", "  ")
		return string(out), false

	default:
		return fmt.Sprintf("Unknown tool: %s", toolName), true
	}
}
