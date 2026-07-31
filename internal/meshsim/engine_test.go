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

// TestLoraCapturedRequiresLockThenMargin is the direct unit test for the
// capture-effect gate itself: an interferer arriving before the wanted
// transmission's own preamble/sync window elapses prevents capture no
// matter how dominant the wanted signal is (lock was never established to
// capture); one arriving after that window is captured only if it clears
// captureMarginDB.
func TestLoraCapturedRequiresLockThenMargin(t *testing.T) {
	radio := DefaultLoRaParams()
	preambleMs := uint32(preambleDurationMs(radio))
	tx := transmission{startMs: 1000, radio: radio}

	tests := []struct {
		name          string
		otherStartMs  uint32
		wantedSNR     float64
		interfererSNR float64
		wantCaptured  bool
	}{
		{
			// New (strength-aware) acquisition behaviour: a much weaker
			// interferer arriving during the preamble no longer prevents
			// lock — the strong wanted signal's preamble correlation wins
			// acquisition. Previously this returned "not captured".
			name:          "interferer during preamble, huge SNR margin — wanted wins acquisition",
			otherStartMs:  tx.startMs + preambleMs/2,
			wantedSNR:     20,
			interfererSNR: -20,
			wantCaptured:  true,
		},
		{
			name:          "interferer during preamble, comparable strength — blocks lock",
			otherStartMs:  tx.startMs + preambleMs/2,
			wantedSNR:     4, // only 4 dB above the interferer, below the preamble capture margin — lock never acquired
			interfererSNR: 0,
			wantCaptured:  false,
		},
		{
			name:          "interferer right at lock deadline — captured given margin",
			otherStartMs:  tx.startMs + preambleMs,
			wantedSNR:     10,
			interfererSNR: 0,
			wantCaptured:  true,
		},
		{
			name:          "interferer after lock, margin exactly met (6dB) — captured",
			otherStartMs:  tx.startMs + preambleMs + 50,
			wantedSNR:     6,
			interfererSNR: 0,
			wantCaptured:  true,
		},
		{
			name:          "interferer after lock, margin just short — not captured",
			otherStartMs:  tx.startMs + preambleMs + 50,
			wantedSNR:     5,
			interfererSNR: 0,
			wantCaptured:  false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			other := transmission{startMs: tt.otherStartMs, radio: radio}
			got := loraCaptured(tt.wantedSNR, tt.interfererSNR, tx, other)
			if got != tt.wantCaptured {
				t.Errorf("loraCaptured(wanted=%v, interferer=%v, otherStart=%d) = %v, want %v",
					tt.wantedSNR, tt.interfererSNR, tt.otherStartMs, got, tt.wantCaptured)
			}
		})
	}
}

// TestRunCaptureEffectSurvivesWeakLateInterferer is the end-to-end (via
// Run, not the unit-level loraCaptured above) proof that a dominant signal
// is decoded through a weaker, late-arriving co-channel interferer instead
// of both being destroyed — the real behavior "any time-overlap destroys
// both" (the previous model) gets wrong.
func TestRunCaptureEffectSurvivesWeakLateInterferer(t *testing.T) {
	const strong, weak, listener = 0, 1, 2
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: strong, To: listener, SNRdB: 15}, // wanted signal
			{From: weak, To: listener, SNRdB: 0},    // interferer: 15dB below wanted, well past captureMarginDB
		},
	}
	// weak starts after strong's own preamble window has elapsed (so its
	// signal is arriving mid-payload, not preventing lock), but still
	// overlaps strong's own airtime window.
	preambleMs := uint32(preambleDurationMs(DefaultLoRaParams()))
	messages := []Message{
		{Origin: strong, SendAtMs: 0, PayloadLen: 20},
		{Origin: weak, SendAtMs: preambleMs + 20, PayloadLen: 20},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atListenerFromStrong *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node == listener && r.FromNode == strong {
			atListenerFromStrong = r
		}
	}
	if atListenerFromStrong == nil {
		t.Fatal("expected a reception at the listener from the strong sender")
	}
	if atListenerFromStrong.Collided {
		t.Errorf("expected the dominant signal to survive the weak, late interferer via capture, got Collided=true: %+v", atListenerFromStrong)
	}
	if !atListenerFromStrong.SurvivedCapture {
		t.Errorf("expected SurvivedCapture=true (an interferer was present but didn't win), got: %+v", atListenerFromStrong)
	}
	if len(atListenerFromStrong.CollidedWith) != 0 {
		t.Errorf("expected an empty CollidedWith for a captured reception, got %v", atListenerFromStrong.CollidedWith)
	}
}

