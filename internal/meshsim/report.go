package meshsim

import (
	"fmt"
	"sort"
)

// CollisionRate is the fraction of Receptions marked Collided — the primary
// metric Suggest optimizes against. 0 if there were no receptions at all
// (an empty scenario isn't "perfect," it's undefined, but 0 is the useful
// default for a search that otherwise ranks candidates by this number).
func (r Report) CollisionRate() float64 {
	if len(r.Receptions) == 0 {
		return 0
	}
	collided := 0
	for _, rec := range r.Receptions {
		if rec.Collided {
			collided++
		}
	}
	return float64(collided) / float64(len(r.Receptions))
}

// isCanonicalDelivery mirrors public/simulator.js's own isCanonicalDelivery
// exactly: a genuinely fresh, undisputed decode — not collided, and not
// one of the three DropReasons that mean "arrived at the radio layer but
// isn't this node's first/only useful copy" (weak_signal/tx_busy were
// never decoded at all — see their own doc comments; already_seen WAS
// decoded, but is a duplicate of an earlier copy this same node already
// processed). Used by both DeliveryRatio (below) and PerNodeStats.
func isCanonicalDelivery(r Reception) bool {
	return !r.Collided && r.DropReason != "weak_signal" && r.DropReason != "tx_busy" && r.DropReason != "already_seen"
}

// DeliveryRatio is, per message, the fraction of the packet's own reachable
// audience (see reachableFrom) that ended up with at least one cleanly
// decoded copy of it — averaged across every message. Unlike CollisionRate,
// this measures the thing the tuner is actually asked to maximise:
// successful delivery, not merely the absence
// of collisions (a policy where every node backs off enormously collides
// less and delivers less — those are not the same goal).
//
// scenario and messages must be the same ones r was produced from (Report
// doesn't carry them itself — Run stays the single source of truth for
// what a Scenario/Message actually is). Returns 0 for an empty messages
// slice, the same "nothing to measure" convention CollisionRate uses.
func (r Report) DeliveryRatio(scenario Scenario, messages []Message) float64 {
	if len(messages) == 0 {
		return 0
	}

	// cleanlyReceived[packetID][node] — every node that got at least one
	// genuinely DECODED, non-collided copy of that packet. weak_signal and
	// tx_busy both leave Collided false but were never decoded at all (see
	// their own doc comments: neither marks the packet seen), so they
	// don't count as a delivery any more than a collision does.
	//
	// isCanonicalDelivery also excludes already_seen, which this map
	// doesn't strictly need to (a duplicate always follows an earlier
	// canonical decode at the same [packetID][node] key, which already set
	// this same boolean true — see isCanonicalDelivery's own doc comment
	// and PerNodeStats, where the exclusion DOES change the result, for
	// why this is the same predicate rather than a separately-maintained
	// one anyway).
	cleanlyReceived := make(map[int]map[int]bool)
	for _, rec := range r.Receptions {
		if !isCanonicalDelivery(rec) {
			continue
		}
		if cleanlyReceived[rec.PacketID] == nil {
			cleanlyReceived[rec.PacketID] = make(map[int]bool)
		}
		cleanlyReceived[rec.PacketID][rec.Node] = true
	}

	var total float64
	var counted int
	for i, m := range messages {
		// Background messages (see Message.Background) are fixed interference,
		// not floods to deliver — they never relay and generate no receptions,
		// so they must NOT be scored as delivery failures (that would drag the
		// ratio down and give the optimizer a corrupt objective).
		if m.Background {
			continue
		}
		counted++
		reachable := reachableFrom(scenario, m.Origin, m.Region)
		delete(reachable, m.Origin) // the origin isn't a delivery TARGET — this measures how much of the rest of the reachable network got it
		if len(reachable) == 0 {
			total += 1 // nothing else was ever reachable — vacuously perfect delivery, not a failure to explain
			continue
		}
		got := cleanlyReceived[i]
		delivered := 0
		for n := range reachable {
			if got[n] {
				delivered++
			}
		}
		total += float64(delivered) / float64(len(reachable))
	}
	if counted == 0 {
		return 0 // nothing but background — no delivery to measure
	}
	return total / float64(counted)
}

