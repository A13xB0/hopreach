package meshsim

import "testing"

// zeroRNG always returns 0 — makes relay timing deterministic in tests that
// don't care about the exact random delay, only whether/when a relay
// happens at all.
type zeroRNG struct{}

func (zeroRNG) IntN(n int) int { return 0 }

func testNode(canRelay bool) SimNode {
	return SimNode{Prefs: DefaultNodePrefs(), CanRelay: canRelay}
}

// TestRunCleanReceptionNoCollision is the baseline case: one sender, one
// listener, nothing else transmitting — the listener must receive the
// packet cleanly (not collided).
func TestRunCleanReceptionNoCollision(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}}, // well above every SF's threshold
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	if len(report.Receptions) != 1 {
		t.Fatalf("expected exactly 1 reception, got %d: %+v", len(report.Receptions), report.Receptions)
	}
	r := report.Receptions[0]
	if r.Node != 1 || r.FromNode != 0 || r.Collided {
		t.Errorf("reception = %+v, want Node=1 FromNode=0 Collided=false", r)
	}
}

// TestRunDetectsCollisionAtSharedListener is the core correctness check for
// the whole simulator: two independent senders, both audible to the same
// third node, transmitting with overlapping airtime windows — the shared
// listener must see a collision, not a clean reception from either.
func TestRunDetectsCollisionAtSharedListener(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 2, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0},
		},
	}
	// Both sent at t=0 with the same payload length -> identical airtime
	// windows -> guaranteed full overlap at the shared listener (node 2).
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 0, PayloadLen: 20},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	if len(report.Receptions) != 2 {
		t.Fatalf("expected 2 receptions (one per packet at node 2), got %d: %+v", len(report.Receptions), report.Receptions)
	}
	for _, r := range report.Receptions {
		if r.Node != 2 {
			t.Fatalf("unexpected receiving node %d, want 2 for both", r.Node)
		}
		if !r.Collided {
			t.Errorf("reception %+v should be marked Collided (two overlapping transmissions at a shared listener)", r)
		}
	}
}

// TestRunNoCollisionWhenWindowsDoNotOverlap is the negative case for the
// above: two senders heard by the same listener, but far enough apart in
// time that their airtime windows never overlap — both must be received
// cleanly.
func TestRunNoCollisionWhenWindowsDoNotOverlap(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 2, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0},
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 10_000, PayloadLen: 20}, // 10s later — no real LoRa packet's airtime is anywhere near that long
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	for _, r := range report.Receptions {
		if r.Collided {
			t.Errorf("reception %+v should not be collided — the two sends are 10s apart, far beyond any packet's airtime", r)
		}
	}
}

// TestRunRelaysOnlyOnce is the regression test for MeshCore's own real
// dedup behavior: a repeater that has already relayed a flood packet must
// not relay it again even if it goes on to hear the same packet a second
// time (e.g. relayed back to it by a neighbour).
func TestRunRelaysOnlyOnce(t *testing.T) {
	// A <-> B <-> C, all mutually in range, all repeaters — B will hear
	// A's original send AND (after relaying it) potentially hear C's own
	// relay of the same packet coming back. B must only ever send once.
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(true)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0},
			{From: 1, To: 0, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0},
			{From: 2, To: 1, SNRdB: 0},
		},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	sendsFromB := 0
	for _, r := range report.Receptions {
		if r.FromNode == 1 {
			sendsFromB++
		}
	}
	// Node 1 (B) should appear as FromNode at most twice: once relaying to
	// A (node 0) and once relaying to C (node 2) — both from the *same*
	// single relay transmission, never a second one.
	if sendsFromB > 2 {
		t.Errorf("node 1 (B) appears to have relayed more than once: %d receptions attributed to it as sender", sendsFromB)
	}
}

// TestRunRespectsHopLimit checks that a flood doesn't propagate forever
// around a cycle — MaxHopCount must cut it off.
func TestRunRespectsHopLimit(t *testing.T) {
	// A ring of repeaters, each only in range of its two neighbours —
	// without a hop limit this would circulate indefinitely.
	const ringSize = 20
	nodes := make([]SimNode, ringSize)
	var links []Link
	for i := 0; i < ringSize; i++ {
		nodes[i] = testNode(true)
		next := (i + 1) % ringSize
		links = append(links, Link{From: i, To: next, SNRdB: 0}, Link{From: next, To: i, SNRdB: 0})
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 600_000)

	maxHop := 0
	for _, r := range report.Receptions {
		if r.HopCount > maxHop {
			maxHop = r.HopCount
		}
	}
	if maxHop > MaxHopCount {
		t.Errorf("max hop count observed = %d, want <= MaxHopCount (%d)", maxHop, MaxHopCount)
	}
}

// TestRunSkipsUnreachableNodes confirms a node with no Link to/from anyone
// simply never appears in the report, rather than erroring.
func TestRunSkipsUnreachableNodes(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: nil, // no connectivity at all
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	if len(report.Receptions) != 0 {
		t.Errorf("expected no receptions with no connectivity, got %+v", report.Receptions)
	}
	// Not just empty but non-nil: a nil slice marshals to JSON "null", not
	// "[]" — the WASM bridge's JS callers (see wasm/meshsim.go,
	// public/simulator.js) iterate this field directly and shouldn't need
	// a null-guard for what is really just "zero results."
	if report.Receptions == nil {
		t.Error("Report.Receptions should be a non-nil empty slice, not nil, so it JSON-marshals to [] rather than null")
	}
}
