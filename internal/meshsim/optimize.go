package meshsim

import (
	"fmt"
	"math"
	"math/rand/v2"
)

// OptimizeRequest configures the adaptive optimizer: it slowly adjusts
// from seeing collisions and contention on specific repeaters until they
// disappear. The search is top-K best-improvement with tabu memory — see
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
	// a cheap screening pass followed by a more-trials confirmation
	// before committing, so the search doesn't chase noise. Trials < 1 is
	// treated as 1.
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
	// node silent" outcome, just reached slowly. 0 falls back to a sensible default (see
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

	// MaxRounds/StaleRoundsLimit are the two normal stopping conditions:
	// no accepted move in N consecutive rounds, and an iteration budget.
	// <= 0 falls back to a sensible default UNLESS the matching Unlimited*
	// flag is set — an explicit flag rather than overloading 0 to mean
	// "unlimited", because an
	// unset field (the common case, a caller that doesn't care) must
	// still get a bounded default, and only an EXPLICIT request should
	// ever mean "run forever".
	MaxRounds        int  `json:"maxRounds"`
	UnlimitedRounds  bool `json:"unlimitedRounds"`
	StaleRoundsLimit int  `json:"staleRoundsLimit"`
	// UnlimitedStaleRounds is only safe because cancellation genuinely
	// works (phase 4's chunked worker + force-terminate backstop, covered
	// by a Playwright test) — if that ever regresses, both Unlimited*
	// flags need to go with it.
	UnlimitedStaleRounds bool `json:"unlimitedStaleRounds"`

	// MoveSet controls which kinds of adjustment the optimizer may
	// propose — nil (the common, "caller didn't set this" case) means
	// "use the default set" (TxDelay+RxDelay on, FloodMax OFF); a
	// non-nil pointer is the caller's own explicit choice, even if every
	// field in it is false (a real, if useless, request — the optimizer
	// will do nothing and say so, rather than silently substituting a
	// default the caller didn't ask for). A plain (non-pointer)
	// OptimizeMoveSet couldn't make this distinction: its zero value and
	// "everything explicitly off" serialize identically over JSON.
	MoveSet *OptimizeMoveSet `json:"moveSet,omitempty"`

	// TopK is how many worst-contention AND how many most-starved nodes
	// (see generateOptimizeCandidates) are screened each round before
	// picking the single best move: evaluate the top-K offenders per
	// round and take the best, rather than always trying the single
	// worst. < 1 falls back to 3.
	TopK int `json:"topK"`
	// TabuTenure is how many rounds a rejected (node, move kind) pair is
	// forbidden from being retried: back off if a repeater could not be
	// optimised further and try another for a bit. <= 0 falls back
	// to a scenario-sized default (see optimizeDefaults).
	TabuTenure int `json:"tabuTenure"`
	// TabuAspirationDelta is how much a tabooed node's OWN contention
	// score must move (up or down) since it was tabooed for it to become
	// eligible again immediately, tenure notwithstanding — change-triggered
	// clearing, so that when something affects a tabooed repeater the
	// search can move back to it. Contention-score units, same scale as
	// MinImprovement. <= 0
	// falls back to a default well above normal trial-to-trial noise.
	TabuAspirationDelta float64 `json:"tabuAspirationDelta"`

	// --- Tier 2/3 — every field below is opt-in and defaults to false/0,
	// so a caller that doesn't set them gets EXACTLY Tier 1's behaviour.
	// Tier 1 is meant to be landed and measured before these are
	// considered; they're built and available, but off by default for the same
	// "don't stack untested changes" reason the plan itself gives.

	// AdaptiveTrials switches candidate screening from a fixed Trials
	// sample to racing/OCBA-lite (work item D): evaluate the incumbent and
	// a candidate together in small paired batches (RacingMinBatch each),
	// and stop as soon as the paired difference is decisive — clearly a
	// pass, clearly a fail, or clearly can't reach MinDeliveryGain/
	// MinImprovement — rather than always spending the full Trials budget.
	// Falls back to using the full Trials budget (identical to the
	// non-adaptive result) whenever a candidate never becomes decisive.
	// See racingCompare.
	AdaptiveTrials bool `json:"adaptiveTrials"`
	// RacingMinBatch is how many paired trials are run before EACH
	// decisiveness check — too small and the early stderr estimate is
	// itself noise; too large and racing can't save much over the fixed
	// budget. <= 0 falls back to 5 (the plan's own "run 5 trials" figure).
	RacingMinBatch int `json:"racingMinBatch"`
	// RacingZThreshold is the z-score a paired difference's confidence
	// bound must clear to count as "decisive" — 1.64 (~90% one-sided) by
	// default. Lower values stop earlier (cheaper, noisier decisions);
	// higher values are more conservative (closer to always using the
	// full Trials budget). <= 0 falls back to 1.64.
	RacingZThreshold float64 `json:"racingZThreshold"`

	// LateAcceptance enables Late Acceptance Hill Climbing (work item E)
	// as a FALLBACK, tried only in a round where nothing passes the
	// normal strict screening (see optimizeAccepts): the single screened
	// candidate with the lowest contention is accepted anyway if it
	// doesn't breach the delivery floor/tolerance AND its contention is
	// no worse than what the search was already at
	// LateAcceptanceHistoryLength rounds ago. This is what lets the
	// search take a temporary, contention-neutral-or-better step sideways
	// to escape a local optimum instead of just declaring staleness — the
	// delivery-first safety gate is never loosened, only the "must beat
	// the immediately preceding round" requirement is.
	LateAcceptance bool `json:"lateAcceptance"`
	// LateAcceptanceHistoryLength (L) is how many rounds back the
	// candidate's contention is compared against. <= 0 falls back to 20.
	LateAcceptanceHistoryLength int `json:"lateAcceptanceHistoryLength"`

	// SPSAWarmStart runs Simultaneous Perturbation Stochastic
	// Approximation (work item F) ONCE, on the very first OptimizeStep
	// call, before the normal round loop begins — perturbing every node's
	// txDelayFactor at once to find a promising starting region cheaply
	// (2 evaluations per iteration, regardless of node count). The plan's
	// own documented objection to SPSA is that its own output is diffuse
	// ("everything moved a little"), the opposite of the actionable
	// per-repeater output this tool exists to produce — so its result is
	// used ONLY as a warm-started CurrentPolicy for the normal tabu/top-K
	// loop to refine from, and is never itself reported as a named
	// per-node deviation (see spsaWarmStart's own doc comment). Adopted
	// only if it doesn't breach the same delivery floor every other move
	// in this file respects.
	SPSAWarmStart bool `json:"spsaWarmStart"`
	// SPSAIterations bounds the warm-start's own cost at 2*SPSAIterations
	// evaluations, keeping the first OptimizeStep call a bounded chunk
	// even with this enabled (see OptimizeStep's own chunking contract).
	// <= 0 falls back to 10.
	SPSAIterations int `json:"spsaIterations"`

	// LearnedWeights lets generateOptimizeCandidates' own ranking use
	// weights that adapt round over round instead of the fixed
	// equal-weighted nodeContentionScore (work item G) — see
	// ContentionWeights' own doc comment for the deliberately narrow
	// blast radius (ranking only, never acceptance thresholds).
	LearnedWeights bool `json:"learnedWeights"`

	// HoldoutSeed/HoldoutTrials are for OptimizeValidate, called once
	// after the loop stops — hold-out validation over a seed range the
	// search itself never touches,
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
	// users — it's categorically riskier than the delay knobs because it
	// changes WHETHER
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
	// moveKindSPSAWarmStart marks the ONE special history row an SPSA
	// warm start (work item F) produces — never a per-node
	// OptimizeDeviation, see spsaWarmStart's own doc comment.
	moveKindSPSAWarmStart = "spsa_warm_start"
)

