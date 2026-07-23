package corescope

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// packetPageLimit is the page size used when paginating GET /api/packets —
// large enough that a real window's worth of traffic (thousands of
// packets/day on a busy mesh) doesn't need hundreds of round trips.
const packetPageLimit = 500

// packetSummary mirrors the fields this package needs from one entry of
// GET /api/packets' response. _parsedPath is CoreScope's own hop-prefix
// list as a real JSON array (unlike path_json, the same data
// double-encoded as a JSON *string* — using this field avoids an extra
// unmarshal step). Unlike the single-packet detail endpoint
// (GET /api/packets/{hash}), the bulk list does not include resolved_path
// (full public keys) — resolvePrefixes below does that resolution here
// instead, against a full node directory fetched once up front.
type packetSummary struct {
	Timestamp   string   `json:"timestamp"`
	DecodedJSON string   `json:"decoded_json"`
	ParsedPath  []string `json:"_parsedPath"`
}

type packetsResponse struct {
	Packets []packetSummary `json:"packets"`
	Total   int             `json:"total"`
}

// decodedChannelPacket is the one field this package cares about from
// decoded_json — present (non-empty) only on packets CoreScope has
// successfully decrypted, which for a plain regional/community channel is
// essentially all of them (its own /api/scope-stats endpoint reports 0
// "unknown scope" packets against a live production instance at the time
// this was written).
type decodedChannelPacket struct {
	Channel string `json:"channel"`
}

// FetchAllNodes fetches every node CoreScope knows about, any role — not
// just role=repeater (see FetchRepeaters) — since a flood's relay path can
// pass through room servers, clients, or anything else CoreScope tracks,
// and resolvePrefixes needs the full directory to have a chance at
// resolving every hop.
func (c *Client) FetchAllNodes(ctx context.Context) ([]Node, error) {
	var nodes []Node
	offset := 0
	for {
		url := fmt.Sprintf("%s/api/nodes?limit=%d&offset=%d", c.BaseURL, pageLimit, offset)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, fmt.Errorf("corescope: building request for %s: %w", url, err)
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return nil, fmt.Errorf("corescope: fetching %s: %w", url, err)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("corescope: fetching %s: unexpected status %d", url, resp.StatusCode)
		}
		var page nodesResponse
		err = json.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("corescope: decoding response from %s: %w", url, err)
		}
		nodes = append(nodes, page.Nodes...)
		offset += len(page.Nodes)
		if len(page.Nodes) == 0 || offset >= page.Total {
			break
		}
	}
	return nodes, nil
}

// prefixIndex resolves a short hop-path prefix (as recorded in a packet's
// _parsedPath — MeshCore trims each hop to its own configured hash_size,
// commonly far shorter than a full 64-hex-character public key) back to
// exactly one known node's full public key. Ambiguous (two+ real nodes
// share that prefix) or unknown prefixes resolve to ("", false) — silently
// dropped rather than guessed, since attributing a real observed hop to the
// wrong repeater would be worse than just not counting it.
type prefixIndex struct {
	pubkeys []string // lowercase, one entry per known node
}

func newPrefixIndex(nodes []Node) prefixIndex {
	pk := make([]string, 0, len(nodes))
	for _, n := range nodes {
		pk = append(pk, strings.ToLower(n.PublicKey))
	}
	return prefixIndex{pubkeys: pk}
}

func (idx prefixIndex) resolve(prefix string) (string, bool) {
	prefix = strings.ToLower(prefix)
	if prefix == "" {
		return "", false
	}
	match := ""
	for _, pk := range idx.pubkeys {
		if strings.HasPrefix(pk, prefix) {
			if match != "" {
				return "", false // ambiguous — 2+ real nodes share this prefix
			}
			match = pk
		}
	}
	return match, match != ""
}

// FetchChannelParticipation walks CoreScope's GET /api/packets newest-first
// (see the package doc on sort order this relies on), stopping once it
// reaches packets older than since, and tallies which channel(s) each
// resolvable repeater appears in as a relay-path participant. Returns
// pubkey (lowercase) -> channel name -> observed count.
//
// A repeater's own self-reported default_scope is too sparse to build a
// map from on its own (confirmed against production: empty for ~76% of
// real repeaters) — this observes real relay behavior instead, using
// decoded_json.channel (CoreScope's own plaintext channel name whenever it
// successfully decrypts a packet) as the ground truth signal.
func (c *Client) FetchChannelParticipation(ctx context.Context, since time.Time, nodes []Node) (map[string]map[string]int, error) {
	idx := newPrefixIndex(nodes)
	counts := make(map[string]map[string]int)
	offset := 0
	for {
		url := fmt.Sprintf("%s/api/packets?limit=%d&offset=%d", c.BaseURL, packetPageLimit, offset)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, fmt.Errorf("corescope: building request for %s: %w", url, err)
		}
		resp, err := c.HTTP.Do(req)
		if err != nil {
			return nil, fmt.Errorf("corescope: fetching %s: %w", url, err)
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("corescope: fetching %s: unexpected status %d", url, resp.StatusCode)
		}
		var page packetsResponse
		err = json.NewDecoder(resp.Body).Decode(&page)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("corescope: decoding response from %s: %w", url, err)
		}
		if len(page.Packets) == 0 {
			break
		}

		reachedWindowStart := false
		for _, p := range page.Packets {
			ts, err := time.Parse(time.RFC3339, p.Timestamp)
			if err != nil {
				continue // malformed timestamp — skip this one packet, not the whole page
			}
			if ts.Before(since) {
				reachedWindowStart = true
				break // newest-first: everything from here on is even older
			}
			tallyPacket(counts, idx, p)
		}
		if reachedWindowStart || len(page.Packets) < packetPageLimit {
			break
		}
		offset += len(page.Packets)
	}
	return counts, nil
}

func tallyPacket(counts map[string]map[string]int, idx prefixIndex, p packetSummary) {
	var decoded decodedChannelPacket
	if err := json.Unmarshal([]byte(p.DecodedJSON), &decoded); err != nil || decoded.Channel == "" {
		return // undecoded (private channel key CoreScope doesn't have) or not a channel message
	}
	for _, hop := range p.ParsedPath {
		pubkey, ok := idx.resolve(hop)
		if !ok {
			continue
		}
		if counts[pubkey] == nil {
			counts[pubkey] = make(map[string]int)
		}
		counts[pubkey][decoded.Channel]++
	}
}

// DominantScope returns the most-observed channel in counts, breaking ties
// alphabetically for reproducible results (a real tie is a rare edge case,
// but Go's own map iteration order is randomized — without a tiebreak,
// otherwise-identical input could non-deterministically produce a
// different answer between runs). ok is false for an empty counts map (no
// resolvable channel participation observed for this repeater at all).
func DominantScope(counts map[string]int) (scope string, total int, ok bool) {
	if len(counts) == 0 {
		return "", 0, false
	}
	channels := make([]string, 0, len(counts))
	for ch := range counts {
		channels = append(channels, ch)
	}
	sort.Strings(channels)

	best, bestCount := channels[0], counts[channels[0]]
	for _, ch := range channels[1:] {
		if counts[ch] > bestCount {
			best, bestCount = ch, counts[ch]
		}
	}
	return best, bestCount, true
}
