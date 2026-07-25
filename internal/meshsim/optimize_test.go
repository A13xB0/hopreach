package meshsim

import (
	"strings"
	"testing"
)

// baseOptimizeRequest returns a small, fast OptimizeRequest against
// lockstepCollisionScenario (tune_test.go) — three relays lockstepped
// (TxDelayFactor forced to 0) into a shared listener, a real,
// deliberately contention-heavy fixture already proven elsewhere in this
// package.
//
// Trials/ConfirmTrials/MaxRounds/StaleRoundsLimit are deliberately not
// tiny: each relay's own airtime here is several hundred ms (see phase
// 3's own path-byte-airtime work), so separating two lockstepped relay
// windows enough to stop colliding needs the escalating step (see
// OptimizeStep's own doc comment on step) several rounds to grow into,
// and needs enough trials per round that a real average improvement
// isn't lost in single-run noise. Verified empirically during
// development — Trials=3/ConfirmTrials=5/MaxRounds=6 (the first values
// tried) were too small for this fixture to ever show improvement at
// all, not because the optimizer didn't work but because the sample was
// too thin to tell a real effect apart from noise.
func baseOptimizeRequest() OptimizeRequest {
	scenario, messages := lockstepCollisionScenario()
	return OptimizeRequest{
		Scenario:          scenario,
		Messages:          messages,
		BasePolicy:        ConfigPolicy{},
		MaxSimTimeMs:      60_000,
		Trials:            10,
		ConfirmTrials:     20,
		Seed:              1,
		DeliveryTolerance: 0,
		MinImprovement:    0.01,
		MaxRounds:         15,
		StaleRoundsLimit:  8,
		HoldoutSeed:       999,
		HoldoutTrials:     20,
	}
}

func TestOptimizeStepFirstCallMeasuresBaselineOnly(t *testing.T) {
	req := baseOptimizeRequest()
	state := OptimizeStep(req, OptimizeState{})

	if !state.Initialized {
		t.Fatal("expected the first call to set Initialized")
	}
	if state.Round != 0 {
		t.Errorf("expected Round to stay 0 on the first call, got %d", state.Round)
	}
	if len(state.Deviations) != 0 {
		t.Errorf("expected no deviations on the first call, got %d", len(state.Deviations))
	}
	if state.Done {
		t.Error("expected the first call not to be Done")
	}
	if state.CurrentContention <= 0 {
		t.Error("expected the lockstep fixture's own baseline contention to be > 0 — test setup assumption")
	}
}

// TestOptimizeStepNeverRegressesDelivery is the direct regression test for
// this file's own delivery-first acceptance gate: accept only if delivery
// does not regress, because collision rate on its own is the wrong
// objective. Runs the full loop to completion and checks
// EVERY round's own CurrentDelivery never drops below the measured
// baseline by more than DeliveryTolerance.
func TestOptimizeStepNeverRegressesDelivery(t *testing.T) {
	req := baseOptimizeRequest()
	state := OptimizeStep(req, OptimizeState{})
	baselineDelivery := state.CurrentDelivery

	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
		if state.CurrentDelivery < baselineDelivery-req.DeliveryTolerance-1e-9 {
			t.Fatalf("round %d: CurrentDelivery %v regressed below baseline %v - tolerance %v", state.Round, state.CurrentDelivery, baselineDelivery, req.DeliveryTolerance)
		}
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to finish within 50 rounds")
	}
}

// TestOptimizeStepReducesContentionOverBaseline proves the loop actually
// does something useful on a real contention-heavy fixture — the whole
// point of work item 4 ("slowly adjusts... until it disappears").
func TestOptimizeStepReducesContentionOverBaseline(t *testing.T) {
	req := baseOptimizeRequest()
	state := OptimizeStep(req, OptimizeState{})
	baselineContention := state.CurrentContention

	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to finish within 50 rounds")
	}
	if state.CurrentContention >= baselineContention {
		t.Errorf("expected the optimizer to reduce contention below the baseline (%v), got %v", baselineContention, state.CurrentContention)
	}
	if len(state.Deviations) == 0 {
		t.Error("expected at least one accepted deviation on a real contention-heavy fixture")
	}
}

// TestOptimizeStepStopsAtMaxRounds proves the round budget is a real,
// working stopping condition — this loop must never run forever.
func TestOptimizeStepStopsAtMaxRounds(t *testing.T) {
	req := baseOptimizeRequest()
	req.MaxRounds = 2
	req.StaleRoundsLimit = 1000 // effectively disabled, isolating MaxRounds as the stop cause
	req.MinImprovement = 1e9    // effectively impossible to satisfy, so no move is ever accepted (StaleRounds can't cause an early stop for a different reason)

	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 10 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("expected the loop to have stopped")
	}
	if state.Round != req.MaxRounds {
		t.Errorf("expected exactly MaxRounds (%d) rounds, got %d", req.MaxRounds, state.Round)
	}
	if state.DoneReason == "" {
		t.Error("expected a non-empty DoneReason")
	}
}

// TestOptimizeStepStopsAtStaleRoundsLimit proves the "no improvement in N
// consecutive rounds" stop works independently of MaxRounds.
func TestOptimizeStepStopsAtStaleRoundsLimit(t *testing.T) {
	req := baseOptimizeRequest()
	req.MaxRounds = 1000
	req.StaleRoundsLimit = 2
	req.MinImprovement = 1e9 // impossible to satisfy — every round is stale

	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 20 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("expected the loop to have stopped")
	}
	if state.Round != req.StaleRoundsLimit {
		t.Errorf("expected exactly StaleRoundsLimit (%d) rounds before stopping, got %d", req.StaleRoundsLimit, state.Round)
	}
	if len(state.Deviations) != 0 {
		t.Errorf("expected zero accepted deviations with an impossible MinImprovement, got %d", len(state.Deviations))
	}
}

