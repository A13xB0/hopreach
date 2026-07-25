package meshsim

import "testing"

func TestConditionNeighborsAtMostMatchesAndRejects(t *testing.T) {
	c := RuleCondition{Kind: ConditionNeighborsAtMost, Threshold: 3}
	if !c.matches(NodeAttrs{NeighborCount: 3}) {
		t.Error("neighbours == threshold should match (at most, inclusive)")
	}
	if !c.matches(NodeAttrs{NeighborCount: 1}) {
		t.Error("neighbours below threshold should match")
	}
	if c.matches(NodeAttrs{NeighborCount: 4}) {
		t.Error("neighbours above threshold should not match")
	}
}

// TestApplyPolicyToScenarioSingleRuleMatchesApplyRuleToScenario proves a
// single-rule ConfigPolicy behaves identically to today's
// applyRuleToScenario with that same rule — the backward-compatibility
// property docs/SIMULATOR_PLAN_PHASE2.md item 15c explicitly asks for.
func TestApplyPolicyToScenarioSingleRuleMatchesApplyRuleToScenario(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true)},
		Links: []Link{{From: 0, To: 1, SNRdB: 0}},
	}
	attrs := []NodeAttrs{{AltitudeM: 100}, {AltitudeM: 900}}
	rule := ConfigRule{
		Condition:     RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: 500},
		TxDelayFactor: floatPtr(1.5),
	}

	viaRule := applyRuleToScenario(scenario, attrs, rule)
	viaPolicy := applyPolicyToScenario(scenario, attrs, ConfigPolicy{rule})

	for i := range viaRule.Nodes {
		if viaRule.Nodes[i].Prefs.TxDelayFactor != viaPolicy.Nodes[i].Prefs.TxDelayFactor {
			t.Errorf("node %d: TxDelayFactor via rule = %v, via single-rule policy = %v — should match exactly",
				i, viaRule.Nodes[i].Prefs.TxDelayFactor, viaPolicy.Nodes[i].Prefs.TxDelayFactor)
		}
	}
}

// TestApplyPolicyToScenarioLaterRuleOverridesEarlier proves the ordered,
// per-field override semantics: a global rule sets a baseline, a second,
// more specific rule overrides just the field it names — the exact
// "score-priority + dense-slow" composite shape item 15c's own models use.
func TestApplyPolicyToScenarioLaterRuleOverridesEarlier(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true)}}
	attrs := []NodeAttrs{{NeighborCount: 10}}
	policy := ConfigPolicy{
		{Name: "global", TxDelayFactor: floatPtr(0.5), RxDelayBase: floatPtr(5.0)},
		{Name: "dense override", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 5}, TxDelayFactor: floatPtr(1.0)},
	}

	out := applyPolicyToScenario(scenario, attrs, policy)

	if out.Nodes[0].Prefs.TxDelayFactor != 1.0 {
		t.Errorf("TxDelayFactor should be overridden by the later, more specific rule: got %v, want 1.0", out.Nodes[0].Prefs.TxDelayFactor)
	}
	if out.Nodes[0].Prefs.RxDelayBase != 5.0 {
		t.Errorf("RxDelayBase should still come from the earlier global rule (never overridden): got %v, want 5.0", out.Nodes[0].Prefs.RxDelayBase)
	}
}

func TestApplyPolicyToScenarioAppliesFloodMax(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true)}}
	policy := ConfigPolicy{{Name: "trim", FloodMax: intPtr(16)}}
	out := applyPolicyToScenario(scenario, nil, policy)
	if out.Nodes[0].FloodMax != 16 {
		t.Errorf("FloodMax = %d, want 16", out.Nodes[0].FloodMax)
	}
}

// TestSuggestPolicyDeterministicForFixedSeed mirrors
// TestSuggestDeterministicForFixedSeed for the new search.
func TestSuggestPolicyDeterministicForFixedSeed(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	req := PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       5,
		Seed:         42,
	}
	a := SuggestPolicy(req, nil)
	b := SuggestPolicy(req, nil)
	if a.BaselineDelivery != b.BaselineDelivery || a.BaselineCollision != b.BaselineCollision {
		t.Errorf("baseline should be deterministic: %+v vs %+v", a, b)
	}
	if len(a.Suggestions) != len(b.Suggestions) {
		t.Fatalf("suggestion count differs: %d vs %d", len(a.Suggestions), len(b.Suggestions))
	}
	for i := range a.Suggestions {
		if a.Suggestions[i].Name != b.Suggestions[i].Name || a.Suggestions[i].DeliveryRatio != b.Suggestions[i].DeliveryRatio {
			t.Fatalf("suggestion %d differs between runs: %+v vs %+v", i, a.Suggestions[i], b.Suggestions[i])
		}
	}
}

// TestSuggestPolicyRanksByDeliveryNotCollision is the direct regression
// test for item 15's own "wrong objective" finding: suggestions must come
// back sorted by DESCENDING DeliveryRatio, not ascending CollisionRate —
// the two are related but not identical, and ranking by the wrong one is
// exactly the bug this search exists to not repeat.
func TestSuggestPolicyRanksByDeliveryNotCollision(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	result := SuggestPolicy(PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       10,
		Seed:         3,
	}, nil)

	if len(result.Suggestions) < 2 {
		t.Fatal("expected at least two suggestions to check ordering")
	}
	for i := 1; i < len(result.Suggestions); i++ {
		if result.Suggestions[i].DeliveryRatio > result.Suggestions[i-1].DeliveryRatio {
			t.Fatalf("suggestions not sorted by descending DeliveryRatio at index %d: %+v then %+v",
				i, result.Suggestions[i-1], result.Suggestions[i])
		}
	}
}

func TestSuggestPolicyFindsImprovementOverBaseline(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	result := SuggestPolicy(PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       40,
		Seed:         1,
	}, nil)

	if len(result.Suggestions) == 0 {
		t.Fatal("expected at least one candidate suggestion")
	}
	best := result.Suggestions[0]
	if best.DeliveryRatio <= result.BaselineDelivery {
		t.Errorf("best suggestion %q (delivery=%.3f) should improve on baseline (%.3f)", best.Name, best.DeliveryRatio, result.BaselineDelivery)
	}
}

// TestSuggestPolicyUsesTopologyModelsRegardlessOfAttrs proves the
// topology-only models (dense-slow, articulation-first, mpr, ...) are
// always in the candidate set — unlike altitude-keyed models, they need
// nothing from the caller.
func TestSuggestPolicyUsesTopologyModelsRegardlessOfAttrs(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	result := SuggestPolicy(PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       2,
		Seed:         1,
	}, nil) // no Attrs at all

	foundTopologyModel := false
	for _, s := range result.Suggestions {
		if s.Name == "articulation-first" {
			foundTopologyModel = true
			break
		}
	}
	if !foundTopologyModel {
		t.Error("expected the articulation-first model in the candidate set even with no Attrs supplied — it's topology-only")
	}
}

func TestSuggestPolicyReportsProgress(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	var calls [][2]int
	SuggestPolicy(PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       2,
		Seed:         1,
	}, func(done, total int) {
		calls = append(calls, [2]int{done, total})
	})
	if len(calls) == 0 {
		t.Fatal("expected at least one progress callback")
	}
	for i, c := range calls {
		if c[0] != i+1 {
			t.Errorf("call %d: done = %d, want %d", i, c[0], i+1)
		}
	}
	last := calls[len(calls)-1]
	if last[0] != last[1] {
		t.Errorf("final progress call should have done == total, got %v", last)
	}
}
