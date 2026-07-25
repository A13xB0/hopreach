package meshsim

import (
	"fmt"
	"math"
	"math/rand/v2"
)

// OptimizeRequest configures the adaptive optimizer — phase 4 work item 4
// (docs/SIMULATOR_PLAN_PHASE4.md): "slowly adjusts from seeing collisions
// etc and contention on specific repeaters etc until it disappears." Phase
// 6 (docs/SIMULATOR_PLAN_PHASE6.md) turned the single-candidate greedy
// search into a top-K best-improvement search with tabu memory — see
// OptimizeStep's own doc comment for the shape of one round.
//
// BasePolicy is REQUIRED and is not searched for here — it's the starting
// point the optimizer only ever ADDS targeted, per-node exceptions on top
// of (see OptimizeState.CurrentPolicy). The plan's own "default: the
// winner of a normal SuggestPolicy run" is a UI-level convention (the
// frontend runs SuggestPolicy first and feeds its own winner in as
// BasePolicy), not something this package re-derives internally — running
// a full SuggestPolicy search INSIDE a single bounded OptimizeStep call
// would make that one chunk unboundedly expensive, defeating the whole
// point of chunking for cancellation (see OptimizeStep's own doc comment).
type OptimizeRequest struct {
	Scenario Scenario  `json:"scenario"`
	Messages []Message `json:"messages"`
	// Attrs, if given, only needs AltitudeM set — same contract as
	// PolicyTuneRequest.Attrs; NeighborCount/IsArticulation/
	// MarginalCoverage are always recomputed from Scenario.
	Attrs        []NodeAttrs  `json:"attrs,omitempty"`
	BasePolicy   ConfigPolicy `json:"basePolicy"`
	MaxSimTimeMs uint32       `json:"maxSimTimeMs"`

	// Trials is the CHEAP screening sample size for each candidate move —
	// "a cheap screening pass followed by a more-trials confirmation
	// before committing" (docs/SIMULATOR_PLAN_PHASE4.md work item 4's own
	// guidance against chasing noise). Trials < 1 is treated as 1.
	Trials int `json:"trials"`
	// ConfirmTrials re-evaluates the single BEST screened candidate with a
	// larger sample before actually accepting it — ConfirmTrials < Trials
	// is treated as equal to Trials (confirmation must never be CHEAPER
	// than screening, or it isn't confirming anything). Only ever spent
	// once per round (on the chosen candidate), regardless of TopK — see
	// OptimizeStep.
	ConfirmTrials int    `json:"confirmTrials"`
	Seed          uint64 `json:"seed"`

	// DeliveryTolerance is how much delivery a SINGLE move may give up
	// while still counting as "delivery held" for the contention-win
	// branch of the acceptance rule (see optimizeAccepts). It is NOT a
	// licence to drift: MaxDeliveryRegression below is a hard floor
	// against the original baseline that no accumulation of
	// within-tolerance moves may ever cross.
	//
	// 0 means "delivery must never regress by even a floating-point
	// hair", which sounds like the safe default and is in fact useless:
	// backing a node off essentially ALWAYS costs a tiny amount of
	// delivery (its relays land later, so a few packets lose a race or
	// fall outside the sim window) while reducing contention. Measured on
	// a 30-node mesh during development, a zero tolerance rejected every
	// single move across 8 rounds — including one that cost 0.0004
	// delivery and bought a 25-point contention reduction. Callers should
	// set a small real value; see simulator.js's own documented default.
	DeliveryTolerance float64 `json:"deliveryTolerance"`
	// MaxDeliveryRegression is the hard floor: no accepted policy may
	// ever measure below (baseline delivery - MaxDeliveryRegression),
	// however many individually-within-tolerance moves led there. Without
	// this, a long run could ratchet delivery down indefinitely, one
	// "negligible" step at a time — exactly the degenerate "make every
	// node silent" outcome docs/SIMULATOR_PLAN_PHASE4.md warns about,
	// just reached slowly. 0 falls back to a sensible default (see
	// optimizeDefaults), never to "unlimited".
	MaxDeliveryRegression float64 `json:"maxDeliveryRegression"`
	// MinDeliveryGain is what counts as a REAL delivery win — a move
	// clearing this is accepted on delivery alone, regardless of what it
	// does to the contention score. Without this branch the optimizer
	// rejects genuine delivery improvements whenever they happen to raise
	// contention, which was observed repeatedly during development
	// (+3.25 percentage points of delivery rejected because the
	// contention score rose). Delivery is the objective; contention is
	// the proxy. 0 falls back to a sensible default.
	MinDeliveryGain float64 `json:"minDeliveryGain"`
	// MinImprovement is the minimum CONTENTION SCORE reduction a move must
	// achieve to count as "improved" — guards against accepting a move
	// whose apparent benefit is smaller than trial-to-trial noise. A zero
	// value here would accept any positive-but-possibly-noisy reduction;
	// callers should set a real epsilon (the JS caller's own default is
	// documented in simulator.js).
	MinImprovement float64 `json:"minImprovement"`

	// MaxRounds/StaleRoundsLimit are the two normal stopping conditions
	// (docs/SIMULATOR_PLAN_PHASE4.md work item 4: "no accepted move in N
	// consecutive rounds; a wall-clock/iteration budget"). <= 0 falls back
	// to a sensible default UNLESS the matching Unlimited* flag is set —
	// see docs/SIMULATOR_PLAN_PHASE6.md work item G on why this needed an
	// explicit flag rather than overloading 0 to mean "unlimited": an
	// unset field (the common case, a caller that doesn't care) must
	// still get a bounded default, and only an EXPLICIT request should
	// ever mean "run forever".
	MaxRounds        int  `json:"maxRounds"`
	UnlimitedRounds  bool `json:"unlimitedRounds"`
	StaleRoundsLimit int  `json:"staleRoundsLimit"`
	// UnlimitedStaleRounds is only safe because cancellation genuinely
	// works (phase 4's chunked worker + force-terminate backstop, covered
	// by a Playwright test) — if that ever regresses, both Unlimited*
	// flags need to go with it. See docs/SIMULATOR_PLAN_PHASE6.md work
	// item G's own safety note.
	UnlimitedStaleRounds bool `json:"unlimitedStaleRounds"`

	// MoveSet controls which kinds of adjustment the optimizer may
	// propose — nil (the common, "caller didn't set this" case) means
	// "use the default set" (TxDelay+RxDelay on, FloodMax OFF); a
	// non-nil pointer is the caller's own explicit choice, even if every
	// field in it is false (a real, if useless, request — the optimizer
	// will do nothing and say so, rather than silently substituting a
	// default the caller didn't ask for). A plain (non-pointer)
	// OptimizeMoveSet couldn't make this distinction: its zero value and
	// "everything explicitly off" serialize identically over JSON. See
	// docs/SIMULATOR_PLAN_PHASE6.md work item H.
	MoveSet *OptimizeMoveSet `json:"moveSet,omitempty"`

	// TopK is how many worst-contention AND how many most-starved nodes
	// (see generateOptimizeCandidates) are screened each round before
	// picking the single best move — docs/SIMULATOR_PLAN_PHASE6.md work
	// item B, "evaluate the top-K offenders per round, take the best"
	// rather than always trying the single worst. < 1 falls back to 3.
	TopK int `json:"topK"`
	// TabuTenure is how many rounds a rejected (node, move kind) pair is
	// forbidden from being retried — docs/SIMULATOR_PLAN_PHASE6.md work
	// items A1/A2, directly implementing "back off if a repeater could
	// not be optimised more and try another for a bit." <= 0 falls back
	// to a scenario-sized default (see optimizeDefaults).
	TabuTenure int `json:"tabuTenure"`
	// TabuAspirationDelta is how much a tabooed node's OWN contention
	// score must move (up or down) since it was tabooed for it to become
	// eligible again immediately, tenure notwithstanding — the
	// change-triggered clearing docs/SIMULATOR_PLAN_PHASE6.md work item
	// A2 describes: "when it affects that repeater then move back to
	// it." Contention-score units, same scale as MinImprovement. <= 0
	// falls back to a default well above normal trial-to-trial noise.
	TabuAspirationDelta float64 `json:"tabuAspirationDelta"`

	// HoldoutSeed/HoldoutTrials are for OptimizeValidate, called once
	// after the loop stops — a seed range the search itself never touches
	// (docs/SIMULATOR_PLAN_PHASE4.md work item 4's "hold-out validation"),
	// so the reported figure isn't just how well the policy fits the exact
	// random draws it was tuned against.
	HoldoutSeed   uint64 `json:"holdoutSeed"`
	HoldoutTrials int    `json:"holdoutTrials"`
}