// TestOptimizeStepCalledAfterDoneIsANoOp proves a caller that keeps
// calling past completion (a plausible JS-side race between the loop
// finishing and the UI noticing) gets the same state back, not an error
// or a fresh restart.
func TestOptimizeStepCalledAfterDoneIsANoOp(t *testing.T) {
	req := baseOptimizeRequest()
	req.MaxRounds = 1
	req.MinImprovement = 1e9

	state := OptimizeStep(req, OptimizeState{})
	state = OptimizeStep(req, state)
	if !state.Done {
		t.Fatal("test setup: expected Done after MaxRounds=1")
	}
	again := OptimizeStep(req, state)
	if again.Round != state.Round || again.Done != state.Done || len(again.Deviations) != len(state.Deviations) {
		t.Errorf("expected calling OptimizeStep after Done to be a no-op: before=%+v after=%+v", state, again)
	}
}

// TestOptimizeStepDeterministicForFixedSeed mirrors this package's own
// established determinism-testing pattern (e.g.
// TestSuggestPolicyDeterministicForFixedSeed) — two independent runs of
// the full loop from the same seed must reach the same trajectory.
func TestOptimizeStepDeterministicForFixedSeed(t *testing.T) {
	req := baseOptimizeRequest()
	runToCompletion := func() OptimizeState {
		state := OptimizeStep(req, OptimizeState{})
		for i := 0; i < 50 && !state.Done; i++ {
			state = OptimizeStep(req, state)
		}
		return state
	}
	a := runToCompletion()
	b := runToCompletion()
	if a.Round != b.Round || a.CurrentDelivery != b.CurrentDelivery || a.CurrentContention != b.CurrentContention {
		t.Errorf("expected two runs from the same seed to match: a=%+v b=%+v", a, b)
	}
	if len(a.Deviations) != len(b.Deviations) {
		t.Fatalf("deviation count differs: %d vs %d", len(a.Deviations), len(b.Deviations))
	}
	for i := range a.Deviations {
		if a.Deviations[i] != b.Deviations[i] {
			t.Errorf("deviation %d differs: %+v vs %+v", i, a.Deviations[i], b.Deviations[i])
		}
	}
}

// TestOptimizeDeviationsHaveReasons proves every accepted deviation
// carries a non-empty, meaningful Reason — the per-repeater "why" the
// the UI shows, not just a bare settings change. Also checks each move
// kind changed its value in the expected direction — the move set is
// wider than pure txdelay back-off.
func TestOptimizeDeviationsHaveReasons(t *testing.T) {
	req := baseOptimizeRequest()
	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if len(state.Deviations) == 0 {
		t.Fatal("test setup: expected at least one deviation on this fixture")
	}
	for _, d := range state.Deviations {
		if d.Reason == "" {
			t.Errorf("deviation for node %d has an empty Reason", d.Node)
		}
		switch d.Kind {
		case moveKindTxBackoff, moveKindRxBackoff:
			if d.NewValue <= d.OldValue {
				t.Errorf("deviation for node %d (%s): NewValue (%v) should exceed OldValue (%v)", d.Node, d.Kind, d.NewValue, d.OldValue)
			}
		case moveKindTxSpeedup, moveKindFloodMaxReduce:
			if d.NewValue >= d.OldValue {
				t.Errorf("deviation for node %d (%s): NewValue (%v) should be below OldValue (%v)", d.Node, d.Kind, d.NewValue, d.OldValue)
			}
		default:
			t.Errorf("deviation for node %d has an unrecognized Kind %q", d.Node, d.Kind)
		}
	}
}

// TestOptimizeValidateUsesHoldoutSeed proves OptimizeValidate actually
// runs (doesn't panic/error on a real policy) and returns a plausible
// delivery ratio — the hold-out check work item 4 asks for.
func TestOptimizeValidateUsesHoldoutSeed(t *testing.T) {
	req := baseOptimizeRequest()
	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	delivery, collision := OptimizeValidate(req, state.CurrentPolicy)
	if delivery < 0 || delivery > 1 {
		t.Errorf("OptimizeValidate delivery = %v, want a value in [0,1]", delivery)
	}
	if collision < 0 || collision > 1 {
		t.Errorf("OptimizeValidate collision = %v, want a value in [0,1]", collision)
	}
}

// TestNodeContentionScoreCombinesAllFourComponents is a direct unit check
// on the scoring formula itself, independent of the full loop.
func TestNodeContentionScoreCombinesAllFourComponents(t *testing.T) {
	s := NodeStats{ContentionCaused: 3, CollisionCount: 2, RedundantRelays: 1, DutyAirtimeMs: 30_000}
	got := nodeContentionScore(s, 60_000) // 30_000/60_000*100 = 50
	want := 3.0 + 2.0 + 1.0 + 50.0
	if got != want {
		t.Errorf("nodeContentionScore = %v, want %v", got, want)
	}
}

func TestDominantContentionReasonPicksTheLargestComponent(t *testing.T) {
	s := NodeStats{ContentionCaused: 1, CollisionCount: 1, RedundantRelays: 50, DutyAirtimeMs: 0}
	got := dominantContentionReason(s, 60_000)
	if got == "" {
		t.Fatal("expected a non-empty reason")
	}
	// RedundantRelays (50) dominates every other component here — the
	// reason text should reflect that, not e.g. collisions (1).
	if !strings.Contains(got, "50") || !strings.Contains(got, "relays") {
		t.Errorf("expected the dominant reason to mention the redundant-relay count, got %q", got)
	}
}

