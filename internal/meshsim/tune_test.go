package meshsim

import "testing"

// lockstepCollisionScenario builds A -> {B,C,D} -> E: three siblings all
// hear the same origin at the same instant and are all mutually audible to
// a shared downstream listener. With TxDelayFactor 0 every sibling's relay
// delay is deterministically 0, so all three relay in perfect lockstep —
// guaranteed collision at E on every trial. Any nonzero spread should
// reduce that.
func lockstepCollisionScenario() (Scenario, []Message) {
	nodes := []SimNode{
		testNode(false), // 0: origin
		testNode(true),  // 1: B
		testNode(true),  // 2: C
		testNode(true),  // 3: D
		testNode(false), // 4: shared listener
	}
	var links []Link
	for _, relay := range []int{1, 2, 3} {
		links = append(links, Link{From: 0, To: relay, SNRdB: 0})
		links = append(links, Link{From: relay, To: 4, SNRdB: 0})
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	for i := range scenario.Nodes {
		scenario.Nodes[i].Prefs.TxDelayFactor = 0
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	return scenario, messages
}

func TestSuggestFindsLowerCollisionRateThanZeroDelayBaseline(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()

	result := Suggest(TuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       40,
		Seed:         1,
	}, nil)

	if len(result.Suggestions) == 0 {
		t.Fatal("expected at least one candidate suggestion")
	}
	// A sends cleanly to B/C/D (3 uncollided receptions), then B/C/D relay
	// in perfect lockstep and all 3 collide at E (3 collided receptions) —
	// 3 collided of 6 total = 0.5, deterministically (TxDelayFactor 0 means
	// zero variance in relay timing).
	if got := result.Baseline; got != 0.5 {
		t.Fatalf("expected the zero-delay baseline collision rate to be exactly 0.5, got %.3f", got)
	}
	best := result.Suggestions[0]
	if best.CollisionRate >= result.Baseline {
		t.Errorf("best suggestion %q (rate=%.3f) should improve on baseline (%.3f)", best.Rule.Name, best.CollisionRate, result.Baseline)
	}
}

func TestSuggestDeterministicForFixedSeed(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	req := TuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       10,
		Seed:         42,
	}

	a := Suggest(req, nil)
	b := Suggest(req, nil)

	if a.Baseline != b.Baseline {
		t.Errorf("baseline should be deterministic for a fixed seed: %.6f vs %.6f", a.Baseline, b.Baseline)
	}
	if len(a.Suggestions) != len(b.Suggestions) {
		t.Fatalf("suggestion count differs: %d vs %d", len(a.Suggestions), len(b.Suggestions))
	}
	for i := range a.Suggestions {
		if a.Suggestions[i].Rule.Name != b.Suggestions[i].Rule.Name || a.Suggestions[i].CollisionRate != b.Suggestions[i].CollisionRate {
			t.Fatalf("suggestion %d differs between runs: %+v vs %+v", i, a.Suggestions[i], b.Suggestions[i])
		}
	}
}

func TestSuggestUsesAltitudeRulesWhenAttrsProvided(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	attrs := []NodeAttrs{
		{AltitudeM: 100},
		{AltitudeM: 900, NeighborCount: 2},
		{AltitudeM: 950, NeighborCount: 2},
		{AltitudeM: 920, NeighborCount: 2},
		{AltitudeM: 100},
	}

	result := Suggest(TuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		Attrs:        attrs,
		MaxSimTimeMs: 60_000,
		Trials:       10,
		Seed:         7,
	}, nil)

	foundAltitudeRule := false
	for _, s := range result.Suggestions {
		if s.Rule.Condition.Kind != ConditionNone {
			foundAltitudeRule = true
			break
		}
	}
	if !foundAltitudeRule {
		t.Error("expected at least one altitude/neighbour-conditional rule in the candidate set when Attrs is provided")
	}
}

func TestSuggestOmitsConditionalRulesWhenAttrsNil(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()

	result := Suggest(TuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		MaxSimTimeMs: 60_000,
		Trials:       5,
		Seed:         3,
	}, nil)

	for _, s := range result.Suggestions {
		if s.Rule.Condition.Kind != ConditionNone {
			t.Errorf("did not expect a conditional rule %q when Attrs is nil", s.Rule.Name)
		}
	}
}

// TestSuggestReportsProgressForBaselineAndEveryCandidate is the regression
// test for a real usability problem: Suggest's whole candidate grid (well
// over a hundred rules with Attrs provided, each evaluated across Trials
// full simulation runs) used to run with zero feedback, which on the
// browser's main thread read as a frozen page for the entire search, not
// just a slow one — see public/meshsim-worker.js, which relies on this
// callback to drive a real progress bar.
func TestSuggestReportsProgressForBaselineAndEveryCandidate(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	attrs := []NodeAttrs{{AltitudeM: 100}, {AltitudeM: 900, NeighborCount: 2}, {AltitudeM: 950, NeighborCount: 2}, {AltitudeM: 920, NeighborCount: 2}, {AltitudeM: 100}}

	var calls [][2]int
	result := Suggest(TuneRequest{
		Scenario:     scenario,
		Messages:     messages,
		Attrs:        attrs,
		MaxSimTimeMs: 60_000,
		Trials:       2,
		Seed:         1,
	}, func(done, total int) {
		calls = append(calls, [2]int{done, total})
	})

	wantTotal := len(result.Suggestions) + 1 // +1 for the baseline
	if len(calls) != wantTotal {
		t.Fatalf("progress called %d times, want %d (one per candidate plus the baseline)", len(calls), wantTotal)
	}
	for i, c := range calls {
		if c[0] != i+1 {
			t.Errorf("call %d: done = %d, want %d (should count up monotonically from 1)", i, c[0], i+1)
		}
		if c[1] != wantTotal {
			t.Errorf("call %d: total = %d, want %d (should stay constant across the whole search)", i, c[1], wantTotal)
		}
	}
}

func TestConfigRuleApplyLeavesUnsetFieldsAtBaseline(t *testing.T) {
	base := DefaultNodePrefs()
	td := 1.25
	rule := ConfigRule{TxDelayFactor: &td}

	out := rule.Apply(base)

	if out.TxDelayFactor != 1.25 {
		t.Errorf("TxDelayFactor = %v, want 1.25", out.TxDelayFactor)
	}
	if out.DirectTxDelayFactor != base.DirectTxDelayFactor {
		t.Errorf("DirectTxDelayFactor should be untouched: got %v, want %v", out.DirectTxDelayFactor, base.DirectTxDelayFactor)
	}
	if out.RxDelayBase != base.RxDelayBase {
		t.Errorf("RxDelayBase should be untouched: got %v, want %v", out.RxDelayBase, base.RxDelayBase)
	}
}

func TestConfigRuleMatchesZeroConditionMatchesEverything(t *testing.T) {
	rule := ConfigRule{}
	if !rule.Matches(NodeAttrs{AltitudeM: -500, NeighborCount: 0}) {
		t.Error("a rule with the zero-value Condition should match every node")
	}
}