// OptimizeMoveSet controls which kinds of adjustment the optimizer may
// propose — see OptimizeRequest.MoveSet's own doc comment on why the
// request field is a pointer to this, not a plain value.
type OptimizeMoveSet struct {
	// TxDelay allows both back-off (raise txdelay on a high-contention
	// node) and speed-up (lower txdelay on a starved, otherwise-healthy
	// node) moves.
	TxDelay bool `json:"txDelay"`
	// RxDelay allows raising a high-contention node's rxDelayBase — a
	// different mechanism from txdelay (a deterministic score-based
	// hold-back rather than random spread; see delay.go's RxDelayMs),
	// worth trying as an alternative when txdelay alone doesn't help.
	RxDelay bool `json:"rxDelay"`
	// FloodMax allows REDUCING a high-redundant-relay node's own
	// flood.max. Defaults to false and should stay that way for most
	// users — see docs/SIMULATOR_PLAN_PHASE6.md work item H for why this
	// is categorically riskier than the delay knobs: it changes WHETHER
	// a packet is ever relayed past a point, not just WHEN, and the
	// delivery-first acceptance gate can only protect against harm
	// visible within the simulated scenario, which is routinely
	// incomplete (model-derived or partial-CoreScope-observed topology).
	// A repeater trimmed in simulation can still be the only path to a
	// real node the simulator never knew about.
	FloodMax bool `json:"floodMax"`
}

// defaultOptimizeMoveSet is used whenever OptimizeRequest.MoveSet is nil
// — see that field's own doc comment for why nil (not a zero-value
// struct) is what triggers this.
func defaultOptimizeMoveSet() OptimizeMoveSet {
	return OptimizeMoveSet{TxDelay: true, RxDelay: true, FloodMax: false}
}

// Move kinds — stable machine-readable slugs carried on OptimizeDeviation
// and OptimizeTabuEntry, so a UI (or a person reading exported JSON) can
// tell moves apart without parsing prose.
const (
	moveKindTxBackoff      = "tx_delay_backoff"
	moveKindTxSpeedup      = "tx_delay_speedup"
	moveKindRxBackoff      = "rx_delay_backoff"
	moveKindFloodMaxReduce = "flood_max_reduce"
)