// TestOptimizeAcceptsRejectsZeroToleranceStalemate is the direct
// regression test for the bug that made the optimizer report "0 repeaters
// adjusted" on every real-sized network: with DeliveryTolerance 0, a move
// that costs a negligible amount of delivery but buys a large contention
// reduction was rejected. Backing a node off essentially always costs a
// hair of delivery, so a zero tolerance rejected literally everything.
func TestOptimizeAcceptsRejectsZeroToleranceStalemate(t *testing.T) {
	strict := OptimizeRequest{DeliveryTolerance: 0, MinImprovement: 0.5, MaxDeliveryRegression: 0.02, MinDeliveryGain: 0.005}
	realistic := OptimizeRequest{DeliveryTolerance: 0.005, MinImprovement: 0.5, MaxDeliveryRegression: 0.02, MinDeliveryGain: 0.005}

	// The exact shape observed on a 30-node mesh: delivery down by
	// 0.0004 (noise-level), contention down by 25 points (a real win).
	// Baseline is set equal to current so the MaxDeliveryRegression floor
	// is nowhere near being the blocker — this test isolates the
	// TOLERANCE behaviour, and the floor gets its own test below.
	const baseline, current, candidate = 0.3762, 0.3762, 0.3758
	const currentContention, candidateContention = 3496.5, 3471.3

	if optimizeAccepts(strict, baseline, current, currentContention, candidate, candidateContention) {
		t.Error("test setup: a zero tolerance is expected to reject this move — that's the bug being regression-tested")
	}
	if !optimizeAccepts(realistic, baseline, current, currentContention, candidate, candidateContention) {
		t.Error("a 0.0004 delivery cost for a 25-point contention win must be ACCEPTED at a realistic tolerance")
	}
}

// TestOptimizeAcceptsTakesRealDeliveryWinsRegardlessOfContention is the
// other half of that fix: genuine delivery improvements were being
// rejected whenever they happened to raise the contention score (observed
// at +3.25 percentage points of delivery). Delivery is the objective;
// contention is only ever a proxy for it.
func TestOptimizeAcceptsTakesRealDeliveryWinsRegardlessOfContention(t *testing.T) {
	req := OptimizeRequest{DeliveryTolerance: 0.005, MinImprovement: 0.5, MaxDeliveryRegression: 0.02, MinDeliveryGain: 0.005}
	// +3.25 points of delivery, contention WORSE by 160.
	if !optimizeAccepts(req, 0.30, 0.3394, 3239.7, 0.3719, 3402.1) {
		t.Error("a real delivery gain must be accepted even when the contention score rises")
	}
}

// TestOptimizeAcceptsEnforcesTheBaselineFloor proves the hard floor
// against cumulative drift: individually-negligible losses must not be
// allowed to ratchet delivery arbitrarily far below where the run
// started (the slow route to the degenerate "everyone silent" outcome).
func TestOptimizeAcceptsEnforcesTheBaselineFloor(t *testing.T) {
	req := OptimizeRequest{DeliveryTolerance: 0.005, MinImprovement: 0.5, MaxDeliveryRegression: 0.02, MinDeliveryGain: 0.005}
	const baseline = 0.40
	// Already drifted to 0.381; one more within-tolerance step would put
	// the candidate at 0.3775, below the 0.38 floor (baseline - 0.02).
	if optimizeAccepts(req, baseline, 0.381, 3000, 0.3775, 2000) {
		t.Error("a move crossing the baseline floor must be rejected however large its contention win")
	}
	// The same-sized contention win just ABOVE the floor is fine.
	if !optimizeAccepts(req, baseline, 0.3850, 3000, 0.3820, 2000) {
		t.Error("a move that stays above the floor should still be accepted")
	}
}

// TestOptimizeStepRecordsHistoryAndNodeSnapshot proves the per-round
// history and the full per-repeater table are actually populated —
// they're what the UI renders as "improvement over time" and "every
// repeater ranked by contention".
func TestOptimizeStepRecordsHistoryAndNodeSnapshot(t *testing.T) {
	req := baseOptimizeRequest()
	state := OptimizeStep(req, OptimizeState{})

	if len(state.NodeSnapshot) != len(req.Scenario.Nodes) {
		t.Errorf("expected a snapshot row for every node (%d), got %d", len(req.Scenario.Nodes), len(state.NodeSnapshot))
	}
	if state.BaselineDelivery != state.CurrentDelivery {
		t.Error("expected baseline to equal current on the very first call")
	}

	state = OptimizeStep(req, state)
	if len(state.History) != 1 {
		t.Fatalf("expected 1 history row after 1 round, got %d", len(state.History))
	}
	if state.History[0].Round != 1 {
		t.Errorf("history row Round = %d, want 1", state.History[0].Round)
	}
	if len(state.NodeSnapshot) != len(req.Scenario.Nodes) {
		t.Errorf("snapshot should still cover every node after a round, got %d", len(state.NodeSnapshot))
	}
	for _, s := range state.NodeSnapshot {
		if s.Diagnosis.Headline == "" {
			t.Errorf("node %d has an empty diagnosis headline", s.Node)
		}
	}
}

// TestNormalizedContentionScoreIsComparableAcrossDifferentTrialCounts is
// the direct regression test for the bug found during this file's own
// development: OptimizeStep's screening pass (Trials) and confirmation
// pass (ConfirmTrials, deliberately larger) must be comparable to each
// other despite summing over different numbers of trials — comparing
// their RAW networkContentionScore sums directly made a genuinely BETTER
// candidate look worse purely because its confirmation pass summed over
// more trials. Two evaluations of the IDENTICAL per-trial distribution at
// different trial counts must normalize to the same score.
func TestNormalizedContentionScoreIsComparableAcrossDifferentTrialCounts(t *testing.T) {
	// Both represent the SAME underlying per-trial distribution
	// (ContentionCaused: 4, CollisionCount: 2 per trial), just summed
	// across a different number of trials.
	threeTrials := []NodeStats{{ContentionCaused: 12, CollisionCount: 6}}
	fiveTrials := []NodeStats{{ContentionCaused: 20, CollisionCount: 10}}

	scoreAt3 := normalizedContentionScore(threeTrials, 0, 3)
	scoreAt5 := normalizedContentionScore(fiveTrials, 0, 5)
	if scoreAt3 != scoreAt5 {
		t.Errorf("expected the same underlying per-trial distribution to normalize to the same score regardless of trial count: 3 trials = %v, 5 trials = %v", scoreAt3, scoreAt5)
	}
}

