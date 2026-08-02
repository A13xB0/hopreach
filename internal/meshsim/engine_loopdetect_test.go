package meshsim

import "testing"

// Loop detection: the documented threshold table, how often node hashes
// collide at each size, and what each detect level does about it.

func TestLoopDetectThresholdMatchesDocumentedTable(t *testing.T) {
	tests := []struct {
		level     string
		hashSize  int
		threshold int
	}{
		{"off", 1, 0}, {"off", 3, 0}, {"", 1, 0},
		{"minimal", 1, 4}, {"minimal", 2, 2}, {"minimal", 3, 1},
		{"moderate", 1, 2}, {"moderate", 2, 1}, {"moderate", 3, 1},
		{"strict", 1, 1}, {"strict", 2, 1}, {"strict", 3, 1},
	}
	for _, tt := range tests {
		if got := loopDetectThreshold(tt.level, tt.hashSize); got != tt.threshold {
			t.Errorf("loopDetectThreshold(%q, %d) = %d, want %d", tt.level, tt.hashSize, got, tt.threshold)
		}
	}
}

// TestNodeHashCollisionsAreMoreCommonAtSmallerSizes is the whole reason
// loop.detect's real thresholds vary by hash size at all: a 1-byte hash
// only has 256 possible values, so two entirely unrelated real repeaters
// legitimately sharing one is common, not a bug — a 3-byte hash has 16M+,
// where that's effectively never true among a realistic node count.
func TestNodeHashCollisionsAreMoreCommonAtSmallerSizes(t *testing.T) {
	countCollisions := func(hashSize, n int) int {
		seen := map[uint32]bool{}
		collisions := 0
		for i := 0; i < n; i++ {
			h := nodeHash(i, hashSize)
			if seen[h] {
				collisions++
			}
			seen[h] = true
		}
		return collisions
	}
	if c := countCollisions(1, 50); c == 0 {
		t.Error("expected at least one real hash collision among 50 nodes at a 1-byte hash (only 256 possible values)")
	}
	if c := countCollisions(3, 50); c != 0 {
		t.Errorf("expected zero collisions among 50 nodes at a 3-byte hash (16M+ possible values), got %d", c)
	}
}

func findHashCollision(t *testing.T, hashSize, limit int) (a, b int) {
	t.Helper()
	seen := map[uint32]int{}
	for i := 0; i < limit; i++ {
		h := nodeHash(i, hashSize)
		if j, ok := seen[h]; ok {
			return j, i
		}
		seen[h] = i
	}
	t.Fatalf("expected to find a %d-byte hash collision among %d node indices", hashSize, limit)
	return 0, 0
}

// TestLoopDetectStrictBlocksRelayOnHashCollisionBetweenDifferentNodes is
// the regression test for the real, documented failure mode loop.detect
// exists to describe: node B never actually saw this packet loop back to
// it — node A (a completely different repeater) relayed it, and node B's
// own path-hash merely *collides* with node A's at B's configured (1-byte)
// hash size. Real firmware in strict mode can't distinguish that from an
// actual loop and refuses to relay anyway — this proves the simulator
// reproduces that exact behavior, not just literal same-node loops (which
// relayed[packetID][node] already prevents regardless of loop.detect).
func TestLoopDetectStrictBlocksRelayOnHashCollisionBetweenDifferentNodes(t *testing.T) {
	a, b := findHashCollision(t, 1, 300)
	if a == b {
		t.Fatal("test setup: collision indices must be different nodes")
	}

	n := a
	if b > n {
		n = b
	}
	listener := n + 1
	nodes := make([]SimNode, listener+1)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	origin := 0
	if origin == a || origin == b {
		t.Fatal("test setup: origin must be distinct from the colliding pair")
	}
	nodes[origin].CanRelay = false
	nodes[b].LoopDetect = "strict"
	nodes[listener].CanRelay = false

	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: origin, To: a, SNRdB: 20},
			{From: a, To: b, SNRdB: 20},
			{From: b, To: listener, SNRdB: 20},
		},
	}
	// HashSize: 1 — loop detect is evaluated at the MESSAGE's own hash
	// size (see Message.HashSize), not anything configured per-node, so
	// the 1-byte collision this test relies on must be requested here.
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 1}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atB *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node == listener {
			t.Errorf("listener should never receive anything — node %d's strict loop.detect should have blocked relay after colliding with node %d's own path-hash: %+v", b, a, r)
		}
		if r.Node == b {
			atB = r
		}
	}
	if atB == nil {
		t.Fatal("expected node b to have received the packet at least once (from node a)")
	}
	if atB.WasRelayed {
		t.Error("node b should not have relayed — its own loop.detect should have blocked it")
	}
	if atB.DropReason != "loop_detect" {
		t.Errorf("DropReason = %q, want %q", atB.DropReason, "loop_detect")
	}
	if len(atB.Path) != 2 || atB.Path[0] != origin || atB.Path[1] != a {
		t.Errorf("Path = %v, want [%d %d] (the real relay chain leading to this reception: origin then node a)", atB.Path, origin, a)
	}
}