// TestRunCollidedWithOnlyListsNonCapturedInterferers proves CollidedWith's
// own doc comment ("every genuine cause of Collided") stays accurate now
// that some overlapping/audible transmissions can be survived via capture:
// a reception with one captured (weak, late) interferer and one genuinely
// colliding (comparable-strength, early) interferer must list only the
// latter.
func TestRunCollidedWithOnlyListsNonCapturedInterferers(t *testing.T) {
	const wanted, capturedAway, realCollider, listener = 0, 1, 2, 3
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: wanted, To: listener, SNRdB: 15},
			{From: capturedAway, To: listener, SNRdB: 0},  // 15dB below — captured, given it arrives late enough
			{From: realCollider, To: listener, SNRdB: 14}, // only 1dB below — genuinely collides
		},
	}
	preambleMs := uint32(preambleDurationMs(DefaultLoRaParams()))
	messages := []Message{
		{Origin: wanted, SendAtMs: 0, PayloadLen: 20},
		{Origin: capturedAway, SendAtMs: preambleMs + 20, PayloadLen: 20}, // late enough to be capturable
		{Origin: realCollider, SendAtMs: 0, PayloadLen: 20},               // simultaneous with wanted — during its preamble, and only 1dB down anyway
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atListenerFromWanted *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node == listener && r.FromNode == wanted {
			atListenerFromWanted = r
		}
	}
	if atListenerFromWanted == nil {
		t.Fatal("expected a reception at the listener from the wanted sender")
	}
	if !atListenerFromWanted.Collided {
		t.Fatalf("expected Collided=true (realCollider genuinely collides), got: %+v", atListenerFromWanted)
	}
	if len(atListenerFromWanted.CollidedWith) != 1 || atListenerFromWanted.CollidedWith[0] != realCollider {
		t.Errorf("CollidedWith = %v, want [%d] (capturedAway should be excluded, having been captured over)", atListenerFromWanted.CollidedWith, realCollider)
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

	// +1: real on-air length is payload + the path_len byte every packet
	// carries (see onAirLen) — path length is 0 here (origin's own first
	// send).
	airtime := AirtimeMs(DefaultLoRaParams(), 21)
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
			t.Errorf("node 1's packet arrived at %dms — too early to have actually been deferred by CAD (expected it pushed back by at least one 120ms minimum retry)", r.AtMs)
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
			// +1: real on-air length is payload + the path_len byte every
			// packet carries (see onAirLen) — path length is 0 here
			// (origin's own first send).
			if r.AtMs != 50+AirtimeMs(DefaultLoRaParams(), 21) {
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
		if r.Node == 1 && r.DropReason == "already_seen" {
			sawAlreadyRelayedAtB = true
			if r.WasRelayed {
				t.Errorf("reception dropped for already_seen should not also be WasRelayed: %+v", r)
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
	// second hearing of the same packetID should be tagged already_seen.
	if !sawAlreadyRelayedAtB {
		t.Error("expected node 1 (B) to have a reception with DropReason \"already_seen\" (hearing C's relay of its own earlier relay)")
	}
}

// TestLoopDetectDropDoesNotResurrectOnALaterPath is the direct regression
// test for a real bug: a node that dropped an earlier copy of a packet for
// loop_detect must not relay a LATER copy of the exact same packet arriving
// via a different path — real firmware's hasSeen() dedup (SimpleMeshTables,
// keyed on payload only, not path — see Packet::calculatePacketHash) catches
// every decoded copy regardless of route, not just ones that went on to
// relay. Before this fix, only `relayed` (set exclusively when a node
// actually relayed) gated re-relay, so a copy dropped for loop_detect left
// no trace and a later copy via a different path sailed through and
// relayed — defeating loop detection.
func TestLoopDetectDropDoesNotResurrectOnALaterPath(t *testing.T) {
	// loop.detect only ever looks at the packet's *accumulated* path-hash
	// sequence, which starts empty at the origin and only gains an entry
	// when a node actually relays (see transmission.path's own doc
	// comment) — so the colliding node must be an intermediate relayer,
	// not the origin itself; a direct origin->listener hop can never
	// trigger loop_detect (empty path). Search among indices >= 1 so index
	// 0 is free to be a distinct origin.
	x, d := 0, 0
	found := false
	seenHash := map[uint32]int{}
	for i := 1; i < 300; i++ {
		h := nodeHash(i, 1)
		if j, ok := seenHash[h]; ok {
			x, d = j, i
			found = true
			break
		}
		seenHash[h] = i
	}
	if !found {
		t.Fatal("expected to find a 1-byte hash collision among node indices 1..299")
	}

	const origin = 0
	n := x
	if d > n {
		n = d
	}
	// y1/y2: a second, longer relay path (origin -> y1 -> y2 -> D) that
	// never touches X's hash, so loop_detect alone would happily let this
	// second copy through — only hasSeen should catch it. The extra hop
	// (vs. X's single hop) also separates the two copies' arrival times at
	// D enough that they don't collide with each other there.
	y1, y2 := n+1, n+2
	total := n + 3
	nodes := make([]SimNode, total)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	// Loop detect is evaluated at the MESSAGE's own hash size (see
	// Message.HashSize), not anything configured per-node — so this test's
	// 1-byte hash collision must come from the message below, not from
	// nodes[x]/nodes[d].HashSize (which no longer have any bearing on loop
	// detect at all).
	nodes[d].LoopDetect = "strict"
	if nodeHash(y2, 1) == nodeHash(d, 1) {
		t.Fatal("test setup: y2 must not itself collide with d's hash, or this no longer isolates hasSeen from loop_detect — pick different indices")
	}

	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			// Path 1 (arrives first): origin -> X -> D. X relays,
			// appending its own hash; D's first copy is dropped for
			// loop_detect since X's hash collides with D's at this
			// 1-byte size.
			{From: origin, To: x, SNRdB: 20},
			{From: x, To: d, SNRdB: 20},
			// Path 2 (arrives later, one hop longer): origin -> y1 -> y2
			// -> D. Neither y1 nor y2 collides with D, so loop_detect on
			// its own would allow this second copy through.
			{From: origin, To: y1, SNRdB: 20},
			{From: y1, To: y2, SNRdB: 20},
			{From: y2, To: d, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 1}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atD []Reception
	for i := range report.Receptions {
		if report.Receptions[i].Node == d {
			atD = append(atD, report.Receptions[i])
		}
	}
	if len(atD) < 2 {
		t.Fatalf("expected D to receive 2 copies of the packet (via X, then via y1/y2), got %d: %+v", len(atD), atD)
	}
	for _, r := range atD {
		if r.Collided {
			t.Fatalf("test setup: the two copies collided with each other at D instead of arriving sequentially — timing needs more separation: %+v", atD)
		}
		if r.WasRelayed {
			t.Errorf("D must never relay this packet — its first copy was dropped for loop_detect, and hasSeen must catch every later copy regardless of path: %+v", r)
		}
	}
	// The first (via X) copy should show loop_detect; the later one (via
	// y1/y2) must show already_seen, not sail through as a fresh relay
	// candidate just because loop_detect itself doesn't fire on that path.
	if atD[0].DropReason != "loop_detect" {
		t.Errorf("D's first reception DropReason = %q, want %q (full: %+v)", atD[0].DropReason, "loop_detect", atD)
	}
	if atD[1].DropReason != "already_seen" {
		t.Errorf("D's second reception DropReason = %q, want %q (full: %+v)", atD[1].DropReason, "already_seen", atD)
	}
}

// TestCollidedReceptionDoesNotMarkSeen is the counterpart to the above: a
// reception that COLLIDED was never actually decoded, so it must not count
// as "seen" — a later, clean copy of the same packet must still be able to
// relay normally, not be dropped as a spurious already_seen.
func TestCollidedReceptionDoesNotMarkSeen(t *testing.T) {
	// Two senders (A, X) both audible to listener L, overlapping in time,
	// both carrying DIFFERENT packets — but we only care about A's packet.
	// A's own transmission to L collides (X's overlaps it). A SECOND,
	// later, non-overlapping transmission of A's same packet (relayed by a
	// side path through node M, arriving after X's transmission ends) must
	// still be able to relay at L.
	const aOrigin, x, l, m = 0, 1, 2, 3
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(true), testNode(true)},
		Links: []Link{
			{From: aOrigin, To: l, SNRdB: 0},
			{From: x, To: l, SNRdB: 0},
			{From: aOrigin, To: m, SNRdB: 0},
			{From: m, To: l, SNRdB: 0},
		},
	}
	messages := []Message{
		{Origin: aOrigin, SendAtMs: 0, PayloadLen: 20}, // reaches L directly, collides with X
		{Origin: x, SendAtMs: 0, PayloadLen: 20},       // the interferer
	}
	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var collidedAtL, laterCleanAtL *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node != l || r.PacketID != 0 {
			continue
		}
		if r.Collided && collidedAtL == nil {
			collidedAtL = r
		} else if !r.Collided {
			laterCleanAtL = r
		}
	}
	if collidedAtL == nil {
		t.Fatal("expected packet 0's direct reception at L to collide with X's transmission")
	}
	if laterCleanAtL == nil {
		t.Fatal("expected a later, clean copy of packet 0 to reach L via M (A -> M -> L)")
	}
	if laterCleanAtL.DropReason == "already_seen" {
		t.Error("a collided reception must not mark the packet as seen — the later clean copy via M should relay normally, not be dropped as already_seen")
	}
	if !laterCleanAtL.WasRelayed {
		t.Errorf("expected the later clean copy to relay (L is a repeater, not yet hop-limited): %+v", laterCleanAtL)
	}
}