// TestOptimizeStepEscalatesStepWhenStartingFromZero is the direct
// regression test for the second bug found during development: a purely
// multiplicative bump (oldTxDelay * optimizeBackoffMultiplier) is a
// permanent no-op starting from TxDelayFactor 0 — a legitimate, real
// starting value (this package's own lockstepCollisionScenario test
// fixture sets it directly) — since 0 * anything is still 0. Backing off
// a zero-delay node must actually move it.
func TestOptimizeStepEscalatesStepWhenStartingFromZero(t *testing.T) {
	req := baseOptimizeRequest() // lockstepCollisionScenario forces TxDelayFactor: 0 on every node
	state := OptimizeStep(req, OptimizeState{})
	state = OptimizeStep(req, state) // one real round

	if len(state.CurrentPolicy) == len(req.BasePolicy) && state.StaleRounds == 0 {
		t.Fatal("test setup: expected either an accepted deviation or a recorded stale round")
	}
	// Whether or not round 1 was itself accepted, the PROPOSED move must
	// never have been a zero-length step — that's the exact bug: 0 * 1.5
	// stays 0 forever, which this test would catch as an infinite stale
	// loop that never escalates (see TestOptimizeStepReducesContention
	// OverBaseline for the full-loop version of this same check).
	if len(state.Deviations) > 0 {
		lastDeviation := state.Deviations[len(state.Deviations)-1]
		if lastDeviation.NewValue == lastDeviation.OldValue {
			t.Errorf("accepted deviation changed nothing: %+v", lastDeviation)
		}
		if lastDeviation.Kind == moveKindTxBackoff && lastDeviation.OldValue != 0 {
			t.Errorf("expected OldValue to reflect the fixture's own forced 0 starting value, got %v — see currentNodeStateFor's own doc comment on reading the SCENARIO's base, not DefaultNodePrefs()", lastDeviation.OldValue)
		}
	}
}

// --- Top-K / tabu search ------------------------------------------------

// TestOptimizeStepUnlimitedRoundsIgnoresMaxRounds proves the explicit
// UnlimitedRounds flag actually overrides MaxRounds, not just a large
// number — the whole point of a separate bool rather than overloading 0
// (see OptimizeRequest.UnlimitedRounds's own doc comment).
func TestOptimizeStepUnlimitedRoundsIgnoresMaxRounds(t *testing.T) {
	req := baseOptimizeRequest()
	req.MaxRounds = 1
	req.UnlimitedRounds = true
	req.StaleRoundsLimit = 3 // still bounded by staleness so the test terminates

	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 200 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to eventually stop via staleness")
	}
	if state.Round <= req.MaxRounds {
		t.Errorf("expected UnlimitedRounds to run past MaxRounds (%d), stopped at round %d", req.MaxRounds, state.Round)
	}
}

// TestOptimizeStepUnlimitedStaleRoundsIgnoresStaleLimit is the mirror
// case: with an impossible MinImprovement (every round stale) but
// UnlimitedStaleRounds set, only MaxRounds may stop the loop.
func TestOptimizeStepUnlimitedStaleRoundsIgnoresStaleLimit(t *testing.T) {
	req := baseOptimizeRequest()
	req.MaxRounds = 4
	req.StaleRoundsLimit = 1
	req.UnlimitedStaleRounds = true
	req.MinImprovement = 1e9 // impossible — every round is stale

	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 20 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("expected MaxRounds to still stop the loop")
	}
	if state.Round != req.MaxRounds {
		t.Errorf("expected exactly MaxRounds (%d) rounds, got %d", req.MaxRounds, state.Round)
	}
}

// TestOptimizeMoveSetNilUsesDefault proves a nil MoveSet behaves like the
// documented default (TxDelay+RxDelay on, FloodMax off) rather than doing
// nothing — see OptimizeRequest.MoveSet's own doc comment on why nil and
// an explicit all-false struct must be distinguishable.
func TestOptimizeMoveSetNilUsesDefault(t *testing.T) {
	req := baseOptimizeRequest()
	req.MoveSet = nil
	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if len(state.Deviations) == 0 {
		t.Fatal("expected at least one accepted deviation with the default move set on this contention-heavy fixture")
	}
	for _, d := range state.Deviations {
		if d.Kind == moveKindFloodMaxReduce {
			t.Errorf("expected FloodMax to stay disabled by default, but got a flood_max_reduce deviation: %+v", d)
		}
	}
}

// TestOptimizeMoveSetExplicitAllFalseDoesNothing proves an explicit,
// non-nil OptimizeMoveSet{} (every field false) is honoured as a real
// request to disable every move kind, not silently replaced by the
// default.
func TestOptimizeMoveSetExplicitAllFalseDoesNothing(t *testing.T) {
	req := baseOptimizeRequest()
	req.MoveSet = &OptimizeMoveSet{}
	req.StaleRoundsLimit = 3

	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 20 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to stop via staleness with no move kinds enabled")
	}
	if len(state.Deviations) != 0 {
		t.Errorf("expected zero deviations with every move kind disabled, got %d", len(state.Deviations))
	}
	for _, round := range state.History {
		if round.TargetNode != -1 {
			t.Errorf("round %d: expected no candidates to ever be generated with an all-false move set, got TargetNode %d", round.Round, round.TargetNode)
		}
	}
}