// OptimizeDeviation records one accepted targeted adjustment — the
// per-repeater "why" the UI shows alongside the resulting action list
// (docs/SIMULATOR_PLAN_PHASE4.md work item 4: "which repeaters deviate
// from the base policy and WHY").
type OptimizeDeviation struct {
	Node     int     `json:"node"`
	Kind     string  `json:"kind"` // one of the moveKind* constants
	Reason   string  `json:"reason"`
	OldValue float64 `json:"oldValue"`
	NewValue float64 `json:"newValue"`
	Round    int     `json:"round"`
	// Warning is set only for moveKindFloodMaxReduce — see
	// OptimizeMoveSet.FloodMax's own doc comment on why that move needs
	// one and the others don't.
	Warning string `json:"warning,omitempty"`
}

// OptimizeRound is one completed round's own summary — the row a UI
// plots to show improvement over time.
type OptimizeRound struct {
	Round      int     `json:"round"`
	Delivery   float64 `json:"delivery"`
	Collision  float64 `json:"collision"`
	Contention float64 `json:"contention"`
	// TargetNode is the node whose move was actually chosen (screened
	// best, then confirmed) this round, whether or not confirmation kept
	// it; -1 if every candidate this round was tabu and none could be
	// tried (see OptimizeStep's own "nothing to try" branch).
	TargetNode int    `json:"targetNode"`
	MoveKind   string `json:"moveKind,omitempty"`
	Accepted   bool   `json:"accepted"`
	// CandidatesTried is how many distinct (node, kind) moves were
	// actually screened this round — visibility into TopK actually
	// doing something, not just a single-candidate greedy step.
	CandidatesTried int `json:"candidatesTried"`
}

// OptimizeNodeSnapshot is one node's own current standing in the
// per-repeater table — its measured stats, its contention score (what the
// optimizer actually ranks on), and its plain-language diagnosis.
type OptimizeNodeSnapshot struct {
	Node            int           `json:"node"`
	ContentionScore float64       `json:"contentionScore"`
	Stats           NodeStats     `json:"stats"`
	Diagnosis       NodeDiagnosis `json:"diagnosis"`
	// TxDelay/RxDelay/FloodMax are what the CURRENT policy resolves this
	// node's own settings to — so the table can show a node's settings
	// changing as the optimizer adjusts them.
	TxDelay  float64 `json:"txDelay"`
	RxDelay  float64 `json:"rxDelay"`
	FloodMax int     `json:"floodMax"`
	// Adjusted is true once the optimizer has accepted at least one
	// targeted change for this node.
	Adjusted bool `json:"adjusted"`
	// Tabooed is true if this node currently has at least one active
	// (node, kind) tabu entry — visible in the UI so "why isn't the
	// optimizer touching this node right now" has a direct answer.
	Tabooed bool `json:"tabooed"`
}

// OptimizeTabuEntry is one forbidden (node, move kind) pair — phase 6's
// implementation of "back off if a repeater could not be optimised more
// and try another for a bit." See OptimizeState.TabuList and
// generateOptimizeCandidates.
type OptimizeTabuEntry struct {
	Node     int    `json:"node"`
	MoveKind string `json:"moveKind"`
	// ExpiresRound: the entry is eligible again once state.Round >=
	// ExpiresRound (standard tenure-based expiry).
	ExpiresRound int `json:"expiresRound"`
	// ScoreWhenTabooed is this node's own contention score at the moment
	// it was tabooed — compared against its CURRENT score each round
	// (see OptimizeRequest.TabuAspirationDelta) to decide whether the
	// situation has moved enough to retry early, tenure notwithstanding.
	// This is the change-triggered clearing docs/SIMULATOR_PLAN_PHASE6.md
	// work item A2 describes, and is NOT standard tabu-search practice
	// (textbook tabu tenure is a fixed iteration count) — it's possible
	// here specifically because per-node contention is already measured
	// every round.
	ScoreWhenTabooed float64 `json:"scoreWhenTabooed"`
}

// OptimizeState is OptimizeStep's own input/output — a caller drives the
// whole search by feeding each call's return value back in as the next
// call's state, same shape as a Go iterator. See OptimizeStep's own doc
// comment for why this exists (cancellation).
type OptimizeState struct {
	// Initialized distinguishes "the very first call" (which only
	// measures the baseline and attempts no adjustment yet) from every
	// later call — an explicit flag rather than inferring it from
	// CurrentPolicy being empty, since an empty BasePolicy is a valid
	// (if degenerate) input this package shouldn't have to special-case
	// out of existence.
	Initialized bool `json:"initialized"`

	CurrentPolicy     ConfigPolicy `json:"currentPolicy"`
	CurrentDelivery   float64      `json:"currentDelivery"`
	CurrentCollision  float64      `json:"currentCollision"`
	CurrentContention float64      `json:"currentContention"`

	// BaselineDelivery/BaselineContention are the very first measurement
	// (the base policy, before any adjustment) — kept for the whole run
	// so the UI can show real improvement-over-time against a fixed
	// reference, and so OptimizeRequest.MaxDeliveryRegression has an
	// absolute floor to enforce rather than only per-move comparisons.
	BaselineDelivery   float64 `json:"baselineDelivery"`
	BaselineContention float64 `json:"baselineContention"`

	Round       int    `json:"round"`
	StaleRounds int    `json:"staleRounds"`
	Done        bool   `json:"done"`
	DoneReason  string `json:"doneReason"`

	// TabuList is every currently-active forbidden (node, kind) pair —
	// see OptimizeTabuEntry. Never nil.
	TabuList []OptimizeTabuEntry `json:"tabuList"`

	// History is one entry per completed round — what the UI plots as
	// "improvement over time". Never nil.
	History []OptimizeRound `json:"history"`

	// NodeSnapshot is every node's own latest measured stats plus its
	// diagnosis, refreshed each round — the full per-repeater table the
	// UI shows (all repeaters, not just the adjusted ones), so you can
	// see WHICH repeaters are causing the most contention and watch them
	// change round by round. Never nil once Initialized.
	NodeSnapshot []OptimizeNodeSnapshot `json:"nodeSnapshot"`

	// Deviations is never nil (same "empty slice, not null, across the
	// WASM/JSON boundary" convention Report.Receptions itself uses) —
	// every accepted adjustment so far, in acceptance order.
	Deviations []OptimizeDeviation `json:"deviations"`
}

