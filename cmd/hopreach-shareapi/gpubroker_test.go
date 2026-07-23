package main

import (
	"testing"

	"hopreach/internal/gpujob"
)

func TestBrokerProgressTracking(t *testing.T) {
	b := &gpuBroker{
		pending:  make(map[string]chan gpuJobResult),
		progress: make(map[string]jobProgress),
	}

	// A Progress frame for a job the broker doesn't consider in-flight
	// (nothing in pending) must not create a lingering entry — e.g. a
	// stray/late frame for an already-delivered job.
	b.setProgress("unknown-job", 5, 10)
	if _, _, ok := b.getProgress("unknown-job"); ok {
		t.Error("expected no progress tracked for a job that was never marked pending")
	}

	// Once a job is registered as pending (as submit() does before writing
	// it to the worker), progress updates for it should be tracked.
	ch := make(chan gpuJobResult, 1)
	b.pending["job-1"] = ch
	b.setProgress("job-1", 3, 10)
	done, total, ok := b.getProgress("job-1")
	if !ok || done != 3 || total != 10 {
		t.Fatalf("getProgress after setProgress = (%d, %d, %v), want (3, 10, true)", done, total, ok)
	}

	b.setProgress("job-1", 7, 10)
	done, _, _ = b.getProgress("job-1")
	if done != 7 {
		t.Errorf("expected progress to update to 7, got %d", done)
	}

	// deliver (a completed job, success or failure) must clear its
	// progress entry so it doesn't linger forever.
	go func() { <-ch }() // drain so deliver doesn't block
	b.deliver("job-1", []byte{1, 2, 3, 4}, "")
	if _, _, ok := b.getProgress("job-1"); ok {
		t.Error("expected progress entry to be cleared after deliver")
	}

	// failAllPending (worker disconnected) must clear progress for every
	// still-pending job, not just leave it to be found later.
	ch2 := make(chan gpuJobResult, 1)
	b.pending["job-2"] = ch2
	b.setProgress("job-2", 1, 5)
	go func() { <-ch2 }()
	b.failAllPending("worker disconnected")
	if _, _, ok := b.getProgress("job-2"); ok {
		t.Error("expected progress entry to be cleared after failAllPending")
	}
}

// TestBrokerAvailableBytesResetsOnNewConnection is the regression test for
// a real correctness concern in the memory-auto-sizing feature: a worker's
// self-reported available memory (gpujob.Hello) must not linger past that
// specific connection, since a replacement worker connecting later could be
// an entirely different box with different RAM — stale data here would
// size tiles against the wrong box's memory, exactly the kind of mismatch
// this feature exists to prevent.
func TestBrokerAvailableBytesResetsOnNewConnection(t *testing.T) {
	b := &gpuBroker{
		pending:  make(map[string]chan gpuJobResult),
		progress: make(map[string]jobProgress),
	}

	if got := b.getAvailableBytes(); got != 0 {
		t.Fatalf("getAvailableBytes() on a fresh broker = %d, want 0 (unknown)", got)
	}

	b.setHello(gpujob.Hello{AvailableBytes: 4_700_000_000})
	if got := b.getAvailableBytes(); got != 4_700_000_000 {
		t.Fatalf("getAvailableBytes() after setHello = %d, want 4700000000", got)
	}

	// A new connection (setConn) — whether it's the same worker
	// reconnecting or a genuinely different box — must not carry the old
	// figure forward until (if ever) that new connection sends its own
	// Hello.
	b.setConn(nil)
	if got := b.getAvailableBytes(); got != 0 {
		t.Errorf("getAvailableBytes() after setConn = %d, want reset to 0 (unknown)", got)
	}
}
