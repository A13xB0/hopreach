package beacon

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"hopreach/internal/meshsource"
)

// Region participation, answered Beacon's way.
//
// "Observed relaying in region X" is a claim about traffic: this repeater
// actually forwarded packets on that region. Beacon does expose
// /nodes?scope=…, and it is tempting to use — but that filters on a node's
// self-reported default_scope, which is a different claim entirely (and one
// CoreScope reports separately, as DefaultScope). Using it here would label
// repeaters as observed participants on the strength of what they say about
// themselves.
//
// So both halves are derived from traffic, as CoreScope derives them. What
// Beacon buys is a server-side scope filter on the packet query, so each
// region is a narrow question rather than a walk of the whole history.

// scopedPacketCap bounds the per-region packet walk. Participation is
// evidence of a behaviour, not a census: a repeater carrying a region shows
// up in the first handful of packets it touches.
const scopedPacketCap = 2000

// unscopedRouteType is MeshCore's ROUTE_TYPE_FLOOD: a plain flood, carrying no
// transport code at all. Distinct from a scoped flood whose region we merely
// failed to name — see meshsource.ObservedUnscoped.
const unscopedRouteType = 1

// unscopedPacketCap bounds the packet walk behind the unscoped signal. It is
// evidence of a behaviour, not a census: a repeater relaying unscoped traffic
// shows up in the first handful of packets it touches, and the answer is used
// only as a boolean.
const unscopedPacketCap = 2000

// FetchRegionParticipation reports which regions each node is observed
// relaying in, and which relay plain unscoped traffic.
func (c *Client) FetchRegionParticipation(
	ctx context.Context, since time.Time, regionNames []string,
) (meshsource.Participation, error) {
	out := meshsource.Participation{
		Scoped:   make(map[string]map[string]int),
		Unscoped: make(map[string]int),
	}

	for _, name := range regionNames {
		if name == "" {
			continue
		}
		counts, err := c.observeScope(ctx, since, name)
		if err != nil {
			return meshsource.Participation{}, fmt.Errorf("beacon: scope %q: %w", name, err)
		}
		for key, n := range counts {
			if out.Scoped[key] == nil {
				out.Scoped[key] = make(map[string]int)
			}
			out.Scoped[key][name] += n
		}
	}

	unscoped, err := c.observeUnscoped(ctx, since)
	if err != nil {
		return meshsource.Participation{}, err
	}
	out.Unscoped = unscoped
	return out, nil
}

// observeScope counts, per node, how many packets on one region it was seen
// relaying in the window.
func (c *Client) observeScope(
	ctx context.Context, since time.Time, scope string,
) (map[string]int, error) {
	packets, _, err := c.fetchWithPaths(ctx, since, time.Now(), scopedPacketCap,
		url.Values{"scope": []string{scope}})
	if err != nil {
		return nil, err
	}
	return tallyRelays(packets), nil
}

// tallyRelays counts how often each node appears as a relay.
//
// Only resolved hops count. An ambiguous hash could belong to several nodes,
// and crediting one of them would manufacture evidence that a specific
// repeater carries a specific region.
func tallyRelays(packets []meshsource.Packet) map[string]int {
	counts := make(map[string]int)
	for _, p := range packets {
		for _, hop := range p.Path {
			if hop.Confidence != meshsource.HopResolved || hop.PublicKey == "" {
				continue
			}
			counts[strings.ToLower(hop.PublicKey)]++
		}
	}
	return counts
}

// observeUnscoped counts, per node, how many plain unscoped floods it was
// seen relaying in the window.
//
// Beacon's packet list carries no relay path, so this needs the per-packet
// detail fan-out. That is why it is capped: the result feeds a boolean, and
// paying for a full census of a busy mesh to compute one would be a poor
// trade against someone else's server.
func (c *Client) observeUnscoped(ctx context.Context, since time.Time) (map[string]int, error) {
	packets, _, err := c.fetchWithPaths(ctx, since, time.Now(), unscopedPacketCap,
		url.Values{"routeType": []string{fmt.Sprint(unscopedRouteType)}})
	if err != nil {
		return nil, err
	}
	return tallyRelays(packets), nil
}
