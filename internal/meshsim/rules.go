package meshsim

// NodeAttrs holds real-world per-node properties that a ConfigRule can key
// off — altitude and observed neighbour count, per the requirement to
// support rules like "increase delays for repeaters above/below a given
// altitude, or with more than N neighbours." Not used by the simulation
// engine itself (Run only cares about Scenario/Link/NodePrefs); this is
// purely an input to rule-based config suggestion.
type NodeAttrs struct {
	AltitudeM     float64 `json:"altitudeM"`
	NeighborCount int     `json:"neighborCount"`
	// IsArticulation/MarginalCoverage (item 15c) are topology-only —
	// always computable from a Scenario's own link graph, see
	// computeTopologyAttrs. SuggestPolicy recomputes both itself rather
	// than trusting a caller-supplied value; Suggest (the older,
	// ConfigRule-based search) never reads either field, so leaving them
	// at their zero value there is harmless.
	IsArticulation   bool `json:"isArticulation,omitempty"`
	MarginalCoverage int  `json:"marginalCoverage,omitempty"`
}

// RuleConditionKind is a closed set of comparisons a RuleCondition can test
// a node's NodeAttrs against — deliberately not an arbitrary predicate
// function, so a ConfigRule (and therefore a Suggestion) is JSON-
// serializable end-to-end. This is what crosses the WASM boundary to the
// browser UI, and a Go func value can't cross that boundary.
type RuleConditionKind string

const (
	ConditionNone             RuleConditionKind = ""
	ConditionAltitudeAtLeast  RuleConditionKind = "altitude_at_least_m"
	ConditionAltitudeAtMost   RuleConditionKind = "altitude_at_most_m"
	ConditionNeighborsAtLeast RuleConditionKind = "neighbors_at_least"
	// ConditionNeighborsAtMost, ConditionIsArticulation and
	// ConditionMarginalCoverageAtLeast back the topology-keyed models
	// (sparse-slow/edge-first, articulation-first, mpr/coverage-gain
	// respectively).
	ConditionNeighborsAtMost         RuleConditionKind = "neighbors_at_most"
	ConditionIsArticulation          RuleConditionKind = "is_articulation"
	ConditionMarginalCoverageAtLeast RuleConditionKind = "marginal_coverage_at_least"
	// ConditionNodeIndexIn matches an explicit set of node indices (RuleCondition.Nodes)
	// rather than any measurable attribute — what the measurement-driven
	// models (redundancy-suppress, airtime-aware) and the adaptive
	// optimizer both need: targeting the SPECIFIC repeaters a prior run
	// identified as offenders, not "every node above/below some
	// threshold." Node identity isn't part of NodeAttrs, so this Kind
	// can't be evaluated by matches(NodeAttrs) at all — see matchesNode,
	// the only place it's actually checked. An EMPTY Nodes list matches
	// NOTHING, deliberately — the dangerous-looking default for a
	// condition whose whole point is "these specific nodes and no
	// others," not silently falling back to "everyone."
	ConditionNodeIndexIn RuleConditionKind = "node_index_in"
)

// RuleCondition is the zero-or-one comparison a ConfigRule gates on. The
// zero value (Kind == ConditionNone) matches every node — used to express
// a global, non-conditional override.
type RuleCondition struct {
	Kind      RuleConditionKind `json:"kind"`
	Threshold float64           `json:"threshold,omitempty"`
	// Nodes lists the explicit node indices this condition matches when
	// Kind is ConditionNodeIndexIn — every other Kind ignores this field.
	// Indices are only meaningful against the exact Scenario.Nodes slice
	// they were computed against; see AssignPolicy's own doc comment for
	// the guard against reapplying one to a different node list.
	Nodes []int `json:"nodes,omitempty"`
}

func (c RuleCondition) matches(a NodeAttrs) bool {
	switch c.Kind {
	case ConditionNone:
		return true
	case ConditionAltitudeAtLeast:
		return a.AltitudeM >= c.Threshold
	case ConditionAltitudeAtMost:
		return a.AltitudeM <= c.Threshold
	case ConditionNeighborsAtLeast:
		return float64(a.NeighborCount) >= c.Threshold
	case ConditionNeighborsAtMost:
		return float64(a.NeighborCount) <= c.Threshold
	case ConditionIsArticulation:
		return a.IsArticulation
	case ConditionMarginalCoverageAtLeast:
		return float64(a.MarginalCoverage) >= c.Threshold
	// ConditionNodeIndexIn deliberately falls through to default: node
	// identity isn't part of NodeAttrs, so this Kind can never be
	// evaluated here — only matchesNode can test it. Any caller that
	// still routes a ConditionNodeIndexIn rule through plain matches()
	// (the legacy Suggest/applyRuleToScenario path, which phase 4 never
	// touches) gets "matches nothing" rather than a panic or a silent
	// "matches everyone" — both of which would be worse for a rule kind
	// whose entire meaning depends on the index it never got told.
	default:
		return false
	}
}

