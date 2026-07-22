package main

import (
	"fmt"
	"os"
	"syscall"
)

// lockPath is process-wide (not per-config), deliberately: the fetch/compute
// pipeline can now be triggered from three independent places — the Docker
// entrypoint's own background initial run, the daily cron job, and (see
// cmd/hopreach-shareapi's /admin/recompute) an on-demand trigger — and
// letting two of them race, both writing repeaters.geojson/meta.json/the
// coverage tiles at once, would silently corrupt the output rather than
// fail loudly. A single well-known lock file makes that impossible
// regardless of which combination fires.
const lockPath = "/tmp/hopreach.lock"

// acquireLock takes a non-blocking exclusive flock, releasing automatically
// if this process dies for any reason (flock is tied to the open file
// descriptor, not explicitly released) — no stale-lock cleanup needed.
// Returns an error immediately (not after waiting) if another run already
// holds it.
func acquireLock() (*os.File, error) {
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("opening lock file: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another run already in progress")
	}
	return f, nil
}
