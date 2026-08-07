//go:build !js

package demgrid

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCleanStaleScratch covers the two production incidents recorded in
// CleanStaleScratch's doc comment: orphaned mmap scratch files left by
// processes that died before Grid.Close could run, which twice filled a
// host's disk (17GB from cmd/hopreach, 29GB from cmd/hopreach-gpuworker).
func TestCleanStaleScratch(t *testing.T) {
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

	CleanStaleScratch(demCacheDir)

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("expected stale scratch file to be removed, stat err = %v", err)
	}
	if _, err := os.Stat(subdir); err != nil {
		t.Errorf("expected the (unexpected but harmless) subdirectory to be left alone, got %v", err)
	}

	// A demCacheDir that has never cached anything (no grid-scratch dir at
	// all) must be a silent no-op, not a panic or an error.
	CleanStaleScratch(t.TempDir())
}

// TestCleanStaleScratchLeavesTileCache guards the boundary that matters
// operationally: the sibling zoom-level tile directories are the legitimate
// persistent cache (2.4GB on the GPU box against 29GB of scratch) and
// re-downloading them is slow. Only grid-scratch is swept.
func TestCleanStaleScratchLeavesTileCache(t *testing.T) {
	demCacheDir := t.TempDir()
	scratchDir := filepath.Join(demCacheDir, "grid-scratch")
	if err := os.MkdirAll(scratchDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(scratchDir, "hopreach-dem-grid-1.bin"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	tile := filepath.Join(demCacheDir, "13", "4021")
	if err := os.MkdirAll(tile, 0o755); err != nil {
		t.Fatal(err)
	}
	tilePath := filepath.Join(tile, "2578.png")
	if err := os.WriteFile(tilePath, []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}

	CleanStaleScratch(demCacheDir)

	if _, err := os.Stat(tilePath); err != nil {
		t.Errorf("cached DEM tile must survive the scratch sweep, got %v", err)
	}
}
