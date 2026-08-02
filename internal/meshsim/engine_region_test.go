package meshsim

import "testing"

// Region (scope) acceptance: which nodes will relay a scoped flood, and
// what "unscoped" means to a node that denies it.

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
