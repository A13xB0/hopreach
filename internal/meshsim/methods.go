package meshsim

// MeshMethod is a named ConfigPolicy sourced from a real MeshCore
// community's own published tuning convention — "the X method", e.g. the
// Sydney method.
//
// Source is REQUIRED (see BuiltinMeshMethods and its own test) — a
// community-reported convention must never render with the same authority
// as a value verified against real firmware source, which is what every
// OTHER model in this package is. Every value below was read from the
// cited page directly, not from a search-engine summary: summaries
// describing this exact material got MeshSydney's own direction backwards
// twice, both times attributing WNY's numbers to Sydney (see the
// accuracy-warning note on MeshSydney below).
type MeshMethod struct {
	Name   string       `json:"name"`
	Policy ConfigPolicy `json:"policy"`
	// Source is a URL — mandatory, see BuiltinMeshMethods' own test.
	Source string `json:"source"`
	// AsOf is when this method was read from Source — a community
	// convention, unlike firmware behaviour, can change without notice.
	AsOf string `json:"asOf"`
	// Direction states which way this method scales delay, in the same
	// vocabulary this package's own model names already use
	// (hilltop-first/hilltop-last/dense-slow/etc.) — worth surfacing
	// directly, since two of the methods below point opposite ways on the
	// same underlying question.
	Direction string `json:"direction"`
	// Note records what this encoding does NOT capture — omitted
	// deployment-only profiles, settings this package doesn't model
	// (agc.reset.interval, multi.acks), and any threshold this package
	// approximated rather than the source itself specifying numerically.
	Note string `json:"note"`
}

// BuiltinMeshMethods is the phase-4 community-method catalogue. Every
// entry's Source must be non-empty (enforced by
// TestBuiltinMeshMethodsAllHaveASource) and read from that URL directly —
// see MeshMethod's own doc comment.
func BuiltinMeshMethods() []MeshMethod {
	return []MeshMethod{meshSydneyMethod(), wnyMethod(), tennMeshMethod(), w6hsMethod(), proposedMinimumsMethod()}
}

// policyNeedsAltitude reports whether any rule in policy gates on an
// altitude condition — the same "only search this candidate when real
// altitude data was actually supplied" gate stage2NamedModelPolicies'
// own hasAltitude parameter already applies to its own altitude-keyed
// models (hilltop-first/-last, altitude-proportional, hub-and-spoke):
// without real AltitudeM data every node's altitude reads as its zero
// value, which would make an altitude-gated method's rules either all
// match or all fail to match identically for every node — a
// misleadingly flat result, not a real measurement.
func policyNeedsAltitude(policy ConfigPolicy) bool {
	for _, rule := range policy {
		if rule.Condition.Kind == ConditionAltitudeAtLeast || rule.Condition.Kind == ConditionAltitudeAtMost {
			return true
		}
	}
	return false
}

// communityMethodCandidates converts BuiltinMeshMethods into
// SuggestPolicy's own policyCandidate shape, gating altitude-keyed
// methods (wnyMethod, w6hsMethod) behind hasAltitude the same way
// stage2NamedModelPolicies gates its own altitude models — see
// policyNeedsAltitude. meshSydneyMethod/tennMeshMethod (neighbour-count
// only) and proposedMinimumsMethod (global) always run.
func communityMethodCandidates(hasAltitude bool) []policyCandidate {
	var out []policyCandidate
	for _, m := range BuiltinMeshMethods() {
		if policyNeedsAltitude(m.Policy) && !hasAltitude {
			continue
		}
		out = append(out, policyCandidate{name: "community: " + m.Name, policy: m.Policy})
	}
	return out
}

