package meshsim

import (
	"fmt"
	"math/rand/v2"
	"sort"
)

// PolicyTuneRequest is SuggestPolicy's input — item 15c's stress-test-
// driven tuning search, distinct from the older Suggest/TuneRequest.
// Suggest itself is left completely unmodified by this file: SuggestPolicy
// is additive, not a replacement, so the existing "Predict settings"
// feature and its own tests keep working exactly as they did before item
// 15. The two differ in three ways: SuggestPolicy searches composite,
// multi-rule ConfigPolicies (not one ConfigRule at a time); it ranks by
// DeliveryRatio, not CollisionRate (see item 13/15's own "wrong objective"
// finding — a policy that makes everyone back off enormously collides less
// and delivers less, which are not the same goal); and its candidate grid
// includes topology-derived models (articulation points, MPR-style
// marginal coverage) Suggest's own grid never had.
type PolicyTuneRequest struct {
	Scenario Scenario  `json:"scenario"`
	Messages []Message `json:"messages"`
	// Attrs, if given, only needs AltitudeM set — NeighborCount/
	// IsArticulation/MarginalCoverage are always (re)computed from
	// Scenario itself (see computeTopologyAttrs), never trusted from the
	// caller, so they're guaranteed accurate for THIS scenario.
	Attrs        []NodeAttrs `json:"attrs,omitempty"`
	MaxSimTimeMs uint32      `json:"maxSimTimeMs"`
	Trials       int         `json:"trials"`
	Seed         uint64      `json:"seed"`
}

// PolicySuggestion is one searched ConfigPolicy's measured outcome.
type PolicySuggestion struct {
	Name          string       `json:"name"`
	Policy        ConfigPolicy `json:"policy"`
	DeliveryRatio float64      `json:"deliveryRatio"`
	// CollisionRate is reported for context (the same diagnostic value it
	// always was) — never the ranking criterion here.
	CollisionRate float64 `json:"collisionRate"`
}

// PolicyTuneResult is SuggestPolicy's output.
type PolicyTuneResult struct {
	BaselineDelivery  float64 `json:"baselineDelivery"`
	BaselineCollision float64 `json:"baselineCollision"`
	// Suggestions is ranked best (highest DeliveryRatio) first.
	Suggestions []PolicySuggestion `json:"suggestions"`
}

// policyCandidate names a generated ConfigPolicy before it's been measured.
type policyCandidate struct {
	name   string
	policy ConfigPolicy
}

// Coarse parameter values shared across the model catalogue below —
// deliberately few, so the total candidate count stays in the same order
// of magnitude as Suggest's own ~144-candidate grid (see
// docs/SIMULATOR_PLAN_PHASE2.md item 15c's own "do not brute-force the
// product" instruction).
var (
	policyDelayLowTx                = 0.25
	policyDelayHighTx               = 1.0
	policyRxDelayOnValues           = []float64{5.0, 10.0} // Finding A: rxDelayBase defaults to 0 (off) — these are representative "on" values
	policyNeighborThresholds        = []float64{3, 6}
	policyMarginalCoverageThreshold = []float64{1, 2}
	policyAltitudeThresholds        = []float64{400, 700}
	policyFloodMaxValues            = []int{16, 32}
)

func floatPtr(v float64) *float64 { return &v }
func intPtr(v int) *int           { return &v }

// stage1GlobalPolicies mirrors Suggest's own global (unconditional) sweeps,
// as single-rule policies — "score-priority" (Finding A: turn on
// firmware's own SNR-based relay-priority mechanism) plus a low/high
// global txdelay pair, so the search always has these as a floor to beat.
func stage1GlobalPolicies() []policyCandidate {
	var out []policyCandidate
	for _, rd := range policyRxDelayOnValues {
		out = append(out, policyCandidate{
			name:   fmt.Sprintf("score-priority (rxdelay %.1f)", rd),
			policy: ConfigPolicy{{Name: "global rxdelay", RxDelayBase: floatPtr(rd)}},
		})
	}
	out = append(out,
		policyCandidate{name: "global txdelay low (0.25)", policy: ConfigPolicy{{Name: "global txdelay", TxDelayFactor: floatPtr(policyDelayLowTx)}}},
		policyCandidate{name: "global txdelay high (1.0)", policy: ConfigPolicy{{Name: "global txdelay", TxDelayFactor: floatPtr(policyDelayHighTx)}}},
	)
	return out
}

