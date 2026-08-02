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
