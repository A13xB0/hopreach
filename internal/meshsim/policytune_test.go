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
// property a multi-rule policy has to preserve.
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

// --- phase 4 work item 1: RuleScale (continuous/proportional rules) ------

func TestRuleScaleValueAtInterpolatesAndClamps(t *testing.T) {
	s := RuleScale{Attr: ScaleByNeighborCount, AtMin: 1, AtMax: 12, ValueAtMin: 0.25, ValueAtMax: 1.0}
	tests := []struct {
		x    float64
		want float64
	}{
		{-5, 0.25},   // below AtMin clamps to ValueAtMin
		{1, 0.25},    // at AtMin
		{6.5, 0.625}, // midpoint
		{12, 1.0},    // at AtMax
		{100, 1.0},   // above AtMax clamps to ValueAtMax
	}
	for _, tt := range tests {
		if got := s.valueAt(tt.x); got != tt.want {
			t.Errorf("valueAt(%v) = %v, want %v", tt.x, got, tt.want)
		}
	}
}

func TestRuleScaleValueAtAtMinEqualsAtMaxNoDivideByZero(t *testing.T) {
	s := RuleScale{Attr: ScaleByAltitude, AtMin: 500, AtMax: 500, ValueAtMin: 0.5, ValueAtMax: 1.5}
	if got := s.valueAt(500); got != 0.5 {
		t.Errorf("valueAt with AtMin == AtMax = %v, want ValueAtMin (0.5)", got)
	}
	if got := s.valueAt(9999); got != 0.5 {
		t.Errorf("valueAt with AtMin == AtMax at a different x = %v, want ValueAtMin (0.5)", got)
	}
}

func TestRuleScaleValueAtDescendingRangeInterpolatesCorrectly(t *testing.T) {
	// AtMin > AtMax is a valid, deliberately-supported "inverse via swapped
	// output values" expression — see RuleScale's own doc comment.
	s := RuleScale{Attr: ScaleByNeighborCount, AtMin: 12, AtMax: 1, ValueAtMin: 1.0, ValueAtMax: 0.25}
	if got := s.valueAt(12); got != 1.0 {
		t.Errorf("valueAt(12) = %v, want 1.0", got)
	}
	if got := s.valueAt(1); got != 0.25 {
		t.Errorf("valueAt(1) = %v, want 0.25", got)
	}
}

func TestScaleAttrValueUnrecognizedAttrFailsClosed(t *testing.T) {
	if _, ok := scaleAttrValue(RuleScaleAttr("bogus"), NodeAttrs{NeighborCount: 5}); ok {
		t.Error("expected an unrecognized RuleScaleAttr to report ok=false")
	}
}

// TestApplyWithAttrsScaleOverridesConstantTxDelay proves Scale takes
// effect (and takes priority over a literal TxDelayFactor, per
// ApplyWithAttrs's own doc comment on that deliberate tie-break) when both
// are present on the same rule.
func TestApplyWithAttrsScaleOverridesConstantTxDelay(t *testing.T) {
	rule := ConfigRule{
		TxDelayFactor: floatPtr(0.5), // should be overridden by Scale below
		Scale: &RuleScale{
			Attr: ScaleByNeighborCount, AtMin: 0, AtMax: 10,
			ValueAtMin: 0.25, ValueAtMax: 1.0,
		},
	}
	base := NodePrefs{TxDelayFactor: 0.5}
	out := rule.ApplyWithAttrs(base, NodeAttrs{NeighborCount: 5})
	want := 0.625 // midpoint of [0.25, 1.0]
	if out.TxDelayFactor != want {
		t.Errorf("TxDelayFactor = %v, want %v (from Scale, not the literal 0.5)", out.TxDelayFactor, want)
	}
}

