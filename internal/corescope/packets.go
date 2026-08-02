package corescope

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// Packet access against CoreScope's GET /api/packets.
//
// This ran in the browser until now: simulator.js binary-searched `offset`
// over the newest-first list to find a time window, because CoreScope has no
// server-side time filter. That put a vendor's pagination quirk, its field
// names, and its timestamp format in front-end code — and made a second
// backend mean a second copy of all three. The search lives here instead, so
// callers ask for a time range and a backend that filters server-side
// (Beacon does) simply doesn't do any of this.

// maxProbeOffset bounds the offset search. Beyond a million rows we are
// past any sane instance, and an unbounded doubling loop against a
// misbehaving server is worse than an incomplete answer.
const maxProbeOffset = 1 << 20

// PacketRow is one packet as the bulk list reports it — one representative
// observation, not every hearing (see FetchPacketDetail for that).
type PacketRow struct {
	Hash         string   `json:"hash"`
	Timestamp    string   `json:"timestamp"`
	RawHex       string   `json:"raw_hex"`
	RouteType    int      `json:"route_type"`
	ObserverID   string   `json:"observer_id"`
	ResolvedPath []string `json:"resolved_path"`
	SNR          *float64 `json:"snr"`
	DecodedJSON  string   `json:"decoded_json"`
}

// PacketObservation is one observer's own hearing of a packet.
type PacketObservation struct {
	ObserverID   string   `json:"observer_id"`
	ObserverName string   `json:"observer_name"`
	Timestamp    string   `json:"timestamp"`
	ResolvedPath []string `json:"resolved_path"`
	SNR          *float64 `json:"snr"`
}

// PacketDetail is GET /api/packets/{hash}: the packet plus EVERY observation
// of it. Completeness matters — the replay compares who heard a packet
// against who was listening, so a dropped observation reads as a delivery
// failure that never happened.
type PacketDetail struct {
	Packet       PacketRow           `json:"packet"`
	Observations []PacketObservation `json:"observations"`
}

type packetRowsResponse struct {
	Packets []PacketRow `json:"packets"`
}

// FetchPacketPage returns one newest-first page of the packet list.
func (c *Client) FetchPacketPage(ctx context.Context, limit, offset int) ([]PacketRow, error) {
	url := fmt.Sprintf("%s/api/packets?limit=%d&offset=%d&sort=timestamp&order=desc",
		c.BaseURL, limit, offset)
	var parsed packetRowsResponse
	if err := c.getJSON(ctx, url, &parsed); err != nil {
		return nil, err
	}
	return parsed.Packets, nil
}

// FetchPacketDetail returns one packet with every observation of it.
func (c *Client) FetchPacketDetail(ctx context.Context, hash string) (PacketDetail, error) {
	url := fmt.Sprintf("%s/api/packets/%s", c.BaseURL, hash)
	var detail PacketDetail
	if err := c.getJSON(ctx, url, &detail); err != nil {
		return PacketDetail{}, err
	}
	return detail, nil
}

// timestampAt reports the timestamp of the single row at offset, or false
// once offset is past the end of history.
func (c *Client) timestampAt(ctx context.Context, offset int) (time.Time, bool, error) {
	rows, err := c.FetchPacketPage(ctx, 1, offset)
	if err != nil {
		return time.Time{}, false, err
	}
	if len(rows) == 0 {
		return time.Time{}, false, nil
	}
	ts, err := time.Parse(time.RFC3339, rows[0].Timestamp)
	if err != nil {
		return time.Time{}, false, nil
	}
	return ts, true, nil
}

// findOffsetOfNewestEdge binary-searches the newest-first list for the first
// offset at or older than `edge`. Roughly twenty single-row probes, whatever
// the packet's age — as opposed to walking the list from the top, which
// costs more the further back you look and silently truncates for anything
// deep in the history.
//
// "At or older" is load-bearing: the predicate is `ts > edge`, not
// `ts >= edge`. A packet whose timestamp is exactly the window's newest edge
// is inside the window, and skipping it drops a real packet from the replay.
func (c *Client) findOffsetOfNewestEdge(ctx context.Context, edge time.Time) (int, error) {
	lo, hi := 0, 4096
	for {
		ts, ok, err := c.timestampAt(ctx, hi)
		if err != nil {
			return 0, err
		}
		if !ok || !ts.After(edge) {
			break
		}
		hi *= 2
		if hi > maxProbeOffset {
			break
		}
	}
	for lo < hi {
		mid := (lo + hi) / 2
		ts, ok, err := c.timestampAt(ctx, mid)
		if err != nil {
			return 0, err
		}
		if !ok || !ts.After(edge) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	return lo, nil
}

// FetchPacketsBetween returns every packet heard in [from, to], newest first.
//
// limit caps the result: hitting it means the window held more traffic than
// the caller asked for, and the answer is a truncated tail rather than the
// whole window. Callers that care should say so in their output rather than
// present a partial window as complete.
func (c *Client) FetchPacketsBetween(
	ctx context.Context, from, to time.Time, limit int,
) ([]PacketRow, error) {
	if limit <= 0 {
		return nil, nil
	}
	start, err := c.findOffsetOfNewestEdge(ctx, to)
	if err != nil {
		return nil, err
	}

	out := make([]PacketRow, 0, min(limit, packetPageLimit))
	offset := start
	for len(out) < limit {
		rows, err := c.FetchPacketPage(ctx, packetPageLimit, offset)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			break
		}
		reachedWindowStart := false
		for _, r := range rows {
			ts, err := time.Parse(time.RFC3339, r.Timestamp)
			if err != nil {
				continue // one malformed row, not the whole page
			}
			if ts.Before(from) {
				reachedWindowStart = true
				break // newest-first: everything after this is older still
			}
			if ts.After(to) {
				continue // still inside the pre-window overshoot
			}
			out = append(out, r)
			if len(out) >= limit {
				break
			}
		}
		if reachedWindowStart || len(rows) < packetPageLimit {
			break
		}
		offset += len(rows)
	}
	return out, nil
}

// getJSON performs one GET and decodes the body, with the same error
// wrapping every other fetch in this package uses.
func (c *Client) getJSON(ctx context.Context, url string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return fmt.Errorf("corescope: building request for %s: %w", url, err)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("corescope: fetching %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("corescope: fetching %s: unexpected status %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
		return fmt.Errorf("corescope: decoding response from %s: %w", url, err)
	}
	return nil
}
