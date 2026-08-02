package meshsim

// The optimizer's public surface: what a caller configures (OptimizeRequest,
// OptimizeMoveSet) and the resumable state it drives the search with
// (OptimizeState and the per-round records hanging off it). All of it
// marshals to JSON across the WASM boundary, which is why the shapes live
// together and away from the search itself.

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
