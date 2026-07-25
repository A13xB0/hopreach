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
	// ConditionMarginalCoverageAtLeast were added for item 15c's
	// topology-keyed models (sparse-slow/edge-first, articulation-first,
	// mpr/coverage-gain respectively) — see docs/SIMULATOR_PLAN_PHASE2.md.
	ConditionNeighborsAtMost         RuleConditionKind = "neighbors_at_most"
	ConditionIsArticulation          RuleConditionKind = "is_articulation"
	ConditionMarginalCoverageAtLeast RuleConditionKind = "marginal_coverage_at_least"
)

// RuleCondition is the zero-or-one comparison a ConfigRule gates on. The
// zero value (Kind == ConditionNone) matches every node — used to express
// a global, non-conditional override.
type RuleCondition struct {
	Kind      RuleConditionKind `json:"kind"`
	Threshold float64           `json:"threshold,omitempty"`
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
	default:
		return false
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
}

// Matches reports whether attrs satisfies the rule's condition.
func (r ConfigRule) Matches(attrs NodeAttrs) bool {
	return r.Condition.matches(attrs)
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

// applyRuleToScenario returns a copy of scenario with rule applied to every
// node whose attrs (parallel to scenario.Nodes) match it. attrs may be nil,
// in which case only unconditional (global) rules make sense to apply — any
// rule with a real Condition will match nothing, since there are no attrs
// to test it against.
func applyRuleToScenario(scenario Scenario, attrs []NodeAttrs, rule ConfigRule) Scenario {
	out := Scenario{Links: scenario.Links, Nodes: make([]SimNode, len(scenario.Nodes))}
	copy(out.Nodes, scenario.Nodes)
	for i := range out.Nodes {
		var a NodeAttrs
		if attrs != nil {
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
// exactly the composite models (e.g. "score-priority + dense-slow")
// docs/SIMULATOR_PLAN_PHASE2.md item 15c asks for, which a single
// ConfigRule cannot express at all.
type ConfigPolicy []ConfigRule

// applyPolicyToScenario is ConfigPolicy's counterpart to
// applyRuleToScenario — ConfigRule.Apply(NodePrefs) is reused unchanged for
// every rule's NodePrefs-level overrides (so a single-rule ConfigPolicy
// behaves identically to applyRuleToScenario with that same rule), plus
// FloodMax is applied separately since it lives on SimNode, not NodePrefs.
func applyPolicyToScenario(scenario Scenario, attrs []NodeAttrs, policy ConfigPolicy) Scenario {
	out := Scenario{Links: scenario.Links, Nodes: make([]SimNode, len(scenario.Nodes))}
	copy(out.Nodes, scenario.Nodes)
	for i := range out.Nodes {
		var a NodeAttrs
		if attrs != nil {
			a = attrs[i]
		}
		for _, rule := range policy {
			if !rule.Matches(a) {
				continue
			}
			out.Nodes[i].Prefs = rule.Apply(out.Nodes[i].Prefs)
			if rule.FloodMax != nil {
				out.Nodes[i].FloodMax = *rule.FloodMax
			}
		}
	}
	return out
}
