package meshsim

// NodeAttrs holds real-world per-node properties that a ConfigRule can key
// off — altitude and observed neighbour count, per the requirement to
// support rules like "increase delays for repeaters above/below a given
// altitude, or with more than N neighbours." Not used by the simulation
// engine itself (Run only cares about Scenario/Link/NodePrefs); this is
// purely an input to rule-based config suggestion.
type NodeAttrs struct {
	AltitudeM     float64
	NeighborCount int
}

// ConfigRule is one "nodes matching Predicate get these overrides" rule. A
// nil override field leaves that NodePrefs field at its baseline value.
// Rules exist so a suggestion is expressible as something a human can read
// and apply ("repeaters above 600m: txdelay 1.0, rxdelay 5"), not just an
// opaque per-node table.
type ConfigRule struct {
	Name      string
	Predicate func(NodeAttrs) bool

	TxDelayFactor       *float64
	DirectTxDelayFactor *float64
	RxDelayBase         *float64
}

// Matches reports whether attrs satisfies the rule's predicate. A nil
// Predicate matches every node — used to express a global (non-conditional)
// override.
func (r ConfigRule) Matches(attrs NodeAttrs) bool {
	if r.Predicate == nil {
		return true
	}
	return r.Predicate(attrs)
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
// in which case only predicate-less (global) rules make sense to apply —
// any rule with a real Predicate will match nothing, since there are no
// attrs to test it against.
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
