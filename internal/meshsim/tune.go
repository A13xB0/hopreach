package meshsim

import (
	"fmt"
	"math/rand/v2"
	"sort"
)

// Candidate grid for Suggest's search. Deliberately coarse — real repeaters
// don't benefit from finer-than-this granularity, and a coarse grid keeps
// the search (a few hundred candidate simulations) fast enough to run
// interactively in the browser.
//
// DirectTxDelayFactor isn't searched: Run only models flood traffic (see
// engine.go's package doc), so direct-traffic delay has no effect on any
// simulated outcome yet — searching it would produce misleading
// identical-score "suggestions." Revisit once direct/routed traffic is
// modeled.
var (
	altitudeThresholds      = []float64{200, 400, 600, 800, 1000}
	neighborCountThresholds = []int{2, 3, 4, 6, 8}
	txDelayCandidates       = []float64{0.25, 0.5, 0.75, 1.0, 1.5}
	rxDelayCandidates       = []float64{2, 5, 10, 15}
)

// TuneRequest is everything Suggest needs to search for better per-node
// settings.
type TuneRequest struct {
	Scenario     Scenario    `json:"scenario"`
	Messages     []Message   `json:"messages"`
	Attrs        []NodeAttrs `json:"attrs,omitempty"` // parallel to Scenario.Nodes; nil/omitted disables altitude/neighbour-based rules (global-only search)
	MaxSimTimeMs uint32      `json:"maxSimTimeMs"`

	// Trials is how many times each candidate is simulated, averaging out
	// the randomized retransmit-delay draws so a candidate isn't judged on
	// one lucky or unlucky run. Trials < 1 is treated as 1.
	Trials int `json:"trials"`
	// Seed drives every trial's RNG deterministically — the same seed
	// reproduces the same TuneResult, and every candidate (plus the
	// baseline) is evaluated against the same per-trial draws so the
	// comparison isn't confounded by which candidate merely got luckier.
	Seed uint64 `json:"seed"`
}

// Suggestion is one candidate rule's measured outcome.
type Suggestion struct {
	Rule          ConfigRule `json:"rule"`
	CollisionRate float64    `json:"collisionRate"`
}

// TuneResult is Suggest's output: the no-override baseline collision rate,
// and every searched candidate ranked best (lowest CollisionRate) first.
type TuneResult struct {
	Baseline    float64      `json:"baseline"`
	Suggestions []Suggestion `json:"suggestions"`
}

// Suggest grid-searches candidate ConfigRules — global tx/rx-delay
// overrides, plus (when Attrs is provided) altitude- and
// neighbour-count-threshold rules — and ranks them by measured collision
// rate against req.Scenario/Messages. This is the "predict settings"
// entry point: callers pick from TuneResult.Suggestions (typically just the
// top one, or the top one per rule category) rather than trusting a single
// blind recommendation.
//
// progress, if non-nil, is called after the baseline and after every
// candidate is evaluated — (1, total) through (total, total) — so a caller
// driving this from a Web Worker (see wasm/meshsim.go's jsSimSuggest and
// public/meshsim-worker.js) can show real search progress instead of a
// plain "please wait": a real scenario's candidate grid (with Attrs
// provided) is well over a hundred rules, each evaluated across req.Trials
// full simulation runs, and this whole call was previously fully
// synchronous on whichever thread invoked it — on the browser's main
// thread that meant a genuinely frozen page for the entire search, not
// just a slow one.
func Suggest(req TuneRequest, progress func(done, total int)) TuneResult {
	trials := req.Trials
	if trials < 1 {
		trials = 1
	}

	var candidates []ConfigRule
	for _, td := range txDelayCandidates {
		td := td
		candidates = append(candidates, ConfigRule{
			Name:          fmt.Sprintf("all nodes: txdelay %.2f", td),
			TxDelayFactor: &td,
		})
	}
	for _, rd := range rxDelayCandidates {
		rd := rd
		candidates = append(candidates, ConfigRule{
			Name:        fmt.Sprintf("all nodes: rxdelay %.1f", rd),
			RxDelayBase: &rd,
		})
	}

	if req.Attrs != nil {
		for _, alt := range altitudeThresholds {
			for _, td := range txDelayCandidates {
				td := td
				candidates = append(candidates,
					ConfigRule{
						Name:          fmt.Sprintf("altitude >= %.0fm: txdelay %.2f", alt, td),
						Condition:     RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: alt},
						TxDelayFactor: &td,
					},
					ConfigRule{
						Name:          fmt.Sprintf("altitude <= %.0fm: txdelay %.2f", alt, td),
						Condition:     RuleCondition{Kind: ConditionAltitudeAtMost, Threshold: alt},
						TxDelayFactor: &td,
					},
				)
			}
			for _, rd := range rxDelayCandidates {
				rd := rd
				candidates = append(candidates,
					ConfigRule{
						Name:        fmt.Sprintf("altitude >= %.0fm: rxdelay %.1f", alt, rd),
						Condition:   RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: alt},
						RxDelayBase: &rd,
					},
					ConfigRule{
						Name:        fmt.Sprintf("altitude <= %.0fm: rxdelay %.1f", alt, rd),
						Condition:   RuleCondition{Kind: ConditionAltitudeAtMost, Threshold: alt},
						RxDelayBase: &rd,
					},
				)
			}
		}
		for _, nc := range neighborCountThresholds {
			for _, td := range txDelayCandidates {
				td := td
				candidates = append(candidates, ConfigRule{
					Name:          fmt.Sprintf("neighbours >= %d: txdelay %.2f", nc, td),
					Condition:     RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: float64(nc)},
					TxDelayFactor: &td,
				})
			}
			for _, rd := range rxDelayCandidates {
				rd := rd
				candidates = append(candidates, ConfigRule{
					Name:        fmt.Sprintf("neighbours >= %d: rxdelay %.1f", nc, rd),
					Condition:   RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: float64(nc)},
					RxDelayBase: &rd,
				})
			}
		}
	}

	total := len(candidates) + 1 // +1 for the baseline
	done := 0
	report := func() {
		done++
		if progress != nil {
			progress(done, total)
		}
	}

	baseline := evaluate(req, ConfigRule{}, trials)
	report()

	suggestions := make([]Suggestion, 0, len(candidates))
	for _, c := range candidates {
		suggestions = append(suggestions, Suggestion{Rule: c, CollisionRate: evaluate(req, c, trials)})
		report()
	}
	sort.Slice(suggestions, func(i, j int) bool { return suggestions[i].CollisionRate < suggestions[j].CollisionRate })

	return TuneResult{Baseline: baseline, Suggestions: suggestions}
}

// evaluate runs trials simulations of req.Scenario with rule applied,
// averaging CollisionRate across them. Each trial index gets its own
// deterministic RNG seeded from req.Seed, and — critically — every
// candidate rule (plus the baseline) reuses the exact same per-trial seeds,
// so differences in the averaged result reflect the rule, not which
// candidate happened to get a luckier draw.
func evaluate(req TuneRequest, rule ConfigRule, trials int) float64 {
	scenario := applyRuleToScenario(req.Scenario, req.Attrs, rule)
	var total float64
	for trial := 0; trial < trials; trial++ {
		rng := rand.New(rand.NewPCG(req.Seed, uint64(trial)))
		report := Run(scenario, req.Messages, rng, req.MaxSimTimeMs)
		total += report.CollisionRate()
	}
	return total / float64(trials)
}