// matchesNode is matches' node-index-aware counterpart — the only place
// ConditionNodeIndexIn (see its own doc comment) can actually be
// evaluated, since it tests node IDENTITY, not any NodeAttrs field. Every
// other Kind delegates to matches unchanged, so this is a strict
// superset — safe to use everywhere matches was used before, and phase 4
// uses it in applyPolicyToScenario/AssignPolicy for exactly that reason.
func (c RuleCondition) matchesNode(index int, a NodeAttrs) bool {
	if c.Kind == ConditionNodeIndexIn {
		for _, n := range c.Nodes {
			if n == index {
				return true
			}
		}
		return false
	}
	return c.matches(a)
}

// RuleScaleAttr is which NodeAttrs field a RuleScale reads — deliberately a
// closed set (like RuleConditionKind) rather than a func, for the same
// WASM-JSON-boundary reason.
type RuleScaleAttr string

const (
	ScaleByNeighborCount    RuleScaleAttr = "neighbor_count"
	ScaleByAltitude         RuleScaleAttr = "altitude_m"
	ScaleByMarginalCoverage RuleScaleAttr = "marginal_coverage"
)

// RuleScale makes a ConfigRule's TxDelayFactor a continuous function of a
// node attribute instead of a constant — closing the `degree-proportional`
// gap left by RuleCondition's own Kind+Threshold shape, which has no way to
// express a continuous function, only a step. Reads as one sentence ("txdelay 0.25
// at 1 neighbour rising to 1.0 at 12+"), unlike a per-node table.
//
// Linear interpolation between (AtMin, ValueAtMin) and (AtMax, ValueAtMax),
// clamped outside that range. AtMin > AtMax is valid (a descending
// attribute range) and interpolates correctly; AtMin == AtMax returns
// ValueAtMin rather than dividing by zero. Swapping ValueAtMin/ValueAtMax
// (not AtMin/AtMax) is the intended way to express a model's inverse —
// e.g. `degree-proportional` vs its own inverse.
type RuleScale struct {
	Attr       RuleScaleAttr `json:"attr"`
	AtMin      float64       `json:"atMin"`
	AtMax      float64       `json:"atMax"`
	ValueAtMin float64       `json:"valueAtMin"`
	ValueAtMax float64       `json:"valueAtMax"`
}

// valueAt linearly interpolates x within [AtMin, AtMax] into
// [ValueAtMin, ValueAtMax], clamped at both ends.
func (s RuleScale) valueAt(x float64) float64 {
	if s.AtMax == s.AtMin {
		return s.ValueAtMin
	}
	t := (x - s.AtMin) / (s.AtMax - s.AtMin)
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	return s.ValueAtMin + t*(s.ValueAtMax-s.ValueAtMin)
}

// scaleAttrValue reads the NodeAttrs field a RuleScale names. The bool is
// false for an unrecognized Attr, so a typo'd/future attribute name fails
// closed (ApplyWithAttrs leaves TxDelayFactor at whatever Apply already
// set) rather than silently reading a zero value as if it meant something.
func scaleAttrValue(attr RuleScaleAttr, a NodeAttrs) (float64, bool) {
	switch attr {
	case ScaleByNeighborCount:
		return float64(a.NeighborCount), true
	case ScaleByAltitude:
		return a.AltitudeM, true
	case ScaleByMarginalCoverage:
		return float64(a.MarginalCoverage), true
	default:
		return 0, false
	}
}

