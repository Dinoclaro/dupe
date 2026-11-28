package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnsureProjectGitIgnoreAndUntrackBloat(t *testing.T) {
	ctx := context.Background()
	projDir := t.TempDir()
	paperDir := filepath.Join(projDir, "paper")
	buildDir := filepath.Join(projDir, ".dupe", "build")
	scratchDir := filepath.Join(projDir, "scratch")
	refsDir := filepath.Join(projDir, "refs")
	notesDir := filepath.Join(projDir, "notes")
	for _, d := range []string{paperDir, buildDir, scratchDir, refsDir, notesDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	initGitRepoIfNeeded(ctx, projDir, "dino")

	// Simulate an older project where bloat files were already committed before .gitignore was updated.
	if err := os.WriteFile(filepath.Join(scratchDir, "exp.py"), []byte("print('temp')\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(buildDir, "main.pdf"), []byte("%PDF-1.4\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(refsDir, "paper1.pdf"), []byte("%PDF-1.4\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(notesDir, "idea.md"), []byte("# Idea\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if committed, _, err := commitAllIfDirty(ctx, projDir, "initial bloated commit"); err != nil || !committed {
		t.Fatalf("initial commit failed: committed=%v err=%v", committed, err)
	}

	if err := ensureProjectGitIgnore(projDir); err != nil {
		t.Fatalf("ensureProjectGitIgnore: %v", err)
	}

	// Untracked from index, but preserved on disk.
	tracked, err := runGitCommand(ctx, projDir, "ls-files")
	if err != nil {
		t.Fatalf("git ls-files: %v", err)
	}
	for _, banned := range []string{"scratch/exp.py", ".dupe/build/main.pdf", "refs/paper1.pdf"} {
		if strings.Contains(tracked, banned) {
			t.Fatalf("expected %s to be removed from git index, still tracked:\n%s", banned, tracked)
		}
	}
	for _, keepOnDisk := range []string{
		filepath.Join(scratchDir, "exp.py"),
		filepath.Join(buildDir, "main.pdf"),
		filepath.Join(refsDir, "paper1.pdf"),
	} {
		if _, statErr := os.Stat(keepOnDisk); statErr != nil {
			t.Fatalf("expected file %s to remain on disk after untrack: %v", keepOnDisk, statErr)
		}
	}

	// New scratch/pdf bloat added later stays ignored on commitAllIfDirty.
	_ = os.WriteFile(filepath.Join(scratchDir, "new_run.log"), []byte("noise\n"), 0o644)
	_ = os.WriteFile(filepath.Join(refsDir, "paper2.pdf"), []byte("%PDF-1.4\n"), 0o644)
	if committed, _, err := commitAllIfDirty(ctx, projDir, "clean sync"); err != nil {
		t.Fatalf("commitAllIfDirty: %v", err)
	} else if committed {
		// Check that only .gitignore + index cleanup were committed, never the new bloat files.
		show, _ := runGitCommand(ctx, projDir, "show", "--stat", "--oneline", "HEAD")
		if strings.Contains(show, "new_run.log") || strings.Contains(show, "paper2.pdf") {
			t.Fatalf("expected ignored bloat files not to be committed, got:\n%s", show)
		}
	}
}