// TestApplyWithAttrsWithoutScaleMatchesApply proves ApplyWithAttrs behaves
// identically to Apply when Scale is nil — the common case, and the
// backward-compatibility property applyPolicyToScenario's own switch to
// ApplyWithAttrs depends on.
func TestApplyWithAttrsWithoutScaleMatchesApply(t *testing.T) {
	rule := ConfigRule{TxDelayFactor: floatPtr(1.25), RxDelayBase: floatPtr(5.0)}
	base := NodePrefs{TxDelayFactor: 0.5, RxDelayBase: 0}
	viaApply := rule.Apply(base)
	viaApplyWithAttrs := rule.ApplyWithAttrs(base, NodeAttrs{NeighborCount: 7})
	if viaApply != viaApplyWithAttrs {
		t.Errorf("ApplyWithAttrs without Scale = %+v, want to match Apply = %+v", viaApplyWithAttrs, viaApply)
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

// TestSuggestPolicyIncludesProportionalModels is the regression test for
// phase 4 work item 1: degree-proportional/coverage-proportional (and
// their inverses) must always be in the candidate set — like the other
// topology-only models, they need nothing from the caller.
func TestSuggestPolicyIncludesProportionalModels(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	result := SuggestPolicy(PolicyTuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       2,
		Seed:         1,
	}, nil)

	want := []string{
		"degree-proportional (txdelay rises with neighbour count)",
		"degree-proportional inverse (txdelay falls with neighbour count)",
		"coverage-proportional (txdelay falls as marginal coverage rises)",
		"coverage-proportional inverse (txdelay rises as marginal coverage rises)",
	}
	for _, name := range want {
		found := false
		for _, s := range result.Suggestions {
			if s.Name == name {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected %q in the candidate set", name)
		}
	}
}

// TestStage2NamedModelPoliciesProportionalModelsProduceARealRange proves
// the generated Scale rules actually span the intended output range on
// real nodes at the edges of the neighbour-count scale, not a degenerate
// single value — the concrete case a copy-paste error in
// stage2NamedModelPolicies (e.g. AtMin == AtMax) would produce silently,
// since valueAt's own AtMin==AtMax branch (see rules.go) would make every
// node's txdelay identical without ever erroring.
func TestStage2NamedModelPoliciesProportionalModelsProduceARealRange(t *testing.T) {
	candidates := stage2NamedModelPolicies(false)
	var degreeProportional ConfigPolicy
	for _, c := range candidates {
		if c.name == "degree-proportional (txdelay rises with neighbour count)" {
			degreeProportional = c.policy
			break
		}
	}
	if degreeProportional == nil {
		t.Fatal("expected to find degree-proportional in the candidate set")
	}
	rule := degreeProportional[0]
	sparse := rule.ApplyWithAttrs(NodePrefs{}, NodeAttrs{NeighborCount: int(policyScaleNeighborMin)})
	dense := rule.ApplyWithAttrs(NodePrefs{}, NodeAttrs{NeighborCount: int(policyScaleNeighborMax)})
	if sparse.TxDelayFactor == dense.TxDelayFactor {
		t.Errorf("expected a sparse node's txdelay (%v) to differ from a dense node's (%v)", sparse.TxDelayFactor, dense.TxDelayFactor)
	}
	if sparse.TxDelayFactor >= dense.TxDelayFactor {
		t.Errorf("expected degree-proportional to rise with neighbour count: sparse=%v, dense=%v", sparse.TxDelayFactor, dense.TxDelayFactor)
	}
}

// --- phase 4 work item 2: per-node targeted overrides (ConditionNodeIndexIn) ---

func TestConditionNodeIndexInMatchesOnlyListedIndices(t *testing.T) {
	c := RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{2, 5, 9}}
	for _, i := range []int{2, 5, 9} {
		if !c.matchesNode(i, NodeAttrs{}) {
			t.Errorf("expected node %d (listed) to match", i)
		}
	}
	for _, i := range []int{0, 1, 3, 4, 6, 10} {
		if c.matchesNode(i, NodeAttrs{}) {
			t.Errorf("expected node %d (not listed) NOT to match", i)
		}
	}
}

// TestConditionNodeIndexInEmptyListMatchesNothing is the dangerous-default
// check: an empty Nodes list must match NOTHING, not everything — the
// opposite of the zero-value convention every other RuleConditionKind
// uses (ConditionNone's zero value matches everyone). Getting this
// backwards would make an accidentally-empty targeted policy silently
// apply to the whole mesh instead of doing nothing.
func TestConditionNodeIndexInEmptyListMatchesNothing(t *testing.T) {
	c := RuleCondition{Kind: ConditionNodeIndexIn}
	for i := 0; i < 5; i++ {
		if c.matchesNode(i, NodeAttrs{}) {
			t.Errorf("expected an empty Nodes list to match nothing, but node %d matched", i)
		}
	}
}

// TestConditionNodeIndexInFallsThroughToMatchesNothing proves the plain
// (non-node-aware) matches() path — used by the legacy Suggest/
// applyRuleToScenario, which phase 4 never touches — treats
// ConditionNodeIndexIn as "matches nothing" rather than panicking or
// (worse) matching everyone, since it has no node index to test at all.
func TestConditionNodeIndexInFallsThroughToMatchesNothing(t *testing.T) {
	c := RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{0, 1, 2}}
	if c.matches(NodeAttrs{}) {
		t.Error("expected plain matches() to report false for ConditionNodeIndexIn — it has no node index to test")
	}
}

