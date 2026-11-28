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

	// Verify .dupe/brain and notes/MOC.md were initialized and .dupe/brain/ is gitignored.
	if _, err := os.Stat(filepath.Join(projDir, ".dupe", "brain", "blackboard.md")); err != nil {
		t.Fatalf("expected .dupe/brain/blackboard.md: %v", err)
	}
	if _, err := os.Stat(filepath.Join(projDir, "notes", "MOC.md")); err != nil {
		t.Fatalf("expected notes/MOC.md: %v", err)
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

	// 2. Anti-bloat gate rejects oversized notes and unlinked notes.
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

	unlinkedResp, unlinkedErr := srv.executeMCPTool(ctx, 1, "local", "write_brain_note", map[string]any{
		"project_id": cfg.ID,
		"path":       "notes/concepts/isolated.md",
		"content":    "# Isolated\n\nNo wikilinks here.\n",
	})
	if !unlinkedErr || !strings.Contains(unlinkedResp, "must include at least one Obsidian link") {
		t.Fatalf("expected orphan rejection when no wikilink, got err=%v resp=%s", unlinkedErr, unlinkedResp)
	}

	// 3. Promote concise insight cleanly into notes/concepts/policy-smoothing.md.
	promResp, promErr := srv.executeMCPTool(ctx, 1, "local", "agent_brain_promote", map[string]any{
		"project_id":   cfg.ID,
		"source_topic": "reward-drift",
		"concept_slug": "policy-smoothing",
		"content":      "---\ntype: concept\nstatus: active\ntags: [control, stability]\naliases: [Action Smoothing]\n---\n\n# Policy Smoothing\n\nBounds step-to-step torque deltas; connects to [[MOC]] and [[missing-ablation]] via [[paper:sutton1990]].\n",
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
	if gHuman.Summary.GhostCount == 0 {
		t.Fatalf("expected unresolved ghost node for [[missing-ablation]]")
	}

	foundAliasBacklink := false
	for _, n := range gHuman.Nodes {
		if n.Path == "notes/concepts/policy-smoothing.md" && n.Backlinks >= 1 {
			foundAliasBacklink = true
		}
	}
	if !foundAliasBacklink {
		t.Fatalf("expected alias [[Action Smoothing]] to resolve as backlink onto policy-smoothing.md; nodes=%+v", gHuman.Nodes)
	}

	// Verify AGENTS.md includes compact Knowledge Brain Status & Anti-Bloat Rules.
	agentsBytes, _ := os.ReadFile(filepath.Join(projDir, "AGENTS.md"))
	agentsText := string(agentsBytes)
	if !strings.Contains(agentsText, "Two-Zone Brain & Anti-Bloat Discipline") || !strings.Contains(agentsText, "### Knowledge Brain Status") {
		t.Fatalf("expected AGENTS.md to contain Two-Zone Brain section, got:\n%s", agentsText)
	}
}
