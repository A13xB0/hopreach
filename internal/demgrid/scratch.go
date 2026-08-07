//go:build !js

package demgrid

import (
	"log"
	"os"
	"path/filepath"
)

// CleanStaleScratch removes leftover mmap scratch files (see mmapFloat32)
// from a previous process that never reached Grid.Close.
//
// Close runs on the normal path and via defer on error paths, but a process
// that dies outright — OOM kill, SIGKILL, panic — never runs deferred
// functions at all, so its scratch file survives. Each one can be a
// gigabyte or more, and they are sparse, so `ls` understates them badly
// while `df` does not.
//
// This has bitten twice in production, which is why it now lives here
// rather than in one command:
//   - cmd/hopreach: 13 orphaned files, 17GB, from one night of debugging
//     GPU dispatch issues.
//   - cmd/hopreach-gpuworker: 101 orphaned files, 29GB on disk (96.5GB
//     apparent), accumulated over 16 days of occasional crash-restarts.
//     That one filled the box's 35GB root filesystem completely and every
//     job then failed with "create scratch file: no space left on device"
//     — 2,632 of them in 78 minutes — because the worker never had the
//     sweep cmd/hopreach already had.
//
// CALLER CONTRACT: call this when no grid can be in use by this process —
// at startup, or under a lock that guarantees a single active run. Removing
// a file another process still has mmap'd is not corrupting on Linux (the
// mapping holds the inode open until munmap, and that process's own
// os.Remove then simply fails), but the space is not reclaimed until it
// exits, so a sweep racing a live sibling is merely useless, not harmful.
//
// Deliberately best-effort: a missing directory (nothing cached yet) or an
// unremovable file are logged and ignored rather than failing the caller.
// This is disk hygiene, not correctness.
func CleanStaleScratch(demCacheDir string) {
	dir := filepath.Join(demCacheDir, "grid-scratch")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if err := os.Remove(path); err != nil {
			log.Printf("demgrid: could not remove stale grid-scratch file %s: %v", path, err)
		}
	}
}