// ConfigRule is one "nodes matching Condition get these overrides" rule. A
// nil override field leaves that NodePrefs field at its baseline value.
// Rules exist so a suggestion is expressible as something a human can read
// and apply ("repeaters above 600m: txdelay 1.0, rxdelay 5"), not just an
// opaque per-node table.
type ConfigRule struct {
	Name      string        `json:"name"`
	Condition RuleCondition `json:"condition"`

	TxDelayFactor       *float64 `json:"txDelayFactor,omitempty"`
	DirectTxDelayFactor *float64 `json:"directTxDelayFactor,omitempty"`
	RxDelayBase         *float64 `json:"rxDelayBase,omitempty"`
	// FloodMax (item 15c's hop-limit-trim model) is a SimNode-level field,
	// not a NodePrefs one, so it's applied separately by
	// applyPolicyToScenario rather than through Apply(NodePrefs) below —
	// Apply/applyRuleToScenario (the older, still-unmodified Suggest path)
	// never reads this field, so leaving it unset there is harmless.
	FloodMax *int `json:"floodMax,omitempty"`
	// Scale, if set, overrides TxDelayFactor with a value computed from a
	// node attribute (see RuleScale) rather than the constant
	// TxDelayFactor field above — the two are mutually exclusive in
	// practice (Scale wins; see ApplyWithAttrs). Only ApplyWithAttrs reads
	// this; the older Apply(NodePrefs) has no NodeAttrs to compute it
	// from, so a Scale-only rule applied via the legacy Suggest path is a
	// no-op there, not an error — Suggest never constructs one.
	Scale *RuleScale `json:"scale,omitempty"`
}

// Matches reports whether attrs satisfies the rule's condition.
func (r ConfigRule) Matches(attrs NodeAttrs) bool {
	return r.Condition.matches(attrs)
}

// MatchesNode is Matches' node-index-aware counterpart — see
// RuleCondition.matchesNode. Required for any rule that might be a
// ConditionNodeIndexIn one; behaviourally identical to Matches for every
// other Kind.
func (r ConfigRule) MatchesNode(index int, attrs NodeAttrs) bool {
	return r.Condition.matchesNode(index, attrs)
}

// Apply returns base with any of the rule's non-nil override fields applied
// on top — base is left unmodified.
func (r ConfigRule) Apply(base NodePrefs) NodePrefs {
	out := base
	if r.TxDelayFactor != nil {
		out.TxDelayFactor = *r.TxDelayFactor
	}
	if r.DirectTxDelayFactor != nil {
		out.DirectTxDelayFactor = *r.DirectTxDelayFactor
	}
	if r.RxDelayBase != nil {
		out.RxDelayBase = *r.RxDelayBase
	}
	return out
}

// ApplyWithAttrs is Apply's counterpart for callers that have a node's own
// NodeAttrs available (phase 4's proportional rules) — everything Apply
// does, plus: if Scale is set and names a recognized attribute (see
// scaleAttrValue), it computes TxDelayFactor from attrs instead of the
// constant TxDelayFactor field. Scale wins over a literal TxDelayFactor if
// both happen to be set on the same rule (not a supported combination in
// practice — phase 4's own model catalogue never sets both — but Scale
// winning, rather than an undefined field order, is the deterministic
// choice). base is left unmodified, same contract as Apply.
func (r ConfigRule) ApplyWithAttrs(base NodePrefs, attrs NodeAttrs) NodePrefs {
	out := r.Apply(base)
	if r.Scale != nil {
		if v, ok := scaleAttrValue(r.Scale.Attr, attrs); ok {
			out.TxDelayFactor = r.Scale.valueAt(v)
		}
	}
	return out
}

// applyRuleToScenario returns a copy of scenario with rule applied to every
// node whose attrs (parallel to scenario.Nodes) match it. attrs may be nil,
// in which case only unconditional (global) rules make sense to apply — any
// rule with a real Condition will match nothing, since there are no attrs
// to test it against.
func applyRuleToScenario(scenario Scenario, attrs []NodeAttrs, rule ConfigRule) Scenario {
	out := Scenario{Links: scenario.Links, Channel: scenario.Channel, Nodes: make([]SimNode, len(scenario.Nodes))}
	copy(out.Nodes, scenario.Nodes)
	for i := range out.Nodes {
		var a NodeAttrs
		if attrs != nil && i < len(attrs) {
			// Guarded like AssignPolicy: a short attrs list from a
			// malformed request must degrade to zero attrs, not panic the
			// whole WASM instance (SIMULATION_REVIEW.md).
			a = attrs[i]
		}
		if rule.Matches(a) {
			out.Nodes[i].Prefs = rule.Apply(out.Nodes[i].Prefs)
		}
	}
	return out
}