// TestRunRespectsHopLimit checks that a flood doesn't propagate forever
// around a cycle — a node's own effectiveFloodMax must cut it off.
func TestRunRespectsHopLimit(t *testing.T) {
	// A ring of repeaters, each only in range of its two neighbours —
	// without a hop limit this would circulate indefinitely. Explicit
	// small FloodMax (well under the real 20-node ring circumference, and
	// far under the real default of 64) so the limit is the thing that
	// actually cuts this off, not hasSeen dedup naturally exhausting the
	// ring on its own after one full pass.
	const ringSize = 20
	const smallFloodMax = 5
	nodes := make([]SimNode, ringSize)
	var links []Link
	for i := 0; i < ringSize; i++ {
		nodes[i] = testNode(true)
		nodes[i].FloodMax = smallFloodMax
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
	if maxHop > smallFloodMax {
		t.Errorf("max hop count observed = %d, want <= FloodMax (%d)", maxHop, smallFloodMax)
	}
	if !sawHopLimitDrop {
		t.Error("expected at least one reception with DropReason \"hop_limit\" — the ring should keep circulating until FloodMax cuts it off")
	}
}

// TestEffectiveFloodMaxDefaults locks in the real firmware defaults (64,
// 64, 8 — examples/simple_repeater/MyMesh.cpp) that apply whenever a
// SimNode leaves FloodMax/FloodMaxUnscoped unset (zero).
func TestEffectiveFloodMaxDefaults(t *testing.T) {
	var n SimNode
	if got := n.effectiveFloodMax(); got != DefaultFloodMax {
		t.Errorf("effectiveFloodMax() with unset FloodMax = %d, want default %d", got, DefaultFloodMax)
	}
	if got := n.effectiveFloodMaxUnscoped(); got != DefaultFloodMaxUnscoped {
		t.Errorf("effectiveFloodMaxUnscoped() with unset FloodMaxUnscoped = %d, want default %d", got, DefaultFloodMaxUnscoped)
	}
	n.FloodMax = 10
	n.FloodMaxUnscoped = 20
	if got := n.effectiveFloodMax(); got != 10 {
		t.Errorf("effectiveFloodMax() with FloodMax=10 = %d, want 10", got)
	}
	if got := n.effectiveFloodMaxUnscoped(); got != 20 {
		t.Errorf("effectiveFloodMaxUnscoped() with FloodMaxUnscoped=20 = %d, want 20", got)
	}
}

// TestRunUnscopedHopLimitOnlyAppliesToUnscopedMessages proves
// FloodMaxUnscoped is a genuinely separate, additional gate: a node with a
// tight FloodMaxUnscoped but a generous FloodMax lets a REGION-SCOPED
// message go further than an UNSCOPED one over the exact same topology.
func TestRunUnscopedHopLimitOnlyAppliesToUnscopedMessages(t *testing.T) {
	buildRing := func(tightUnscoped bool) Scenario {
		const ringSize = 10
		nodes := make([]SimNode, ringSize)
		var links []Link
		for i := 0; i < ringSize; i++ {
			nodes[i] = testNode(true)
			nodes[i].FloodMax = 100 // generous — not the limit under test
			if tightUnscoped {
				nodes[i].FloodMaxUnscoped = 2
			}
			nodes[i].Regions = []string{"sco"} // so a #sco-scoped message can actually be relayed at all
			next := (i + 1) % ringSize
			links = append(links, Link{From: i, To: next, SNRdB: 0}, Link{From: next, To: i, SNRdB: 0})
		}
		return Scenario{Nodes: nodes, Links: links}
	}
	maxHopFor := func(region string) int {
		scenario := buildRing(true)
		messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, Region: region}}
		report := Run(scenario, messages, zeroRNG{}, 600_000)
		maxHop := 0
		for _, r := range report.Receptions {
			if r.HopCount > maxHop {
				maxHop = r.HopCount
			}
		}
		return maxHop
	}

	unscopedMaxHop := maxHopFor("")
	scopedMaxHop := maxHopFor("sco")

	if unscopedMaxHop > 2 {
		t.Errorf("unscoped message's max hop = %d, want <= FloodMaxUnscoped (2)", unscopedMaxHop)
	}
	if scopedMaxHop <= unscopedMaxHop {
		t.Errorf("scoped message's max hop (%d) should exceed the unscoped one (%d) — FloodMaxUnscoped must not gate a scoped message", scopedMaxHop, unscopedMaxHop)
	}

	scenario := buildRing(true)
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, Region: ""}}
	report := Run(scenario, messages, zeroRNG{}, 600_000)
	sawUnscopedHopLimit := false
	for _, r := range report.Receptions {
		if r.DropReason == "hop_limit_unscoped" {
			sawUnscopedHopLimit = true
		}
		if r.DropReason == "hop_limit" {
			t.Errorf("expected the tight FloodMaxUnscoped case to report \"hop_limit_unscoped\", not the generic \"hop_limit\": %+v", r)
		}
	}
	if !sawUnscopedHopLimit {
		t.Error("expected at least one reception with DropReason \"hop_limit_unscoped\"")
	}
}

// TestAcceptsRegionDenyUnscoped proves DenyUnscoped is a simulator what-if
// knob layered on top of firmware's real default (regions are additive —
// holding keys never revokes plain unscoped relaying, see acceptsRegion's
// doc comment): unset, an unscoped message is always accepted regardless of
// Regions; set, it's refused even with no Regions configured at all.
func TestAcceptsRegionDenyUnscoped(t *testing.T) {
	plain := SimNode{}
	if !plain.acceptsRegion("") {
		t.Error("a node with DenyUnscoped unset should accept an unscoped (empty-region) message")
	}
	denied := SimNode{DenyUnscoped: true}
	if denied.acceptsRegion("") {
		t.Error("a node with DenyUnscoped set should refuse an unscoped (empty-region) message")
	}
	// DenyUnscoped must never affect a genuinely scoped message either way.
	scoped := SimNode{DenyUnscoped: true, Regions: []string{"sco"}}
	if !scoped.acceptsRegion("sco") {
		t.Error("DenyUnscoped should not affect a scoped message the node holds the region key for")
	}
	// ...and the mirror image: holding region keys must not revoke plain
	// unscoped relaying. The two gates are independent in firmware, so a
	// repeater configured with scopes still carries regionless traffic
	// unless unscoped is explicitly denied.
	keyed := SimNode{Regions: []string{"sco", "ioi"}}
	if !keyed.acceptsRegion("") {
		t.Error("holding region keys should not stop a node relaying unscoped traffic")
	}
	if keyed.acceptsRegion("edi") {
		t.Error("a node should refuse a region it holds no key for")
	}
}