// spsaWarmStartTargetNode is OptimizeRound.TargetNode's sentinel for the
// SPSA warm-start row — distinct from -1 ("no candidates were available
// this round") since this is a genuinely different situation: every node
// was touched at once, not none.
const spsaWarmStartTargetNode = -2

// OptimizeDeviation records one accepted targeted adjustment — the
// per-repeater "why" the UI shows alongside the resulting action list:
// which repeaters deviate from the base policy, and why.
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
	// This change-triggered clearing is NOT standard tabu-search practice
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

	// ContentionWeights is the current (possibly learned — work item G,
	// only when OptimizeRequest.LearnedWeights is set) ranking weight
	// vector. Always populated from Initialized onward, even when
	// learning is disabled, so every downstream call site has one real
	// value to read rather than needing an "is this even set" branch.
	ContentionWeights ContentionWeights `json:"contentionWeights"`

	// CostHistory is Late Acceptance Hill Climbing's own ring buffer of
	// past normalized contention scores (work item E) — only populated
	// when OptimizeRequest.LateAcceptance is set. Length
	// LateAcceptanceHistoryLength once initialized; indexed by
	// `Round % len(CostHistory)`.
	CostHistory []float64 `json:"costHistory,omitempty"`
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
	if req.RacingMinBatch < 1 {
		req.RacingMinBatch = 5
	}
	if req.RacingZThreshold <= 0 {
		req.RacingZThreshold = 1.64
	}
	if req.LateAcceptanceHistoryLength <= 0 {
		req.LateAcceptanceHistoryLength = 20
	}
	if req.SPSAIterations <= 0 {
		req.SPSAIterations = 10
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

// evaluateOneTrial runs exactly one simulation trial of an already-
// policy-applied scenario, at a given (seed, trial) pair — the shared
// building block evaluateAverageOptimize sums over, and that racingCompare
// also uses
// directly, since racing needs each trial's own value, not just a running
// sum. Takes the scenario with policy ALREADY applied so a multi-trial
// caller doesn't re-run applyPolicyToScenario on every trial.
func evaluateOneTrial(applied Scenario, messages []Message, maxSimTimeMs uint32, seed uint64, trial int) (delivery, collision float64, stats []NodeStats) {
	rng := rand.New(rand.NewPCG(seed, uint64(trial)))
	report := Run(applied, messages, rng, maxSimTimeMs)
	return report.DeliveryRatio(applied, messages), report.CollisionRate(), report.PerNodeStats(applied, messages)
}

// addNodeStatsInto sums src's own trial-scoped counters into dst — the
// per-trial accumulation both evaluateAverageOptimize and racingCompare
// need, factored out so the two can't drift on which fields actually get
// summed.
func addNodeStatsInto(dst *NodeStats, src NodeStats) {
	dst.SuccessCount += src.SuccessCount
	dst.CollisionCount += src.CollisionCount
	dst.ContentionCaused += src.ContentionCaused
	dst.TxBusyCount += src.TxBusyCount
	dst.DutyAirtimeMs += src.DutyAirtimeMs
	dst.RelayedCount += src.RelayedCount
	dst.RedundantRelays += src.RedundantRelays
	dst.UniqueDeliveries += src.UniqueDeliveries
	dst.DeliveredCount += src.DeliveredCount
	dst.ReachableCount += src.ReachableCount
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
		d, c, trialStats := evaluateOneTrial(applied, messages, maxSimTimeMs, seed, trial)
		totalDelivery += d
		totalCollision += c
		// Summed across trials, NOT averaged — see this function's own
		// note in OptimizeStep on why raw totals are used for ranking
		// (relative order is unaffected by a constant per-node divisor,
		// and integer NodeStats fields would lose real signal to
		// truncation if divided here).
		for i := range trialStats {
			if i >= len(sums) {
				continue
			}
			addNodeStatsInto(&sums[i], trialStats[i])
		}
	}
	return totalDelivery / float64(trials), totalCollision / float64(trials), sums
}