// optimizeDefaults fills in the zero-value fallbacks OptimizeRequest's own
// field docs describe, without mutating the caller's request.
func optimizeDefaults(req OptimizeRequest) OptimizeRequest {
	if req.Trials < 1 {
		req.Trials = 1
	}
	if req.ConfirmTrials < req.Trials {
		req.ConfirmTrials = req.Trials
	}
	if req.MaxDeliveryRegression <= 0 {
		req.MaxDeliveryRegression = 0.02 // 2 percentage points below baseline, total, ever
	}
	if req.MinDeliveryGain <= 0 {
		req.MinDeliveryGain = 0.005 // half a percentage point counts as a real delivery win
	}
	if !req.UnlimitedRounds && req.MaxRounds <= 0 {
		req.MaxRounds = 30
	}
	if !req.UnlimitedStaleRounds && req.StaleRoundsLimit <= 0 {
		req.StaleRoundsLimit = 5
	}
	if req.HoldoutTrials < 1 {
		req.HoldoutTrials = req.Trials
	}
	if req.TopK < 1 {
		req.TopK = 3
	}
	if req.TabuTenure <= 0 {
		// Scenario-sized default: a bigger network can afford (and
		// benefits from) forbidding a failed move for longer before
		// retrying it, since there's more elsewhere to try in the
		// meantime. sqrt keeps this from growing too aggressively on a
		// large mesh — an arbitrary but documented choice, same "start
		// simple" latitude the contention-score weighting already uses.
		n := len(req.Scenario.Nodes)
		t := int(math.Sqrt(float64(n)))
		if t < 2 {
			t = 2
		}
		req.TabuTenure = t
	}
	if req.TabuAspirationDelta <= 0 {
		req.TabuAspirationDelta = 5.0 // contention-score points — well above normal trial-to-trial noise
	}
	return req
}

// optimizeAttrs mirrors SuggestPolicy's own attrs-merging logic exactly
// (policytune.go) — a separate copy rather than a shared refactor, so this
// new file can't accidentally change SuggestPolicy's already-tested
// behaviour (see this package's own "additive, don't touch working code"
// discipline, e.g. applyPolicyToScenario vs applyRuleToScenario).
func optimizeAttrs(req OptimizeRequest) []NodeAttrs {
	attrs := computeTopologyAttrs(req.Scenario)
	if req.Attrs != nil {
		for i := range attrs {
			if i < len(req.Attrs) {
				attrs[i].AltitudeM = req.Attrs[i].AltitudeM
			}
		}
	}
	return attrs
}

// nodeContentionScore combines the four measurements
// docs/SIMULATOR_PLAN_PHASE4.md work item 4 names — ContentionCaused,
// CollisionCount, RedundantRelays, duty cycle — into one comparable
// number for one node. Deliberately simple (an equal-weighted sum, duty
// cycle expressed as a percentage so its magnitude is comparable to the
// other three counts rather than swamped or swamping them) — the plan's
// own words are "exact weighting is a tuning decision — start simple and
// document it," not a claim that this is the objectively correct
// weighting. A future pass could learn/tune these weights; this is the
// documented starting point.
func nodeContentionScore(s NodeStats, maxSimTimeMs uint32) float64 {
	dutyPct := 0.0
	if maxSimTimeMs > 0 {
		dutyPct = float64(s.DutyAirtimeMs) / float64(maxSimTimeMs) * 100
	}
	return float64(s.ContentionCaused) + float64(s.CollisionCount) + float64(s.RedundantRelays) + dutyPct
}

// nodeSpeedupScore ranks nodes for the "speed up" candidate set — phase 6
// work item C's own "speed up (not just back off)" — a starving,
// otherwise-uninvolved node whose reachable audience isn't getting the
// packet, weighted by how many things depend on it. Deliberately simple
// and stated as a first cut, not a rigorously derived heuristic
// (docs/SIMULATOR_PLAN_PHASE6.md's own note on this): a node with a real
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
	dutyPct := 0.0
	if maxSimTimeMs > 0 {
		dutyPct = float64(s.DutyAirtimeMs) / float64(maxSimTimeMs) * 100
	}
	type component struct {
		value float64
		text  string
	}
	components := []component{
		{float64(s.ContentionCaused), fmt.Sprintf("its own transmissions caused %d collisions elsewhere", s.ContentionCaused)},
		{float64(s.CollisionCount), fmt.Sprintf("%d of its own receptions collided", s.CollisionCount)},
		{float64(s.RedundantRelays), fmt.Sprintf("%d of its own relays added no new delivery", s.RedundantRelays)},
		{dutyPct, fmt.Sprintf("high duty cycle (%.0f%% airtime used)", dutyPct)},
	}
	best := components[0]
	for _, c := range components[1:] {
		if c.value > best.value {
			best = c
		}
	}
	return best.text
}