// TestAcceptsRegionWildcard proves the "*" sentinel (used as a planned
// repeater's default, since its real region config is unknown) accepts
// every region, not just the ones literally listed.
func TestAcceptsRegionWildcard(t *testing.T) {
	n := SimNode{Regions: []string{"*"}}
	for _, region := range []string{"sco", "ioi", "anything"} {
		if !n.acceptsRegion(region) {
			t.Errorf("a node with Regions=[\"*\"] should accept region %q", region)
		}
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

// --- item 9: airtime duty-cycle budget -----------------------------------
//
// txBudget's own formulas are cheap and precise to test directly, rather
// than only proving the behavior indirectly through a Run() that needs to
// drain a full simulated hour's worth of airtime — see
// TestRunDutyCycleBudgetThrottlesHeavySender below for that integration
// check.

func TestTxBudgetInitialValueIsHalfTheWindow(t *testing.T) {
	b := newTxBudget()
	want := dutyCycleWindowMs * dutyCycleFactor
	if b.remainingMs != want {
		t.Errorf("newTxBudget().remainingMs = %v, want %v (real firmware boots with a full 50%% duty-cycle budget)", b.remainingMs, want)
	}
}

func TestTxBudgetRefillCapsAtMax(t *testing.T) {
	b := newTxBudget()
	b.remainingMs = 0
	b.refill(dutyCycleWindowMs * 10) // absurdly long elapsed time
	want := dutyCycleWindowMs * dutyCycleFactor
	if b.remainingMs != want {
		t.Errorf("refill after a huge elapsed time = %v, want capped at %v", b.remainingMs, want)
	}
}

func TestTxBudgetRefillAccruesAtDutyCycleFactor(t *testing.T) {
	b := txBudget{remainingMs: 0, lastUpdateMs: 0}
	b.refill(1000)
	want := 1000.0 * dutyCycleFactor
	if b.remainingMs != want {
		t.Errorf("refill(1000ms) = %v, want %v (dutyCycleFactor %v)", b.remainingMs, want, dutyCycleFactor)
	}
}

func TestTxBudgetDeferralMsZeroWhenBudgetSufficient(t *testing.T) {
	b := newTxBudget()
	if got := b.deferralMs(1000); got != 0 {
		t.Errorf("deferralMs with a full budget = %d, want 0", got)
	}
}

func TestTxBudgetDeferralMsWaitsForHalfTheEstAirtime(t *testing.T) {
	// Needs 300/2=150ms of budget but only has 100 — a 50ms deficit at a
	// 0.5 refill rate takes 100ms of elapsed time to make up.
	b := txBudget{remainingMs: 100}
	got := b.deferralMs(300)
	want := uint32(100)
	if got != want {
		t.Errorf("deferralMs(300) with 100ms budget = %d, want %d", got, want)
	}
}

func TestTxBudgetSpendFloorsAtZero(t *testing.T) {
	b := txBudget{remainingMs: 50}
	b.spend(200)
	if b.remainingMs != 0 {
		t.Errorf("spend(200) with 50ms budget = %v, want floored at 0", b.remainingMs)
	}
}

// TestRunDutyCycleBudgetThrottlesHeavySender is the Run()-level integration
// check: a node sending far more near-max-size traffic than a 50% duty
// cycle allows must eventually get throttled — a real listener sees at
// least one reception whose sender was deferred by its own budget, a
// distinct cause from every other gate this package already models (CAD,
// hop limits, loop.detect).
func TestRunDutyCycleBudgetThrottlesHeavySender(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 20}},
	}

	// With firmware-accurate TX serialization a single radio airs these
	// back-to-back, so the budget drains at (spend − refill) per frame.
	// Max-size frames sit EXACTLY on the gate's knife edge (refill per
	// frame = airtime·factor = est/minTxBudgetAirtimeDiv = the threshold,
	// for factor 0.5 and div 2) and never defer — matching firmware's own
	// arithmetic for gapless max-size sends. Half-size frames refill less
	// than the max-size-est threshold and throttle properly; the old
	// fixture only "worked" via the physically impossible
	// everything-at-once burst.
	payload := maxTransUnitBytes / 2
	frameAirtime := AirtimeMs(DefaultNodePrefs().Radio, payload)
	n := int(dutyCycleWindowMs*dutyCycleFactor/((1-dutyCycleFactor)*float64(frameAirtime))) + 400
	messages := make([]Message, n)
	for i := range messages {
		messages[i] = Message{Origin: 0, SendAtMs: uint32(i), PayloadLen: payload}
	}

	report := Run(scenario, messages, zeroRNG{}, dutyCycleWindowMs*2)

	sawDeferred := false
	for _, r := range report.Receptions {
		if r.SenderWasBudgetDeferred {
			sawDeferred = true
			break
		}
	}
	if !sawDeferred {
		t.Error("expected at least one reception whose sender was deferred by its own duty-cycle budget after far exceeding a 50% duty cycle")
	}
}

// --- item 12: Transmissions as first-class events ------------------------