// meshSydneyMethod encodes MeshSydney's own role/elevation profile table
// (https://meshsydney.com/wiki, read 2026-07) — hilltop-first: "Highest-
// reach nodes fire first, covering the most area in a single transmission
// before the channel fills with retransmissions from lower nodes" (quoted
// directly from the source).
//
// The full published table has 7 profiles: BACKBONE (0.25, 1-2 neighbours,
// variable elevation), CRITICAL (0.3, 20+ neighbours, highest elevation),
// LINK (0.6, 15-20, mid), STANDARD (1.0, 5-10, average), LOCAL (1.4, 1-3,
// low), MOBILE (2.0, variable), BRIDGE (0.25, variable, ESP-NOW).
//
// Only CRITICAL/LINK/STANDARD/LOCAL are encoded here. BACKBONE, MOBILE and
// BRIDGE are deployment-role facts ("this is a point-to-point link," "this
// is a vehicle"), not anything derivable from topology — no altitude or
// neighbour-count condition can express them, and skipping is the honest
// option rather than fabricating a mapping. There's a second,
// sharper reason to drop BACKBONE specifically: its own stated neighbour
// range (1-2) OVERLAPS LOCAL's (1-3) while its delay (0.25) is the
// OPPOSITE end of the scale from LOCAL's (1.4) — a real backbone
// point-to-point link can have very few neighbours by design and still
// need to fire fastest, since nothing else can cover for it. Keying
// BACKBONE on neighbour count alone would therefore actively
// MISREPRESENT the method, not just approximate it, so it's excluded
// rather than approximated.
//
// The four kept profiles ARE numerically distinguishable by neighbour
// count alone (5/15/20 are the source's own stated band boundaries),
// so — unlike wnyMethod/w6hsMethod below — nothing here is an invented
// threshold.
func meshSydneyMethod() MeshMethod {
	return MeshMethod{
		Name: "MeshSydney (NSW)",
		Policy: ConfigPolicy{
			{Name: "LOCAL", TxDelayFactor: floatPtr(1.4)},
			{Name: "STANDARD", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 5}, TxDelayFactor: floatPtr(1.0)},
			{Name: "LINK", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 15}, TxDelayFactor: floatPtr(0.6)},
			{Name: "CRITICAL", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 20}, TxDelayFactor: floatPtr(0.3)},
		},
		Source:    "https://meshsydney.com/wiki",
		AsOf:      "2026-07",
		Direction: "hilltop-first",
		Note: "BACKBONE, MOBILE and BRIDGE profiles omitted — deployment-role " +
			"facts, not derivable from topology (see this method's own doc " +
			"comment for why BACKBONE specifically can't be approximated " +
			"either). rxdelay/direct.txdelay aren't specified per-profile " +
			"by the source.",
	}
}

// wnyAltitudeBoundaries are OUR OWN approximated tier boundaries for
// wnyMethod/w6hsMethod-style elevation tiers — NOT sourced from either
// community guide, both of which describe their tiers qualitatively
// ("mountain peaks," "typical rooftop install") with no stated metres.
// Deliberately a separate set from policytune.go's own
// policyAltitudeThresholds ([400, 700]): those were tuned for phase 2's
// own two-threshold candidate models, not for fitting WNY's four
// non-mobile tiers, which need three boundaries to place four bands.
var wnyAltitudeBoundaries = []float64{150, 400, 700}

// wnyMethod encodes WNY MeshCore's own five-tier guide
// (https://wnymeshcore.org/blog/repeater-setup-naming-guides, read
// 2026-07; republished verbatim by Colorado MeshCore and Denver
// MeshCore) — hilltop-last, the OPPOSITE direction from MeshSydney: "make
// higher nodes wait longer before retransmitting" (quoted from the
// source). The guide itself credits "the Australian model" as its origin
// and claims its own values are "nearly identical" to Sydney's — that
// claim does not survive checking against meshsydney.com/wiki directly
// (Sydney's own top/bottom tiers are 0.3/1.4; WNY's are 2.0/0.3, close to
// a mirror image) and is not repeated here.
//
// txdelay VALUES are WNY's own (2.0/1.5/0.8/0.3) — only the altitude
// BOUNDARIES at which each applies are approximated (wnyAltitudeBoundaries
// above), since the source gives tier names, not metres. MOBILE (3.0) is
// omitted for the same deployment-role reason as MeshSydney's BACKBONE/
// MOBILE/BRIDGE.
func wnyMethod() MeshMethod {
	return MeshMethod{
		Name: "WNY MeshCore",
		Policy: ConfigPolicy{
			{Name: "LOCAL", RxDelayBase: floatPtr(3), TxDelayFactor: floatPtr(0.3)},
			{Name: "SUBURBAN", Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: wnyAltitudeBoundaries[0]}, TxDelayFactor: floatPtr(0.8)},
			{Name: "FOOTHILLS", Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: wnyAltitudeBoundaries[1]}, TxDelayFactor: floatPtr(1.5)},
			{Name: "HILLTOP", Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: wnyAltitudeBoundaries[2]}, TxDelayFactor: floatPtr(2.0)},
		},
		Source:    "https://wnymeshcore.org/blog/repeater-setup-naming-guides",
		AsOf:      "2026-07",
		Direction: "hilltop-last",
		Note: "Elevation BOUNDARIES between tiers are approximated (the " +
			"source names tiers qualitatively, without stated metres) — " +
			"only the txdelay VALUES (2.0/1.5/0.8/0.3) are WNY's own. " +
			"MOBILE (3.0) omitted — deployment-role fact, not derivable " +
			"from topology. agc.reset.interval (WNY: 500) isn't modelled " +
			"by this package.",
	}
}