// evaluateAverageOptimize averages DeliveryRatio/CollisionRate over trials
// runs of policy — the same averaging shape as policytune.go's own
// evaluate/evaluatePolicy, duplicated rather than shared for the same
// "don't risk already-tested code" reason as optimizeAttrs above.
func evaluateAverageOptimize(scenario Scenario, attrs []NodeAttrs, policy ConfigPolicy, messages []Message, maxSimTimeMs uint32, trials int, seed uint64) (delivery, collision float64, stats []NodeStats) {
	applied := applyPolicyToScenario(scenario, attrs, policy)
	sums := make([]NodeStats, len(applied.Nodes))
	for i := range sums {
		sums[i].Node = i
	}
	var totalDelivery, totalCollision float64
	for trial := 0; trial < trials; trial++ {
		rng := rand.New(rand.NewPCG(seed, uint64(trial)))
		report := Run(applied, messages, rng, maxSimTimeMs)
		totalDelivery += report.DeliveryRatio(applied, messages)
		totalCollision += report.CollisionRate()
		// Summed across trials, NOT averaged — see this function's own
		// note in OptimizeStep on why raw totals are used for ranking
		// (relative order is unaffected by a constant per-node divisor,
		// and integer NodeStats fields would lose real signal to
		// truncation if divided here).
		trialStats := report.PerNodeStats(applied, messages)
		for i := range trialStats {
			if i >= len(sums) {
				continue
			}
			sums[i].SuccessCount += trialStats[i].SuccessCount
			sums[i].CollisionCount += trialStats[i].CollisionCount
			sums[i].ContentionCaused += trialStats[i].ContentionCaused
			sums[i].TxBusyCount += trialStats[i].TxBusyCount
			sums[i].DutyAirtimeMs += trialStats[i].DutyAirtimeMs
			sums[i].RelayedCount += trialStats[i].RelayedCount
			sums[i].RedundantRelays += trialStats[i].RedundantRelays
			sums[i].UniqueDeliveries += trialStats[i].UniqueDeliveries
			sums[i].DeliveredCount += trialStats[i].DeliveredCount
			sums[i].ReachableCount += trialStats[i].ReachableCount
		}
	}
	return totalDelivery / float64(trials), totalCollision / float64(trials), sums
}

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
// conventions (docs/SIMULATOR_PLAN_PHASE4.md work item 5) suggest values
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

// buildNodeSnapshot assembles the full per-repeater table — EVERY node,
// not just the adjusted ones, since "which repeaters are causing the most
// contention" is only answerable by seeing them all ranked together.
// stats must be the summed-across-trials NodeStats
// evaluateAverageOptimize returns, with trials passed alongside so
// per-trial averages can be recovered where that matters.
func buildNodeSnapshot(req OptimizeRequest, attrs []NodeAttrs, policy ConfigPolicy, stats []NodeStats, trials int, adjustedNodes map[int]bool, tabooedNodes map[int]bool) []OptimizeNodeSnapshot {
	if trials < 1 {
		trials = 1
	}
	out := make([]OptimizeNodeSnapshot, len(stats))
	for i, s := range stats {
		// Per-trial averages, so the table's own numbers read as "per
		// simulated run" rather than "summed over however many trials
		// this round happened to use" — the same normalization
		// normalizedContentionScore applies for the same reason.
		perTrial := s
		perTrial.SuccessCount = s.SuccessCount / trials
		perTrial.CollisionCount = s.CollisionCount / trials
		perTrial.ContentionCaused = s.ContentionCaused / trials
		perTrial.TxBusyCount = s.TxBusyCount / trials
		perTrial.DutyAirtimeMs = s.DutyAirtimeMs / uint32(trials)
		perTrial.RelayedCount = s.RelayedCount / trials
		perTrial.RedundantRelays = s.RedundantRelays / trials
		perTrial.UniqueDeliveries = s.UniqueDeliveries / trials
		perTrial.DeliveredCount = s.DeliveredCount / trials
		perTrial.ReachableCount = s.ReachableCount / trials
		perTrial.DropReasons = map[string]int{}
		for k, v := range s.DropReasons {
			perTrial.DropReasons[k] = v / trials
		}

		var nodeAttrs NodeAttrs
		if i < len(attrs) {
			nodeAttrs = attrs[i]
		}
		resolved := currentNodeStateFor(i, baselineNodeFor(req, i), nodeAttrs, policy)
		out[i] = OptimizeNodeSnapshot{
			Node:            i,
			ContentionScore: nodeContentionScore(s, req.MaxSimTimeMs) / float64(trials),
			Stats:           perTrial,
			Diagnosis:       DiagnoseNode(perTrial, req.MaxSimTimeMs),
			TxDelay:         resolved.Prefs.TxDelayFactor,
			RxDelay:         resolved.Prefs.RxDelayBase,
			FloodMax:        resolved.effectiveFloodMax(),
			Adjusted:        adjustedNodes[i],
			Tabooed:         tabooedNodes[i],
		}
	}
	return out
}