// reachableFrom computes the set of nodes a message from origin, tagged
// with region, could possibly reach at all — a static, topology-only
// property (no SNR/decode-probability modeling; that's what Run's own
// stochastic simulation is for), used as DeliveryRatio's denominator so an
// isolated or out-of-range node doesn't cap every score below 1 and add
// constant noise that swamps the real differences between candidates.
//
// A breadth-first search over scenario.Links, gated exactly the way Run's
// own relay-eligibility switch is: a node that can't relay (CanRelay ==
// false) or wouldn't accept this region (acceptsRegion) is included in the
// result (it's still reachable itself, on this same hop) but does NOT
// extend the search past itself — it's a leaf, same as it would be in the
// real simulation. The origin itself is exempt from both gates: those only
// govern whether a RELAYER passes a packet on, never whether the origin
// sends it in the first place (see Run's own initial eventSend push, which
// isn't gated by CanRelay/acceptsRegion at all).
func reachableFrom(scenario Scenario, origin int, region string) map[int]bool {
	adj := buildAdjacency(scenario.Links)
	reachable := map[int]bool{origin: true}
	queue := []int{origin}
	for len(queue) > 0 {
		n := queue[0]
		queue = queue[1:]
		if n != origin {
			// A Link referencing an index outside scenario.Nodes means
			// the caller passed a Links slice that doesn't actually match
			// Nodes (see this function's own doc comment on the
			// scenario/messages-must-match contract PerNodeStats and
			// DeliveryRatio both share) — not something Run itself
			// tolerates either, but reachableFrom is reachable from more
			// places now (phase 4's PerNodeStats/optimizer code, which
			// programmatically builds/trims Scenarios), so treat it as an
			// unreachable leaf rather than panicking a caller for a bug
			// that's meaningfully more likely to happen there than in
			// hand-built test fixtures.
			if n < 0 || n >= len(scenario.Nodes) {
				continue
			}
			node := scenario.Nodes[n]
			if !node.CanRelay || !node.acceptsRegion(region) {
				continue // leaf: reachable itself, but doesn't relay onward
			}
		}
		for _, link := range adj[n] {
			if !reachable[link.To] {
				reachable[link.To] = true
				queue = append(queue, link.To)
			}
		}
	}
	return reachable
}

// NodeStats is one node's own aggregated outcomes across every packet in a
// Report — the per-node measurements needed to find "which specific
// repeaters" are the offenders a targeted policy or the adaptive optimizer
// should single out. Ported line-for-line from public/simulator.js's own
// computeRankings,
// which is the ORIGINAL and, until phase 4's WASM-bridge work happens (see
// phase 4 work item 7), still the ONLY thing the UI's per-repeater
// scoreboard actually uses — this is a second, Go-side copy for search
// code, not a replacement for that one, so keep the two in sync by hand
// until they're unified.
type NodeStats struct {
	Node int `json:"node"`

	SuccessCount     int `json:"successCount"`
	CollisionCount   int `json:"collisionCount"`
	ContentionCaused int `json:"contentionCaused"` // see Reception.CollidedWith's own doc comment
	TxBusyCount      int `json:"txBusyCount"`

	// DutyAirtimeMs is this node's own summed Transmission.AirtimeMs —
	// callers wanting a percentage divide by their own sim window
	// (mirrors computeRankings' own dutyCyclePct, which isn't reproduced
	// here since PerNodeStats has no maxSimTimeMs of its own to divide by).
	DutyAirtimeMs uint32 `json:"dutyAirtimeMs"`

	RelayedCount int `json:"relayedCount"`
	// RedundantRelays is how many of this node's own relay transmissions
	// produced zero canonical deliveries — every listener either already
	// had the packet from someone else, or never got it via any path —
	// i.e. airtime spent without adding coverage. See UniqueDeliveries'
	// own converse: a relay is redundant exactly when its (packetID, node)
	// pair never appears among the deliveringPairs UniqueDeliveries counts.
	RedundantRelays  int `json:"redundantRelays"`
	UniqueDeliveries int `json:"uniqueDeliveries"`

	DeliveredCount int `json:"deliveredCount"`
	// DropReasons counts this node's own receptions by DropReason — the
	// raw material for answering "why isn't this repeater relaying?"
	// (see DiagnoseNode). Keyed by the same strings Reception.DropReason
	// uses ("loop_detect", "hop_limit", "region_mismatch", "cannot_relay",
	// "already_seen", "weak_signal", "tx_busy"); a clean reception that
	// went on to relay contributes no entry at all. Never nil.
	DropReasons map[string]int `json:"dropReasons"`
	// ReachableCount is reachableFrom's own audience size for every
	// message this node could ever have received, summed across every
	// message in the Report's own originating batch (the origin itself
	// excluded from its own count, same convention DeliveryRatio uses) —
	// PerNodeStats' own denominator for a per-node delivery ratio, the
	// same "don't let an unreachable node look like a failure" reasoning
	// DeliveryRatio's own doc comment explains.
	ReachableCount int `json:"reachableCount"`
}