// tennMeshMethod encodes TennMesh's own neighbour-count-banded settings
// (https://tennmesh.com/settings/, read 2026-07) — dense-slow: "repeaters
// that hear more neighbors should wait longer before transmitting" (the
// source's own stated reasoning). Every band boundary AND value here is
// numerically sourced directly — nothing approximated, unlike
// wnyMethod/w6hsMethod.
func tennMeshMethod() MeshMethod {
	return MeshMethod{
		Name: "TennMesh",
		Policy: ConfigPolicy{
			{Name: "0-1 neighbours", RxDelayBase: floatPtr(3), TxDelayFactor: floatPtr(0.3), DirectTxDelayFactor: floatPtr(0.1)},
			{Name: "2-4 neighbours", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 2}, TxDelayFactor: floatPtr(0.5), DirectTxDelayFactor: floatPtr(0.3)},
			{Name: "5-9 neighbours", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 5}, TxDelayFactor: floatPtr(1.0), DirectTxDelayFactor: floatPtr(0.5)},
			{Name: "10-14 neighbours", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 10}, TxDelayFactor: floatPtr(1.5), DirectTxDelayFactor: floatPtr(1.0)},
			{Name: "15+ neighbours", Condition: RuleCondition{Kind: ConditionNeighborsAtLeast, Threshold: 15}, TxDelayFactor: floatPtr(2.0), DirectTxDelayFactor: floatPtr(2.0)},
		},
		Source:    "https://tennmesh.com/settings/",
		AsOf:      "2026-07",
		Direction: "dense-slow",
		Note:      "agc.reset.interval (4) and multi.acks (1), both stated network-wide by the source, aren't modelled by this package.",
	}
}

// w6hsMethod encodes Eric Hendrickson's three-tier deployment guide
// (https://w6hs.net/meshcore-repeater-deployment-timing-considerations-for-wide-area-networks/,
// published 2025-11-21, updated 2026-01-28, read 2026-07) — hilltop-last,
// same direction as WNY. txdelay VALUES (0.5/1.0/2.0) are the source's
// own; the source gives no numeric elevation bounds at all (its tiers are
// "personal/balcony/residential rooftop, or mobile," "high-rise apartment
// and office buildings," "mountain-top or tower-height"), so the two
// boundaries here reuse policytune.go's OWN policyAltitudeThresholds
// ([400, 700]) rather than inventing a third, W6HS-specific set — a
// natural fit since this method needs exactly two boundaries for three
// bands, and it's the same approximation-boundary choice phase 2's own
// hub-and-spoke/two-tier-backbone models already made for a similar gap.
func w6hsMethod() MeshMethod {
	return MeshMethod{
		Name: "W6HS three-tier",
		Policy: ConfigPolicy{
			{Name: "personal/residential/mobile", TxDelayFactor: floatPtr(0.5)},
			{Name: "high-rise urban", Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: policyAltitudeThresholds[0]}, TxDelayFactor: floatPtr(1.0)},
			{Name: "mountaintop/backbone", Condition: RuleCondition{Kind: ConditionAltitudeAtLeast, Threshold: policyAltitudeThresholds[1]}, TxDelayFactor: floatPtr(2.0)},
		},
		Source:    "https://w6hs.net/meshcore-repeater-deployment-timing-considerations-for-wide-area-networks/",
		AsOf:      "2026-07",
		Direction: "hilltop-last",
		Note:      "Elevation boundaries are approximated (the source gives no metres) — only the txdelay values (0.5/1.0/2.0) are the source's own. flood.max explicitly left at default by the source; this package's own default already matches.",
	}
}

// proposedMinimumsMethod encodes the delay-parameter minimums proposed in
// github.com/meshcore-dev/MeshCore issue #2123 (KPrivitt, opened
// 2026-03-22, read 2026-07): rxdelay >= 3 (vs firmware's own 0 default),
// txdelay >= 1.6 (8 backoff slots, vs 0.5 default), direct.txdelay >= 1 (5
// slots, vs 0.3 default). NOT a community method — a single proposed
// global floor, and NOT maintainer-endorsed: the issue shows no
// maintainer response, and the related auto-tuning discussion (#2053)
// records maintainers
// declining to merge similar work without "convincing test results."
// Included as a real, citable candidate worth searching, labelled
// honestly as a proposal rather than a recommendation.
func proposedMinimumsMethod() MeshMethod {
	return MeshMethod{
		Name: "Upstream proposed minimums (issue #2123)",
		Policy: ConfigPolicy{
			{Name: "global minimums", TxDelayFactor: floatPtr(1.6), RxDelayBase: floatPtr(3), DirectTxDelayFactor: floatPtr(1)},
		},
		Source:    "https://github.com/meshcore-dev/MeshCore/issues/2123",
		AsOf:      "2026-07",
		Direction: "global floor, not tiered",
		Note:      "NOT a community method and NOT maintainer-endorsed — a single proposed global minimum, open and unresolved as of AsOf.",
	}
}
