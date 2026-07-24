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

// TestPreviousCoverageSurvivesAcrossRuns is the regression test for keeping
// coverage visible while a fresh run is still computing its own: a new run
// writes meta.json early (before any tier of its own is ready — see run()),
// and that write must not blank out coverage a previous run already
// produced, since the tile PNGs it describes are still genuinely on disk
// untouched at that point.
func TestPreviousCoverageSurvivesAcrossRuns(t *testing.T) {
	dir := t.TempDir()
	metaPath := filepath.Join(dir, "meta.json")

	if got := previousCoverage(dir); got != nil {
		t.Fatalf("expected nil for a genuine first run (no meta.json yet), got %+v", got)
	}

	write := func(body string) {
		if err := os.WriteFile(metaPath, []byte(body), 0o644); err != nil {
			t.Fatalf("writing meta.json: %v", err)
		}
	}

	write(`not valid json`)
	if got := previousCoverage(dir); got != nil {
		t.Errorf("expected nil for unparseable meta.json, got %+v", got)
	}

	// Deliberately incomplete (complete:false, as a run still in progress or
	// one that crashed would leave it) — previousCoverage must still surface
	// whatever tiles it named, since those tiles are real regardless of
	// whether the run that made them ever finished.
	write(`{"complete":false,"coverage":{"standard":{"tiles":[{"image":"coverage-0-0.png"}]}}}`)
	got := previousCoverage(dir)
	if got == nil || got.Standard == nil {
		t.Fatalf("expected a non-nil Standard coverage from an incomplete meta.json, got %+v", got)
	}
	if len(got.Standard.Tiles) != 1 || got.Standard.Tiles[0].Image != "coverage-0-0.png" {
		t.Errorf("Standard.Tiles = %+v, want one tile named coverage-0-0.png", got.Standard.Tiles)
	}
	if got.Precision != nil {
		t.Errorf("expected nil Precision (never present in this meta.json), got %+v", got.Precision)
	}
}

// TestTierFreshToday is the regression test for the per-tier same-day skip
// (see run()'s shouldComputeTier) — a deploy-time restart or an
// /admin/recompute call shouldn't redo an expensive Precision pass that
// already finished a few hours earlier the same day, but must still
// recompute a tier that's missing entirely, stale from a previous day, or
// has an unparseable timestamp (an older writer, before GeneratedAt
// existed).
func TestTierFreshToday(t *testing.T) {
	now := time.Date(2026, 7, 24, 15, 0, 0, 0, time.UTC)

	if got := tierFreshToday(nil, now); got {
		t.Error("nil (no previous tier at all — e.g. a genuine first run) should never be considered fresh")
	}

	if got := tierFreshToday(&coverageMeta{}, now); got {
		t.Error("an empty GeneratedAt (a tier written before this field existed) should never be considered fresh")
	}

	if got := tierFreshToday(&coverageMeta{GeneratedAt: "not a timestamp"}, now); got {
		t.Error("an unparseable GeneratedAt should never be considered fresh")
	}

	earlierToday := time.Date(2026, 7, 24, 3, 0, 0, 0, time.UTC).Format(time.RFC3339)
	if got := tierFreshToday(&coverageMeta{GeneratedAt: earlierToday}, now); !got {
		t.Errorf("a tier generated earlier the same UTC day (%s) should be fresh relative to now (%s)", earlierToday, now)
	}

	justBeforeMidnightUTC := time.Date(2026, 7, 23, 23, 59, 59, 0, time.UTC).Format(time.RFC3339)
	if got := tierFreshToday(&coverageMeta{GeneratedAt: justBeforeMidnightUTC}, now); got {
		t.Error("a tier generated the previous UTC calendar day (even just over a minute earlier) should not be fresh")
	}

	// A non-UTC offset that's still the same UTC calendar day once
	// normalized — tierFreshToday must compare in UTC, not the timestamp's
	// own literal offset, since GeneratedAt is always written in UTC (see
	// buildCoverageMeta) but should tolerate whatever it's given.
	sameUTCDayDifferentOffset := "2026-07-25T00:30:00+02:00" // = 2026-07-24T22:30:00Z
	if got := tierFreshToday(&coverageMeta{GeneratedAt: sameUTCDayDifferentOffset}, now); !got {
		t.Errorf("%s normalizes to the same UTC calendar day as %s and should be fresh", sameUTCDayDifferentOffset, now)
	}
}

// TestPreviousScopeCoverageSurvivesAcrossRuns mirrors
// TestPreviousCoverageSurvivesAcrossRuns for ScopeCoverage — same
// rationale: a fresh run's early meta.json write must not blank out
// per-scope tiles a previous run already produced.
func TestPreviousScopeCoverageSurvivesAcrossRuns(t *testing.T) {
	dir := t.TempDir()
	metaPath := filepath.Join(dir, "meta.json")

	if got := previousScopeCoverage(dir); got != nil {
		t.Fatalf("expected nil for a genuine first run (no meta.json yet), got %+v", got)
	}

	write := func(body string) {
		if err := os.WriteFile(metaPath, []byte(body), 0o644); err != nil {
			t.Fatalf("writing meta.json: %v", err)
		}
	}

	write(`not valid json`)
	if got := previousScopeCoverage(dir); got != nil {
		t.Errorf("expected nil for unparseable meta.json, got %+v", got)
	}

	write(`{"complete":false,"scope_coverage":{"#fif":{"tiles":[{"image":"coverage-scope-fif-0-0.png"}]}}}`)
	got := previousScopeCoverage(dir)
	if got == nil || got["#fif"] == nil {
		t.Fatalf("expected a non-nil #fif entry from an incomplete meta.json, got %+v", got)
	}
	if len(got["#fif"].Tiles) != 1 || got["#fif"].Tiles[0].Image != "coverage-scope-fif-0-0.png" {
		t.Errorf("#fif.Tiles = %+v, want one tile named coverage-scope-fif-0-0.png", got["#fif"].Tiles)
	}
	if _, ok := got["#sco"]; ok {
		t.Errorf("expected no #sco entry (never present in this meta.json), got %+v", got["#sco"])
	}
}
