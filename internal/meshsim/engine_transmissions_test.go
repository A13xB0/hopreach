package meshsim

import "testing"

// Item 12: transmissions as first-class events — what a node actually put
// on the air, as opposed to what a listener heard.

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
