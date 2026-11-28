package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBrainGraphBlackboardAntiBloatAndMCP(t *testing.T) {
	ctx := context.Background()
	storageDir := t.TempDir()
	db, err := initSQLiteDB(ctx, filepath.Join(storageDir, "library.db"))
	if err != nil {
		t.Fatalf("init sqlite: %v", err)
	}
	defer db.Close()
	_ = createOrUpdateUser(ctx, db, "local", "local-mode-implicit-user", "#FFEB3B")

	srv := &Server{
		db:          db,
		jwtSecret:   []byte("test-secret-at-least-32-bytes-long"),
		storageDir:  storageDir,
		projectsDir: t.TempDir(),
		mode:        "local",
		offlineMeta: true,
	}

	cfg, projDir, err := srv.createProjectOnDisk(ctx, 1, "local", "Brain Test Paper", "", "", true)
	if err != nil {
		t.Fatalf("createProjectOnDisk: %v", err)
	}

	// Verify .dupe/brain/topics and notes/concepts were initialized and .dupe/brain/ is gitignored.
	if _, err := os.Stat(filepath.Join(projDir, ".dupe", "brain", "topics")); err != nil {
		t.Fatalf("expected .dupe/brain/topics: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projDir, "notes", "concepts")); err != nil {
		t.Fatalf("expected notes/concepts: %v", err)
	}
	giBytes, _ := os.ReadFile(filepath.Join(projDir, ".gitignore"))
	if !strings.Contains(string(giBytes), ".dupe/brain/") {
		t.Fatalf("expected .gitignore to include .dupe/brain/, got:\n%s", string(giBytes))
	}

	// 1. Agent posts messy brainstorm to .dupe/brain/ without touching notes/.
	outPost, isErr := srv.executeMCPTool(ctx, 1, "local", "agent_brain_post", map[string]any{
		"project_id": cfg.ID,
		"topic":      "reward-drift",
		"agent":      "dupe-code",
		"summary":    "Horizon instability above 40 steps",
		"body":       "Dead end: clipping gradient at 0.5 failed. Next hypothesis links to [[policy-smoothing]].",
		"links":      []any{"MOC", "paper:sutton1990"},
	})
	if isErr {
		t.Fatalf("agent_brain_post failed: %s", outPost)
	}
	if _, err := os.Stat(filepath.Join(projDir, ".dupe", "brain", "topics", "reward-drift.md")); err != nil {
		t.Fatalf("expected topic file: %v", err)
	}

	outRead, isErr := srv.executeMCPTool(ctx, 1, "local", "agent_brain_read", map[string]any{
		"project_id": cfg.ID,
		"topic":      "reward-drift",
	})
	if isErr || !strings.Contains(outRead, "Horizon instability") {
		t.Fatalf("agent_brain_read unexpected: isErr=%v out=%s", isErr, outRead)
	}

	// 2. Anti-bloat gate rejects oversized notes while ignoring inline code examples like `[[wikilinks]]`.
	var longLines strings.Builder
	longLines.WriteString("---\ntype: concept\ntags: [test]\n---\n\nSee [[MOC]].\n")
	for i := 0; i < 165; i++ {
		longLines.WriteString("- Verbose filler line\n")
	}
	bloatResp, bloatErr := srv.executeMCPTool(ctx, 1, "local", "write_brain_note", map[string]any{
		"project_id": cfg.ID,
		"path":       "notes/concepts/too-big.md",
		"content":    longLines.String(),
	})
	if !bloatErr || !strings.Contains(bloatResp, "anti-bloat rejection") {
		t.Fatalf("expected anti-bloat rejection for >150 lines, got err=%v resp=%s", bloatErr, bloatResp)
	}

	// Clean note mentioning `[[not-a-link]]` in backticks must NOT create a ghost node.
	docResp, docErr := srv.executeMCPTool(ctx, 1, "local", "write_brain_note", map[string]any{
		"project_id": cfg.ID,
		"path":       "notes/syntax-guide.md",
		"content":    "# Syntax\n\nUse `[[not-a-ghost]]` syntax.\n",
	})
	if docErr {
		t.Fatalf("write_brain_note failed: %s", docResp)
	}

	// 3. Promote concise insight cleanly into notes/concepts/policy-smoothing.md.
	promResp, promErr := srv.executeMCPTool(ctx, 1, "local", "agent_brain_promote", map[string]any{
		"project_id":   cfg.ID,
		"source_topic": "reward-drift",
		"concept_slug": "policy-smoothing",
		"content":      "---\ntype: concept\nstatus: active\ntags: [control, stability]\naliases: [Action Smoothing]\n---\n\n# Policy Smoothing\n\nBounds step-to-step torque deltas; connects to [[syntax-guide]] and [[missing-ablation]] via [[paper:sutton1990]].\n",
	})
	if promErr {
		t.Fatalf("agent_brain_promote failed: %s", promResp)
	}

	// Also create a second note linking via alias [[Action Smoothing]].
	noteResp, noteErr := srv.executeMCPTool(ctx, 1, "local", "write_brain_note", map[string]any{
		"project_id": cfg.ID,
		"path":       "notes/ablation-summary.md",
		"content":    "---\ntype: note\ntags: [experiments]\n---\n\nTested [[Action Smoothing]] cleanly.\n",
	})
	if noteErr {
		t.Fatalf("write_brain_note failed: %s", noteResp)
	}

	// 4. Inspect full graph without agent blackboard vs with agent blackboard.
	humanGraphJSON, gErr := srv.executeMCPTool(ctx, 1, "local", "get_brain_graph", map[string]any{
		"project_id":          cfg.ID,
		"include_agent_brain": false,
	})
	if gErr {
		t.Fatalf("get_brain_graph failed: %s", humanGraphJSON)
	}
	var gHuman BrainGraph
	if err := json.Unmarshal([]byte(humanGraphJSON), &gHuman); err != nil {
		t.Fatalf("unmarshal graph: %v", err)
	}
	if gHuman.Summary.BlackboardCount != 0 {
		t.Fatalf("expected 0 blackboard nodes when include_agent_brain=false, got %d", gHuman.Summary.BlackboardCount)
	}
	if gHuman.Summary.GhostCount != 1 || len(gHuman.Summary.Ghosts) != 1 || gHuman.Summary.Ghosts[0] != "missing-ablation" {
		t.Fatalf("expected only unresolved ghost [[missing-ablation]] (ignoring inline code), got %+v", gHuman.Summary.Ghosts)
	}

	// Verify AGENTS.md includes Two-Zone discipline.
	agentsBytes, _ := os.ReadFile(filepath.Join(projDir, "AGENTS.md"))
	agentsText := string(agentsBytes)
	if !strings.Contains(agentsText, "Two-Zone Brain & Zero-Bloat Discipline") || !strings.Contains(agentsText, "### Knowledge Brain Status") {
		t.Fatalf("expected AGENTS.md to contain Two-Zone Brain section, got:\n%s", agentsText)
	}
}
