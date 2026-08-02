package meshsim

import "testing"

// Item 13: the collision taxonomy — tx_busy, no_lock and corrupted are
// three different failures and the report has to keep them apart.

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
