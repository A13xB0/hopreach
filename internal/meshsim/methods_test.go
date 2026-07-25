package meshsim

import "testing"

// TestBuiltinMeshMethodsAllHaveASource enforces MeshMethod's own
// mandatory-provenance contract (see its doc comment): a community
// convention must never render with the same authority as a
// firmware-verified fact, and Source is what lets the UI tell the two
// apart. A method with no Source shouldn't exist at all.
func TestBuiltinMeshMethodsAllHaveASource(t *testing.T) {
	for _, m := range BuiltinMeshMethods() {
		if m.Source == "" {
			t.Errorf("method %q has no Source", m.Name)
		}
		if m.Name == "" {
			t.Error("a method has no Name")
		}
		if len(m.Policy) == 0 {
			t.Errorf("method %q has an empty Policy", m.Name)
		}
	}
}

// TestBuiltinMeshMethodsNamesAreUnique — a duplicate name would make the
// UI's method picker ambiguous.
func TestBuiltinMeshMethodsNamesAreUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range BuiltinMeshMethods() {
		if seen[m.Name] {
			t.Errorf("duplicate method name %q", m.Name)
		}
		seen[m.Name] = true
	}
}

// TestMeshSydneyAndWnyPointOppositeDirections is the direct regression
// test for phase 4 work item 5's own central finding: MeshSydney and
// WNY/W6HS publish OPPOSITE directions for the same underlying question
// (does a high-neighbour-count/high-altitude repeater fire first or
// last). A sparse/low node and a dense/high one must show opposite
// orderings between the two methods.
func TestMeshSydneyAndWnyPointOppositeDirections(t *testing.T) {
	sydney := meshSydneyMethod().Policy
	wny := wnyMethod().Policy

	sparse := NodeAttrs{NeighborCount: 1, AltitudeM: 50}
	dense := NodeAttrs{NeighborCount: 25, AltitudeM: 900}

	sydneySparse := applyPolicyPrefs(sydney, sparse)
	sydneyDense := applyPolicyPrefs(sydney, dense)
	if sydneySparse.TxDelayFactor <= sydneyDense.TxDelayFactor {
		t.Errorf("expected MeshSydney (hilltop-first) to give the dense/high node a LOWER txdelay: sparse=%v, dense=%v", sydneySparse.TxDelayFactor, sydneyDense.TxDelayFactor)
	}

	wnySparse := applyPolicyPrefs(wny, sparse)
	wnyDense := applyPolicyPrefs(wny, dense)
	if wnySparse.TxDelayFactor >= wnyDense.TxDelayFactor {
		t.Errorf("expected WNY (hilltop-last) to give the dense/high node a HIGHER txdelay: sparse=%v, dense=%v", wnySparse.TxDelayFactor, wnyDense.TxDelayFactor)
	}
}

// TestTennMeshBandsAreMonotonic proves TennMesh's own five neighbour bands
// apply in the right order and produce a strictly non-decreasing txdelay
// as neighbour count rises — a direct check against the source's own
// stated table, not just "some rule matched."
func TestTennMeshBandsAreMonotonic(t *testing.T) {
	policy := tennMeshMethod().Policy
	neighborCounts := []int{0, 3, 7, 12, 20}
	var last float64 = -1
	for _, nc := range neighborCounts {
		prefs := applyPolicyPrefs(policy, NodeAttrs{NeighborCount: nc})
		if prefs.TxDelayFactor < last {
			t.Errorf("txdelay dropped at neighbourCount=%d: %v < previous %v", nc, prefs.TxDelayFactor, last)
		}
		last = prefs.TxDelayFactor
	}
	if last != 2.0 {
		t.Errorf("expected the top band (15+) to reach TennMesh's own stated 2.0, got %v", last)
	}
}

// TestSuggestPolicyIncludesCommunityMethods proves BuiltinMeshMethods are
// actually in SuggestPolicy's own candidate set, prefixed for the UI to
// tell them apart from this package's own topology models — so a user can
// load their own repeaters, run both directions and get a measured answer.
func TestSuggestPolicyIncludesCommunityMethods(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	result := SuggestPolicy(PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       2,
		Seed:         1,
	}, nil) // no Attrs — altitude-gated methods (WNY, W6HS) must be excluded

	foundSydney, foundWny := false, false
	for _, s := range result.Suggestions {
		if s.Name == "community: MeshSydney (NSW)" {
			foundSydney = true
		}
		if s.Name == "community: WNY MeshCore" {
			foundWny = true
		}
	}
	if !foundSydney {
		t.Error("expected MeshSydney (neighbour-count only) in the candidate set even with no Attrs")
	}
	if foundWny {
		t.Error("expected WNY (altitude-gated) to be EXCLUDED when no altitude data was supplied")
	}
}

// applyPolicyPrefs is a small test helper: apply a policy to a single
// node's default NodePrefs and return the result, without needing a full
// Scenario/applyPolicyToScenario round-trip.
func applyPolicyPrefs(policy ConfigPolicy, attrs NodeAttrs) NodePrefs {
	prefs := DefaultNodePrefs()
	for _, rule := range policy {
		if !rule.Matches(attrs) {
			continue
		}
		prefs = rule.ApplyWithAttrs(prefs, attrs)
	}
	return prefs
}