// TestOptimizeMoveSetFloodMaxCarriesWarning proves a proposed
// flood_max_reduce candidate always carries a non-empty warning — phase
// 6 work item H's explicit requirement that any flood.max reduction must
// carry a reachability caveat, since the delivery-first acceptance gate
// can only see the simulated (possibly topology-incomplete) scenario.
// Calls generateOptimizeCandidates directly with a hand-built NodeStats
// showing RedundantRelays > 0, rather than depending on the full
// screen/confirm loop to happen to accept one — deterministic and fast.
func TestOptimizeMoveSetFloodMaxCarriesWarning(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	for i := range scenario.Nodes {
		scenario.Nodes[i].FloodMax = 64
	}
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, BasePolicy: ConfigPolicy{},
		MaxSimTimeMs: 60_000, Trials: 5, Seed: 1,
	}
	req = optimizeDefaults(req)
	state := OptimizeStep(req, OptimizeState{})
	attrs := optimizeAttrs(req)

	stats := make([]NodeStats, len(scenario.Nodes))
	for i := range stats {
		stats[i] = NodeStats{Node: i}
	}
	stats[1].RedundantRelays = 4 // node 1 (a relay) has redundant relays — should propose a flood_max_reduce

	candidates := generateOptimizeCandidates(req, state, attrs, stats, OptimizeMoveSet{FloodMax: true}, defaultContentionWeights())
	found := false
	for _, c := range candidates {
		if c.node != 1 || c.kind != moveKindFloodMaxReduce {
			continue
		}
		found = true
		if c.warning == "" {
			t.Error("expected a flood_max_reduce candidate to carry a non-empty warning")
		}
		if c.newValue >= c.oldValue {
			t.Errorf("expected flood_max_reduce to lower the value: old=%v new=%v", c.oldValue, c.newValue)
		}
	}
	if !found {
		t.Fatal("expected a flood_max_reduce candidate for node 1 given RedundantRelays=4")
	}
}

// TestOptimizeTabuBlocksRepeatedFailure proves a (node, moveKind) that
// fails screening gets tabooed with a tenure that actually extends past
// the round it failed in — phase 6 work item A1. Uses an impossible
// MinImprovement so every candidate fails screening. Checked after only
// 2 rounds (well inside TabuTenure=5) so pruning hasn't had a chance to
// remove anything yet — this is a check on tabuOne's own bookkeeping, not
// on when pruneExpiredTabuEntries next runs (which is lazy, and legitimately
// leaves already-expired entries in a Done state's final TabuList, since
// nothing calls OptimizeStep again to prune them).
func TestOptimizeTabuBlocksRepeatedFailure(t *testing.T) {
	req := baseOptimizeRequest()
	req.MinImprovement = 1e9 // impossible — every screened candidate fails
	req.TabuTenure = 5
	req.StaleRoundsLimit = 1000
	req.MaxRounds = 1000

	state := OptimizeStep(req, OptimizeState{})
	state = OptimizeStep(req, state)
	state = OptimizeStep(req, state)
	if state.Round != 2 {
		t.Fatalf("test setup: expected exactly 2 rounds so far, got %d", state.Round)
	}
	if len(state.TabuList) == 0 {
		t.Fatal("expected at least one tabu entry after repeated screening failures")
	}
	for _, e := range state.TabuList {
		if e.ExpiresRound <= state.Round {
			t.Errorf("tabu entry %+v should not have already expired at round %d (tenure %d)", e, state.Round, req.TabuTenure)
		}
	}
}

// TestOptimizeTabuAspirationClearsOnScoreChange proves the change-
// triggered clearing rule (work item A2): a tabu entry whose
// ScoreWhenTabooed differs from the node's current score by more than
// TabuAspirationDelta must not block a fresh candidate from being
// generated for that (node, kind) even before its tenure elapses.
func TestOptimizeTabuAspirationClearsOnScoreChange(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, BasePolicy: ConfigPolicy{},
		MaxSimTimeMs: 60_000, Trials: 5, ConfirmTrials: 5, Seed: 1,
		TabuAspirationDelta: 0.001, // hair-trigger: almost any score movement clears it
	}
	req = optimizeDefaults(req)
	state := OptimizeStep(req, OptimizeState{})

	// Manually taboo node 1's tx backoff with a ScoreWhenTabooed far from
	// its real current score, forcing the aspiration check to trigger.
	state.TabuList = []OptimizeTabuEntry{{Node: 1, MoveKind: moveKindTxBackoff, ExpiresRound: state.Round + 1000, ScoreWhenTabooed: -99999}}

	attrs := optimizeAttrs(req)
	_, _, currentStats := evaluateAverageOptimize(req.Scenario, attrs, state.CurrentPolicy, req.Messages, req.MaxSimTimeMs, req.Trials, req.Seed)
	candidates := generateOptimizeCandidates(req, state, attrs, currentStats, defaultOptimizeMoveSet(), defaultContentionWeights())

	found := false
	for _, c := range candidates {
		if c.node == 1 && c.kind == moveKindTxBackoff {
			found = true
		}
	}
	if !found {
		t.Error("expected the aspiration criterion to clear node 1's tabu entry and surface a tx_delay_backoff candidate for it")
	}
}