// stage2NamedModelPolicies is the model catalogue from
// docs/SIMULATOR_PLAN_PHASE2.md item 15c. Each model is included alongside
// its own inverse where the plan calls for one — do not assume which way
// round is right; that's a property of the specific topology being
// searched, which is why it's measured rather than reasoned about.
//
// Three models from the plan's own table are deliberately NOT implemented
// here, each for a documented infrastructure reason rather than being
// forgotten:
//   - degree-proportional: needs continuous (non-threshold) scaling of
//     txdelay by neighbour count — RuleCondition's Kind+Threshold shape
//     has no way to express a continuous function, only a step. The plan
//     itself flags this as needing "a new proportional rule kind."
//   - redundancy-suppress / airtime-aware: these are measurement-driven —
//     they target SPECIFIC nodes identified from a prior run's own
//     scoreboard (item 16: high redundant-relay count / high duty cycle),
//     not nodes matching a general topology/altitude condition. Nothing
//     in RuleCondition can match "this specific set of node indices";
//     that needs a different mechanism than every other model here uses,
//     which is a larger change than this pass has room for.
func stage2NamedModelPolicies(hasAltitude bool) []policyCandidate {
	var out []policyCandidate

	for _, nc := range policyNeighborThresholds {
		out = append(out,
			policyCandidate{
				name:   fmt.Sprintf("dense-slow (neighbours>=%.0f: txdelay high)", nc),
				policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: nc}, TxDelayFactor: floatPtr(policyDelayHighTx)}},
			},
			policyCandidate{
				name:   fmt.Sprintf("dense-fast (neighbours>=%.0f: txdelay low)", nc),
				policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: nc}, TxDelayFactor: floatPtr(policyDelayLowTx)}},
			},
			policyCandidate{
				name:   fmt.Sprintf("sparse-slow (neighbours<=%.0f: txdelay high)", nc),
				policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionNeighborsAtMost, Threshold: nc}, TxDelayFactor: floatPtr(policyDelayHighTx)}},
			},
			policyCandidate{
				name:   fmt.Sprintf("edge-first (neighbours<=%.0f: txdelay low)", nc),
				policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionNeighborsAtMost, Threshold: nc}, TxDelayFactor: floatPtr(policyDelayLowTx)}},
			},
		)
	}

	// articulation-first: cut vertices are never redundant relays, so they
	// should never be the ones hanging back.
	out = append(out, policyCandidate{
		name:   "articulation-first",
		policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionIsArticulation}, TxDelayFactor: floatPtr(policyDelayLowTx)}},
	})

	for _, mc := range policyMarginalCoverageThreshold {
		out = append(out, policyCandidate{
			name:   fmt.Sprintf("mpr (marginal coverage>=%.0f: txdelay low)", mc),
			policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionMarginalCoverageAtLeast, Threshold: mc}, TxDelayFactor: floatPtr(policyDelayLowTx)}},
		})
	}

	for _, fm := range policyFloodMaxValues {
		out = append(out, policyCandidate{
			name:   fmt.Sprintf("hop-limit-trim (flood.max=%d)", fm),
			policy: ConfigPolicy{{Name: "global flood.max", FloodMax: intPtr(fm)}},
		})
	}

	// score-priority + dense-slow: the best global rxdelay combined with
	// the best composite txdelay policy, expressed as a genuine two-rule
	// ConfigPolicy — the concrete case a single ConfigRule can't express.
	out = append(out, policyCandidate{
		name: "score-priority + dense-slow",
		policy: ConfigPolicy{
			{Name: "global rxdelay", RxDelayBase: floatPtr(policyRxDelayOnValues[0])},
			{Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: policyNeighborThresholds[len(policyNeighborThresholds)-1]}, TxDelayFactor: floatPtr(policyDelayHighTx)},
		},
	})

	if hasAltitude {
		for _, alt := range policyAltitudeThresholds {
			out = append(out,
				policyCandidate{
					name:   fmt.Sprintf("hilltop-first (altitude>=%.0fm: txdelay low)", alt),
					policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: alt}, TxDelayFactor: floatPtr(policyDelayLowTx)}},
				},
				policyCandidate{
					name:   fmt.Sprintf("hilltop-last (altitude>=%.0fm: txdelay high)", alt),
					policy: ConfigPolicy{{Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: alt}, TxDelayFactor: floatPtr(policyDelayHighTx)}},
				},
			)
		}
		// hub-and-spoke / two-tier-backbone both call for an altitude-AND-
		// neighbour-count condition, which RuleCondition's single-Kind
		// shape can't express (no AND combinator exists) — approximated
		// here with altitude alone, the harder-to-fake-cheaply half of
		// the pair (a real hilltop reaches more nodes; a real hub having
		// many neighbours often follows FROM being a hilltop in a
		// terrain-shaped mesh). Named accordingly so this approximation
		// is visible in the UI, not silently passed off as the real thing.
		out = append(out,
			policyCandidate{
				name: "hub-and-spoke (approx: altitude only)",
				policy: ConfigPolicy{
					{Name: "baseline high", TxDelayFactor: floatPtr(policyDelayHighTx)},
					{Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: policyAltitudeThresholds[len(policyAltitudeThresholds)-1]}, TxDelayFactor: floatPtr(policyDelayLowTx)},
				},
			},
			policyCandidate{
				name: "two-tier-backbone (approx: altitude only)",
				policy: ConfigPolicy{
					{Name: "fringe: high delay, trimmed flood.max", TxDelayFactor: floatPtr(policyDelayHighTx), FloodMax: intPtr(policyFloodMaxValues[0])},
					{Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: policyAltitudeThresholds[len(policyAltitudeThresholds)-1]}, TxDelayFactor: floatPtr(policyDelayLowTx)},
				},
			},
		)
	}

	return out
}

