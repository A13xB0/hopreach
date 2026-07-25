package meshsim

import "testing"

// TestBackgroundTransmissionCollidesButNeverRelays is the core check for
// phase 8's background-interference support: a fixed background transmission
// (Message.Background) occupies the channel — colliding with an overlapping
// flood at a shared listener — but never itself relays or generates a
// reception.
func TestBackgroundTransmissionCollidesButNeverRelays(t *testing.T) {
	// 0 floods to listener 2; 1 emits a fixed background transmission, also
	// audible at 2, at the same instant — guaranteeing an overlap at 2.
	const flood, bg, listener = 0, 1, 2
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(true)},
		Links: []Link{
			{From: flood, To: listener, SNRdB: 0},
			{From: bg, To: listener, SNRdB: 0},
		},
	}
	messages := []Message{
		{Origin: flood, SendAtMs: 0, PayloadLen: 20},
		{Origin: bg, SendAtMs: 0, PayloadLen: 20, Background: true, FrameBytes: 24},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	// The background node must transmit exactly once, marked Background, and
	// never relay (no second transmission from it).
	bgTx := 0
	for _, tx := range report.Transmissions {
		if tx.Node == bg {
			bgTx++
			if !tx.Background {
				t.Errorf("background node's transmission not marked Background: %+v", tx)
			}
		}
	}
	if bgTx != 1 {
		t.Errorf("expected the background node to transmit exactly once (never relay), got %d transmissions", bgTx)
	}

	// The background transmission must NOT produce a reception of its own
	// (packetID 1 is the background message).
	for _, r := range report.Receptions {
		if r.PacketID == bg {
			t.Errorf("background transmission should generate no receptions, got %+v", r)
		}
	}

	// The flood's reception at the listener must have collided, naming the
	// background node as the cause — proving background interferes.
	var atListener *Reception
	for i := range report.Receptions {
		if report.Receptions[i].PacketID == flood && report.Receptions[i].Node == listener {
			atListener = &report.Receptions[i]
		}
	}
	if atListener == nil {
		t.Fatal("expected a reception of the flood at the listener")
	}
	if !atListener.Collided {
		t.Errorf("expected the flood reception to collide with the overlapping background transmission, got %+v", atListener)
	}
	found := false
	for _, c := range atListener.CollidedWith {
		if c == bg {
			found = true
		}
	}
	if !found {
		t.Errorf("expected CollidedWith to name the background node %d, got %v", bg, atListener.CollidedWith)
	}
}

// TestBackgroundTransmissionCausesTxBusy proves a node's own background
// transmission makes it deaf (half-duplex) to a flood arriving during that
// window — the background node itself can't hear what it's talking over.
func TestBackgroundTransmissionCausesTxBusy(t *testing.T) {
	// 0 floods to node 1; node 1 also emits a background transmission at the
	// same time, so it's keyed up and can't hear the flood.
	const flood, node1 = 0, 1
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true)},
		Links: []Link{{From: flood, To: node1, SNRdB: 0}},
	}
	messages := []Message{
		{Origin: flood, SendAtMs: 0, PayloadLen: 20},
		{Origin: node1, SendAtMs: 0, PayloadLen: 20, Background: true, FrameBytes: 40}, // longer, so it certainly overlaps the flood's own airtime
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atNode1 *Reception
	for i := range report.Receptions {
		if report.Receptions[i].PacketID == flood && report.Receptions[i].Node == node1 {
			atNode1 = &report.Receptions[i]
		}
	}
	if atNode1 == nil {
		t.Fatal("expected a reception of the flood at node 1")
	}
	if atNode1.DropReason != "tx_busy" {
		t.Errorf("expected node 1 to miss the flood as tx_busy (its own background tx was keyed), got DropReason %q", atNode1.DropReason)
	}
}

// TestBackgroundMessagesExcludedFromDeliveryMetrics proves a background
// message is NOT scored as a delivery (it never relays and produces no
// receptions, so counting it would corrupt the delivery ratio the optimizer
// maximises). A scenario with one healthy flood and one background message
// must report the flood's delivery, not an average dragged toward zero.
func TestBackgroundMessagesExcludedFromDeliveryMetrics(t *testing.T) {
	// 0 -> 1 -> 2, a clean flood chain (delivery should be ~1). 3 emits a
	// background transmission that reaches nobody useful.
	a, b, c, bg := 0, 1, 2, 3
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(false), testNode(true)},
		Links: []Link{
			{From: a, To: b, SNRdB: 20}, {From: b, To: c, SNRdB: 20},
		},
	}
	messages := []Message{
		{Origin: a, SendAtMs: 0, PayloadLen: 20},
		{Origin: bg, SendAtMs: 1000, PayloadLen: 20, Background: true, FrameBytes: 24},
	}
	report := Run(scenario, messages, zeroRNG{}, 60_000)

	// The flood reaches b and c (its whole reachable audience) — delivery 1.0.
	// If the background message were counted, its zero delivery would halve it.
	got := report.DeliveryRatio(scenario, messages)
	if got < 0.99 {
		t.Errorf("DeliveryRatio = %v, want ~1.0 (the background message must not be scored as a failed delivery)", got)
	}

	// And the background node must not accrue a ReachableCount from its own
	// non-delivering message.
	stats := report.PerNodeStats(scenario, messages)
	// c is reachable from the flood origin, so it has a ReachableCount; the
	// background message must not have added any reachable audience of its own.
	// (Sanity: b and c are the flood's audience; bg's own reach isn't counted.)
	if stats[bg].ReachableCount != 0 {
		t.Errorf("background node ReachableCount = %d, want 0 (its own background message is not a delivery)", stats[bg].ReachableCount)
	}
}

// TestBackgroundTransmissionInertWithoutOverlap is the negative case: a
// background transmission that doesn't overlap a flood in time leaves the
// flood cleanly received — background only interferes when it actually
// shares airtime.
func TestBackgroundTransmissionInertWithoutOverlap(t *testing.T) {
	const flood, bg, listener = 0, 1, 2
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(false)},
		Links: []Link{
			{From: flood, To: listener, SNRdB: 0},
			{From: bg, To: listener, SNRdB: 0},
		},
	}
	messages := []Message{
		{Origin: flood, SendAtMs: 0, PayloadLen: 20},
		{Origin: bg, SendAtMs: 40_000, PayloadLen: 20, Background: true, FrameBytes: 24}, // well after the flood is done
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	for _, r := range report.Receptions {
		if r.PacketID == flood && r.Node == listener && r.Collided {
			t.Errorf("a non-overlapping background transmission must not collide with the flood: %+v", r)
		}
	}
}