// racingResult is one side (incumbent or candidate) of a racingCompare —
// the normalized delivery/collision/contention plus the raw per-node
// stat sums, over however many trials racing actually used.
type racingResult struct {
	delivery, collision, contention float64
	stats                           []NodeStats
	trials                          int
}

// racingCompare implements adaptive trial budgeting / racing ("OCBA-lite"):
// incumbent and candidate are evaluated together, trial by trial, using
// COMMON RANDOM NUMBERS (the same (seed, trial) pair for both — the same
// pairing discipline every other comparison in this file already uses),
// in batches of RacingMinBatch. After each batch, the paired delivery
// difference and paired contention difference are checked — via a
// normal-approximation confidence bound on their running mean — against
// the same three verdicts optimizeAccepts itself distinguishes: a
// decisively real delivery win, a decisive failure of both acceptance
// paths, or a decisive delivery-neutral contention win. The moment any of
// those clears its threshold, evaluation stops early — "same wall-clock
// budget buys substantially more decisions" per the plan's own framing.
// If nothing ever becomes decisive, the full req.Trials budget runs, so
// racing can never be LESS thorough than the fixed-budget path, only
// faster when the call is easy.
//
// Deliberately independent of nodeContentionScore/ContentionWeights
// (work item G): racing's own decisiveness check always uses the FIXED
// equal-weighted scale (via normalizedContentionScore), for the same
// reason optimizeAccepts' own thresholds do — MinImprovement and
// DeliveryTolerance are calibrated against that fixed scale, and mixing
// in a round-to-round-adapting weight vector here would make "decisive"
// mean something different depending on how much learning has drifted.
func racingCompare(req OptimizeRequest, attrs []NodeAttrs, incumbentPolicy, candidatePolicy ConfigPolicy, seed uint64) (inc, cand racingResult, decisive bool) {
	appliedInc := applyPolicyToScenario(req.Scenario, attrs, incumbentPolicy)
	appliedCand := applyPolicyToScenario(req.Scenario, attrs, candidatePolicy)

	incSums := make([]NodeStats, len(appliedInc.Nodes))
	candSums := make([]NodeStats, len(appliedCand.Nodes))
	for i := range incSums {
		incSums[i].Node = i
	}
	for i := range candSums {
		candSums[i].Node = i
	}

	var incDeliverySum, candDeliverySum, incCollisionSum, candCollisionSum float64
	var n int
	// Welford's online mean/variance for the paired delivery difference
	// (candidate - incumbent) and the paired contention difference
	// (incumbent - candidate; positive means the candidate improved).
	var deliveryDiffMean, deliveryDiffM2 float64
	var contentionDiffMean, contentionDiffM2 float64

	maxTrials := req.Trials
	trial := 0
	for trial < maxTrials {
		batchEnd := trial + req.RacingMinBatch
		if batchEnd > maxTrials {
			batchEnd = maxTrials
		}
		for ; trial < batchEnd; trial++ {
			incD, incC, incStats := evaluateOneTrial(appliedInc, req.Messages, req.MaxSimTimeMs, seed, trial)
			candD, candC, candStats := evaluateOneTrial(appliedCand, req.Messages, req.MaxSimTimeMs, seed, trial)
			incDeliverySum += incD
			candDeliverySum += candD
			incCollisionSum += incC
			candCollisionSum += candC
			for i := range incSums {
				if i < len(incStats) {
					addNodeStatsInto(&incSums[i], incStats[i])
				}
			}
			for i := range candSums {
				if i < len(candStats) {
					addNodeStatsInto(&candSums[i], candStats[i])
				}
			}

			incContentionTrial := normalizedContentionScore(incStats, req.MaxSimTimeMs, 1)
			candContentionTrial := normalizedContentionScore(candStats, req.MaxSimTimeMs, 1)

			n++
			deliveryDelta := candD - incD
			dMeanDelta := deliveryDelta - deliveryDiffMean
			deliveryDiffMean += dMeanDelta / float64(n)
			deliveryDiffM2 += dMeanDelta * (deliveryDelta - deliveryDiffMean)

			contentionDelta := incContentionTrial - candContentionTrial
			cMeanDelta := contentionDelta - contentionDiffMean
			contentionDiffMean += cMeanDelta / float64(n)
			contentionDiffM2 += cMeanDelta * (contentionDelta - contentionDiffMean)
		}

		if n >= 2 {
			deliveryStderr := math.Sqrt(deliveryDiffM2 / float64(n-1) / float64(n))
			contentionStderr := math.Sqrt(contentionDiffM2 / float64(n-1) / float64(n))
			z := req.RacingZThreshold
			lowerDelivery := deliveryDiffMean - z*deliveryStderr
			upperDelivery := deliveryDiffMean + z*deliveryStderr
			lowerContention := contentionDiffMean - z*contentionStderr

			switch {
			case lowerDelivery >= req.MinDeliveryGain:
				decisive = true // clearly a real delivery win
			case upperDelivery < -req.DeliveryTolerance:
				decisive = true // clearly fails both acceptance paths
			case lowerContention > req.MinImprovement && lowerDelivery >= -req.DeliveryTolerance:
				decisive = true // clearly a delivery-neutral contention win
			}
			if decisive {
				break
			}
		}
	}
	if n < 1 {
		n = 1 // defensive only — optimizeDefaults already guarantees req.Trials >= 1
	}

	inc = racingResult{delivery: incDeliverySum / float64(n), collision: incCollisionSum / float64(n), stats: incSums, trials: n}
	cand = racingResult{delivery: candDeliverySum / float64(n), collision: candCollisionSum / float64(n), stats: candSums, trials: n}
	inc.contention = normalizedContentionScore(incSums, req.MaxSimTimeMs, n)
	cand.contention = normalizedContentionScore(candSums, req.MaxSimTimeMs, n)
	return inc, cand, decisive
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

// buildNodeSnapshot assembles the full per-repeater table — EVERY node,
// not just the adjusted ones, since "which repeaters are causing the most
// contention" is only answerable by seeing them all ranked together.
// stats must be the summed-across-trials NodeStats
// evaluateAverageOptimize returns, with trials passed alongside so
// per-trial averages can be recovered where that matters.
func buildNodeSnapshot(req OptimizeRequest, attrs []NodeAttrs, policy ConfigPolicy, stats []NodeStats, trials int, adjustedNodes map[int]bool, tabooedNodes map[int]bool, weights ContentionWeights) []OptimizeNodeSnapshot {
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
			ContentionScore: weightedContentionScore(s, req.MaxSimTimeMs, weights) / float64(trials),
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

// optimizeAcceptsLAHC is Late Acceptance Hill Climbing's own acceptance
// rule — used ONLY as
// a fallback in a round where optimizeAccepts found nothing to accept
// against the immediately-preceding round (see OptimizeStep's own LAHC
// fallback block). The delivery floor (MaxDeliveryRegression) and the
// "must not cost more than DeliveryTolerance versus the CURRENT round"
// requirement are both preserved unchanged from optimizeAccepts — LAHC
// never loosens the safety gate, only the "must also beat the immediately
// preceding round's contention" requirement, which it replaces with
// "must not be worse than historicalContention" (the contention
// LateAcceptanceHistoryLength rounds ago). This is the classic LAHC
// comparison (candidate cost <= history[i mod L]) adapted to this file's
// multi-criterion, delivery-gated setting — it's what lets a temporarily
// worse-than-current, but historically fine, move through, which is the
// whole point: escaping a local optimum optimizeAccepts alone cannot.
func optimizeAcceptsLAHC(req OptimizeRequest, baselineDelivery, currentDelivery, candidateDelivery, candidateContention, historicalContention float64) bool {
	if candidateDelivery < baselineDelivery-req.MaxDeliveryRegression {
		return false
	}
	if candidateDelivery < currentDelivery-req.DeliveryTolerance {
		return false
	}
	return candidateContention <= historicalContention
}

// advanceLateAcceptanceHistory pushes this round's own resulting
// contention into the LAHC ring buffer (work item E) — standard LAHC
// bookkeeping, run unconditionally once per round (whether or not a move
// was accepted this round, and regardless of whether it was accepted via
// the strict path or the LAHC fallback) whenever LateAcceptance is
// enabled. A no-op otherwise.
func advanceLateAcceptanceHistory(req OptimizeRequest, state *OptimizeState) {
	if !req.LateAcceptance || len(state.CostHistory) == 0 {
		return
	}
	state.CostHistory[state.Round%len(state.CostHistory)] = state.CurrentContention
}

// optimizeWeightLearningRate/optimizeWeightMin/optimizeWeightMax bound
// work item G's online weight update — small enough that one round's own
// (noisy) outcome nudges the ranking weights without letting a single
// result swing them wildly, and clamped rather than renormalized, since
// candidate RANKING only depends on relative proportions between the four
// weights — a uniform positive rescale can never change which node ranks
// highest, so there's no need to fight the clamp back to a fixed sum.
const (
	optimizeWeightLearningRate = 0.05
	optimizeWeightMin          = 0.1
	optimizeWeightMax          = 5.0
)

// updateContentionWeights is work item G's online learning step — after
// each round's screening, every back-off-kind candidate (tx_delay_backoff/
// rx_delay_backoff/flood_max_reduce; speed-up candidates are driven by
// nodeSpeedupScore, an unrelated ranking, and have nothing to teach these
// weights) is a training example: the four raw contention components that
// made this node rank highly, paired with the REAL delivery outcome
// actually observed when the move was tried. Each component's weight
// moves toward components that were large on good-outcome candidates and
// away from components large on bad-outcome ones — grounded in delivery
// (the real objective), not in the contention score itself, per this
// file's own standing "don't optimize contention directly" rule.
func updateContentionWeights(weights ContentionWeights, results []optimizeScreenResult, currentStats []NodeStats, maxSimTimeMs uint32) ContentionWeights {
	clamp := func(v float64) float64 {
		if v < optimizeWeightMin {
			return optimizeWeightMin
		}
		if v > optimizeWeightMax {
			return optimizeWeightMax
		}
		return v
	}
	for _, r := range results {
		switch r.c.kind {
		case moveKindTxBackoff, moveKindRxBackoff, moveKindFloodMaxReduce:
		default:
			continue
		}
		if r.c.node < 0 || r.c.node >= len(currentStats) {
			continue
		}
		raw := contentionComponents(currentStats[r.c.node], maxSimTimeMs)
		total := raw[0] + raw[1] + raw[2] + raw[3]
		if total <= 0 {
			continue
		}
		reward := r.deliveryGain
		weights.ContentionCaused = clamp(weights.ContentionCaused + optimizeWeightLearningRate*reward*(raw[0]/total))
		weights.CollisionCount = clamp(weights.CollisionCount + optimizeWeightLearningRate*reward*(raw[1]/total))
		weights.RedundantRelays = clamp(weights.RedundantRelays + optimizeWeightLearningRate*reward*(raw[2]/total))
		weights.DutyPct = clamp(weights.DutyPct + optimizeWeightLearningRate*reward*(raw[3]/total))
	}
	return weights
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

// OptimizeStep does ONE bounded unit of work — either measuring the
// starting baseline (the very first call, state.Initialized == false) or
// running one full round of the top-K, tabu-aware search (every call
// after). This resumable-chunk design is what makes real cancellation
// possible: `self.onmessage` can't fire
// while a synchronous WASM call runs, so a single call that searched to
// completion could never be cancelled mid-search. A caller (public/
// simulator.js) drives the whole optimization by calling this repeatedly,
// feeding each return value back in as the next call's state, and can
// simply STOP calling it — checking for cancellation between calls,
// updating a progress UI with real per-round numbers, and terminating the
// worker as a hard backstop if a call somehow still hangs.
//
// One round:
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
		// The TRUE baseline — before any adjustment, including the SPSA
		// warm start below — measured first and kept in
		// BaselineDelivery/BaselineContention for the whole run, so "how
		// much did the whole process help" always has an honest zero
		// point regardless of which Tier 2/3 features are enabled.
		delivery, collision, stats := evaluateAverageOptimize(req.Scenario, attrs, req.BasePolicy, req.Messages, req.MaxSimTimeMs, req.Trials, req.Seed)
		contention := normalizedContentionScore(stats, req.MaxSimTimeMs, req.Trials)

		currentPolicy := req.BasePolicy
		currentDelivery, currentCollision, currentContention := delivery, collision, contention
		snapshotStats := stats
		history := []OptimizeRound{}

		if req.SPSAWarmStart {
			// See spsaWarmStart's own doc comment for why its result is
			// adopted-or-discarded here as a single all-or-nothing step,
			// never reported as per-node deviations.
			warmPolicy := spsaWarmStart(req, attrs, req.BasePolicy, req.Seed)
			warmDelivery, warmCollision, warmStats := evaluateAverageOptimize(req.Scenario, attrs, warmPolicy, req.Messages, req.MaxSimTimeMs, req.Trials, req.Seed+0x5254a5)
			warmContention := normalizedContentionScore(warmStats, req.MaxSimTimeMs, req.Trials)
			adopted := optimizeAccepts(req, delivery, delivery, contention, warmDelivery, warmContention)
			if adopted {
				currentPolicy = warmPolicy
				currentDelivery, currentCollision, currentContention = warmDelivery, warmCollision, warmContention
				snapshotStats = warmStats
			}
			history = append(history, OptimizeRound{
				Round: 0, Delivery: currentDelivery, Collision: currentCollision, Contention: currentContention,
				TargetNode: spsaWarmStartTargetNode, MoveKind: moveKindSPSAWarmStart, Accepted: adopted, CandidatesTried: req.SPSAIterations,
			})
		}

		weights := defaultContentionWeights()
		var costHistory []float64
		if req.LateAcceptance {
			// Seeded with the (possibly SPSA-adjusted) starting
			// contention repeated L times — standard LAHC initialization,
			// so the very first rounds aren't comparing against an
			// artificial zero.
			costHistory = make([]float64, req.LateAcceptanceHistoryLength)
			for i := range costHistory {
				costHistory[i] = currentContention
			}
		}

		return OptimizeState{
			Initialized:        true,
			CurrentPolicy:      currentPolicy,
			CurrentDelivery:    currentDelivery,
			CurrentCollision:   currentCollision,
			CurrentContention:  currentContention,
			BaselineDelivery:   delivery,
			BaselineContention: contention,
			Deviations:         []OptimizeDeviation{},
			History:            history,
			TabuList:           []OptimizeTabuEntry{},
			NodeSnapshot:       buildNodeSnapshot(req, attrs, currentPolicy, snapshotStats, req.Trials, nil, nil, weights),
			ContentionWeights:  weights,
			CostHistory:        costHistory,
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
	// originally accepted ZERO moves on any real-sized network.
	roundSeed := req.Seed + uint64(state.Round)*1_000_003
	currentDelivery, currentCollision, currentStats := evaluateAverageOptimize(req.Scenario, attrs, state.CurrentPolicy, req.Messages, req.MaxSimTimeMs, req.Trials, roundSeed)
	currentContention := normalizedContentionScore(currentStats, req.MaxSimTimeMs, req.Trials)

	// Defensive against a zero-value ContentionWeights (an old/foreign
	// state that predates this field, or simply never round-tripped
	// through the Initialized branch) — a zero weight vector would make
	// EVERY node's ranking score 0, silently producing zero backoff
	// candidates every round. resolveContentionWeights guarantees a real,
	// usable vector regardless.
	weights := resolveContentionWeights(state.ContentionWeights)
	state.ContentionWeights = weights

	state.TabuList = pruneExpiredTabuEntries(state.TabuList, state.Round)
	candidates := generateOptimizeCandidates(req, state, attrs, currentStats, moveSet, weights)

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
		state.NodeSnapshot = buildNodeSnapshot(req, attrs, state.CurrentPolicy, currentStats, req.Trials, adjustedNodes, tabooed, weights)
		if currentContention <= 0 {
			state.Done = true
			state.DoneReason = "converged — no node shows any contention or delivery-shortfall signal left"
		} else {
			advanceLateAcceptanceHistory(req, &state)
			optimizeCheckStopping(req, &state)
		}
		return state
	}

	// Screen every surviving candidate — cheap (Trials, or fewer if
	// AdaptiveTrials/racing decides early — work item D), each paired
	// against the SAME roundSeed incumbent measurement above (racing
	// re-measures its OWN paired incumbent sample per candidate; see
	// racingCompare's own doc comment on why that's still consistent).
	results := make([]optimizeScreenResult, len(candidates))
	for i, c := range candidates {
		if req.AdaptiveTrials {
			inc, cnd, _ := racingCompare(req, attrs, state.CurrentPolicy, c.policy, roundSeed)
			results[i] = optimizeScreenResult{
				c: c, delivery: cnd.delivery, collision: cnd.collision, contention: cnd.contention,
				deliveryGain:   cnd.delivery - inc.delivery,
				contentionGain: inc.contention - cnd.contention,
				passed:         optimizeAccepts(req, state.BaselineDelivery, inc.delivery, inc.contention, cnd.delivery, cnd.contention),
			}
			continue
		}
		d, col, stats := evaluateAverageOptimize(req.Scenario, attrs, c.policy, req.Messages, req.MaxSimTimeMs, req.Trials, roundSeed)
		cont := normalizedContentionScore(stats, req.MaxSimTimeMs, req.Trials)
		results[i] = optimizeScreenResult{
			c: c, delivery: d, collision: col, contention: cont,
			deliveryGain:   d - currentDelivery,
			contentionGain: currentContention - cont,
			passed:         optimizeAccepts(req, state.BaselineDelivery, currentDelivery, currentContention, d, cont),
		}
	}

	// Work item G — online weight learning, from this round's own
	// screening outcomes, before ranking is used again next round.
	if req.LearnedWeights {
		weights = updateContentionWeights(weights, results, currentStats, req.MaxSimTimeMs)
		state.ContentionWeights = weights
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

	// Work item E — Late Acceptance Hill Climbing fallback: only tried
	// when the strict path above found NOTHING to accept this round.
	// Picks the single screened candidate with the lowest contention
	// (regardless of whether it passed the strict gate) and accepts it
	// anyway if it clears the same delivery floor/tolerance AND is no
	// worse than the search's own contention LateAcceptanceHistoryLength
	// rounds ago — see optimizeAcceptsLAHC's own doc comment. This is
	// what lets the search escape a local optimum the strict, accept-
	// only gate cannot.
	lahcChosen := false
	var lahcHistoricalContention float64
	if bestIdx < 0 && req.LateAcceptance && len(results) > 0 && len(state.CostHistory) > 0 {
		lahcIdx := 0
		for i := 1; i < len(results); i++ {
			if results[i].contention < results[lahcIdx].contention {
				lahcIdx = i
			}
		}
		lahcHistoricalContention = state.CostHistory[state.Round%len(state.CostHistory)]
		if optimizeAcceptsLAHC(req, state.BaselineDelivery, currentDelivery, results[lahcIdx].delivery, results[lahcIdx].contention, lahcHistoricalContention) {
			bestIdx = lahcIdx
			lahcChosen = true
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
		// A candidate chosen via the LAHC fallback is confirmed against
		// the SAME LAHC rule it was screened with — confirming it against
		// the strict rule instead would almost always just reject it
		// again, defeating the entire point of the fallback.
		confirmPassed := optimizeAccepts(req, state.BaselineDelivery, baseDelivery, baseContention, confirmDelivery, confirmContention)
		if lahcChosen {
			confirmPassed = optimizeAcceptsLAHC(req, state.BaselineDelivery, baseDelivery, confirmDelivery, confirmContention, lahcHistoricalContention)
		}
		if confirmPassed {
			accepted = true
			state.CurrentPolicy = chosen.policy
			state.CurrentDelivery = confirmDelivery
			state.CurrentCollision = confirmCollision
			state.CurrentContention = confirmContention
			state.TabuList = clearTabuFor(state.TabuList, chosen.node, chosen.kind)
			state.Deviations = append(state.Deviations, OptimizeDeviation{
				Node: chosen.node, Kind: chosen.kind, Reason: chosen.reason,
				OldValue: chosen.oldValue, NewValue: chosen.newValue, Round: state.Round, Warning: chosen.warning,
			})
			if !lahcChosen {
				state.StaleRounds = 0
			}
			// A LAHC-accepted move (lahcChosen) deliberately does NOT
			// reset StaleRounds here — see the combined increment below.
			// LAHC's own "<=" comparison (see optimizeAcceptsLAHC's own
			// doc comment — standard LAHC practice, not a bug, allows
			// crossing a plateau) means that once contention has genuinely
			// plateaued, candidateContention <= historicalContention holds
			// almost trivially, round after round, for whatever candidate
			// the deterministic ranking proposes next. Resetting
			// staleness on every such "acceptance" was observed, live,
			// to let a run burn its ENTIRE round budget accepting a
			// sequence of indistinguishable-from-no-op lateral moves on
			// the same node, never once correctly reporting itself as
			// stuck. Counting a LAHC accept the same as a rejection for
			// staleness purposes (while still keeping the move itself —
			// it's a real, if lateral, step) fixes that: a long run of
			// pure lateral moves still eventually trips the stale-rounds
			// limit, exactly as a long run of pure rejections would.
		} else {
			state.TabuList = tabuOne(state.TabuList, chosen.node, chosen.kind, tabuExpiry, nodeContentionScore(currentStats[chosen.node], req.MaxSimTimeMs))
		}
	}

	if !accepted || lahcChosen {
		state.StaleRounds++
	}
	if !accepted {
		// Keep the reported figures tracking the freshly-measured
		// incumbent even on a rejected round, so a UI reading
		// CurrentDelivery/CurrentContention shows this round's own real
		// measurement rather than a stale value frozen since the last
		// acceptance.
		state.CurrentDelivery = currentDelivery
		state.CurrentCollision = currentCollision
		state.CurrentContention = currentContention
	}
	advanceLateAcceptanceHistory(req, &state)

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
	state.NodeSnapshot = buildNodeSnapshot(req, attrs, state.CurrentPolicy, snapshotStats, snapshotTrials, adjustedNodes, tabooed, weights)

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
// never drew from — hold-out validation, guarding against a long greedy
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