// TestGenerateOptimizeCandidatesRespectsTopK proves the top-K cutoff
// (work item B) — never more than TopK nodes are proposed as back-off
// candidates, however many nodes have a positive contention score.
func TestGenerateOptimizeCandidatesRespectsTopK(t *testing.T) {
	scenario := stressScenario(20)
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, BasePolicy: ConfigPolicy{},
		MaxSimTimeMs: 30_000, Trials: 3, Seed: 1, TopK: 2,
	}
	req = optimizeDefaults(req)
	state := OptimizeStep(req, OptimizeState{})
	attrs := optimizeAttrs(req)
	_, _, currentStats := evaluateAverageOptimize(req.Scenario, attrs, state.CurrentPolicy, req.Messages, req.MaxSimTimeMs, req.Trials, req.Seed)
	candidates := generateOptimizeCandidates(req, state, attrs, currentStats, OptimizeMoveSet{TxDelay: true}, defaultContentionWeights())

	backoffNodes := map[int]bool{}
	speedupNodes := map[int]bool{}
	for _, c := range candidates {
		switch c.kind {
		case moveKindTxBackoff:
			backoffNodes[c.node] = true
		case moveKindTxSpeedup:
			speedupNodes[c.node] = true
		}
	}
	if len(backoffNodes) > req.TopK {
		t.Errorf("expected at most TopK (%d) distinct back-off nodes, got %d: %v", req.TopK, len(backoffNodes), backoffNodes)
	}
	if len(speedupNodes) > req.TopK {
		t.Errorf("expected at most TopK (%d) distinct speed-up nodes, got %d: %v", req.TopK, len(speedupNodes), speedupNodes)
	}
}

// TestOptimizeStepPicksBestAmongCandidates is a best-improvement sanity
// check (work item B): with TopK > 1 on a scenario with more than one
// offender, the optimizer must still make normal accept/reject progress
// (it doesn't need to prove optimality — just that widening the
// candidate set doesn't break the core loop).
func TestOptimizeStepPicksBestAmongCandidates(t *testing.T) {
	req := baseOptimizeRequest()
	req.TopK = 3
	state := OptimizeStep(req, OptimizeState{})
	baselineContention := state.CurrentContention
	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to finish within 50 rounds")
	}
	if state.CurrentContention >= baselineContention {
		t.Errorf("expected contention to improve over baseline with TopK=3, got %v vs baseline %v", state.CurrentContention, baselineContention)
	}
	for _, round := range state.History {
		if round.Accepted && round.CandidatesTried < 1 {
			t.Errorf("round %d: accepted a move but recorded CandidatesTried=%d", round.Round, round.CandidatesTried)
		}
	}
}

// --- Tier 2/3 (racing, LAHC, SPSA, learned weights) ---------------------

// TestRacingCompareStopsEarlyOnADecisiveDifference is work item D's own
// direct test: a candidate with an obvious, large contention improvement
// over the incumbent should be decided well before the full Trials
// budget is spent — that early stopping is racing's entire point.
func TestRacingCompareStopsEarlyOnADecisiveDifference(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, MaxSimTimeMs: 60_000,
		Trials: 60, RacingMinBatch: 5, RacingZThreshold: 1.64,
		MinDeliveryGain: 0.005, MinImprovement: 0.5, DeliveryTolerance: 0.02, MaxDeliveryRegression: 0.05,
		Seed: 1,
	}
	req = optimizeDefaults(req)
	attrs := optimizeAttrs(req)

	incumbentPolicy := ConfigPolicy{}
	// A large, obviously-effective back-off on node 1 — this fixture's
	// own three lockstepped relays (see lockstepCollisionScenario) are
	// already known (TestOptimizeStepReducesContentionOverBaseline) to
	// respond clearly to exactly this kind of move.
	candidatePolicy := ConfigPolicy{{
		Name:          "big backoff",
		Condition:     RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{1}},
		TxDelayFactor: floatPtr(2.0),
	}}

	_, cand, decisive := racingCompare(req, attrs, incumbentPolicy, candidatePolicy, req.Seed)
	if !decisive {
		t.Error("expected a large, obvious contention improvement to be decided decisively")
	}
	if cand.trials >= req.Trials {
		t.Errorf("expected racing to stop before the full trial budget (%d), used %d", req.Trials, cand.trials)
	}
}

// TestRacingCompareUsesFullBudgetWhenIndecisive proves racing never does
// LESS work than the fixed-budget path when the comparison genuinely
// can't be called early — comparing a policy against ITSELF has a true
// difference of exactly zero, which should never cross any of
// racingCompare's own decisive thresholds.
func TestRacingCompareUsesFullBudgetWhenIndecisive(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, MaxSimTimeMs: 60_000,
		Trials: 20, RacingMinBatch: 5, RacingZThreshold: 1.64,
		MinDeliveryGain: 0.005, MinImprovement: 0.5, DeliveryTolerance: 0.02, MaxDeliveryRegression: 0.05,
		Seed: 1,
	}
	req = optimizeDefaults(req)
	attrs := optimizeAttrs(req)

	policy := ConfigPolicy{}
	_, cand, decisive := racingCompare(req, attrs, policy, policy, req.Seed)
	if decisive {
		t.Error("comparing a policy against itself should never be decisive")
	}
	if cand.trials != req.Trials {
		t.Errorf("expected the full trial budget (%d) to be used when indecisive, got %d", req.Trials, cand.trials)
	}
}

// TestOptimizeStepWithAdaptiveTrialsStillReducesContention is the
// end-to-end smoke test for work item D — the full loop must still make
// real progress with AdaptiveTrials enabled, not just avoid crashing.
func TestOptimizeStepWithAdaptiveTrialsStillReducesContention(t *testing.T) {
	req := baseOptimizeRequest()
	req.AdaptiveTrials = true
	state := OptimizeStep(req, OptimizeState{})
	baselineContention := state.CurrentContention
	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to finish within 50 rounds")
	}
	if state.CurrentContention >= baselineContention {
		t.Errorf("expected AdaptiveTrials to still reduce contention below baseline (%v), got %v", baselineContention, state.CurrentContention)
	}
}