func TestApplyPolicyToScenarioAppliesConditionNodeIndexIn(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true), testNode(true), testNode(true)}}
	policy := ConfigPolicy{{
		Name:          "targeted",
		Condition:     RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{1}},
		TxDelayFactor: floatPtr(1.75),
	}}
	out := applyPolicyToScenario(scenario, nil, policy)
	if out.Nodes[0].Prefs.TxDelayFactor == 1.75 {
		t.Error("node 0 (not targeted) should be untouched")
	}
	if out.Nodes[1].Prefs.TxDelayFactor != 1.75 {
		t.Errorf("node 1 (targeted) TxDelayFactor = %v, want 1.75", out.Nodes[1].Prefs.TxDelayFactor)
	}
	if out.Nodes[2].Prefs.TxDelayFactor == 1.75 {
		t.Error("node 2 (not targeted) should be untouched")
	}
}

// --- phase 4 work item 6: AssignPolicy ------------------------------------

func TestAssignPolicyReturnsMatchingIndicesInApplicationOrder(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true), testNode(true)}}
	attrs := []NodeAttrs{{NeighborCount: 10}, {NeighborCount: 1}}
	policy := ConfigPolicy{
		{Name: "global", TxDelayFactor: floatPtr(0.5)},
		{Name: "dense", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 5}, TxDelayFactor: floatPtr(1.0)},
	}
	assignments := AssignPolicy(scenario, attrs, policy)
	if len(assignments) != 2 {
		t.Fatalf("expected 2 assignments, got %d", len(assignments))
	}
	if got := assignments[0].MatchedRules; len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Errorf("node 0 (dense) MatchedRules = %v, want [0 1] (application order)", got)
	}
	if got := assignments[1].MatchedRules; len(got) != 1 || got[0] != 0 {
		t.Errorf("node 1 (sparse) MatchedRules = %v, want [0] (only the global rule)", got)
	}
}

// TestAssignPolicyUnmatchedNodeReturnsEmptyNotNil is the JSON-boundary
// regression test for PolicyAssignment.MatchedRules' own doc comment: an
// unmatched node's slice must marshal as [] to a JS caller, never null.
func TestAssignPolicyUnmatchedNodeReturnsEmptyNotNil(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true)}}
	policy := ConfigPolicy{{
		Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: 9999},
	}}
	assignments := AssignPolicy(scenario, []NodeAttrs{{AltitudeM: 100}}, policy)
	if assignments[0].MatchedRules == nil {
		t.Error("expected MatchedRules to be non-nil (empty), even for an unmatched node")
	}
	if len(assignments[0].MatchedRules) != 0 {
		t.Errorf("expected no matches, got %v", assignments[0].MatchedRules)
	}
}

func TestAssignPolicyNodeMatchingGlobalAndTierRuleReportsBoth(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true)}}
	policy := ConfigPolicy{
		{Name: "global rxdelay", RxDelayBase: floatPtr(5.0)},
		{Name: "HILLTOP", Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: 500}, TxDelayFactor: floatPtr(0.3)},
	}
	assignments := AssignPolicy(scenario, []NodeAttrs{{AltitudeM: 900}}, policy)
	if len(assignments[0].MatchedRules) != 2 {
		t.Errorf("expected a node matching both a global rule and a tier rule to report both, got %v", assignments[0].MatchedRules)
	}
}

// TestAssignPolicyResultSumsCoverEveryNode is the "nothing silently
// dropped" check: every loaded node gets exactly one PolicyAssignment,
// matched or not.
func TestAssignPolicyResultCoversEveryNode(t *testing.T) {
	scenario := Scenario{Nodes: []SimNode{testNode(true), testNode(true), testNode(true), testNode(true)}}
	policy := ConfigPolicy{{Condition: RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{1}}, TxDelayFactor: floatPtr(1.0)}}
	assignments := AssignPolicy(scenario, nil, policy)
	if len(assignments) != len(scenario.Nodes) {
		t.Fatalf("expected an assignment for every node (%d), got %d", len(scenario.Nodes), len(assignments))
	}
	matched := 0
	for _, a := range assignments {
		if len(a.MatchedRules) > 0 {
			matched++
		}
	}
	if matched != 1 {
		t.Errorf("expected exactly 1 matched node, got %d", matched)
	}
}
