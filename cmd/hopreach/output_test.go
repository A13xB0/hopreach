package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestLastGeneratedAtIgnoresIncompleteRuns is the regression test for a
// real production incident: this process's own meta.json is written early
// (before any raster), so a run that crashes partway through — an OOM, a
// kill, any abrupt exit — leaves behind a *recent* but *incomplete*
// meta.json. Without checking Complete, the next container start would see
// that recent timestamp, believe a full render just happened, and skip
// retrying, leaving stale/partial coverage data live indefinitely.
func TestLastGeneratedAtIgnoresIncompleteRuns(t *testing.T) {
	dir := t.TempDir()
	metaPath := filepath.Join(dir, "meta.json")
	recent := time.Now().UTC().Add(-time.Minute).Format(time.RFC3339)

	write := func(body string) {
		if err := os.WriteFile(metaPath, []byte(body), 0o644); err != nil {
			t.Fatalf("writing meta.json: %v", err)
		}
	}

	if _, ok := lastGeneratedAt(dir); ok {
		t.Fatalf("expected ok=false when meta.json doesn't exist yet")
	}

	write(`{"generated_at":"` + recent + `","complete":false}`)
	if _, ok := lastGeneratedAt(dir); ok {
		t.Errorf("expected ok=false for a recent but incomplete meta.json (crashed mid-run)")
	}

	write(`{"generated_at":"` + recent + `"}`) // complete omitted entirely, same as false
	if _, ok := lastGeneratedAt(dir); ok {
		t.Errorf("expected ok=false when complete is entirely absent (older/crashed writer)")
	}

	write(`not valid json`)
	if _, ok := lastGeneratedAt(dir); ok {
		t.Errorf("expected ok=false for unparseable meta.json")
	}

	write(`{"generated_at":"` + recent + `","complete":true}`)
	got, ok := lastGeneratedAt(dir)
	if !ok {
		t.Fatalf("expected ok=true for a complete, recently-written meta.json")
	}
	if age := time.Since(got); age < 0 || age > 5*time.Minute {
		t.Errorf("lastGeneratedAt = %v, want roughly 1 minute ago (got age %v)", got, age)
	}
}