// optimizeAccepts is the acceptance rule, in one place so the screening
// and confirmation passes can't drift apart. Both comparisons must be
// PAIRED (candidate and incumbent measured at the same seed and trial
// count) — see OptimizeStep's own roundSeed comment.
//
// Two ways to be accepted, plus one hard veto:
//
//  1. A real delivery win (>= MinDeliveryGain), regardless of what it does
//     to the contention score. Delivery is the actual objective;
//     contention is only ever a proxy for it. Requiring contention to
//     improve TOO rejected genuine +1 to +3 percentage-point delivery
//     gains during development, purely because the contention score
//     happened to rise alongside them.
//  2. A contention win (> MinImprovement) that costs no more than
//     DeliveryTolerance of delivery — the "free" case: less airtime
//     wasted, delivery essentially unchanged.
//
// Vetoed either way if the candidate would put cumulative delivery below
// (baseline - MaxDeliveryRegression). Rule 2 alone would otherwise let a
// long run ratchet delivery down indefinitely in individually-negligible
// steps, arriving at the degenerate "everyone stays quiet, nothing
// collides, nothing arrives" outcome one harmless-looking move at a time.
func optimizeAccepts(req OptimizeRequest, baselineDelivery, currentDelivery, currentContention, candidateDelivery, candidateContention float64) bool {
	if candidateDelivery < baselineDelivery-req.MaxDeliveryRegression {
		return false
	}
	deliveryGain := candidateDelivery - currentDelivery
	contentionGain := currentContention - candidateContention
	if deliveryGain >= req.MinDeliveryGain {
		return true
	}
	return contentionGain > req.MinImprovement && deliveryGain >= -req.DeliveryTolerance
}

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

