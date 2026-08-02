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
// CoreScope has to infer this: it walks its packet history, decodes each
// packet's transport code, and tallies which repeaters appear in the relay
// paths of scoped traffic. Beacon already knows — it stores a packet's scope
// when it ingests it, and exposes /nodes?scope=… — so the scoped half is a
// direct question rather than a reconstruction, and a more reliable answer
// than the inference it replaces.
//
// The unscoped half has no such shortcut and is derived from traffic, the
// same way CoreScope does it.

// nodePageLimit matches FetchRepeaters' paging.
const nodePageLimit = 500

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
		keys, err := c.nodeKeysInScope(ctx, name)
		if err != nil {
			return meshsource.Participation{}, fmt.Errorf("beacon: scope %q: %w", name, err)
		}
		for _, k := range keys {
			if out.Scoped[k] == nil {
				out.Scoped[k] = make(map[string]int)
			}
			// Beacon reports membership, not a tally. The count exists in the
			// canonical shape because CoreScope counts observations; here a 1
			// means "confirmed in this scope", and callers only ever ask
			// whether the map is non-empty (meshsource.ObservedScopes).
			out.Scoped[k][name] = 1
		}
	}

	unscoped, err := c.observeUnscoped(ctx, since)
	if err != nil {
		return meshsource.Participation{}, err
	}
	out.Unscoped = unscoped
	return out, nil
}

// nodeKeysInScope lists every node Beacon places in one transport scope.
func (c *Client) nodeKeysInScope(ctx context.Context, scope string) ([]string, error) {
	var (
		keys   []string
		cursor *int64
	)
	for {
		q := url.Values{}
		q.Set("scope", scope)
		q.Set("iatas", c.iataParam())
		q.Set("limit", fmt.Sprint(nodePageLimit))
		if cursor != nil {
			q.Set("cursor", fmt.Sprint(*cursor))
		}
		var pg page[nodeSummary]
		if err := c.get(ctx, "/nodes", q, &pg); err != nil {
			return nil, err
		}
		for _, n := range pg.Items {
			if n.PublicKey != "" {
				keys = append(keys, strings.ToLower(n.PublicKey))
			}
		}
		if !pg.HasMore || pg.NextCursor == nil || len(pg.Items) == 0 {
			break
		}
		cursor = pg.NextCursor
	}
	return keys, nil
}

// observeUnscoped counts, per node, how many plain unscoped floods it was
// seen relaying in the window.
//
// Beacon's packet list carries no relay path, so this needs the per-packet
// detail fan-out. That is why it is capped: the result feeds a boolean, and
// paying for a full census of a busy mesh to compute one would be a poor
// trade against someone else's server.
func (c *Client) observeUnscoped(ctx context.Context, since time.Time) (map[string]int, error) {
	counts := make(map[string]int)
	packets, _, err := c.fetchUnscopedWithPaths(ctx, since, time.Now())
	if err != nil {
		return nil, err
	}
	for _, p := range packets {
		for _, hop := range p.Path {
			// Only resolved hops count. An ambiguous hash could belong to
			// several nodes, and crediting one of them would manufacture
			// evidence that a specific repeater relays unscoped traffic.
			if hop.Confidence != meshsource.HopResolved || hop.PublicKey == "" {
				continue
			}
			counts[strings.ToLower(hop.PublicKey)]++
		}
	}
	return counts, nil
}
