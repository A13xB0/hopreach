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
	// Node 1 is a plain client (testNode(false)) — it can receive but never
	// relays, which should be reported as such rather than left unexplained.
	if r.WasRelayed {
		t.Error("plain client should never relay")
	}
	if r.DropReason != "cannot_relay" {
		t.Errorf("DropReason = %q, want %q", r.DropReason, "cannot_relay")
	}
}

// TestRunWeakSignalDropReason confirms a reception below the listening
// radio's own SF threshold is reported as such, distinct from every other
// reason a hop might not go on to relay.
func TestRunWeakSignalDropReason(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true)},
		// Default SF11's threshold is -17.5dB (see snrThresholdDB) — -20dB
		// is audible enough to reach the listener at all (still below the
		// hidden -999 "unreachable" sentinel) but too weak to decode.
		Links: []Link{{From: 0, To: 1, SNRdB: -20}},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	if len(report.Receptions) != 1 {
		t.Fatalf("expected exactly 1 reception, got %d: %+v", len(report.Receptions), report.Receptions)
	}
	r := report.Receptions[0]
	if r.WasRelayed {
		t.Error("reception below the SF threshold should not be relayed")
	}
	if r.DropReason != "weak_signal" {
		t.Errorf("DropReason = %q, want %q", r.DropReason, "weak_signal")
	}
}

// TestReceptionPathReflectsActualRelayChain checks that Path (the real
// node-index relay chain) matches the true hop-by-hop route rather than the
// internal loop-detect hashes it's derived alongside.
func TestReceptionPathReflectsActualRelayChain(t *testing.T) {
	// A -> B -> C -> D, a straight line, each only audible to its
	// immediate neighbour.
	a, b, c, d := 0, 1, 2, 3
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(true), testNode(true)},
		Links: []Link{
			{From: a, To: b, SNRdB: 0}, {From: b, To: a, SNRdB: 0},
			{From: b, To: c, SNRdB: 0}, {From: c, To: b, SNRdB: 0},
			{From: c, To: d, SNRdB: 0}, {From: d, To: c, SNRdB: 0},
		},
	}
	messages := []Message{{Origin: a, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atD *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node == d {
			atD = r
		}
	}
	if atD == nil {
		t.Fatal("expected node D to eventually receive the packet via B and C")
	}
	want := []int{a, b, c}
	if len(atD.Path) != len(want) {
		t.Fatalf("Path = %v, want %v", atD.Path, want)
	}
	for i, n := range want {
		if atD.Path[i] != n {
			t.Errorf("Path = %v, want %v", atD.Path, want)
			break
		}
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
		// The reception whose FromNode is 0 collided because of node 1's
		// transmission, and vice versa — CollidedWith must name the *other*
		// sender specifically, not just record that a collision happened.
		wantOther := 1
		if r.FromNode == 1 {
			wantOther = 0
		}
		if len(r.CollidedWith) != 1 || r.CollidedWith[0] != wantOther {
			t.Errorf("reception from node %d: CollidedWith = %v, want [%d]", r.FromNode, r.CollidedWith, wantOther)
		}
	}
}