// TestOptimizeAcceptsLAHCAllowsATemporaryWorseningMove is work item E's
// own direct test: a candidate that would be REJECTED by the strict rule
// (no real delivery gain, contention not improved enough) must still be
// ACCEPTED via the LAHC rule when its contention is no worse than the
// historical value it's compared against — the whole point of the
// fallback.
func TestOptimizeAcceptsLAHCAllowsATemporaryWorseningMove(t *testing.T) {
	req := OptimizeRequest{DeliveryTolerance: 0.005, MinImprovement: 0.5, MaxDeliveryRegression: 0.02, MinDeliveryGain: 0.005}
	const baseline, current, candidate = 0.40, 0.40, 0.399 // within DeliveryTolerance, not a real delivery gain
	const candidateContention = 3400.0
	const historicalContention = 3450.0 // candidate is BETTER than L rounds ago, though maybe not better than the immediately preceding round

	if !optimizeAcceptsLAHC(req, baseline, current, candidate, candidateContention, historicalContention) {
		t.Error("expected LAHC to accept a move that beats the historical contention and stays within the delivery floor/tolerance")
	}
	// The same candidate must still be rejected if it beaches the
	// baseline floor, exactly like the strict rule.
	if optimizeAcceptsLAHC(req, baseline, current, 0.37, candidateContention, historicalContention) {
		t.Error("expected LAHC to still respect the baseline delivery floor")
	}
	// And rejected if its own contention is WORSE than the historical
	// value — LAHC isn't a free pass, just a different comparison point.
	if optimizeAcceptsLAHC(req, baseline, current, candidate, historicalContention+1, historicalContention) {
		t.Error("expected LAHC to reject a candidate worse than the historical contention")
	}
}

// TestOptimizeStepWithLateAcceptanceDoesNotCrashAndAdvancesHistory is the
// end-to-end smoke test for work item E — CostHistory must be populated
// at Initialized and keep advancing round over round, and the loop must
// still terminate normally.
func TestOptimizeStepWithLateAcceptanceDoesNotCrashAndAdvancesHistory(t *testing.T) {
	req := baseOptimizeRequest()
	req.LateAcceptance = true
	req.LateAcceptanceHistoryLength = 5

	state := OptimizeStep(req, OptimizeState{})
	if len(state.CostHistory) != 5 {
		t.Fatalf("expected CostHistory to be seeded at length 5, got %d", len(state.CostHistory))
	}
	firstSnapshot := append([]float64{}, state.CostHistory...)

	for i := 0; i < 10 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if len(state.CostHistory) != 5 {
		t.Errorf("expected CostHistory to stay length 5, got %d", len(state.CostHistory))
	}
	if reflectDeepEqualFloatSlices(firstSnapshot, state.CostHistory) {
		t.Error("expected CostHistory to have advanced after several rounds, not stay frozen at its seeded values")
	}
}

// TestOptimizeStepLAHCAcceptancesStillCountTowardStaleness is the direct
// regression test for a bug found live (via a real browser/worker run
// against a genuinely plateaued 2-node fixture): once contention stopped
// changing round to round, EVERY round's own best-by-contention candidate
// trivially satisfied optimizeAcceptsLAHC's own "<=" comparison (nothing
// was actually getting WORSE, so nothing ever failed it), and because
// StaleRounds was being reset to 0 on every such "acceptance" exactly
// like a real improvement, the run burned its entire 100-round budget
// accepting a long sequence of indistinguishable-from-no-op lateral moves
// on the same node — never once correctly reporting itself as stuck, and
// never converging. Constructed here directly: a scenario where every
// node already has TxDelayFactor at optimizeMaxTxDelay (so back-off
// candidates keep getting proposed — RedundantRelays keeps them non-zero
// — but can never actually change anything, `newVal` clamped to the same
// ceiling every round) forces exactly this "flat forever" condition.
func TestOptimizeStepLAHCAcceptancesStillCountTowardStaleness(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	for i := range scenario.Nodes {
		scenario.Nodes[i].Prefs.TxDelayFactor = optimizeMaxTxDelay // already capped — back-off moves become true no-ops
	}
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, BasePolicy: ConfigPolicy{},
		MaxSimTimeMs: 60_000, Trials: 5, ConfirmTrials: 5, Seed: 1,
		DeliveryTolerance: 0.02, MinDeliveryGain: 0.005, MaxDeliveryRegression: 0.05,
		MinImprovement: 1e9, // impossible — the strict path can never accept anything, isolating the LAHC path
		LateAcceptance: true, LateAcceptanceHistoryLength: 5,
		MaxRounds: 200, StaleRoundsLimit: 10,
	}
	state := OptimizeStep(req, OptimizeState{})
	for i := 0; i < 250 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("expected the run to stop on its own within 250 rounds")
	}
	if state.Round >= req.MaxRounds {
		t.Errorf("expected the run to stop via staleness well before the %d-round budget, ran %d rounds — LAHC acceptances on a truly flat scenario must still count as stale", req.MaxRounds, state.Round)
	}
}

