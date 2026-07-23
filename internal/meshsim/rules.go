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
