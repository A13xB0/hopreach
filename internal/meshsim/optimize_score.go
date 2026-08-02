package meshsim

import (
	"fmt"
)

// Contention scoring: how much airtime pressure one node's own
// behaviour creates, and how that rolls up to a single network
// figure the optimizer can compare policies on.

// ContentionWeights are the per-component multipliers
// weightedContentionScore combines — learned contention-score weights.
// This is deliberately low-priority: delivery is already the primary
// objective with contention only a proxy/tiebreak, which limits how much
// the weighting can mislead — which is exactly why its blast radius is
// deliberately kept narrow here: learned weights only ever change WHICH
// nodes generateOptimizeCandidates ranks to the top for a back-off move
// (a targeting decision). They never touch optimizeAccepts, MinImprovement,
// or any reported delivery/contention figure — those all stay on the
// fixed equal-weighted scale via nodeContentionScore/networkContention
// Score/normalizedContentionScore, exactly as shipped in Tier 1. That
// keeps every existing threshold and every number the UI already shows
// meaningful regardless of whether learning is enabled.
type ContentionWeights struct {
	ContentionCaused float64 `json:"contentionCaused"`
	CollisionCount   float64 `json:"collisionCount"`
	RedundantRelays  float64 `json:"redundantRelays"`
	DutyPct          float64 `json:"dutyPct"`
}

// defaultContentionWeights is the equal-weighted starting point — both
// the permanent fixed scale nodeContentionScore itself always uses, and
// LearnedWeights' own starting point before any round has updated it.
func defaultContentionWeights() ContentionWeights {
	return ContentionWeights{ContentionCaused: 1, CollisionCount: 1, RedundantRelays: 1, DutyPct: 1}
}

// resolveContentionWeights guarantees a real, non-zero weight vector —
// see its own call site's comment on why a bare zero-value
// ContentionWeights (an unset/foreign field) must never reach
// weightedContentionScore directly.
func resolveContentionWeights(w ContentionWeights) ContentionWeights {
	if w == (ContentionWeights{}) {
		return defaultContentionWeights()
	}
	return w
}

// weightedContentionScore is nodeContentionScore generalized to take an
// explicit weight vector — see ContentionWeights' own doc comment on
// where this is (and isn't) used. nodeContentionScore itself is defined
// in terms of this function at the fixed default weights, so Tier 1's
// existing behaviour is provably unchanged.
func weightedContentionScore(s NodeStats, maxSimTimeMs uint32, w ContentionWeights) float64 {
	dutyPct := 0.0
	if maxSimTimeMs > 0 {
		dutyPct = float64(s.DutyAirtimeMs) / float64(maxSimTimeMs) * 100
	}
	return w.ContentionCaused*float64(s.ContentionCaused) + w.CollisionCount*float64(s.CollisionCount) + w.RedundantRelays*float64(s.RedundantRelays) + w.DutyPct*dutyPct
}

// nodeContentionScore combines four measurements — ContentionCaused,
// CollisionCount, RedundantRelays, duty cycle — into one comparable
// number for one node. Deliberately simple (an equal-weighted sum, duty
// cycle expressed as a percentage so its magnitude is comparable to the
// other three counts rather than swamped or swamping them) — the plan's
// own words are "exact weighting is a tuning decision — start simple and
// document it," not a claim that this is the objectively correct
// weighting. This is the FIXED scale every reported number and every
// acceptance threshold (MinImprovement, TabuAspirationDelta) is
// calibrated against — see weightedContentionScore for the learnable
// generalization used only for candidate ranking.
func nodeContentionScore(s NodeStats, maxSimTimeMs uint32) float64 {
	return weightedContentionScore(s, maxSimTimeMs, defaultContentionWeights())
}

