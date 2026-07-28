package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

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

// TestStaleConnectionTeardownLeavesNewerConnectionRegistered is the
// regression test for a real production incident: a whole Precision tier
// ran on CPU for hours at roughly 13x the wall-clock cost, because the
// broker reported no worker connected while the worker's own log showed it
// connected and idle.
//
// The sequence: the worker's socket half-opens, the worker notices, gives
// up and reconnects, and the new connection registers. Some time later —
// whenever the OS finally gives up on the old socket — the OLD read loop
// wakes up and tears down. It used to clear the registration
// unconditionally (`if old := b.setConn(nil); old == conn` cleared first
// and only *logged* conditionally), so the stale loop wiped the live
// connection on its way out. Nothing ever re-registered it, because from
// the worker's point of view it was already connected.
func TestStaleConnectionTeardownLeavesNewerConnectionRegistered(t *testing.T) {
	b := &gpuBroker{
		pending:  make(map[string]chan gpuJobResult),
		progress: make(map[string]jobProgress),
	}

	// Two distinct connections. Real *websocket.Conn values aren't needed —
	// the broker only ever compares them by identity.
	first := &websocket.Conn{}
	second := &websocket.Conn{}

	if old := b.setConn(first); old != nil {
		t.Fatalf("setConn on a fresh broker returned old = %v, want nil", old)
	}
	// The worker reconnects; the new connection takes over.
	if old := b.setConn(second); old != first {
		t.Fatalf("setConn returned old = %v, want the first connection", old)
	}
	if !b.connected() {
		t.Fatal("precondition: broker should report connected after the reconnect")
	}

	// Now the stale first connection's read loop finally errors out.
	if cleared := b.clearConnIf(first); cleared {
		t.Error("clearConnIf(first) reported that it cleared the registration — the stale connection must not touch the newer one")
	}
	if !b.connected() {
		t.Fatal("the live (second) connection was torn down by the stale first one's cleanup — this is the production bug")
	}

	// And the live connection must still be able to tear itself down.
	if cleared := b.clearConnIf(second); !cleared {
		t.Error("clearConnIf(second) should clear its own registration")
	}
	if b.connected() {
		t.Error("broker still reports connected after the live connection cleared itself")
	}
}

// A stale teardown must not fail the CURRENT connection's in-flight jobs
// either — those belong to the worker that's still connected and still
// working on them.
func TestStaleConnectionTeardownDoesNotFailLiveJobs(t *testing.T) {
	b := &gpuBroker{
		pending:  make(map[string]chan gpuJobResult),
		progress: make(map[string]jobProgress),
	}
	first := &websocket.Conn{}
	second := &websocket.Conn{}
	b.setConn(first)
	b.setConn(second)

	ch := make(chan gpuJobResult, 1)
	b.pending["job-live"] = ch

	// Mirrors readLoop's error path for the stale connection: failAllPending
	// is only reached when clearConnIf reports it actually cleared.
	if b.clearConnIf(first) {
		b.failAllPending("worker disconnected")
	}

	select {
	case got := <-ch:
		t.Fatalf("in-flight job was failed by a stale connection's teardown: %+v", got)
	default:
	}
}

// End-to-end version of the two tests above, driving the real HTTP handler
// and real websocket connections rather than calling clearConnIf directly —
// so it covers handleGPUWorkerConnect and readLoop as actually wired, which
// is where the production bug lived.
//
// Reproduces the exact production sequence: a worker's socket half-opens,
// the worker gives up and reconnects (registering a second connection),
// and only afterwards does the first connection's read loop notice and
// tear down. The broker must still report a worker connected.
func TestBrokerStaysConnectedWhenAStaleSocketClosesAfterAReconnect(t *testing.T) {
	const token = "test-token"

	// handleGPUWorkerConnect operates on the package-level broker.
	saved := broker
	broker = &gpuBroker{
		pending:  make(map[string]chan gpuJobResult),
		progress: make(map[string]jobProgress),
	}
	t.Cleanup(func() { broker = saved })

	srv := httptest.NewServer(http.HandlerFunc(handleGPUWorkerConnect(token)))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	hdr := http.Header{"Authorization": []string{"Bearer " + token}}

	dial := func() *websocket.Conn {
		t.Helper()
		c, _, err := websocket.DefaultDialer.Dial(wsURL, hdr)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		return c
	}

	waitConnected := func(want bool) {
		t.Helper()
		for i := 0; i < 200; i++ {
			if broker.connected() == want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("broker.connected() = %v, want %v", broker.connected(), want)
	}

	first := dial()
	waitConnected(true)

	// The worker reconnects while the broker still holds the first socket.
	second := dial()
	waitConnected(true)

	// Now the stale first socket finally closes. Its read loop wakes up and
	// tears down — which must not disturb the live second connection.
	first.Close()
	// Give the stale loop time to run its teardown, then confirm the
	// registration survived it.
	time.Sleep(200 * time.Millisecond)
	if !broker.connected() {
		t.Fatal("broker reported no worker after a STALE connection's teardown — the live one was unregistered (the production bug)")
	}

	// The live connection closing does unregister, so a genuinely gone
	// worker is still reported gone.
	second.Close()
	waitConnected(false)
}
