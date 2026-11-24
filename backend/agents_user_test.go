package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeAgentsWithUserBlock(t *testing.T, dir, desc string) {
	t.Helper()
	content := "# AGENTS.md\n\n" + agentsUserStartMarker + "\n" + desc + "\n" + agentsUserEndMarker + "\n"
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func setMTime(t *testing.T, path string, ts time.Time) {
	t.Helper()
	if err := os.Chtimes(path, ts, ts); err != nil {
		t.Fatal(err)
	}
}

func TestResolveUserDescriptionSyncMirror(t *testing.T) {
	dir := t.TempDir()
	notePath := filepath.Join(dir, "notes", agentsUserNoteName)
	agentsPath := filepath.Join(dir, "AGENTS.md")
	old := time.Now().Add(-time.Hour)

	// Placeholder only: nothing to mirror.
	writeAgentsWithUserBlock(t, dir, agentsUserPlaceholder)
	if got := resolveUserDescription(dir); got != "" {
		t.Fatalf("placeholder: want empty, got %q", got)
	}
	if _, err := os.Stat(notePath); err == nil {
		t.Fatal("placeholder must not create the mirror note")
	}

	// Legacy AGENTS.md content migrates into the synced note.
	writeAgentsWithUserBlock(t, dir, "Mac setup v1")
	if got := resolveUserDescription(dir); got != "Mac setup v1" {
		t.Fatalf("migration: got %q", got)
	}
	if raw, _ := os.ReadFile(notePath); strings.TrimSpace(string(raw)) != "Mac setup v1" {
		t.Fatalf("migration: note = %q", raw)
	}

	// Note pulled from another machine (newer) wins over the stale local AGENTS.md.
	setMTime(t, agentsPath, old)
	_ = os.WriteFile(notePath, []byte("Mac setup v2 from remote\n"), 0o644)
	if got := resolveUserDescription(dir); got != "Mac setup v2 from remote" {
		t.Fatalf("pulled note: got %q", got)
	}

	// Local edit of AGENTS.md (newer) is copied back into the note.
	setMTime(t, notePath, old)
	writeAgentsWithUserBlock(t, dir, "Edited locally in AGENTS.md")
	if got := resolveUserDescription(dir); got != "Edited locally in AGENTS.md" {
		t.Fatalf("local edit: got %q", got)
	}
	if raw, _ := os.ReadFile(notePath); strings.TrimSpace(string(raw)) != "Edited locally in AGENTS.md" {
		t.Fatalf("local edit: note = %q", raw)
	}

	// Fresh machine: AGENTS.md has only the placeholder, the synced note provides the content.
	writeAgentsWithUserBlock(t, dir, agentsUserPlaceholder)
	if got := resolveUserDescription(dir); got != "Edited locally in AGENTS.md" {
		t.Fatalf("fresh machine: got %q", got)
	}
}