// TestRunRelayCADDeferralReportsActualAirTime is a direct regression test:
// a relay's reported
// AtMs must be when it ACTUALLY went out, not when it was scheduled — CAD
// backoff can and does push those apart.
func TestRunRelayCADDeferralReportsActualAirTime(t *testing.T) {
	// Node 1 finishes receiving packet 0 at exactly this instant, and (per
	// zeroRNG — every random draw picks the minimum — and the default
	// RxDelayBase of 0, i.e. disabled) would schedule its relay for exactly
	// this same instant: both RxDelayMs and RetransmitDelayMs are 0.
	// +1: real on-air length is payload + the path_len byte every packet
	// carries (see onAirLen) — path length is 0 at this point (origin's
	// own first send), so no accumulated path bytes yet.
	scheduledRelayAt := AirtimeMs(DefaultLoRaParams(), 21)

	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(true), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0}, // origin -> relay
			{From: 2, To: 1, SNRdB: 0}, // interferer, audible to the relay
			{From: 1, To: 3, SNRdB: 0}, // relay -> listener
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20}, // packet 0: what node 1 will relay
		// packet 1: starts exactly as node 1 finishes receiving packet 0 —
		// so it does NOT overlap (and therefore does not collide with)
		// packet 0's own reception window, but IS on the air, audible to
		// node 1, at the exact instant node 1 tries to key up for its own
		// scheduled relay — the CAD condition under test.
		{Origin: 2, SendAtMs: scheduledRelayAt, PayloadLen: 250},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	foundReception := false
	for _, r := range report.Receptions {
		if r.PacketID == 0 && r.Node == 1 {
			foundReception = true
			if r.Collided {
				t.Fatalf("test setup assumes node 1's reception of packet 0 does not collide with the interferer — adjust the fixture: %+v", r)
			}
			if r.AtMs != scheduledRelayAt {
				t.Fatalf("test setup assumes node 1 finishes receiving packet 0 at exactly %dms, got %dms — adjust the fixture", scheduledRelayAt, r.AtMs)
			}
		}
	}
	if !foundReception {
		t.Fatal("expected node 1 to receive packet 0 from the origin")
	}

	var relayTx *Transmission
	for i := range report.Transmissions {
		if report.Transmissions[i].PacketID == 0 && report.Transmissions[i].Node == 1 {
			relayTx = &report.Transmissions[i]
		}
	}
	if relayTx == nil {
		t.Fatal("expected node 1 to relay packet 0")
	}
	if !relayTx.CADDeferred {
		t.Errorf("expected node 1's relay to be reported as CAD-deferred: %+v", relayTx)
	}
	if relayTx.AtMs <= scheduledRelayAt {
		t.Errorf("expected node 1's relay to actually air later than its scheduled time (%dms) due to CAD, got %dms", scheduledRelayAt, relayTx.AtMs)
	}
	if !relayTx.IsRelay {
		t.Errorf("expected node 1's transmission of packet 0 to be marked IsRelay: %+v", relayTx)
	}
}

// TestRunTransmissionsPacketNodeKeyIsUnique proves (PacketID, Node) never
// appears twice in Report.Transmissions — real firmware's hasSeen dedup
// guarantees a node transmits any given packet at most once, so a caller
// can pair a Reception with its causing Transmission by that key alone.
// A dense ring is a
// deliberately adversarial topology: every node repeatedly hears copies of
// the same packet arriving from both directions.
func TestRunTransmissionsPacketNodeKeyIsUnique(t *testing.T) {
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

	seen := make(map[[2]int]bool)
	for _, tx := range report.Transmissions {
		key := [2]int{tx.PacketID, tx.Node}
		if seen[key] {
			t.Fatalf("(PacketID, Node) = %v appears more than once in Transmissions", key)
		}
		seen[key] = true
	}
	if len(report.Transmissions) == 0 {
		t.Fatal("expected at least one transmission in this ring")
	}
}

// TestRunTransmissionsOriginAndRelayHopCounts proves the origin's own first
// send is reported as IsRelay:false/HopCount:0, and a first-hop relay as
// IsRelay:true/HopCount:1.
func TestRunTransmissionsOriginAndRelayHopCounts(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(true), testNode(false)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0},
		},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var origin, relay *Transmission
	for i := range report.Transmissions {
		switch report.Transmissions[i].Node {
		case 0:
			origin = &report.Transmissions[i]
		case 1:
			relay = &report.Transmissions[i]
		}
	}
	if origin == nil || relay == nil {
		t.Fatalf("expected transmissions from both the origin and the relay, got %+v", report.Transmissions)
	}
	if origin.IsRelay || origin.HopCount != 0 {
		t.Errorf("origin's own send should be IsRelay:false, HopCount:0, got %+v", origin)
	}
	if !relay.IsRelay || relay.HopCount != 1 {
		t.Errorf("first-hop relay should be IsRelay:true, HopCount:1, got %+v", relay)
	}
}

// TestRunTransmissionOmittedWhenRelayScheduledPastSimWindow is a direct
// regression test: a Reception can report WasRelayed:true (the relay was scheduled) while the
// scheduled instant itself falls past maxSimTimeMs and is dropped by the
// sim-window guard — in which case no Transmission is ever produced for it.
// A caller must therefore treat a reception's WasRelayed as "was eligible
// to relay," not as proof a Transmission exists.
func TestRunTransmissionOmittedWhenRelayScheduledPastSimWindow(t *testing.T) {
	relay := testNode(true)
	// Deliberately huge — pushes the relay's own RxDelayMs holdback (real
	// firmware's score-based "let the best-positioned node go first" delay)
	// out far past any reasonable sim window.
	relay.Prefs.RxDelayBase = 1000
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), relay},
		// Default radio is SF8 (EU/UK Narrow — see DefaultLoRaParams),
		// whose own decode threshold is -10dB (snrThresholdDB[1]). Just
		// above that threshold gives a PacketScore near 0, which maximises
		// RxDelayMs's (0.85-score) exponent and therefore the delay.
		Links: []Link{{From: 0, To: 1, SNRdB: -9.9}},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	const maxSimTimeMs = 2000
	report := Run(scenario, messages, zeroRNG{}, maxSimTimeMs)

	var reception *Reception
	for i := range report.Receptions {
		if report.Receptions[i].Node == 1 {
			reception = &report.Receptions[i]
		}
	}
	if reception == nil {
		t.Fatal("expected node 1 to receive the packet")
	}
	if !reception.WasRelayed {
		t.Fatal("test setup expects node 1 to have been ELIGIBLE to relay (WasRelayed) even though the relay itself never actually airs — adjust the fixture if this fails")
	}
	for _, tx := range report.Transmissions {
		if tx.Node == 1 {
			t.Errorf("expected no Transmission for node 1 (its relay was scheduled past maxSimTimeMs=%d), got %+v", maxSimTimeMs, tx)
		}
	}
}

// --- item 13: collision taxonomy (tx_busy / no_lock / corrupted) ---------

// TestRunTxBusyWhenListenerIsTransmitting is the direct regression test for
// a half-duplex bug: a node cannot receive while its own transmitter is on
// the air. Node 0
// begins its own send at t=0; node 1 sends a packet to it at the same
// instant. Node 0 must report the reception as tx_busy — not collided, not
// decoded — rather than the bug's actual prior behaviour (received and
// even relayed while transmitting).
func TestRunTxBusyWhenListenerIsTransmitting(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 1, To: 0, SNRdB: 0}},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20}, // node 0's own outbound send, keeping its radio busy
		{Origin: 1, SendAtMs: 0, PayloadLen: 20}, // arrives at node 0 during that same window
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var reception *Reception
	for i := range report.Receptions {
		if report.Receptions[i].PacketID == 1 && report.Receptions[i].Node == 0 {
			reception = &report.Receptions[i]
		}
	}
	if reception == nil {
		t.Fatal("expected a reception record for packet 1 at node 0")
	}
	if reception.DropReason != "tx_busy" {
		t.Errorf("expected DropReason \"tx_busy\", got %q: %+v", reception.DropReason, reception)
	}
	if reception.Collided {
		t.Errorf("tx_busy is a miss, not a collision — Collided should be false: %+v", reception)
	}
	if reception.WasRelayed {
		t.Errorf("a packet never heard at all can't have been relayed: %+v", reception)
	}
}