// PerNodeStats computes NodeStats for every node in scenario — see
// NodeStats' own doc comment for what each figure means and its
// public/simulator.js counterpart. scenario and messages must be the ones
// r was produced from, same contract as DeliveryRatio.
func (r Report) PerNodeStats(scenario Scenario, messages []Message) []NodeStats {
	n := len(scenario.Nodes)
	stats := make([]NodeStats, n)
	for i := range stats {
		stats[i].Node = i
		stats[i].DropReasons = map[string]int{}
	}
	inRange := func(i int) bool { return i >= 0 && i < n }

	for _, rec := range r.Receptions {
		if !inRange(rec.Node) {
			continue
		}
		if rec.Collided {
			stats[rec.Node].CollisionCount++
		} else {
			stats[rec.Node].SuccessCount++
		}
		if rec.DropReason == "tx_busy" {
			stats[rec.Node].TxBusyCount++
		}
		if rec.DropReason != "" {
			stats[rec.Node].DropReasons[rec.DropReason]++
		}
		for _, other := range rec.CollidedWith {
			if inRange(other) {
				stats[other].ContentionCaused++
			}
		}
	}

	// deliveringPairs: (packetID, fromNode) pairs whose transmission
	// actually delivered the packet to at least one listener — the input
	// RedundantRelays' own attribution below needs, at the per-packet
	// level. Mirrors public/simulator.js's own deliveringPairs Set exactly
	// (same "packetId:fromNode" key shape, just a struct key instead of a
	// string one on this side of the boundary).
	type pairKey struct{ packetID, fromNode int }
	deliveringPairs := make(map[pairKey]bool)
	for _, rec := range r.Receptions {
		if !isCanonicalDelivery(rec) {
			continue
		}
		if inRange(rec.FromNode) {
			stats[rec.FromNode].UniqueDeliveries++
		}
		if inRange(rec.Node) {
			stats[rec.Node].DeliveredCount++
		}
		deliveringPairs[pairKey{rec.PacketID, rec.FromNode}] = true
	}

	for _, tx := range r.Transmissions {
		if !inRange(tx.Node) {
			continue
		}
		stats[tx.Node].DutyAirtimeMs += tx.AirtimeMs
		if tx.IsRelay {
			stats[tx.Node].RelayedCount++
			if !deliveringPairs[pairKey{tx.PacketID, tx.Node}] {
				stats[tx.Node].RedundantRelays++
			}
		}
	}

	for _, m := range messages {
		if m.Background {
			continue // fixed interference, not a delivery target — see DeliveryRatio
		}
		reachable := reachableFrom(scenario, m.Origin, m.Region)
		delete(reachable, m.Origin)
		for node := range reachable {
			if inRange(node) {
				stats[node].ReachableCount++
			}
		}
	}

	return stats
}

// NodeDiagnosis is one repeater's own plain-language "what's wrong here,
// and what would you actually do about it" — the per-repeater answer to
// "this repeater keeps not relaying, so here's the suggestion." Derived
// entirely from measured NodeStats, never from assumption.
type NodeDiagnosis struct {
	Node int `json:"node"`
	// Headline is the single most significant thing about this node, in
	// plain language ("relayed 0 of 47 packets it received").
	Headline string `json:"headline"`
	// Findings are every notable observation, most significant first —
	// empty for a node behaving unremarkably.
	Findings []NodeFinding `json:"findings"`
}

// NodeFinding is one observation about a node plus what to do about it.
type NodeFinding struct {
	// Kind is a stable machine-readable slug ("never_relays",
	// "loop_detect_drops", "high_contention", ...) so a UI can filter or
	// sort on it without parsing prose.
	Kind string `json:"kind"`
	// Detail states the measurement itself, with real numbers.
	Detail string `json:"detail"`
	// Suggestion is the concrete action, or "" where there genuinely
	// isn't one (some findings are context for a human, not a knob to
	// turn — saying nothing is better than inventing a fix).
	Suggestion string `json:"suggestion"`
	// Severity ranks findings within a node: higher is more significant.
	// Used only for ordering, not as a calibrated score.
	Severity int `json:"severity"`
}

