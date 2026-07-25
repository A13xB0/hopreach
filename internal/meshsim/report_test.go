package meshsim

import "testing"

// --- reachableFrom ---------------------------------------------------

func TestReachableFromExcludesUnreachableNodes(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(true)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}}, // node 2 has no link at all — unreachable
	}
	got := reachableFrom(scenario, 0, "")
	if !got[0] || !got[1] {
		t.Errorf("expected the origin and node 1 both reachable: %v", got)
	}
	if got[2] {
		t.Errorf("expected node 2 (no link at all) to be unreachable: %v", got)
	}
	if len(got) != 2 {
		t.Errorf("reachableFrom = %v, want exactly {0, 1}", got)
	}
}

func TestReachableFromCanRelayFalseNodeIsALeaf(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(false), testNode(true)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0}, // origin -> A (CanRelay:false)
			{From: 1, To: 2, SNRdB: 0}, // A -> B, only reachable via A
		},
	}
	got := reachableFrom(scenario, 0, "")
	if !got[0] || !got[1] {
		t.Errorf("expected the origin and node 1 (a leaf) both reachable: %v", got)
	}
	if got[2] {
		t.Errorf("expected node 2 to be unreachable — node 1 can't relay, so it's a leaf: %v", got)
	}
}

func TestReachableFromRegionRefusingNodeIsALeaf(t *testing.T) {
	relay := testNode(true)
	relay.Regions = []string{"#other"} // doesn't hold the message's own region key
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), relay, testNode(true)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0},
		},
	}
	got := reachableFrom(scenario, 0, "#target")
	if !got[0] || !got[1] {
		t.Errorf("expected the origin and node 1 (a leaf — wrong region) both reachable: %v", got)
	}
	if got[2] {
		t.Errorf("expected node 2 to be unreachable — node 1 doesn't hold #target's region key, so it's a leaf: %v", got)
	}
}

// TestReachableFromOriginExemptFromItsOwnGates proves CanRelay/acceptsRegion
// only govern whether a RELAYER passes a packet on — never whether the
// origin sends it in the first place (mirroring Run's own initial
// eventSend push, which isn't gated by either).
func TestReachableFromOriginExemptFromItsOwnGates(t *testing.T) {
	origin := testNode(false) // CanRelay:false and holds no region key at all
	scenario := Scenario{
		Nodes: []SimNode{origin, testNode(true)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}},
	}
	got := reachableFrom(scenario, 0, "#target")
	if !got[0] || !got[1] {
		t.Errorf("expected both the origin and node 1 reachable regardless of the origin's own CanRelay/region: %v", got)
	}
}

// --- DeliveryRatio -----------------------------------------------------

func TestDeliveryRatioFullDelivery(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	if got := report.DeliveryRatio(scenario, messages); got != 1.0 {
		t.Errorf("DeliveryRatio = %v, want 1.0 (the only reachable node received cleanly)", got)
	}
}

func TestDeliveryRatioPartialDelivery(t *testing.T) {
	// Two reachable neighbours of the origin; only one will ever actually
	// decode it — the other's SNR is far below any SF's own threshold.
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0},   // decodes fine
			{From: 0, To: 2, SNRdB: -99}, // far below threshold — never decodes (weak_signal)
		},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	if got := report.DeliveryRatio(scenario, messages); got != 0.5 {
		t.Errorf("DeliveryRatio = %v, want 0.5 (1 of 2 reachable nodes actually decoded it)", got)
	}
}

// TestDeliveryRatioExcludesUnreachableNodeFromDenominator is the direct
// regression test for the "reachability denominator" requirement: an
// isolated node must not count against delivery just for existing in the
// scenario.
func TestDeliveryRatioExcludesUnreachableNodeFromDenominator(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}}, // node 2 has no link at all
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	if got := report.DeliveryRatio(scenario, messages); got != 1.0 {
		t.Errorf("DeliveryRatio = %v, want 1.0 — an unreachable node must not count against delivery", got)
	}
}

func TestDeliveryRatioEmptyMessagesReturnsZero(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(false)}}
	report := Run(scenario, nil, zeroRNG{}, 60_000)
	if got := report.DeliveryRatio(scenario, nil); got != 0 {
		t.Errorf("DeliveryRatio with no messages = %v, want 0", got)
	}
}

// --- PerNodeStats (phase 4 work item 3) -----------------------------------

// TestPerNodeStatsCountsSuccessAndCollision reuses
// TestRunCollisionKindNoLockDominatesCorrupted's own proven fixture (a
// guaranteed collision with two real interferers) to check the
// aggregation layer: SuccessCount/CollisionCount/ContentionCaused must
// come out right given a report already known to contain exactly this
// shape of reception.
func TestPerNodeStatsCountsSuccessAndCollision(t *testing.T) {
	radio := DefaultLoRaParams()
	preambleMs := uint32(preambleDurationMs(radio))
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: 0, To: 3, SNRdB: 10},
			{From: 1, To: 3, SNRdB: 0},
			{From: 2, To: 3, SNRdB: 6},
		},
	}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 1, SendAtMs: 0, PayloadLen: 20},
		{Origin: 2, SendAtMs: preambleMs + 1, PayloadLen: 20},
	}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	stats := report.PerNodeStats(scenario, messages)

	if len(stats) != 4 {
		t.Fatalf("expected 4 NodeStats (one per node), got %d", len(stats))
	}
	if stats[3].CollisionCount == 0 {
		t.Errorf("expected node 3 (the listener) to show at least one collision: %+v", stats[3])
	}
	// Node 1 and/or node 2 caused the collision at node 3 — CollidedWith
	// attributes it to whichever interferer(s) were actually audible and
	// overlapping (see Reception.CollidedWith's own doc comment); either
	// or both should show non-zero ContentionCaused.
	if stats[1].ContentionCaused == 0 && stats[2].ContentionCaused == 0 {
		t.Errorf("expected at least one of the two interferers (node 1, node 2) to show ContentionCaused > 0: %+v / %+v", stats[1], stats[2])
	}
}