// TestLoopDetectOffNeverBlocksRelay is the negative case: the same
// hash-colliding setup as above, but with LoopDetect left at its real
// firmware default ("off") — must relay normally regardless.
func TestLoopDetectOffNeverBlocksRelay(t *testing.T) {
	a, b := findHashCollision(t, 1, 300)
	n := a
	if b > n {
		n = b
	}
	listener := n + 1
	nodes := make([]SimNode, listener+1)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	origin := 0
	nodes[origin].CanRelay = false
	// LoopDetect left unset ("off")
	nodes[listener].CanRelay = false

	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: origin, To: a, SNRdB: 20},
			{From: a, To: b, SNRdB: 20},
			{From: b, To: listener, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 1}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	found := false
	for _, r := range report.Receptions {
		if r.Node == listener {
			found = true
		}
	}
	if !found {
		t.Error("expected the listener to receive the packet — loop.detect is off, so the hash collision between nodes a and b should never matter")
	}
}

// TestRunDirectMessageSkipsUnscopedHopLimit proves flood_max_unscoped only
// gates ROUTE_TYPE_FLOOD traffic (see Message.Direct's own doc comment,
// mirroring MyMesh.cpp's forwarding gate) — an unscoped Direct message must
// never be dropped for hop_limit_unscoped, even under a FloodMaxUnscoped
// tight enough that an equivalent flood message would be.
func TestRunDirectMessageSkipsUnscopedHopLimit(t *testing.T) {
	const ringSize = 10
	nodes := make([]SimNode, ringSize)
	var links []Link
	for i := 0; i < ringSize; i++ {
		nodes[i] = testNode(true)
		nodes[i].FloodMax = 100 // generous — not the limit under test
		nodes[i].FloodMaxUnscoped = 2
		next := (i + 1) % ringSize
		links = append(links, Link{From: i, To: next, SNRdB: 0}, Link{From: next, To: i, SNRdB: 0})
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, Direct: true}}

	report := Run(scenario, messages, zeroRNG{}, 600_000)

	maxHop := 0
	for _, r := range report.Receptions {
		if r.DropReason == "hop_limit_unscoped" {
			t.Errorf("a Direct message must never be dropped for hop_limit_unscoped: %+v", r)
		}
		if r.HopCount > maxHop {
			maxHop = r.HopCount
		}
	}
	if maxHop <= 2 {
		t.Errorf("expected the Direct message to propagate past FloodMaxUnscoped (2), got max hop %d", maxHop)
	}
}

// TestRunDirectMessageUsesDirectTxDelayFactor proves a Direct message's
// relay timing is computed from NodePrefs.DirectTxDelayFactor, not
// TxDelayFactor — give the two wildly different values and confirm a
// relay's actual timing reflects whichever one applies.
func TestRunDirectMessageUsesDirectTxDelayFactor(t *testing.T) {
	relayAtMs := func(direct bool) uint32 {
		relay := testNode(true)
		relay.Prefs.TxDelayFactor = 0.5
		relay.Prefs.DirectTxDelayFactor = 0.1
		scenario := Scenario{
			Nodes: []SimNode{testNode(false), relay, testNode(false)},
			Links: []Link{
				{From: 0, To: 1, SNRdB: 20}, {From: 1, To: 0, SNRdB: 20},
				{From: 1, To: 2, SNRdB: 20},
			},
		}
		messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, Direct: direct}}
		report := Run(scenario, messages, fixedRNG{pickMax: true}, 60_000)
		for _, r := range report.Receptions {
			if r.Node == 2 {
				return r.AtMs
			}
		}
		t.Fatal("node 2 (two hops from the origin) never received the packet")
		return 0
	}

	floodAt := relayAtMs(false)
	directAt := relayAtMs(true)
	if directAt >= floodAt {
		t.Errorf("Direct relay (factor 0.1) should arrive sooner than flood relay (factor 0.5) under the same fixed-max RNG draw: direct=%dms, flood=%dms", directAt, floodAt)
	}
}
