package beacon

import (
	"context"
	"net/url"
	"sync"
	"time"

	"hopreach/internal/meshsource"
)

// defaultDetailConcurrency bounds the packet-detail fan-out. Each detail call
// costs Beacon a per-hop path-resolution round trip, so this is deliberately
// modest: the aim is "a second or two for a replay window", not maximum load
// on someone else's server.
const defaultDetailConcurrency = 8

// FetchPacketsWithPaths returns the packets in a window *with* their resolved
// paths filled in.
//
// Beacon deliberately omits resolvedPath from list responses — its own code
// comment says full resolution "stays a GET /packets/{packetHash}-only
// feature" — but the replay builds its topology from exactly that. So the
// list gives us the window cheaply (one request, thanks to server-side
// since/until), and this fans out detail requests for it.
//
// Failures are tolerated per packet: a window is evidence, and losing one
// packet's path degrades the reconstruction rather than invalidating it.
// Callers can tell, because such a packet keeps its (empty) list-derived path
// and is reported in the returned failure count.
func (c *Client) FetchPacketsWithPaths(
	ctx context.Context, from, to time.Time, limit int,
) (packets []meshsource.Packet, failed int, err error) {
	list, err := c.FetchPacketsBetween(ctx, from, to, limit)
	if err != nil {
		return nil, 0, err
	}
	return c.resolvePaths(ctx, list)
}

// fetchWithPaths is the same window query narrowed by a server-side filter —
// one region, or one route type. Region participation needs the relay paths
// of a narrow slice of traffic, not of everything.
func (c *Client) fetchWithPaths(
	ctx context.Context, from, to time.Time, limit int, filter url.Values,
) (packets []meshsource.Packet, failed int, err error) {
	list, err := c.fetchPacketList(ctx, from, to, limit, filter)
	if err != nil {
		return nil, 0, err
	}
	return c.resolvePaths(ctx, list)
}

// resolvePaths fills in each packet's relay path from the per-packet detail
// endpoint, bounded by DetailConcurrency.
func (c *Client) resolvePaths(
	ctx context.Context, list []meshsource.Packet,
) (packets []meshsource.Packet, failed int, err error) {
	conc := c.DetailConcurrency
	if conc <= 0 {
		conc = defaultDetailConcurrency
	}

	var (
		mu   sync.Mutex
		wg   sync.WaitGroup
		sem  = make(chan struct{}, conc)
		fail int
	)
	for i := range list {
		// A packet that already carries a path (a Beacon that grew
		// ?resolve=true, or a future list that includes it) needs no detail
		// call — this stays correct and simply gets faster.
		if len(list[i].Path) > 0 {
			continue
		}
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				mu.Lock()
				fail++
				mu.Unlock()
				return
			}
			defer func() { <-sem }()

			detail, derr := c.FetchPacketDetail(ctx, list[idx].Hash)
			mu.Lock()
			defer mu.Unlock()
			if derr != nil {
				fail++
				return
			}
			// Keep the list's own timing/route fields; take from detail only
			// what the list could not carry.
			list[idx].Path = detail.Path
			list[idx].ObserverKey = detail.ObserverKey
			list[idx].OriginKey = detail.OriginKey
			list[idx].Observations = detail.Observations
			if list[idx].SNR == nil {
				list[idx].SNR = detail.SNR
			}
			if list[idx].HashSize == 0 {
				list[idx].HashSize = detail.HashSize
			}
			if list[idx].HopCount == 0 {
				list[idx].HopCount = detail.HopCount
			}
		}(i)
	}
	wg.Wait()
	return list, fail, nil
}