func reflectDeepEqualFloatSlices(a, b []float64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestSPSAWarmStartProducesAHistoryRowNotDeviations is work item F's own
// direct test: SPSA must contribute exactly one History row (never
// per-node OptimizeDeviation entries — the plan's own "diffuse, not
// actionable" concern this design works around), and the TRUE baseline
// (BaselineDelivery/BaselineContention) must match what the SAME request
// measures WITHOUT SPSA enabled, since it's measured before SPSA ever
// runs.
func TestSPSAWarmStartProducesAHistoryRowNotDeviations(t *testing.T) {
	req := baseOptimizeRequest()
	req.SPSAWarmStart = true
	req.SPSAIterations = 3 // small — this test only cares about the mechanism, not convergence quality

	withoutSPSA := baseOptimizeRequest()
	baselineOnly := OptimizeStep(withoutSPSA, OptimizeState{})

	state := OptimizeStep(req, OptimizeState{})
	if state.BaselineDelivery != baselineOnly.CurrentDelivery || state.BaselineContention != baselineOnly.CurrentContention {
		t.Errorf("expected the TRUE baseline to match a non-SPSA run exactly: SPSA baseline=(%v,%v) plain=(%v,%v)",
			state.BaselineDelivery, state.BaselineContention, baselineOnly.CurrentDelivery, baselineOnly.CurrentContention)
	}
	if len(state.Deviations) != 0 {
		t.Errorf("expected zero per-node deviations from the SPSA warm start itself, got %d", len(state.Deviations))
	}
	if len(state.History) != 1 {
		t.Fatalf("expected exactly one history row for the SPSA warm start, got %d", len(state.History))
	}
	row := state.History[0]
	if row.MoveKind != moveKindSPSAWarmStart || row.Round != 0 || row.TargetNode != spsaWarmStartTargetNode {
		t.Errorf("unexpected SPSA history row: %+v", row)
	}
}

// TestSPSAWarmStartDiscardedIfItBreachesTheDeliveryFloor proves SPSA's
// own result is gated by the exact same delivery-first safety rule every
// other move in this file respects, not adopted unconditionally.
func TestSPSAWarmStartDiscardedIfItBreachesTheDeliveryFloor(t *testing.T) {
	scenario, messages := lockstepCollisionScenario()
	req := OptimizeRequest{
		Scenario: scenario, Messages: messages, MaxSimTimeMs: 60_000,
		Trials: 5, ConfirmTrials: 5, Seed: 1,
		SPSAWarmStart: true, SPSAIterations: 5,
		MaxDeliveryRegression: 0.0001, // an almost-zero floor — SPSA's own perturbation is very likely to cost at least this much somewhere
	}
	state := OptimizeStep(req, OptimizeState{})
	if len(state.History) != 1 {
		t.Fatalf("expected one history row, got %d", len(state.History))
	}
	if state.History[0].Accepted && state.CurrentDelivery < state.BaselineDelivery-req.MaxDeliveryRegression {
		t.Error("SPSA warm start was adopted despite breaching MaxDeliveryRegression")
	}
	// Whether adopted or discarded, CurrentDelivery must never itself be
	// below the floor — the same invariant OptimizeStep's normal rounds
	// already guarantee.
	req = optimizeDefaults(req)
	if state.CurrentDelivery < state.BaselineDelivery-req.MaxDeliveryRegression-1e-9 {
		t.Errorf("CurrentDelivery %v breaches the baseline floor after an SPSA warm start", state.CurrentDelivery)
	}
}

// TestUpdateContentionWeightsRewardsComponentsOnGoodOutcomes is work item
// G's own direct test: a candidate whose dominant component was
// ContentionCaused and whose realized delivery outcome was strongly
// positive should push that weight UP; a candidate whose dominant
// component was RedundantRelays with a strongly negative outcome should
// push that weight DOWN.
func TestUpdateContentionWeightsRewardsComponentsOnGoodOutcomes(t *testing.T) {
	weights := defaultContentionWeights()
	stats := []NodeStats{
		{Node: 0, ContentionCaused: 10}, // node 0: almost entirely ContentionCaused
		{Node: 1, RedundantRelays: 10},  // node 1: almost entirely RedundantRelays
	}
	results := []optimizeScreenResult{
		{c: optimizeMoveCandidate{node: 0, kind: moveKindTxBackoff}, deliveryGain: 0.05},       // good outcome
		{c: optimizeMoveCandidate{node: 1, kind: moveKindFloodMaxReduce}, deliveryGain: -0.05}, // bad outcome
	}
	updated := updateContentionWeights(weights, results, stats, 60_000)
	if updated.ContentionCaused <= weights.ContentionCaused {
		t.Errorf("expected ContentionCaused weight to increase on a good outcome: before=%v after=%v", weights.ContentionCaused, updated.ContentionCaused)
	}
	if updated.RedundantRelays >= weights.RedundantRelays {
		t.Errorf("expected RedundantRelays weight to decrease on a bad outcome: before=%v after=%v", weights.RedundantRelays, updated.RedundantRelays)
	}
	// Speed-up candidates aren't contention-ranking training examples —
	// must be ignored entirely, not accidentally move any weight.
	speedupOnly := []optimizeScreenResult{
		{c: optimizeMoveCandidate{node: 0, kind: moveKindTxSpeedup}, deliveryGain: 0.2},
	}
	unchanged := updateContentionWeights(weights, speedupOnly, stats, 60_000)
	if unchanged != weights {
		t.Errorf("expected speed-up-only results to leave weights unchanged: before=%+v after=%+v", weights, unchanged)
	}
}

// TestOptimizeStepWithLearnedWeightsStillReducesContention is the
// end-to-end smoke test for work item G.
func TestOptimizeStepWithLearnedWeightsStillReducesContention(t *testing.T) {
	req := baseOptimizeRequest()
	req.LearnedWeights = true
	state := OptimizeStep(req, OptimizeState{})
	baselineContention := state.CurrentContention
	for i := 0; i < 50 && !state.Done; i++ {
		state = OptimizeStep(req, state)
	}
	if !state.Done {
		t.Fatal("test setup: expected the loop to finish within 50 rounds")
	}
	if state.CurrentContention >= baselineContention {
		t.Errorf("expected LearnedWeights to still reduce contention below baseline (%v), got %v", baselineContention, state.CurrentContention)
	}
	if state.ContentionWeights == defaultContentionWeights() {
		t.Error("expected ContentionWeights to have moved from the default after several rounds of learning on a real contention-heavy fixture")
	}
}
