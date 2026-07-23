package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCleanStaleGridScratch is the regression test for a real production
// incident: a box's disk filled to 69% because 13 crashed runs (OOM kills,
// timeouts, chasing GPU dispatch bugs) each left behind a demgrid mmap
// scratch file that was never cleaned up (grid.Close() only runs on the
// normal, non-crashing path) — 17GB total. cleanStaleGridScratch is called
// unconditionally at the top of every run() specifically to sweep these up.
func TestCleanStaleGridScratch(t *testing.T) {
	demCacheDir := t.TempDir()
	scratchDir := filepath.Join(demCacheDir, "grid-scratch")
	if err := os.MkdirAll(scratchDir, 0o755); err != nil {
		t.Fatal(err)
	}

	stale := filepath.Join(scratchDir, "hopreach-dem-grid-12345.bin")
	if err := os.WriteFile(stale, []byte("fake grid data"), 0o644); err != nil {
		t.Fatal(err)
	}
	subdir := filepath.Join(scratchDir, "unexpected-subdir")
	if err := os.MkdirAll(subdir, 0o755); err != nil {
		t.Fatal(err)
	}

	cleanStaleGridScratch(demCacheDir)

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("expected stale scratch file to be removed, stat err = %v", err)
	}
	if _, err := os.Stat(subdir); err != nil {
		t.Errorf("expected the (unexpected but harmless) subdirectory to be left alone, got %v", err)
	}

	// A demCacheDir that's never had anything cached (no grid-scratch dir
	// at all yet) must not panic or error — just a no-op.
	cleanStaleGridScratch(t.TempDir())
}