// TestRunTxBusyDoesNotMarkSeen proves a tx_busy miss doesn't count as
// "decoded" for hasSeen dedup purposes: node 0 misses packet A's direct
// copy (busy transmitting its own packet at the same instant), but a LATER
// copy of the same packet, arriving via a longer path once node 0 is free
// again, must still be received cleanly and relayed onward — exactly the
// same rule weak_signal already follows (see item 1's own ordering notes).
func TestRunTxBusyDoesNotMarkSeen(t *testing.T) {
	scenario := Scenario{
		// 0: busy-then-relaying node under test. 1: listener, observes
		// whether 0 relays packet A. 2: packet A's origin, never relays.
		// 3: bridges packet A's alternate (longer, later-arriving) path —
		// must itself be able to relay.
		Nodes: []SimNode{testNode(true), testNode(false), testNode(false), testNode(true)},
		Links: []Link{
			{From: 2, To: 0, SNRdB: 0}, // packet A's direct path to node 0 — missed (tx_busy)
			{From: 2, To: 3, SNRdB: 0}, // packet A's alternate path, hop 1
			{From: 3, To: 0, SNRdB: 0}, // packet A's alternate path, hop 2 — arrives once node 0 is free
			{From: 0, To: 1, SNRdB: 0}, // observes whether node 0 goes on to relay packet A
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20}, // packet 0: node 0's own send, busy for [0, airtime20)
		{Origin: 2, SendAtMs: 0, PayloadLen: 20}, // packet 1 ("packet A"): same payload size, so its direct copy's window exactly matches node 0's busy window
	}

	airtime20 := AirtimeMs(DefaultLoRaParams(), 20)
	// The alternate path's second hop can only arrive once node 3 has
	// itself received AND relayed packet A — at the very earliest 2 ×
	// airtime20 (one airtime for node 3's own reception, one more for its
	// relay) — which must land after node 0's busy window
	// ([0, airtime20)) has already ended, or this test doesn't actually
	// exercise "seen despite the miss."
	if 2*airtime20 <= airtime20 {
		t.Fatal("test setup assumes the alternate path's second hop arrives after node 0's own busy window ends — adjust the fixture")
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var missedAt, cleanAt *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.PacketID != 1 || r.Node != 0 {
			continue
		}
		if r.DropReason == "tx_busy" {
			missedAt = r
		} else {
			cleanAt = r
		}
	}
	if missedAt == nil {
		t.Fatal("expected node 0 to miss packet A's direct copy as tx_busy")
	}
	if cleanAt == nil {
		t.Fatal("expected node 0 to still cleanly receive packet A's later copy via the alternate path, despite the earlier tx_busy miss")
	}
	if !cleanAt.WasRelayed {
		t.Errorf("expected node 0 to relay packet A after receiving it cleanly: %+v", cleanAt)
	}

	sawAtListener := false
	for _, r := range report.Receptions {
		if r.PacketID == 1 && r.Node == 1 && !r.Collided {
			sawAtListener = true
		}
	}
	if !sawAtListener {
		t.Error("expected node 1 to eventually receive packet A via node 0's relay — propagation should continue normally past the tx_busy miss")
	}
}

// TestLoraCaptureOutcomeDistinguishesNoLockFromCorrupted is
// TestLoraCapturedRequiresLockThenMargin's own fixture, re-run against
// loraCaptureOutcome to prove it reports WHICH of the two ways capture
// failed (not just that it failed) — the direct source for
// Reception.CollisionKind.
func TestLoraCaptureOutcomeDistinguishesNoLockFromCorrupted(t *testing.T) {
	radio := DefaultLoRaParams()
	preambleMs := uint32(preambleDurationMs(radio))
	tx := transmission{startMs: 1000, radio: radio}

	tests := []struct {
		name          string
		otherStartMs  uint32
		wantedSNR     float64
		interfererSNR float64
		want          captureOutcome
	}{
		{"interferer during preamble, comparable strength — no_lock", tx.startMs + preambleMs/2, 4, 0, outcomeNoLock},
		{"interferer during preamble, much weaker — wanted wins acquisition", tx.startMs + preambleMs/2, 20, -20, outcomeCaptured},
		{"interferer after lock, margin met — captured", tx.startMs + preambleMs + 50, 10, 0, outcomeCaptured},
		{"interferer after lock, margin short — corrupted", tx.startMs + preambleMs + 50, 5, 0, outcomeCorrupted},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			other := transmission{startMs: tt.otherStartMs, radio: radio}
			got := loraCaptureOutcome(tt.wantedSNR, tt.interfererSNR, tx, other)
			if got != tt.want {
				t.Errorf("loraCaptureOutcome(...) = %v, want %v", got, tt.want)
			}
		})
	}
}

// TestRunCollisionKindNoLockDominatesCorrupted proves that when a reception
// has BOTH a no_lock-causing interferer and a corrupted-causing interferer
// at once, CollisionKind reports "no_lock" — without lock, whatever a
// different interferer did at the payload level is moot.
func TestRunCollisionKindNoLockDominatesCorrupted(t *testing.T) {
	radio := DefaultLoRaParams()
	preambleMs := uint32(preambleDurationMs(radio))

	scenario := Scenario{
		// 0: wanted signal's origin. 1: causes no_lock (starts alongside
		// 0, inside its preamble window, and is strong enough that 0 can't
		// win acquisition over it — see the SNR note below). 2: causes
		// corrupted (starts after 0's lock deadline, with insufficient SNR
		// margin). 3: the listener under test.
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 3, SNRdB: 10},
			{From: 1, To: 3, SNRdB: 8}, // 10 - 8 = 2 < preambleCaptureMarginDB (6) — 0 can't capture over it during preamble, so lock never acquires (no_lock)
			{From: 2, To: 3, SNRdB: 6}, // 10 - 6 = 4 < captureMarginDB (6) — insufficient margin, i.e. "corrupted" on its own
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 0, PayloadLen: 20},              // starts alongside packet 0 — inside its preamble window
		{Origin: 2, SendAtMs: preambleMs + 1, PayloadLen: 20}, // starts just after packet 0's own lock deadline
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var reception *Reception
	for i := range report.Receptions {
		if report.Receptions[i].PacketID == 0 && report.Receptions[i].Node == 3 {
			reception = &report.Receptions[i]
		}
	}
	if reception == nil {
		t.Fatal("expected a reception of packet 0 at node 3")
	}
	if !reception.Collided {
		t.Fatalf("test setup assumes this reception collides (two interferers) — adjust the fixture: %+v", reception)
	}
	if reception.CollisionKind != "no_lock" {
		t.Errorf("expected CollisionKind \"no_lock\" (it dominates \"corrupted\"), got %q: %+v", reception.CollisionKind, reception)
	}
}

