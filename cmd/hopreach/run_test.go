package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"hopreach/internal/analytics"
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

// TestRecordCrashedRunIfAny is the regression test for a real gap found
// right after a genuine production OOM: a run killed by the kernel
// mid-pass never reaches its own defer (SIGKILL gives Go no chance to run
// any cleanup at all), so it left zero trace in analytics/runs.jsonl —
// nothing to distinguish "the box was quiet" from "something crashed."
// recordCrashedRunIfAny, called at the start of the *next* run, is what
// gives that silent failure a RunRecord of its own.
func TestRecordCrashedRunIfAny(t *testing.T) {
	dir := t.TempDir()
	runsPath := filepath.Join(dir, "runs.jsonl")
	markerPath := filepath.Join(dir, "in_progress.json")
	progressPath := filepath.Join(dir, "progress.json")

	// No marker at all (the common case: every previous run finished
	// cleanly and cleared its own) — must not fabricate a crash record.
	recordCrashedRunIfAny(runsPath, markerPath, progressPath)
	if got, err := analytics.ReadAll[analytics.RunRecord](runsPath); err != nil || len(got) != 0 {
		t.Fatalf("expected no RunRecord written with no leftover marker, got %+v (err=%v)", got, err)
	}

	// A leftover marker (the crash scenario) plus a progress.json showing
	// what stage it died in.
	startedAt := time.Now().Add(-90 * time.Second)
	markerBody, _ := json.Marshal(analytics.InProgressMarker{StartedAt: startedAt})
	if err := os.WriteFile(markerPath, append(markerBody, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(progressPath, []byte(`{"stage":"computing_coverage_precision","done":0,"total":1}`), 0o644); err != nil {
		t.Fatal(err)
	}

	recordCrashedRunIfAny(runsPath, markerPath, progressPath)

	got, err := analytics.ReadAll[analytics.RunRecord](runsPath)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected exactly one synthesized crash RunRecord, got %d: %+v", len(got), got)
	}
	rec := got[0]
	if rec.Success {
		t.Error("expected Success=false for a crashed run")
	}
	if !rec.StartedAt.Equal(startedAt) {
		t.Errorf("StartedAt = %v, want %v (from the leftover marker)", rec.StartedAt, startedAt)
	}
	if rec.Error == "" {
		t.Error("expected a non-empty Error explaining the crash")
	}
	wantStageMention := "computing_coverage_precision"
	if !strings.Contains(rec.Error, wantStageMention) {
		t.Errorf("Error = %q, want it to mention the last known stage %q from progress.json", rec.Error, wantStageMention)
	}
}