// TestPerNodeStatsRedundantRelayWhenListenerAlreadyHadPacket is the direct
// regression test for RedundantRelays' own purpose: a relay whose only
// listener already had the packet from a faster path spent airtime
// without adding coverage, and must be counted as redundant — while the
// relay that ACTUALLY delivered it must not be.
//
// Topology: two paths from origin 0 to listener 2 — a 2-hop path via node
// 1, and a deliberately longer 3-hop path via nodes 3 then 4. The longer
// path's extra hop guarantees node 4's relay arrives at node 2 strictly
// after node 1's already has (node 2's reception via node 4 is
// already_seen, non-canonical), regardless of the equal SNR on every link.
func TestPerNodeStatsRedundantRelayWhenListenerAlreadyHadPacket(t *testing.T) {
	const origin, fast, listener, slowA, slowB = 0, 1, 2, 3, 4
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(false), testNode(true), testNode(true)},
		Links: []Link{
			{From: origin, To: fast, SNRdB: 20},
			{From: fast, To: listener, SNRdB: 20},
			{From: origin, To: slowA, SNRdB: 20},
			{From: slowA, To: slowB, SNRdB: 20},
			{From: slowB, To: listener, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20}}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	stats := report.PerNodeStats(scenario, messages)

	if stats[fast].RelayedCount != 1 {
		t.Fatalf("test setup: expected node %d to relay exactly once, got %d", fast, stats[fast].RelayedCount)
	}
	if stats[slowB].RelayedCount != 1 {
		t.Fatalf("test setup: expected node %d to relay exactly once, got %d", slowB, stats[slowB].RelayedCount)
	}
	if stats[fast].RedundantRelays != 0 {
		t.Errorf("node %d's relay actually delivered the packet — should NOT count as redundant: %+v", fast, stats[fast])
	}
	if stats[slowB].RedundantRelays != 1 {
		t.Errorf("node %d's relay arrived after the listener already had it — should count as redundant: %+v", slowB, stats[slowB])
	}
	if stats[fast].UniqueDeliveries != 1 {
		t.Errorf("expected node %d to be credited with the one unique delivery, got %d", fast, stats[fast].UniqueDeliveries)
	}
}

// TestPerNodeStatsReachableCountExcludesOrigin proves ReachableCount uses
// the same "origin isn't its own delivery target" convention
// DeliveryRatio's own doc comment describes.
func TestPerNodeStatsReachableCountExcludesOrigin(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	stats := report.PerNodeStats(scenario, messages)

	if stats[0].ReachableCount != 0 {
		t.Errorf("origin's own ReachableCount = %d, want 0 (it isn't a delivery target for its own message)", stats[0].ReachableCount)
	}
	if stats[1].ReachableCount != 1 {
		t.Errorf("node 1's ReachableCount = %d, want 1", stats[1].ReachableCount)
	}
}

// TestPerNodeStatsDutyAirtimeMsSumsTransmissions proves DutyAirtimeMs sums
// every one of a node's own Transmission.AirtimeMs values, not just the
// first or last.
func TestPerNodeStatsDutyAirtimeMsSumsTransmissions(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(false), testNode(false)}, Links: []Link{{From: 0, To: 1, SNRdB: 0}}}
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 20},
		{Origin: 0, SendAtMs: 10_000, PayloadLen: 20},
	}
	report := Run(scenario, messages, zeroRNG{}, 60_000)
	stats := report.PerNodeStats(scenario, messages)

	var wantSum uint32
	for _, tx := range report.Transmissions {
		if tx.Node == 0 {
			wantSum += tx.AirtimeMs
		}
	}
	if wantSum == 0 {
		t.Fatal("test setup: expected node 0 to have at least one transmission")
	}
	if stats[0].DutyAirtimeMs != wantSum {
		t.Errorf("DutyAirtimeMs = %d, want %d (sum of every one of node 0's own transmissions)", stats[0].DutyAirtimeMs, wantSum)
	}
}

// TestPerNodeStatsOutOfRangeReferencesDoNotPanic guards the inRange checks
// — a defensive measure for a caller passing a scenario/messages pair that
// doesn't actually match r (see PerNodeStats' own doc comment on that
// contract); this must not panic even if it produces meaningless output.
func TestPerNodeStatsOutOfRangeReferencesDoNotPanic(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(false), testNode(false)}, Links: []Link{{From: 0, To: 1, SNRdB: 0}}}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	report := Run(scenario, messages, zeroRNG{}, 60_000)

	// A scenario with FEWER nodes than the report was actually produced
	// from — every node-index reference in the report is now "out of
	// range" relative to this smaller scenario.
	smaller := Scenario{Nodes: scenario.Nodes[:1], Links: scenario.Links}
	_ = report.PerNodeStats(smaller, messages) // must not panic
}
