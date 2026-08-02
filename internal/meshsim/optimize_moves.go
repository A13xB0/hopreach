package meshsim

import (
	"fmt"
	"math"
)

// Candidate move generation and the tabu list: which per-node
// changes the optimizer proposes each round, and which ones it has
// learned not to propose again yet.

// optimizeMoveCandidate is one proposed, not-yet-evaluated move — a
// (node, kind) pair plus the resulting policy. Generated in bulk each
// round by generateOptimizeCandidates, then screened.
type optimizeMoveCandidate struct {
	node          int
	kind          string
	policy        ConfigPolicy
	oldValue      float64
	newValue      float64
	reason        string
	warning       string
	priorityScore float64 // the ranking score (contention or speedup) that surfaced this candidate — for ordering only
}

// optimizeScreenResult is one candidate's own screening-pass outcome —
// promoted to a package-level type (rather than staying a local type
// inside OptimizeStep) specifically so updateContentionWeights (work item
// G) can take a slice of them as a parameter.
type optimizeScreenResult struct {
	c              optimizeMoveCandidate
	delivery       float64
	collision      float64
	contention     float64
	deliveryGain   float64
	contentionGain float64
	passed         bool
}

// generateOptimizeCandidates builds this round's own move list: up to
// TopK back-off candidates (highest nodeContentionScore) and up to TopK
// speed-up candidates (highest nodeSpeedupScore), expanded into one
// optimizeMoveCandidate per (node, allowed move kind) — phase 6 work item
// B. Candidates whose (node, kind) is currently tabu are dropped UNLESS
// the change-triggered aspiration criterion clears them (work item A2):
// see the tabuBlocks closure below.
func generateOptimizeCandidates(req OptimizeRequest, state OptimizeState, attrs []NodeAttrs, currentStats []NodeStats, moveSet OptimizeMoveSet, weights ContentionWeights) []optimizeMoveCandidate {
	n := len(currentStats)

	tabuBlocks := func(node int, kind string) bool {
		for _, e := range state.TabuList {
			if e.Node != node || e.MoveKind != kind {
				continue
			}
			if state.Round >= e.ExpiresRound {
				continue // expired — not blocking (pruned properly at the end of the round)
			}
			// Change-triggered clearing (work item A2): if this node's
			// own contention score has moved enough since it was
			// tabooed, the situation that caused the rejection may no
			// longer hold — worth retrying now rather than waiting out
			// the rest of the tenure.
			nowScore := nodeContentionScore(currentStats[node], req.MaxSimTimeMs)
			if math.Abs(nowScore-e.ScoreWhenTabooed) > req.TabuAspirationDelta {
				continue
			}
			return true
		}
		return false
	}

	type ranked struct {
		node  int
		score float64
	}
	backoffRanked := make([]ranked, 0, n)
	speedupRanked := make([]ranked, 0, n)
	for i, s := range currentStats {
		// Ranking uses the (possibly learned, see ContentionWeights' own
		// doc comment) weighted score — this is the ONE place learned
		// weights are allowed to change behaviour: which nodes rise to
		// the top of the candidate list. tabuBlocks' own aspiration check
		// below deliberately stays on the fixed nodeContentionScore scale,
		// since TabuAspirationDelta is calibrated against it.
		if cs := weightedContentionScore(s, req.MaxSimTimeMs, weights); cs > 0 {
			backoffRanked = append(backoffRanked, ranked{i, cs})
		}
		if ss := nodeSpeedupScore(s); ss > 0 {
			speedupRanked = append(speedupRanked, ranked{i, ss})
		}
	}
	sortRankedDesc := func(r []ranked) {
		for i := 1; i < len(r); i++ {
			for j := i; j > 0 && r[j].score > r[j-1].score; j-- {
				r[j], r[j-1] = r[j-1], r[j]
			}
		}
	}
	sortRankedDesc(backoffRanked)
	sortRankedDesc(speedupRanked)
	if len(backoffRanked) > req.TopK {
		backoffRanked = backoffRanked[:req.TopK]
	}
	if len(speedupRanked) > req.TopK {
		speedupRanked = speedupRanked[:req.TopK]
	}

	var out []optimizeMoveCandidate
	for _, r := range backoffRanked {
		node := r.node
		baseline := baselineNodeFor(req, node)
		resolved := currentNodeStateFor(node, baseline, attrs[node], state.CurrentPolicy)
		reason := dominantContentionReason(currentStats[node], req.MaxSimTimeMs)

		if moveSet.TxDelay && !tabuBlocks(node, moveKindTxBackoff) {
			old := resolved.Prefs.TxDelayFactor
			step := escalatingStep(optimizeMinBackoffStep, state.StaleRounds)
			newVal := old * optimizeBackoffMultiplier
			if newVal < old+step {
				newVal = old + step
			}
			if newVal > optimizeMaxTxDelay {
				newVal = optimizeMaxTxDelay
			}
			out = append(out, optimizeMoveCandidate{
				node: node, kind: moveKindTxBackoff, oldValue: old, newValue: newVal, reason: reason, priorityScore: r.score,
				policy: append(clonePolicy(state.CurrentPolicy), ConfigRule{
					Name:          fmt.Sprintf("adaptive: back off node %d txdelay (round %d)", node, state.Round+1),
					Condition:     RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{node}},
					TxDelayFactor: floatPtr(newVal),
				}),
			})
		}
		if moveSet.RxDelay && !tabuBlocks(node, moveKindRxBackoff) {
			old := resolved.Prefs.RxDelayBase
			step := escalatingStep(optimizeRxDelayStep, state.StaleRounds)
			newVal := old + step
			if newVal > optimizeMaxRxDelay {
				newVal = optimizeMaxRxDelay
			}
			out = append(out, optimizeMoveCandidate{
				node: node, kind: moveKindRxBackoff, oldValue: old, newValue: newVal, reason: reason, priorityScore: r.score,
				policy: append(clonePolicy(state.CurrentPolicy), ConfigRule{
					Name:        fmt.Sprintf("adaptive: raise node %d rxdelay (round %d)", node, state.Round+1),
					Condition:   RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{node}},
					RxDelayBase: floatPtr(newVal),
				}),
			})
		}
		if moveSet.FloodMax && currentStats[node].RedundantRelays > 0 && !tabuBlocks(node, moveKindFloodMaxReduce) {
			old := resolved.effectiveFloodMax()
			newVal := old - optimizeFloodMaxStep
			if newVal < optimizeMinFloodMax {
				newVal = optimizeMinFloodMax
			}
			if newVal < old {
				out = append(out, optimizeMoveCandidate{
					node: node, kind: moveKindFloodMaxReduce,
					oldValue: float64(old), newValue: float64(newVal),
					reason:        fmt.Sprintf("%d of its own relays added no new delivery", currentStats[node].RedundantRelays),
					warning:       "Reduces how far this repeater's own relays can travel — verify it isn't the only path to somewhere real before applying. The simulator can only check reachability within its own modelled topology.",
					priorityScore: r.score,
					policy: append(clonePolicy(state.CurrentPolicy), ConfigRule{
						Name:      fmt.Sprintf("adaptive: trim node %d flood.max (round %d)", node, state.Round+1),
						Condition: RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{node}},
						FloodMax:  intPtr(newVal),
					}),
				})
			}
		}
	}
	for _, r := range speedupRanked {
		node := r.node
		if !moveSet.TxDelay || tabuBlocks(node, moveKindTxSpeedup) {
			continue
		}
		baseline := baselineNodeFor(req, node)
		resolved := currentNodeStateFor(node, baseline, attrs[node], state.CurrentPolicy)
		old := resolved.Prefs.TxDelayFactor
		step := escalatingStep(optimizeMinSpeedupStep, state.StaleRounds)
		newVal := old - step
		if newVal < optimizeMinTxDelay {
			newVal = optimizeMinTxDelay
		}
		if newVal < old {
			out = append(out, optimizeMoveCandidate{
				node: node, kind: moveKindTxSpeedup, oldValue: old, newValue: newVal, priorityScore: r.score,
				reason: fmt.Sprintf("only %d of %d reachable listeners have received its packets", currentStats[node].DeliveredCount, currentStats[node].ReachableCount),
				policy: append(clonePolicy(state.CurrentPolicy), ConfigRule{
					Name:          fmt.Sprintf("adaptive: speed up node %d txdelay (round %d)", node, state.Round+1),
					Condition:     RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{node}},
					TxDelayFactor: floatPtr(newVal),
				}),
			})
		}
	}
	return out
}