// contentionComponents returns the four raw (unweighted) component values
// for s, in the same fixed order weightedContentionScore/ContentionWeights
// use — the shared building block for both dominantContentionReason's
// "which one is biggest" check and the online weight-learning update in
// OptimizeStep.
func contentionComponents(s NodeStats, maxSimTimeMs uint32) [4]float64 {
	dutyPct := 0.0
	if maxSimTimeMs > 0 {
		dutyPct = float64(s.DutyAirtimeMs) / float64(maxSimTimeMs) * 100
	}
	return [4]float64{float64(s.ContentionCaused), float64(s.CollisionCount), float64(s.RedundantRelays), dutyPct}
}

// nodeSpeedupScore ranks nodes for the "speed up" candidate set — phase 6
// work item C's own "speed up (not just back off)" — a starving,
// otherwise-uninvolved node whose reachable audience isn't getting the
// packet, weighted by how many things depend on it. Deliberately simple
// and stated as a first cut, not a rigorously derived heuristic: a node with a real
// delivery shortfall (DeliveredCount well below ReachableCount) that
// matters more the more nodes are downstream of it. Zero for a node with
// nothing reachable from it, or with no shortfall at all.
func nodeSpeedupScore(s NodeStats) float64 {
	if s.ReachableCount <= 0 {
		return 0
	}
	shortfall := 1.0 - float64(s.DeliveredCount)/float64(s.ReachableCount)
	if shortfall < 0 {
		shortfall = 0
	}
	return shortfall * float64(s.ReachableCount)
}

// networkContentionScore sums nodeContentionScore across every node — the
// single number OptimizeStep's own accept/reject comparison ranks
// candidates by (never CollisionRate/CollisionCount alone — see this
// file's own acceptance-gate doc comment on why delivery must gate this,
// not the reverse).
func networkContentionScore(stats []NodeStats, maxSimTimeMs uint32) float64 {
	var total float64
	for _, s := range stats {
		total += nodeContentionScore(s, maxSimTimeMs)
	}
	return total
}

// normalizedContentionScore is networkContentionScore divided by however
// many trials stats was summed across — the ONLY form of the network-wide
// score that's safe to compare between two evaluations, since
// evaluateAverageOptimize's own NodeStats are raw SUMS across trials (see
// its own doc comment on why: ranking nodes within one evaluation doesn't
// need the division, but comparing two evaluations does). This bit a real
// bug during development: OptimizeStep's screening pass runs Trials
// trials and its confirmation pass runs ConfirmTrials (deliberately more,
// per this file's own "guarding against noise" design) — comparing their
// RAW sums directly made the confirmation pass's own larger sample look
// like a contention INCREASE even when the per-trial average genuinely
// improved, simply because it summed over more trials. Every scalar
// contention comparison in this file goes through this function, never
// networkContentionScore directly, so that mistake can't recur.
func normalizedContentionScore(stats []NodeStats, maxSimTimeMs uint32, trials int) float64 {
	if trials < 1 {
		trials = 1
	}
	return networkContentionScore(stats, maxSimTimeMs) / float64(trials)
}

// dominantContentionReason names whichever of the four contention
// components is largest for s — the human-readable "why" OptimizeStep
// records for each accepted back-off deviation. Ties break toward
// whichever is checked first below (contention caused > collisions >
// redundant relays > duty cycle), an arbitrary but deterministic order.
func dominantContentionReason(s NodeStats, maxSimTimeMs uint32) string {
	raw := contentionComponents(s, maxSimTimeMs)
	texts := [4]string{
		fmt.Sprintf("its own transmissions caused %d collisions elsewhere", s.ContentionCaused),
		fmt.Sprintf("%d of its own receptions collided", s.CollisionCount),
		fmt.Sprintf("%d of its own relays added no new delivery", s.RedundantRelays),
		fmt.Sprintf("high duty cycle (%.0f%% airtime used)", raw[3]),
	}
	bestIdx := 0
	for i := 1; i < len(raw); i++ {
		if raw[i] > raw[bestIdx] {
			bestIdx = i
		}
	}
	return texts[bestIdx]
}