// refinePolicy is stage 3's coordinate descent: nudge each numeric
// override in the winning policy's own rules by a small multiplier set,
// keeping any change that improves delivery, repeating until nothing helps
// or a small iteration cap is hit. Deliberately simple — the search space
// here (a handful of rules, each with 1-2 numeric fields) is small enough
// that this converges in a handful of evaluations, and a generic optimizer
// would be solving a much harder problem than actually exists here.
func refinePolicy(start PolicySuggestion, evaluate func(ConfigPolicy) (float64, float64)) PolicySuggestion {
	best := start
	const maxIterations = 3
	multipliers := []float64{0.5, 0.75, 1.25, 1.5, 2.0}
	for iter := 0; iter < maxIterations; iter++ {
		improved := false
		for ruleIdx := range best.Policy {
			for _, mult := range multipliers {
				if best.Policy[ruleIdx].TxDelayFactor != nil {
					candidate := clonePolicy(best.Policy)
					v := *candidate[ruleIdx].TxDelayFactor * mult
					candidate[ruleIdx].TxDelayFactor = &v
					if d, c := evaluate(candidate); d > best.DeliveryRatio {
						best = PolicySuggestion{Name: best.Name + " (refined)", Policy: candidate, DeliveryRatio: d, CollisionRate: c}
						improved = true
					}
				}
				if best.Policy[ruleIdx].RxDelayBase != nil {
					candidate := clonePolicy(best.Policy)
					v := *candidate[ruleIdx].RxDelayBase * mult
					candidate[ruleIdx].RxDelayBase = &v
					if d, c := evaluate(candidate); d > best.DeliveryRatio {
						best = PolicySuggestion{Name: best.Name + " (refined)", Policy: candidate, DeliveryRatio: d, CollisionRate: c}
						improved = true
					}
				}
			}
		}
		if !improved {
			break
		}
	}
	return best
}