// pruneExpiredTabuEntries drops entries whose tenure has already elapsed
// — keeps OptimizeState.TabuList from growing without bound over a long
// (potentially unlimited-rounds) run.
func pruneExpiredTabuEntries(entries []OptimizeTabuEntry, round int) []OptimizeTabuEntry {
	out := entries[:0]
	for _, e := range entries {
		if round < e.ExpiresRound {
			out = append(out, e)
		}
	}
	return out
}

// tabuOne appends (or refreshes) a tabu entry for (node, kind) — called
// when a candidate fails screening or confirmation.
func tabuOne(entries []OptimizeTabuEntry, node int, kind string, expiresRound int, score float64) []OptimizeTabuEntry {
	for i, e := range entries {
		if e.Node == node && e.MoveKind == kind {
			entries[i].ExpiresRound = expiresRound
			entries[i].ScoreWhenTabooed = score
			return entries
		}
	}
	return append(entries, OptimizeTabuEntry{Node: node, MoveKind: kind, ExpiresRound: expiresRound, ScoreWhenTabooed: score})
}

// clearTabuFor removes any tabu entry for (node, kind) — called when a
// move at that (node, kind) is actually accepted, so a future rejection
// starts its own tenure fresh rather than inheriting a stale one.
func clearTabuFor(entries []OptimizeTabuEntry, node int, kind string) []OptimizeTabuEntry {
	out := entries[:0]
	for _, e := range entries {
		if e.Node != node || e.MoveKind != kind {
			out = append(out, e)
		}
	}
	return out
}