// generateOptimizeCandidates builds this round's own move list: up to
// TopK back-off candidates (highest nodeContentionScore) and up to TopK
// speed-up candidates (highest nodeSpeedupScore), expanded into one
// optimizeMoveCandidate per (node, allowed move kind) — phase 6 work item
// B. Candidates whose (node, kind) is currently tabu are dropped UNLESS
// the change-triggered aspiration criterion clears them (work item A2):
// see the tabuBlocks closure below.
func generateOptimizeCandidates(req OptimizeRequest, state OptimizeState, attrs []NodeAttrs, currentStats []NodeStats, moveSet OptimizeMoveSet) []optimizeMoveCandidate {
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
		if cs := nodeContentionScore(s, req.MaxSimTimeMs); cs > 0 {
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
// (potentially unlimited-rounds, see docs/SIMULATOR_PLAN_PHASE6.md work
// item G) run.
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

// OptimizeStep does ONE bounded unit of work — either measuring the
// starting baseline (the very first call, state.Initialized == false) or
// running one full round of the top-K, tabu-aware search (every call
// after). This is the resumable-chunk design docs/SIMULATOR_PLAN_PHASE4.md
// work item 4 requires for real cancellation: `self.onmessage` can't fire
// while a synchronous WASM call runs, so a single call that searched to
// completion could never be cancelled mid-search. A caller (public/
// simulator.js) drives the whole optimization by calling this repeatedly,
// feeding each return value back in as the next call's state, and can
// simply STOP calling it — checking for cancellation between calls,
// updating a progress UI with real per-round numbers, and terminating the
// worker as a hard backstop if a call somehow still hangs.
//
// One round (docs/SIMULATOR_PLAN_PHASE6.md):
//
//  1. Re-measure the incumbent policy at a fresh, round-specific seed
//     (paired comparisons throughout — see the roundSeed comment below).
//  2. Generate up to 2*TopK candidate moves (work item B): the TopK
//     highest-contention nodes' own back-off moves (txdelay/rxdelay/
//     flood.max, per MoveSet — work item C/H) and the TopK most-starved
//     nodes' own speed-up moves, skipping anything currently tabu unless
//     change-triggered aspiration clears it (work item A1/A2).
//  3. Screen every surviving candidate (cheap, Trials-sized, paired
//     against the same incumbent measurement).
//  4. Every candidate that FAILS screening is tabooed. Among candidates
//     that PASS, the single best (by delivery gain, then contention gain)
//     is confirmed with a larger sample (ConfirmTrials). Confirmation
//     failure taboos it too — a screening false positive.
//  5. Accept or reject; refresh the per-repeater table and append to
//     history either way.
//
// Always returns state with Done reflecting whether normal stopping
// conditions were hit — a caller stopping early (user cancel) just stops
// calling; nothing here needs to know the difference between "stopped
// because Done" and "stopped because cancelled."
func OptimizeStep(req OptimizeRequest, state OptimizeState) OptimizeState {
	req = optimizeDefaults(req)
	attrs := optimizeAttrs(req)
	moveSet := defaultOptimizeMoveSet()
	if req.MoveSet != nil {
		moveSet = *req.MoveSet
	}

	if !state.Initialized {
		delivery, collision, stats := evaluateAverageOptimize(req.Scenario, attrs, req.BasePolicy, req.Messages, req.MaxSimTimeMs, req.Trials, req.Seed)
		contention := normalizedContentionScore(stats, req.MaxSimTimeMs, req.Trials)
		return OptimizeState{
			Initialized:        true,
			CurrentPolicy:      req.BasePolicy,
			CurrentDelivery:    delivery,
			CurrentCollision:   collision,
			CurrentContention:  contention,
			BaselineDelivery:   delivery,
			BaselineContention: contention,
			Deviations:         []OptimizeDeviation{},
			History:            []OptimizeRound{},
			TabuList:           []OptimizeTabuEntry{},
			NodeSnapshot:       buildNodeSnapshot(req, attrs, req.BasePolicy, stats, req.Trials, nil, nil),
		}
	}
	if state.Done {
		return state // already finished — calling again is a no-op, not an error
	}

	// Re-measure the incumbent with a FRESH seed offset each round (see
	// this package's own "guarding against noise" requirement) rather
	// than trusting state's cached numbers indefinitely — state.Round
	// perturbs the seed so consecutive rounds don't all draw the exact
	// same trial set.
	//
	// CRITICALLY, the incumbent's delivery/contention measured HERE — at
	// roundSeed — are what every candidate below is compared against, NOT
	// state.CurrentDelivery/CurrentContention (which were measured at a
	// different seed, in a different round). This is a PAIRED comparison:
	// both sides see the identical set of random draws, so the difference
	// between them is the effect of the policy change alone. Getting this
	// wrong (comparing across different seeds) is why the optimizer
	// originally accepted ZERO moves on any real-sized network — see
	// docs/SIMULATOR_PLAN_PHASE4.md's own incident notes.
	roundSeed := req.Seed + uint64(state.Round)*1_000_003
	currentDelivery, currentCollision, currentStats := evaluateAverageOptimize(req.Scenario, attrs, state.CurrentPolicy, req.Messages, req.MaxSimTimeMs, req.Trials, roundSeed)
	currentContention := normalizedContentionScore(currentStats, req.MaxSimTimeMs, req.Trials)

	state.TabuList = pruneExpiredTabuEntries(state.TabuList, state.Round)
	candidates := generateOptimizeCandidates(req, state, attrs, currentStats, moveSet)

	state.Round++

	if len(candidates) == 0 {
		// Either the network has genuinely converged (no node has any
		// contention or starvation signal left) or everything available
		// is currently tabu — either way there is nothing to try this
		// round. Record it plainly rather than silently doing nothing.
		state.StaleRounds++
		state.CurrentDelivery, state.CurrentCollision, state.CurrentContention = currentDelivery, currentCollision, currentContention
		state.History = append(state.History, OptimizeRound{
			Round: state.Round, Delivery: currentDelivery, Collision: currentCollision, Contention: currentContention,
			TargetNode: -1, Accepted: false, CandidatesTried: 0,
		})
		tabooed := map[int]bool{}
		for _, e := range state.TabuList {
			tabooed[e.Node] = true
		}
		adjustedNodes := map[int]bool{}
		for _, d := range state.Deviations {
			adjustedNodes[d.Node] = true
		}
		state.NodeSnapshot = buildNodeSnapshot(req, attrs, state.CurrentPolicy, currentStats, req.Trials, adjustedNodes, tabooed)
		if currentContention <= 0 {
			state.Done = true
			state.DoneReason = "converged — no node shows any contention or delivery-shortfall signal left"
		} else {
			optimizeCheckStopping(req, &state)
		}
		return state
	}

	// Screen every surviving candidate — cheap (Trials), each paired
	// against the SAME roundSeed incumbent measurement above.
	type screened struct {
		c              optimizeMoveCandidate
		delivery       float64
		collision      float64
		contention     float64
		deliveryGain   float64
		contentionGain float64
		passed         bool
	}
	results := make([]screened, len(candidates))
	for i, c := range candidates {
		d, col, stats := evaluateAverageOptimize(req.Scenario, attrs, c.policy, req.Messages, req.MaxSimTimeMs, req.Trials, roundSeed)
		cont := normalizedContentionScore(stats, req.MaxSimTimeMs, req.Trials)
		results[i] = screened{
			c: c, delivery: d, collision: col, contention: cont,
			deliveryGain:   d - currentDelivery,
			contentionGain: currentContention - cont,
			passed:         optimizeAccepts(req, state.BaselineDelivery, currentDelivery, currentContention, d, cont),
		}
	}

	// Every candidate that failed screening is tabooed now — it had its
	// chance this round and didn't hold up.
	tabuExpiry := state.Round + req.TabuTenure
	for _, r := range results {
		if !r.passed {
			state.TabuList = tabuOne(state.TabuList, r.c.node, r.c.kind, tabuExpiry, nodeContentionScore(currentStats[r.c.node], req.MaxSimTimeMs))
		}
	}

	// Among passing candidates, take the single best: real delivery gains
	// first (any of them beats any pure-contention win — see
	// optimizeAccepts' own doc comment on why), then by contention gain.
	bestIdx := -1
	for i, r := range results {
		if !r.passed {
			continue
		}
		if bestIdx < 0 {
			bestIdx = i
			continue
		}
		b := results[bestIdx]
		bothRealGains := r.deliveryGain >= req.MinDeliveryGain && b.deliveryGain >= req.MinDeliveryGain
		switch {
		case r.deliveryGain >= req.MinDeliveryGain && b.deliveryGain < req.MinDeliveryGain:
			bestIdx = i
		case bothRealGains && r.deliveryGain > b.deliveryGain:
			bestIdx = i
		case !bothRealGains && r.deliveryGain < req.MinDeliveryGain && b.deliveryGain < req.MinDeliveryGain && r.contentionGain > b.contentionGain:
			bestIdx = i
		}
	}

	accepted := false
	var chosen *optimizeMoveCandidate
	if bestIdx >= 0 {
		chosen = &results[bestIdx].c
		// Confirmation pass — a LARGER sample, PAIRED (see the roundSeed
		// comment above): the incumbent is re-measured at confirmSeed
		// too, at the same ConfirmTrials count, so candidate-vs-incumbent
		// is again a like-for-like comparison. Spent exactly once per
		// round regardless of TopK — this is the one place cost doesn't
		// scale with candidate count.
		confirmSeed := roundSeed + 7919
		baseDelivery, _, baseStats := evaluateAverageOptimize(req.Scenario, attrs, state.CurrentPolicy, req.Messages, req.MaxSimTimeMs, req.ConfirmTrials, confirmSeed)
		baseContention := normalizedContentionScore(baseStats, req.MaxSimTimeMs, req.ConfirmTrials)
		confirmDelivery, confirmCollision, confirmStats := evaluateAverageOptimize(req.Scenario, attrs, chosen.policy, req.Messages, req.MaxSimTimeMs, req.ConfirmTrials, confirmSeed)
		confirmContention := normalizedContentionScore(confirmStats, req.MaxSimTimeMs, req.ConfirmTrials)
		if optimizeAccepts(req, state.BaselineDelivery, baseDelivery, baseContention, confirmDelivery, confirmContention) {
			accepted = true
			state.CurrentPolicy = chosen.policy
			state.CurrentDelivery = confirmDelivery
			state.CurrentCollision = confirmCollision
			state.CurrentContention = confirmContention
			state.StaleRounds = 0
			state.TabuList = clearTabuFor(state.TabuList, chosen.node, chosen.kind)
			state.Deviations = append(state.Deviations, OptimizeDeviation{
				Node: chosen.node, Kind: chosen.kind, Reason: chosen.reason,
				OldValue: chosen.oldValue, NewValue: chosen.newValue, Round: state.Round, Warning: chosen.warning,
			})
		} else {
			state.TabuList = tabuOne(state.TabuList, chosen.node, chosen.kind, tabuExpiry, nodeContentionScore(currentStats[chosen.node], req.MaxSimTimeMs))
		}
	}

	if !accepted {
		state.StaleRounds++
		// Keep the reported figures tracking the freshly-measured
		// incumbent even on a rejected round, so a UI reading
		// CurrentDelivery/CurrentContention shows this round's own real
		// measurement rather than a stale value frozen since the last
		// acceptance.
		state.CurrentDelivery = currentDelivery
		state.CurrentCollision = currentCollision
		state.CurrentContention = currentContention
	}

	// Refresh the per-repeater table and append this round to the
	// history, whether the move was accepted or not.
	adjustedNodes := make(map[int]bool, len(state.Deviations))
	for _, d := range state.Deviations {
		adjustedNodes[d.Node] = true
	}
	tabooed := make(map[int]bool, len(state.TabuList))
	for _, e := range state.TabuList {
		tabooed[e.Node] = true
	}
	snapshotStats, snapshotTrials := currentStats, req.Trials
	if accepted {
		// On an accepted round, currentStats describes the OLD policy —
		// re-measure so the table reflects what was actually kept.
		_, _, snapshotStats = evaluateAverageOptimize(req.Scenario, attrs, state.CurrentPolicy, req.Messages, req.MaxSimTimeMs, req.Trials, roundSeed)
	}
	state.NodeSnapshot = buildNodeSnapshot(req, attrs, state.CurrentPolicy, snapshotStats, snapshotTrials, adjustedNodes, tabooed)

	targetNode, moveKind := -1, ""
	if chosen != nil {
		targetNode, moveKind = chosen.node, chosen.kind
	}
	state.History = append(state.History, OptimizeRound{
		Round: state.Round, Delivery: state.CurrentDelivery, Collision: state.CurrentCollision, Contention: state.CurrentContention,
		TargetNode: targetNode, MoveKind: moveKind, Accepted: accepted, CandidatesTried: len(candidates),
	})

	optimizeCheckStopping(req, &state)
	return state
}

// optimizeCheckStopping applies the two normal stopping conditions —
// factored out since both the "nothing to try" branch and the normal
// round-completion path in OptimizeStep need it.
func optimizeCheckStopping(req OptimizeRequest, state *OptimizeState) {
	switch {
	case !req.UnlimitedRounds && state.Round >= req.MaxRounds:
		state.Done = true
		state.DoneReason = "reached the round budget"
	case !req.UnlimitedStaleRounds && state.StaleRounds >= req.StaleRoundsLimit:
		state.Done = true
		state.DoneReason = fmt.Sprintf("no accepted improvement in %d consecutive rounds", state.StaleRounds)
	}
}

// OptimizeValidate re-evaluates policy against seeds the search itself
// never drew from — docs/SIMULATOR_PLAN_PHASE4.md work item 4's own
// "hold-out validation" requirement, guarding against a long greedy
// search overfitting to its own specific random draws. Called once, after
// OptimizeStep-driven iteration stops (naturally or by user cancel) — not
// part of the chunked loop itself, since one confirmation pass is already
// a bounded, cheap call.
func OptimizeValidate(req OptimizeRequest, policy ConfigPolicy) (delivery, collision float64) {
	req = optimizeDefaults(req)
	attrs := optimizeAttrs(req)
	delivery, collision, _ = evaluateAverageOptimize(req.Scenario, attrs, policy, req.Messages, req.MaxSimTimeMs, req.HoldoutTrials, req.HoldoutSeed)
	return delivery, collision
}