// clonePolicy copies the slice (each ConfigRule element, including its
// pointer fields) so refinePolicy can mutate a candidate without aliasing
// the policy it started from — replacing a pointer field with a new
// pointer (rather than writing through the old one) never touches the
// original rule's own value.
func clonePolicy(p ConfigPolicy) ConfigPolicy {
	out := make(ConfigPolicy, len(p))
	copy(out, p)
	return out
}

// SuggestPolicy is item 15c's own search entry point — see
// PolicyTuneRequest's doc comment for how this differs from the older
// Suggest. progress, if non-nil, is called after the baseline, after every
// stage-1/2 candidate, and once more after stage 3's refinement pass —
// same (done, total) shape as Suggest's own progress callback, for the
// same reason (see wasm/meshsim.go's jsSimSuggestPolicy).
func SuggestPolicy(req PolicyTuneRequest, progress func(done, total int)) PolicyTuneResult {
	trials := req.Trials
	if trials < 1 {
		trials = 1
	}

	attrs := computeTopologyAttrs(req.Scenario)
	hasAltitude := false
	if req.Attrs != nil {
		for i := range attrs {
			if i < len(req.Attrs) {
				attrs[i].AltitudeM = req.Attrs[i].AltitudeM
				if req.Attrs[i].AltitudeM != 0 {
					hasAltitude = true
				}
			}
		}
	}

	candidates := stage1GlobalPolicies()
	candidates = append(candidates, stage2NamedModelPolicies(hasAltitude)...)

	total := len(candidates) + 2 // +1 baseline, +1 stage-3 refinement (reported as one step, not per-iteration)
	done := 0
	reportProgress := func() {
		done++
		if progress != nil {
			progress(done, total)
		}
	}

	evaluate := func(scenario Scenario) (float64, float64) {
		var totalDelivery, totalCollision float64
		for trial := 0; trial < trials; trial++ {
			rng := rand.New(rand.NewPCG(req.Seed, uint64(trial)))
			r := Run(scenario, req.Messages, rng, req.MaxSimTimeMs)
			totalDelivery += r.DeliveryRatio(scenario, req.Messages)
			totalCollision += r.CollisionRate()
		}
		return totalDelivery / float64(trials), totalCollision / float64(trials)
	}
	evaluatePolicy := func(policy ConfigPolicy) (float64, float64) {
		return evaluate(applyPolicyToScenario(req.Scenario, attrs, policy))
	}

	baselineDelivery, baselineCollision := evaluate(req.Scenario)
	reportProgress()

	suggestions := make([]PolicySuggestion, 0, len(candidates))
	for _, c := range candidates {
		d, cr := evaluatePolicy(c.policy)
		suggestions = append(suggestions, PolicySuggestion{Name: c.name, Policy: c.policy, DeliveryRatio: d, CollisionRate: cr})
		reportProgress()
	}
	sort.Slice(suggestions, func(i, j int) bool { return suggestions[i].DeliveryRatio > suggestions[j].DeliveryRatio })

	if len(suggestions) > 0 && suggestions[0].DeliveryRatio > baselineDelivery {
		refined := refinePolicy(suggestions[0], evaluatePolicy)
		if refined.DeliveryRatio > suggestions[0].DeliveryRatio {
			suggestions = append([]PolicySuggestion{refined}, suggestions...)
			sort.Slice(suggestions, func(i, j int) bool { return suggestions[i].DeliveryRatio > suggestions[j].DeliveryRatio })
		}
	}
	reportProgress()

	return PolicyTuneResult{
		BaselineDelivery:  baselineDelivery,
		BaselineCollision: baselineCollision,
		Suggestions:       suggestions,
	}
}
