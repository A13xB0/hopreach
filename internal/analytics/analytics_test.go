package analytics

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAppendAndReadAllRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runs.jsonl")

	r1 := RunRecord{StartedAt: time.Now(), Success: true, Version: "v0.1.9"}
	r2 := RunRecord{StartedAt: time.Now(), Success: false, Error: "boom"}

	if err := Append(path, r1, 0); err != nil {
		t.Fatalf("Append r1: %v", err)
	}
	if err := Append(path, r2, 0); err != nil {
		t.Fatalf("Append r2: %v", err)
	}

	got, err := ReadAll[RunRecord](path)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("ReadAll returned %d records, want 2", len(got))
	}
	if got[0].Version != "v0.1.9" || got[1].Error != "boom" {
		t.Errorf("records came back wrong: %+v", got)
	}
}

// TestAppendCreatesParentDirectory is the regression test for a real
// production bug: every caller passes a path under a sibling "analytics"
// directory (next to output_dir) that's never explicitly created anywhere
// else, and the first deploy of this feature silently failed every single
// write with "no such file or directory" because Append assumed the
// directory already existed.
func TestAppendCreatesParentDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "analytics", "runs.jsonl")
	if err := Append(path, RunRecord{Success: true}, 0); err != nil {
		t.Fatalf("Append into a non-existent parent directory: %v", err)
	}
	got, err := ReadAll[RunRecord](path)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(got) != 1 || !got[0].Success {
		t.Errorf("ReadAll = %+v, want one successful record", got)
	}
}

func TestReadAllMissingFileIsEmptyNotError(t *testing.T) {
	got, err := ReadAll[RunRecord](filepath.Join(t.TempDir(), "does-not-exist.jsonl"))
	if err != nil {
		t.Fatalf("expected no error for a missing file, got %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected an empty slice, got %d entries", len(got))
	}
}

func TestAppendCapsAtMaxLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "samples.jsonl")
	for i := 0; i < 10; i++ {
		if err := Append(path, MemorySample{AvailableBytes: uint64(i)}, 3); err != nil {
			t.Fatalf("Append %d: %v", i, err)
		}
	}
	got, err := ReadAll[MemorySample](path)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected exactly 3 entries after capping, got %d", len(got))
	}
	// Oldest dropped first: the last 3 appended (indices 7, 8, 9) should
	// be what's left.
	for i, want := range []uint64{7, 8, 9} {
		if got[i].AvailableBytes != want {
			t.Errorf("entry %d: AvailableBytes = %d, want %d (oldest entries should be dropped first)", i, got[i].AvailableBytes, want)
		}
	}
}

func TestReadAllSkipsUnparseableLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mixed.jsonl")
	if err := os.WriteFile(path, []byte("{\"time\":\"2026-01-01T00:00:00Z\"}\nnot valid json\n{\"time\":\"2026-01-02T00:00:00Z\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ReadAll[PlanShareEvent](path)
	if err != nil {
		t.Fatalf("ReadAll: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected the 2 valid lines to survive (1 malformed line skipped), got %d", len(got))
	}
}