// DiagnoseNode turns one node's measured NodeStats into plain-language
// findings. maxSimTimeMs is needed for the duty-cycle percentage (see
// nodeContentionScore's own use of it).
//
// Deliberately conservative about suggestions: several findings are
// reported with an empty Suggestion because the honest answer is "this is
// worth knowing, but the fix depends on context this simulator can't see"
// — inventing a confident recommendation for those would be worse than
// staying quiet, especially since these render next to copy-pasteable CLI
// commands users paste into real hardware.
func DiagnoseNode(s NodeStats, maxSimTimeMs uint32) NodeDiagnosis {
	d := NodeDiagnosis{Node: s.Node, Findings: []NodeFinding{}}
	received := s.SuccessCount + s.CollisionCount

	add := func(kind, detail, suggestion string, severity int) {
		d.Findings = append(d.Findings, NodeFinding{Kind: kind, Detail: detail, Suggestion: suggestion, Severity: severity})
	}

	// "Keeps not relaying" — the headline case. Split by WHY, since the
	// action is completely different for each cause.
	if loops := s.DropReasons["loop_detect"]; loops > 0 {
		add("loop_detect_drops",
			fmt.Sprintf("dropped %d received packet(s) for loop.detect", loops),
			"Its own path-hash is colliding with another repeater's. Raise the sending nodes' hash size (3 bytes collides far less than 1), or relax this repeater's loop.detect level.",
			90)
	}
	if hops := s.DropReasons["hop_limit"] + s.DropReasons["hop_limit_unscoped"]; hops > 0 {
		add("hop_limit_drops",
			fmt.Sprintf("dropped %d received packet(s) for a hop limit", hops),
			"Packets are arriving already at flood.max. Raise flood.max/flood.max.unscoped here, or shorten the path by siting a relay closer to the source.",
			80)
	}
	if region := s.DropReasons["region_mismatch"]; region > 0 {
		add("region_mismatch_drops",
			fmt.Sprintf("dropped %d received packet(s) for a region mismatch", region),
			"It doesn't hold the sending region's key. Add that region to this repeater, or send unscoped.",
			80)
	}
	if s.DropReasons["cannot_relay"] > 0 {
		add("cannot_relay",
			fmt.Sprintf("received %d packet(s) but is configured never to relay", s.DropReasons["cannot_relay"]),
			"", // a companion/client node not relaying is correct behaviour, not a fault
			10)
	}
	if weak := s.DropReasons["weak_signal"]; weak > 0 {
		add("weak_signal",
			fmt.Sprintf("%d packet(s) arrived below its own decode threshold", weak),
			"Marginal links into this repeater. Better siting/antenna, or a slower spreading factor, would help more than any delay setting.",
			60)
	}
	if s.TxBusyCount > 0 {
		add("tx_busy_misses",
			fmt.Sprintf("missed %d packet(s) because its own transmitter was keyed (half-duplex)", s.TxBusyCount),
			"It's talking when it should be listening. Backing off its txdelay spreads its own transmissions away from the traffic it needs to hear.",
			70)
	}
	if s.CollisionCount > 0 {
		add("own_receptions_collided",
			fmt.Sprintf("%d of its %d received packet(s) collided", s.CollisionCount, received),
			"", // the fix belongs to whoever is CAUSING the collisions, not this node — see contention_caused on those nodes
			50)
	}
	if s.ContentionCaused > 0 {
		add("causes_contention",
			fmt.Sprintf("its own transmissions caused %d collision(s) at other repeaters", s.ContentionCaused),
			"Raising this repeater's txdelay spreads its transmissions out and directly reduces collisions elsewhere.",
			85)
	}
	if s.RedundantRelays > 0 {
		add("redundant_relays",
			fmt.Sprintf("%d of its %d relay(s) reached nobody new", s.RedundantRelays, s.RelayedCount),
			"Pure wasted airtime — every listener already had the packet. Raise its txdelay so faster neighbours cover that ground first, or trim flood.max.",
			75)
	}
	if maxSimTimeMs > 0 {
		if dutyPct := float64(s.DutyAirtimeMs) / float64(maxSimTimeMs) * 100; dutyPct >= 40 {
			add("high_duty_cycle",
				fmt.Sprintf("used %.0f%% of the window as airtime", dutyPct),
				"Approaching real firmware's own ~50% duty-cycle cap, past which it will start deferring its own sends regardless of settings.",
				65)
		}
	}

	sort.SliceStable(d.Findings, func(i, j int) bool { return d.Findings[i].Severity > d.Findings[j].Severity })

	switch {
	case received > 0 && s.RelayedCount == 0 && s.DropReasons["cannot_relay"] == 0:
		d.Headline = fmt.Sprintf("relayed none of the %d packet(s) it received", received)
	case len(d.Findings) > 0:
		d.Headline = d.Findings[0].Detail
	case received == 0:
		d.Headline = "received nothing at all"
	default:
		d.Headline = fmt.Sprintf("healthy — relayed %d of %d received, no issues found", s.RelayedCount, received)
	}
	return d
}
