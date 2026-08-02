package meshsim

import (
	"fmt"
	"math"
	"math/rand/v2"
)

// SPSA warm start: a cheap gradient-free pre-search that moves the
// whole policy at once, before the per-node tabu search starts
// making targeted single-node exceptions.

// currentNodeStateFor resolves node's own effective SimNode (Prefs +
// FloodMax) under policy, starting from the SCENARIO's own already-
// configured values (NOT DefaultNodePrefs()/a bare zero SimNode) — a
// scenario can and does set its own starting values directly (e.g. a test
// fixture forcing TxDelayFactor 0, or a real repeater's own currently-
// configured settings), and policy only ever applies ON TOP of that,
// exactly like applyPolicyToScenario itself does (`copy(out.Nodes,
// scenario.Nodes)` before applying any rule). Using a fabricated baseline
// here previously reported a nonsensical "old" value in OptimizeDeviation
// while the underlying mechanics still worked (a rule's own field always
// fully replaces, never multiplies, the base) — which is exactly what let
// that bug hide during development. FloodMax resolves through
// effectiveFloodMax() so an unset (<=0) result reads as the real firmware
// default (64), not a raw zero.
func currentNodeStateFor(node int, baseline SimNode, attrs NodeAttrs, policy ConfigPolicy) SimNode {
	n := baseline
	for _, rule := range policy {
		if !rule.MatchesNode(node, attrs) {
			continue
		}
		n.Prefs = rule.ApplyWithAttrs(n.Prefs, attrs)
		if rule.FloodMax != nil {
			n.FloodMax = *rule.FloodMax
		}
	}
	return n
}

func baselineNodeFor(req OptimizeRequest, node int) SimNode {
	if node >= 0 && node < len(req.Scenario.Nodes) {
		return req.Scenario.Nodes[node]
	}
	return SimNode{Prefs: DefaultNodePrefs()}
}

// optimizeBackoffMultiplier/optimizeMinBackoffStep/optimizeMaxTxDelay bound
// how aggressively one round nudges its chosen offender's txdelay — a
// single-step multiplicative bump (same style as refinePolicy's own
// multiplier set), capped so repeated rounds targeting the SAME node
// can't run away to an absurd value. optimizeMinBackoffStep exists
// because a pure multiplier is a no-op starting from zero: real scenarios
// (including this package's own lockstepCollisionScenario test fixture —
// the exact case that surfaced this during development) legitimately
// configure TxDelayFactor: 0 directly, and 0 * optimizeBackoffMultiplier
// is still 0, forever. Guaranteeing a minimum absolute step makes a real
// move possible regardless of the starting value.
//
// optimizeMinSpeedupStep/optimizeMinTxDelay are the speed-up direction's
// own counterparts — a floor rather than a ceiling, since speeding up
// means DEcreasing txdelay.
//
// optimizeRxDelayStep/optimizeMaxRxDelay bound the rxDelayBase back-off
// move — real firmware's own default is 0 ("off"); researched community
// conventions (see methods.go) suggest values
// around 3, so the step/ceiling here are sized to reach and exceed that
// range within a handful of escalating rounds, not to hit it in one.
//
// optimizeFloodMaxStep/optimizeMinFloodMax bound the flood.max reduction
// move — floor at 8, the real firmware default for flood.max.advert
// (SimNode's own DefaultFloodMaxAdvert), reused here as a defensible
// "don't go below what firmware itself already treats as a tight limit"
// floor rather than an arbitrary number.
const (
	optimizeBackoffMultiplier = 1.5
	optimizeMinBackoffStep    = 0.1
	optimizeMaxTxDelay        = 3.0
	optimizeMinSpeedupStep    = 0.1
	optimizeMinTxDelay        = 0.05

	optimizeRxDelayStep = 1.0
	optimizeMaxRxDelay  = 20.0

	optimizeFloodMaxStep = 8
	optimizeMinFloodMax  = 8
)

// escalatingStep scales a base step by (1+staleRounds) — see
// optimizeMinBackoffStep's own doc comment for why a fixed step can stay
// too small forever and why escalating by the GLOBAL staleRounds count
// (not a per-node retry count) is a deliberate, documented
// simplification: a different node inheriting an already-elevated step
// from unrelated prior failures is slightly more aggressive than ideal,
// never less, so it can't undermine the delivery-first acceptance gate,
// only how fast a real improvement is found.
func escalatingStep(base float64, staleRounds int) float64 {
	return base * float64(1+staleRounds)
}

// spsaAlpha/spsaGamma are Spall's own recommended SPSA gain-sequence
// exponents — standard, widely-cited default values, not tuned for this
// project specifically. spsaGainA/spsaGainC size the gain sequences
// relative to this file's OWN existing txDelayFactor step conventions
// (optimizeMinBackoffStep=0.1) rather than being independently derived —
// a documented starting point, the same latitude this file's other
// move-size constants were given when first introduced.
// spsaEvalFloor/spsaEvalCeiling are a generous SAFETY clamp applied only
// to the two evaluation points each SPSA iteration probes (never to the
// gradient math itself — see spsaWarmStart's own comment on why), wide
// enough to rarely bind during a normal run, existing only to keep a
// pathological perturbation from ever handing the simulator a deeply
// negative txDelayFactor.
const (
	spsaAlpha         = 0.602
	spsaGamma         = 0.101
	spsaGainA         = 0.2
	spsaGainC         = 0.15
	spsaStabilityFrac = 0.1
	spsaEvalFloor     = 0.0
	spsaEvalCeiling   = optimizeMaxTxDelay * 2
)

