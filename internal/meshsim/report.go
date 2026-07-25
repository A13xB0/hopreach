package meshsim

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

// DeliveryRatio is, per message, the fraction of the packet's own reachable
// audience (see reachableFrom) that ended up with at least one cleanly
// decoded copy of it — averaged across every message. Unlike CollisionRate,
// this measures the thing docs/SIMULATOR_PLAN_PHASE2.md item 15 actually
// asks the tuner to maximise: successful delivery, not merely the absence
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
	cleanlyReceived := make(map[int]map[int]bool)
	for _, rec := range r.Receptions {
		if rec.Collided || rec.DropReason == "weak_signal" || rec.DropReason == "tx_busy" {
			continue
		}
		if cleanlyReceived[rec.PacketID] == nil {
			cleanlyReceived[rec.PacketID] = make(map[int]bool)
		}
		cleanlyReceived[rec.PacketID][rec.Node] = true
	}

	var total float64
	for i, m := range messages {
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
	return total / float64(len(messages))
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