// TestRunCollisionKindEmptyWhenNotCollided proves CollisionKind stays empty
// on a clean, uncontended reception — it only ever explains a collision,
// never anything else.
func TestRunCollisionKindEmptyWhenNotCollided(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}}, // well above every SF's threshold, nothing else audible
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	if len(report.Receptions) != 1 {
		t.Fatalf("expected exactly 1 reception, got %d: %+v", len(report.Receptions), report.Receptions)
	}
	r := report.Receptions[0]
	if r.Collided {
		t.Fatalf("test setup assumes a clean reception — adjust the fixture: %+v", r)
	}
	if r.CollisionKind != "" {
		t.Errorf("expected CollisionKind empty on an uncollided reception, got %q: %+v", r.CollisionKind, r)
	}
}

// --- phase 3: path-hash size is a packet property, not a node one --------
//
// Real firmware: the ORIGINATOR picks a message's path-hash size
// (Mesh::sendFlood(packet, delay, path_hash_size), src/Mesh.cpp:634) and it
// travels unchanged with the packet — a relay appends its own hash at the
// PACKET's size, never its own configured one (Mesh::routeRecvPacket,
// src/Mesh.cpp:335), and loop.detect reads the packet's size too
// (MyMesh::isLooped, examples/simple_repeater/MyMesh.cpp:404).