// spsaWarmStart runs Simultaneous Perturbation Stochastic Approximation
// once: perturbs EVERY
// node's txDelayFactor simultaneously and estimates a full per-node
// gradient from just 2 simulation evaluations per iteration, regardless
// of node count — dramatically cheaper than evaluating each node
// separately once dozens of nodes are involved. Minimizes the FIXED,
// unweighted normalizedContentionScore internally, purely as a cheap
// descent heuristic to find a promising region quickly — never delivery,
// since a single scalar descent target has to be cheap to evaluate many
// times, and contention is this file's own designated cheap proxy for
// exactly that reason (see nodeContentionScore's own doc comment).
//
// The plan's own documented objection to SPSA is that its raw output is
// diffuse — "everything moved a little" — the opposite of the actionable,
// named-repeater output this tool exists to produce. This function is
// therefore never treated as a final answer: its result comes back as a
// single candidate STARTING policy, which OptimizeStep's own Initialized
// branch either adopts (only if it clears the exact same delivery-floor
// gate every other move in this file respects) or discards outright. Even
// when adopted, it contributes exactly ONE history row (moveKindSPSA
// WarmStart) — never per-node OptimizeDeviation entries — and becomes
// CurrentPolicy for the normal tabu/top-K loop to keep refining from. This
// is the hybrid the plan itself suggests: "SPSA to find the region,
// per-node refinement for the final actionable deltas."
func spsaWarmStart(req OptimizeRequest, attrs []NodeAttrs, basePolicy ConfigPolicy, seed uint64) ConfigPolicy {
	n := len(req.Scenario.Nodes)
	if n == 0 {
		return basePolicy
	}
	theta := make([]float64, n)
	for i := 0; i < n; i++ {
		resolved := currentNodeStateFor(i, baselineNodeFor(req, i), attrs[i], basePolicy)
		theta[i] = resolved.Prefs.TxDelayFactor
	}

	clampEval := func(v float64) float64 {
		if v < spsaEvalFloor {
			return spsaEvalFloor
		}
		if v > spsaEvalCeiling {
			return spsaEvalCeiling
		}
		return v
	}
	buildPolicy := func(vals []float64) ConfigPolicy {
		rules := make([]ConfigRule, 0, n)
		for i, v := range vals {
			rules = append(rules, ConfigRule{
				Name:          fmt.Sprintf("adaptive: spsa warm-start node %d txdelay", i),
				Condition:     RuleCondition{Kind: ConditionNodeIndexIn, Nodes: []int{i}},
				TxDelayFactor: floatPtr(v),
			})
		}
		return append(clonePolicy(basePolicy), rules...)
	}

	rng := rand.New(rand.NewPCG(seed, 0x53504153)) // "SPAS" — a fixed, distinguishing stream from every other rng in this file
	for k := 0; k < req.SPSAIterations; k++ {
		ak := spsaGainA / math.Pow(float64(k+1)+spsaStabilityFrac*float64(req.SPSAIterations), spsaAlpha)
		ck := spsaGainC / math.Pow(float64(k+1), spsaGamma)

		delta := make([]float64, n)
		for i := range delta {
			if rng.IntN(2) == 0 {
				delta[i] = -1
			} else {
				delta[i] = 1
			}
		}

		plus := make([]float64, n)
		minus := make([]float64, n)
		for i := range theta {
			plus[i] = clampEval(theta[i] + ck*delta[i])
			minus[i] = clampEval(theta[i] - ck*delta[i])
		}

		trialSeed := seed + 0x9e3779b9 + uint64(k)*2
		_, _, plusStats := evaluateAverageOptimize(req.Scenario, attrs, buildPolicy(plus), req.Messages, req.MaxSimTimeMs, req.Trials, trialSeed)
		_, _, minusStats := evaluateAverageOptimize(req.Scenario, attrs, buildPolicy(minus), req.Messages, req.MaxSimTimeMs, req.Trials, trialSeed)
		plusObj := normalizedContentionScore(plusStats, req.MaxSimTimeMs, req.Trials)
		minusObj := normalizedContentionScore(minusStats, req.MaxSimTimeMs, req.Trials)

		for i := range theta {
			// Standard SPSA gradient estimate: the SAME scalar objective
			// difference, divided by a DIFFERENT per-component
			// perturbation — this is what recovers a full per-node
			// gradient from just 2 evaluations. Using the EFFECTIVE
			// (possibly clamp-shortened) delta actually evaluated, not
			// the raw ck*delta[i], keeps the estimate consistent with
			// what the simulator was actually asked about.
			effectiveDeltaI := (plus[i] - minus[i]) / 2
			if effectiveDeltaI == 0 {
				continue
			}
			grad := (plusObj - minusObj) / (2 * effectiveDeltaI)
			theta[i] -= ak * grad
		}
	}

	for i := range theta {
		if theta[i] < optimizeMinTxDelay {
			theta[i] = optimizeMinTxDelay
		}
		if theta[i] > optimizeMaxTxDelay {
			theta[i] = optimizeMaxTxDelay
		}
	}
	return buildPolicy(theta)
}
