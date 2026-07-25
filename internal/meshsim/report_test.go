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
// regression test for the "reachability denominator" requirement in
// docs/SIMULATOR_PLAN_PHASE2.md item 15a: an isolated node must not count
// against delivery just for existing in the scenario.
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