// TestRunCollidedWithEmptyNotNilWhenClean is the JSON-shape counterpart to
// Report's own "never nil" convention (see Run's report initialization) —
// a clean reception's CollidedWith must marshal to [], not null, so JS
// callers never need a null-guard before iterating it.
func TestRunCollidedWithEmptyNotNilWhenClean(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	if len(report.Receptions) != 1 {
		t.Fatalf("expected 1 reception, got %d", len(report.Receptions))
	}
	r := report.Receptions[0]
	if r.Collided {
		t.Fatalf("expected a clean reception, got Collided=true: %+v", r)
	}
	if r.CollidedWith == nil {
		t.Error("expected CollidedWith to be an empty slice, not nil, for a clean reception")
	}
	if len(r.CollidedWith) != 0 {
		t.Errorf("expected CollidedWith to be empty for a clean reception, got %v", r.CollidedWith)
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

// TestRunCADDefersSendWhenSenderCanHearOngoingTransmission is the
// regression test for channelBusy/CAD (see engine.go's cadFailRetryDelayMs
// doc comment, a real firmware mechanism — Dispatcher::checkSend()'s
// _radio->isReceiving() check — this package didn't model at all before).
// Node 1's own send at t=50ms would, without CAD, overlap node 0's
// transmission ([0, airtime)) and collide at their shared listener. Since
// node 1 can directly hear node 0, real firmware would defer node 1's send
// until the channel clears rather than transmit into it — so with CAD
// modeled, the two transmissions must not actually overlap, and node 1's
// packet must arrive at the shared listener uncollided.
func TestRunCADDefersSendWhenSenderCanHearOngoingTransmission(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0}, {From: 1, To: 0, SNRdB: 0}, // 0 and 1 can hear each other directly
			{From: 0, To: 2, SNRdB: 0}, {From: 1, To: 2, SNRdB: 0}, // both audible to a shared listener, node 2
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 50, PayloadLen: 20}, // scheduled to start well within node 0's own airtime window
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	airtime := AirtimeMs(DefaultLoRaParams(), 20)
	if 50 >= airtime {
		t.Fatalf("test setup assumes node 1's naive send time (50ms) falls inside node 0's airtime window (%dms) — adjust the fixture", airtime)
	}

	found := false
	for _, r := range report.Receptions {
		if r.PacketID != 1 || r.Node != 2 {
			continue
		}
		found = true
		if r.Collided {
			t.Errorf("node 1's packet should have been deferred by CAD until the channel cleared, not collided: %+v", r)
		}
		if r.AtMs < 50+airtime {
			t.Errorf("node 1's packet arrived at %dms — too early to have actually been deferred by CAD (expected it pushed back by at least one %dms retry)", r.AtMs, cadFailRetryDelayMs)
		}
	}
	if !found {
		t.Fatal("expected a reception of packet 1 at listener node 2")
	}
}