// TestMessageEffectiveHashSizeDefaultsAndClamps proves Message.HashSize's
// resolution: unset/zero falls back to defaultMessageHashSize, and
// out-of-range values clamp into the real 1-3 byte range the same way
// nodeHash's own hashSize parameter does.
func TestMessageEffectiveHashSizeDefaultsAndClamps(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{"zero falls back to default", 0, defaultMessageHashSize},
		{"negative falls back to default", -1, defaultMessageHashSize},
		{"above 3 clamps to 3", 4, 3},
		{"1 passes through", 1, 1},
		{"2 passes through", 2, 2},
		{"3 passes through", 3, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := Message{HashSize: tt.in}
			if got := m.effectiveHashSize(); got != tt.want {
				t.Errorf("Message{HashSize: %d}.effectiveHashSize() = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

// TestOnAirLenIncludesPathBytes is a table-driven check against
// Packet::getRawLength's own wire layout (src/Packet.cpp): 2 framing bytes
// (header + path_len) + hash_count*hash_size accumulated path bytes +
// payload + 4 transport-code bytes when the packet carries them.
func TestOnAirLenIncludesPathBytes(t *testing.T) {
	tests := []struct {
		payloadLen, hashCount, hashSize int
		transport                       bool
		want                            int
	}{
		{20, 0, 3, false, 22}, // origin's own first send: no accumulated path yet, 2 framing bytes
		{20, 1, 3, false, 25}, // one relay hop at 3 bytes
		{20, 5, 1, false, 27}, // five hops at 1 byte
		{20, 2, 2, false, 26}, // two hops at 2 bytes
		{0, 0, 3, false, 2},   // zero-length payload still carries the 2 framing bytes
		{20, 0, 3, true, 26},  // region-scoped: + 4 transport-code bytes
		{20, 1, 3, true, 29},  // scoped, one relay hop
	}
	for _, tt := range tests {
		if got := onAirLen(tt.payloadLen, tt.hashCount, tt.hashSize, tt.transport); got != tt.want {
			t.Errorf("onAirLen(%d, %d, %d, %v) = %d, want %d", tt.payloadLen, tt.hashCount, tt.hashSize, tt.transport, got, tt.want)
		}
	}
}

// TestRunAirtimeGrowsWithHopCount is the regression guard for phase 3's
// airtime fix: two otherwise-identical relay chains of different depth
// must show STRICTLY increasing AirtimeMs per hop, since each additional
// hop's accumulated path bytes really are on the air (previously, airtime
// was computed from PayloadLen alone and never grew with path depth at
// all).
func TestRunAirtimeGrowsWithHopCount(t *testing.T) {
	// An 8-node chain: 0 -> 1 -> ... -> 7, all relays. Airtime is quantized
	// into whole LoRa symbols (see AirtimeMs's own ceil()), so consecutive
	// hops (each +3 accumulated path bytes) don't always cross a symbol
	// boundary — two adjacent hops can legitimately report identical
	// AirtimeMs (verified directly against AirtimeMs: at the default radio
	// params, hops 2->3 and 6->7 both plateau). So this only asserts
	// monotonic NON-decrease hop to hop, plus a strict increase between the
	// first and last hop reached — the real, hop-agnostic claim: a deeper
	// relay chain's packet costs strictly more airtime overall than a
	// shallow one's, even though not literally every single hop must.
	const chainLen = 8
	nodes := make([]SimNode, chainLen)
	var links []Link
	for i := 0; i < chainLen; i++ {
		nodes[i] = testNode(true)
		if i > 0 {
			links = append(links, Link{From: i - 1, To: i, SNRdB: 20})
		}
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	airtimeByHop := map[int]uint32{}
	for _, tx := range report.Transmissions {
		if tx.PacketID != 0 {
			continue
		}
		airtimeByHop[tx.HopCount] = tx.AirtimeMs
	}
	maxHop := -1
	for hop := range airtimeByHop {
		if hop > maxHop {
			maxHop = hop
		}
	}
	if maxHop < 3 {
		t.Fatalf("test setup: expected the chain to propagate at least 3 hops deep within the sim window, got hops up to %d: %+v", maxHop, airtimeByHop)
	}
	for hop := 0; hop < maxHop; hop++ {
		cur, ok := airtimeByHop[hop]
		if !ok {
			continue
		}
		next, ok := airtimeByHop[hop+1]
		if !ok {
			continue
		}
		if next < cur {
			t.Errorf("expected hop %d's airtime (%dms) to be at least hop %d's (%dms) — airtime must never SHRINK as the accumulated path grows", hop+1, next, hop, cur)
		}
	}
	if airtimeByHop[maxHop] <= airtimeByHop[0] {
		t.Errorf("expected the deepest hop's airtime (%dms, hop %d) to strictly exceed the origin's own (%dms, hop 0) — %d hops' worth of accumulated path bytes must cost something overall", airtimeByHop[maxHop], maxHop, airtimeByHop[0], maxHop)
	}
}

// TestRunRelayAppendsAtPacketHashSizeNotItsOwn proves a relay's own
// SimNode.HashSize has no bearing on the packet it merely relays — only on
// packets it originates. A message sent at 3-byte hash size through a
// relay configured with HashSize 1 must still be reported (and evaluated
// for loop.detect) at 3 bytes throughout.
func TestRunRelayAppendsAtPacketHashSizeNotItsOwn(t *testing.T) {
	const origin, relay, listener = 0, 1, 2
	nodes := []SimNode{testNode(false), testNode(true), testNode(false)}
	nodes[relay].HashSize = 1 // what this node stamps on packets IT originates — irrelevant here
	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: origin, To: relay, SNRdB: 20},
			{From: relay, To: listener, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var relayTx *Transmission
	for i := range report.Transmissions {
		if report.Transmissions[i].Node == relay && report.Transmissions[i].PacketID == 0 {
			relayTx = &report.Transmissions[i]
		}
	}
	if relayTx == nil {
		t.Fatal("expected node 1 to relay packet 0")
	}
	if relayTx.HashSize != 3 {
		t.Errorf("relay's own transmission HashSize = %d, want 3 (the packet's own size, not the relay's configured HashSize of 1)", relayTx.HashSize)
	}
	wantOnAir := onAirLen(20, 1, 3, false) // 1 accumulated hop (origin's own hash) at 3 bytes, unscoped (no transport codes)
	if relayTx.OnAirLen != wantOnAir {
		t.Errorf("relay's own transmission OnAirLen = %d, want %d", relayTx.OnAirLen, wantOnAir)
	}
}

// TestRunLoopDetectUsesPacketHashSizeNotListeners is a direct regression
// test: a listener's own
// configured SimNode.HashSize must never drive its own loop.detect
// evaluation — only the packet's own HashSize does (MyMesh::isLooped reads
// packet->getPathHashSize(), examples/simple_repeater/MyMesh.cpp:404).
//
// Listener D is configured with HashSize 1 (minimal threshold there would
// be 4 — see loopDetectThreshold), but the packet itself carries hash size
// 3 (minimal threshold 1). If the engine incorrectly used the listener's
// own HashSize, a single appearance of D's hash in the path would NOT
// trigger loop_detect (threshold 4 needs 4 appearances); using the
// packet's own size (3), it must trigger on the very first appearance.
func TestRunLoopDetectUsesPacketHashSizeNotListeners(t *testing.T) {
	// Find a node index X whose 3-byte hash collides with D's 3-byte hash
	// — same technique as the existing hash-collision tests, just at a
	// different hash size so this test can't accidentally pass via the
	// 1-byte table instead.
	var x, d int
	found := false
	seenHash := map[uint32]int{}
	for i := 0; i < 5000; i++ {
		h := nodeHash(i, 3)
		if j, ok := seenHash[h]; ok {
			x, d = j, i
			found = true
			break
		}
		seenHash[h] = i
	}
	if !found {
		t.Fatal("expected to find a 3-byte hash collision among node indices 0..4999")
	}

	n := x
	if d > n {
		n = d
	}
	origin := n + 1
	nodes := make([]SimNode, n+2)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	nodes[d].HashSize = 1 // the listener's own configured size — must NOT be what gates its own loop detect
	nodes[d].LoopDetect = "minimal"

	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: origin, To: x, SNRdB: 20},
			{From: x, To: d, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atD *Reception
	for i := range report.Receptions {
		if report.Receptions[i].Node == d {
			atD = &report.Receptions[i]
		}
	}
	if atD == nil {
		t.Fatal("expected node d to receive the packet")
	}
	if atD.DropReason != "loop_detect" {
		t.Errorf("DropReason = %q, want %q — the packet's own 3-byte hash size gives a minimal threshold of 1 (loopDetectThreshold(\"minimal\", 3) == 1), which node d's single colliding hop should trip regardless of d's own configured HashSize of 1", atD.DropReason, "loop_detect")
	}
}

// SIMULATION_REVIEW.md A1: a single radio strictly serializes its own
// sends — two messages scheduled to overlap from one node must air
// back-to-back, never concurrently.
func TestRunOwnTransmissionsAreSerialized(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 20}},
	}
	// Two sends 10ms apart, each frame far longer than 10ms of airtime.
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 200},
		{Origin: 0, SendAtMs: 10, PayloadLen: 200},
	}
	report := Run(scenario, messages, zeroRNG{}, 60000)
	if len(report.Transmissions) < 2 {
		t.Fatalf("expected both messages transmitted, got %d transmissions", len(report.Transmissions))
	}
	var spans [][2]uint32
	for _, tx := range report.Transmissions {
		if tx.Node == 0 {
			spans = append(spans, [2]uint32{tx.AtMs, tx.AtMs + tx.AirtimeMs})
		}
	}
	if len(spans) != 2 {
		t.Fatalf("expected exactly 2 transmissions from node 0, got %d", len(spans))
	}
	for i := 0; i < len(spans); i++ {
		for j := i + 1; j < len(spans); j++ {
			a, b := spans[i], spans[j]
			if a[0] < b[1] && b[0] < a[1] {
				t.Errorf("node 0 aired two packets concurrently: %v overlaps %v — a single radio cannot do that", a, b)
			}
		}
	}
}

// SIMULATION_REVIEW.md A2: firmware refuses to relay once the accumulated
// path would exceed MAX_PATH_SIZE (64 bytes) — 21 hops at 3-byte hashes.
// A long chain must show path_full drops instead of relaying forever.
func TestRunPathFullGateStopsDeepFloods(t *testing.T) {
	const chain = 30 // > 64/3 = 21 hops
	nodes := make([]SimNode, chain)
	links := make([]Link, 0, chain-1)
	for i := range nodes {
		nodes[i] = testNode(true)
		if i > 0 {
			links = append(links, Link{From: i - 1, To: i, SNRdB: 20})
		}
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}
	report := Run(scenario, messages, zeroRNG{}, 10_000_000)

	maxHop := 0
	sawPathFull := false
	for _, r := range report.Receptions {
		if r.HopCount > maxHop {
			maxHop = r.HopCount
		}
		if r.DropReason == "path_full" {
			sawPathFull = true
		}
	}
	// The last APPENDER is hop index 20 (21 hashes incl. its own); the
	// packet it airs arrives with hopCount 21 and must NOT be relayed on.
	if maxHop > 21 {
		t.Errorf("flood reached hop %d — firmware's MAX_PATH_SIZE gate caps a 3-byte-hash flood at 21 accumulated hashes", maxHop)
	}
	if !sawPathFull {
		t.Error("expected at least one path_full drop on a 30-node chain")
	}
}