// ConfigPolicy is an ORDERED list of ConfigRules — item 15c's generalised
// form of the single ConfigRule Suggest/applyRuleToScenario have always
// used. Later rules override earlier ones on a per-field basis (each
// still only touches the fields it explicitly sets), so a policy can
// express "set a global default, then override a subset" as two rules —
// exactly the composite models (e.g. "score-priority + dense-slow"), which
// a single ConfigRule cannot express at all.
type ConfigPolicy []ConfigRule

// applyPolicyToScenario is ConfigPolicy's counterpart to
// applyRuleToScenario — ConfigRule.Apply(NodePrefs) is reused unchanged for
// every rule's NodePrefs-level overrides (so a single-rule ConfigPolicy
// behaves identically to applyRuleToScenario with that same rule), plus
// FloodMax is applied separately since it lives on SimNode, not NodePrefs.
func applyPolicyToScenario(scenario Scenario, attrs []NodeAttrs, policy ConfigPolicy) Scenario {
	// Channel must be carried through — it governs the reception model
	// (see Scenario.Channel), and the optimizer runs every candidate policy
	// through this; dropping it here would silently evaluate candidates
	// under the legacy hard-threshold/no-fading model even when the caller
	// enabled the probabilistic one.
	out := Scenario{Links: scenario.Links, Channel: scenario.Channel, Nodes: make([]SimNode, len(scenario.Nodes))}
	copy(out.Nodes, scenario.Nodes)
	for i := range out.Nodes {
		var a NodeAttrs
		if attrs != nil && i < len(attrs) {
			// Guarded like AssignPolicy: a short attrs list from a
			// malformed request must degrade to zero attrs, not panic the
			// whole WASM instance (SIMULATION_REVIEW.md).
			a = attrs[i]
		}
		for _, rule := range policy {
			if !rule.MatchesNode(i, a) {
				continue
			}
			out.Nodes[i].Prefs = rule.ApplyWithAttrs(out.Nodes[i].Prefs, a)
			if rule.FloodMax != nil {
				out.Nodes[i].FloodMax = *rule.FloodMax
			}
		}
	}
	return out
}

// AssignPolicy reports, for every node in scenario, which of policy's
// rules matched it (in application order) — the "which tier was this
// repeater labelled" question, which applyPolicyToScenario itself throws
// away (it
// only returns the FINAL Scenario, not which rules got there).
//
// Deliberately returns matched rule INDICES, not a single resolved label:
// a node can legitimately match more than one rule (e.g. a global
// baseline rule AND a tier-specific one), and picking a single winning
// label out of several matches is a presentation decision with real
// ambiguity — callers decide their own convention (phase 4's UI shows the
// last match with a non-empty Name, with the rest in a tooltip) rather
// than that choice being baked into the engine and hidden.
//
// attrs should be the same slice the policy was searched/applied against
// (computeTopologyAttrs plus any altitude data) — a mismatched attrs
// slice (wrong length, or from a different scenario) produces silently
// wrong assignments, same risk as applyPolicyToScenario's own attrs
// parameter, and ConditionNodeIndexIn rules carry this risk furthest:
// node indices are only meaningful against the exact node list they were
// computed against at all. Callers persisting a policy across scenarios
// (a saved setup, an exported CSV) must not blindly reapply a
// ConditionNodeIndexIn rule to a different node list.
func AssignPolicy(scenario Scenario, attrs []NodeAttrs, policy ConfigPolicy) []PolicyAssignment {
	out := make([]PolicyAssignment, len(scenario.Nodes))
	for i := range scenario.Nodes {
		var a NodeAttrs
		if attrs != nil && i < len(attrs) {
			a = attrs[i]
		}
		out[i] = PolicyAssignment{Node: i, MatchedRules: []int{}}
		for ruleIdx, rule := range policy {
			if rule.MatchesNode(i, a) {
				out[i].MatchedRules = append(out[i].MatchedRules, ruleIdx)
			}
		}
	}
	return out
}

// PolicyAssignment records which of a ConfigPolicy's rules matched one
// node, in application order — see AssignPolicy.
type PolicyAssignment struct {
	Node int `json:"node"`
	// MatchedRules is never nil (see AssignPolicy's own initialization),
	// so JSON callers always get "matchedRules":[] for an unmatched node,
	// never "matchedRules":null — same reasoning as Report.Receptions'
	// own doc comment on this exact convention (engine.go).
	MatchedRules []int `json:"matchedRules"`
}