// TestRunCADDoesNotPreventHiddenNodeCollisions is TestRunCAD...'s
// counterpart: CAD only ever stops *this* node from transmitting into a
// channel *it* can hear is busy — it cannot help the classic hidden-node
// case, where two senders can't hear each other at all but share a
// downstream listener. Same scenario as the CAD test above but without the
// 0<->1 links, so node 1 has no way to detect node 0's transmission before
// sending — the two must still collide at their shared listener exactly
// as they would with no CAD modeling at all.
func TestRunCADDoesNotPreventHiddenNodeCollisions(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 2, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0},
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 50, PayloadLen: 20},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	foundCollision := false
	for _, r := range report.Receptions {
		if r.PacketID == 1 && r.Node == 2 {
			if r.AtMs != 50+AirtimeMs(DefaultLoRaParams(), 20) {
				t.Errorf("hidden nodes: node 1's send should never be deferred (it can't detect node 0 at all), got AtMs=%d", r.AtMs)
			}
			if r.Collided {
				foundCollision = true
			}
		}
	}
	if !foundCollision {
		t.Error("expected node 1's packet to still collide at the shared listener — CAD cannot prevent a hidden-node collision")
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
	sawAlreadyRelayedAtB := false
	for _, r := range report.Receptions {
		if r.FromNode == 1 {
			sendsFromB++
		}
		if r.Node == 1 && r.DropReason == "already_relayed" {
			sawAlreadyRelayedAtB = true
			if r.WasRelayed {
				t.Errorf("reception dropped for already_relayed should not also be WasRelayed: %+v", r)
			}
		}
	}
	// Node 1 (B) should appear as FromNode at most twice: once relaying to
	// A (node 0) and once relaying to C (node 2) — both from the *same*
	// single relay transmission, never a second one.
	if sendsFromB > 2 {
		t.Errorf("node 1 (B) appears to have relayed more than once: %d receptions attributed to it as sender", sendsFromB)
	}
	// C relays the packet back to B after B already relayed it once — B's
	// second hearing of the same packetID should be tagged already_relayed.
	if !sawAlreadyRelayedAtB {
		t.Error("expected node 1 (B) to have a reception with DropReason \"already_relayed\" (hearing C's relay of its own earlier relay)")
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
	sawHopLimitDrop := false
	for _, r := range report.Receptions {
		if r.HopCount > maxHop {
			maxHop = r.HopCount
		}
		if r.DropReason == "hop_limit" {
			sawHopLimitDrop = true
			if r.WasRelayed {
				t.Errorf("reception dropped for hop_limit should not also be WasRelayed: %+v", r)
			}
		}
	}
	if maxHop > MaxHopCount {
		t.Errorf("max hop count observed = %d, want <= MaxHopCount (%d)", maxHop, MaxHopCount)
	}
	if !sawHopLimitDrop {
		t.Error("expected at least one reception with DropReason \"hop_limit\" — the ring should keep circulating until MaxHopCount cuts it off")
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

// TestRunRegionScopedMessageOnlyRelayedByMatchingNodes is the regression
// test for SimNode.acceptsRegion/Message.Region — mirrors real MeshCore's
// `region default <name>` (see docs.meshcore.io/cli_commands): a repeater
// with no matching region key can't relay a region-tagged message onward,
// but ordinary (unscoped) traffic and the region-tagged message's own
// first-hop *reception* (a physical-layer event, unaffected by region) are
// both unaffected.
func TestRunRegionScopedMessageOnlyRelayedByMatchingNodes(t *testing.T) {
	// A -> B -> C: B is a repeater, but only has "#sco" — a message tagged
	// "#ioi" must reach B (physical reception) but never get relayed onward
	// to C.
	scenario := Scenario{
		Nodes: []SimNode{
			testNode(false), // 0: origin
			{Prefs: DefaultNodePrefs(), CanRelay: true, Regions: []string{"#sco"}}, // 1: repeater, only #sco
			testNode(false), // 2: downstream listener
		},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 20},
			{From: 1, To: 2, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, Region: "#ioi"}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atNode1 *Reception
	for i := range report.Receptions {
		if report.Receptions[i].Node == 1 {
			atNode1 = &report.Receptions[i]
		}
		if report.Receptions[i].Node == 2 {
			t.Errorf("node 2 should never receive anything — node 1 shouldn't have relayed a #ioi message it has no key for: %+v", report.Receptions[i])
		}
	}
	if atNode1 == nil {
		t.Fatal("expected node 1 to still physically receive the #ioi message (region only gates relaying, not reception)")
	}
	if atNode1.WasRelayed {
		t.Error("node 1 has only #sco, and should not have relayed a message tagged #ioi")
	}
	if atNode1.DropReason != "region_mismatch" {
		t.Errorf("DropReason = %q, want %q", atNode1.DropReason, "region_mismatch")
	}
}

// TestRunUnscopedMessageRelayedRegardlessOfNodeRegions is
// TestRunRegionScoped...'s counterpart: a message with no Region set at
// all (ordinary flood traffic) must be relayed by any repeater, even one
// with a completely different region — or none at all — since plain floods
// carry no region-specific transport code to validate against.
func TestRunUnscopedMessageRelayedRegardlessOfNodeRegions(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{
			testNode(false),
			{Prefs: DefaultNodePrefs(), CanRelay: true, Regions: []string{"#sco"}},
			testNode(false),
		},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 20},
			{From: 1, To: 2, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}} // no Region

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	foundAtNode2 := false
	for _, r := range report.Receptions {
		if r.Node == 2 {
			foundAtNode2 = true
		}
	}
	if !foundAtNode2 {
		t.Error("expected node 1 to relay an unscoped message on to node 2 regardless of its own region list")
	}
}

// TestLoopDetectThresholdMatchesDocumentedTable is a direct check against
// docs.meshcore.io/cli_commands's own published loop.detect table, so a
// typo here would fail loudly rather than silently mis-simulate the real
// setting.
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
	nodes[a].HashSize = 1
	nodes[b].HashSize = 1
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
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20}}

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
	nodes[a].HashSize = 1
	nodes[b].HashSize = 1
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
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20}}

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
