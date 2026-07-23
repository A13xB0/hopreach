package corescope

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
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
// double-encoded as a JSON *string*). Unlike the single-packet detail
// endpoint (GET /api/packets/{hash}), the bulk list does not include
// resolved_path (full public keys) — resolvePrefixes below does that
// resolution here instead, against a full node directory fetched once up
// front.
type packetSummary struct {
	Timestamp  string   `json:"timestamp"`
	RawHex     string   `json:"raw_hex"`
	RouteType  int      `json:"route_type"`
	ParsedPath []string `json:"_parsedPath"`
}

type packetsResponse struct {
	Packets []packetSummary `json:"packets"`
	Total   int             `json:"total"`
}

type scopeStatsResponse struct {
	ByRegion []struct {
		Name string `json:"name"`
	} `json:"byRegion"`
}

// MeshCore route types that carry the 4-byte transport_codes field this
// package decodes — see decodePacketRegion. Every other route type (plain
// flood, plain direct) carries no per-packet region information at all.
const (
	routeTypeTransportFlood  = 0
	routeTypeTransportDirect = 3
)

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

// scopeStatsWindow is fixed at CoreScope's own longest supported window
// (its GET /api/scope-stats only accepts the literal values "1h", "24h",
// or "7d" — not an arbitrary hour count) — deliberately independent of
// this package's own configurable packet-tally window (see
// FetchRegionParticipation's since parameter): this call's only job is
// discovering which real regions exist at all, so the widest window gives
// it the best chance of finding a region that's gone quiet more recently.
const scopeStatsWindow = "7d"

// FetchKnownRegionNames returns the real, currently-active region names
// CoreScope's own analytics already knows about (its GET /api/scope-stats
// "byRegion" breakdown — e.g. "#sco", "#fif", "#edi") — the authoritative
// candidate list decodePacketRegion checks each packet's transport code
// against, rather than guessing at region names ourselves.
func (c *Client) FetchKnownRegionNames(ctx context.Context) ([]string, error) {
	url := fmt.Sprintf("%s/api/scope-stats?window=%s", c.BaseURL, scopeStatsWindow)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("corescope: building request for %s: %w", url, err)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("corescope: fetching %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("corescope: fetching %s: unexpected status %d", url, resp.StatusCode)
	}
	var parsed scopeStatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("corescope: decoding response from %s: %w", url, err)
	}
	names := make([]string, 0, len(parsed.ByRegion))
	for _, r := range parsed.ByRegion {
		if r.Name != "" {
			names = append(names, r.Name)
		}
	}
	return names, nil
}

// regionKey derives a region's 16-byte transport key straight from its
// public name — see MeshCore's own src/helpers/TransportKeyStore.cpp,
// TransportKeyStore::getAutoKeyFor: "calc key for publicly-known hashtag
// region name" is literally sha256(name)[:16], no secret involved. Any
// region name in FetchKnownRegionNames' own list is, by definition, public.
func regionKey(name string) [16]byte {
	digest := sha256.Sum256([]byte(name))
	var key [16]byte
	copy(key[:], digest[:16])
	return key
}

// decodePacketRegion recovers which region a packet's flood actually
// belongs to, straight from its raw over-the-air bytes — see
// docs/packet_format.md (fetched from github.com/meshcore-dev/MeshCore)
// for the wire format this parses, and TransportKeyStore.cpp's
// calcTransportCode for the HMAC this reverses. Only
// ROUTE_TYPE_TRANSPORT_FLOOD/_DIRECT packets carry a transport code at
// all (checked by the caller via routeType); every candidate region name
// is tried in turn since computing the code requires the *key*, which
// isn't itself present in the packet.
//
// Verified against real production data before this was written: a real
// captured packet's embedded transport_code_1 (0x3fee) matched exactly
// one candidate ("#ioi") out of a realistic candidate set, computed
// entirely independently from CoreScope's own classification of that
// packet.
func decodePacketRegion(rawHex string, candidateKeys map[string][16]byte) (region string, ok bool) {
	raw, err := hex.DecodeString(rawHex)
	if err != nil || len(raw) < 6 {
		return "", false
	}
	header := raw[0]
	routeType := int(header & 0x03)
	if routeType != routeTypeTransportFlood && routeType != routeTypeTransportDirect {
		return "", false
	}
	payloadType := (header >> 2) & 0x0F
	if len(raw) < 5 {
		return "", false
	}
	transportCode1 := uint16(raw[1]) | uint16(raw[2])<<8 // little-endian, matching the firmware's own native uint16_t layout

	pathLenByte := raw[5]
	hopCount := int(pathLenByte & 0x3F)
	hashSize := int(pathLenByte>>6) + 1
	pathEnd := 6 + hopCount*hashSize
	if pathEnd > len(raw) {
		return "", false // malformed/truncated capture
	}
	payload := raw[pathEnd:]

	msg := make([]byte, 0, 1+len(payload))
	msg = append(msg, payloadType)
	msg = append(msg, payload...)

	for name, key := range candidateKeys {
		mac := hmac.New(sha256.New, key[:])
		mac.Write(msg)
		sum := mac.Sum(nil)
		code := uint16(sum[0]) | uint16(sum[1])<<8 // little-endian, matching calcTransportCode's own uint16_t output
		if code == transportCode1 {
			return name, true
		}
	}
	return "", false
}

// FetchRegionParticipation walks CoreScope's GET /api/packets newest-first
// (see the package doc on sort order this relies on), stopping once it
// reaches packets older than since, and tallies which real region(s) each
// resolvable repeater appears in as a relay-path participant — decoded
// straight from each packet's own transport code (see decodePacketRegion),
// not any secondhand classification. Returns pubkey (lowercase) -> region
// name -> observed count.
//
// A repeater's own self-reported default_scope is too sparse to build a
// map from on its own (confirmed against production: empty for ~76% of
// real repeaters) — this observes real relay behavior instead.
func (c *Client) FetchRegionParticipation(ctx context.Context, since time.Time, nodes []Node, regionNames []string) (map[string]map[string]int, error) {
	idx := newPrefixIndex(nodes)
	candidateKeys := make(map[string][16]byte, len(regionNames))
	for _, name := range regionNames {
		candidateKeys[name] = regionKey(name)
	}

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
			tallyPacket(counts, idx, candidateKeys, p)
		}
		if reachedWindowStart || len(page.Packets) < packetPageLimit {
			break
		}
		offset += len(page.Packets)
	}
	return counts, nil
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

func tallyPacket(counts map[string]map[string]int, idx prefixIndex, candidateKeys map[string][16]byte, p packetSummary) {
	region, ok := decodePacketRegion(p.RawHex, candidateKeys)
	if !ok {
		return
	}
	for _, hop := range p.ParsedPath {
		pubkey, ok := idx.resolve(hop)
		if !ok {
			continue
		}
		if counts[pubkey] == nil {
			counts[pubkey] = make(map[string]int)
		}
		counts[pubkey][region]++
	}
}

// ObservedScopes returns every region counts has at least one confirmed
// observation for, sorted alphabetically for reproducible output. A real
// MeshCore repeater can have more than one region enabled at once (see
// RegionMap's own support for a node holding several regions' transport
// keys simultaneously) — collapsing to a single "dominant" scope would
// silently drop real memberships. Unlike the project's earlier, incorrect
// channel-name-based approach, a match here comes from an HMAC transport
// code verification, which is either right or it isn't — there's no
// "probably noise, filter it out" case the way a fuzzy signal would need;
// every entry in counts is a genuine, cryptographically confirmed
// observation, so no minimum-count threshold is applied.
func ObservedScopes(counts map[string]int) []string {
	if len(counts) == 0 {
		return nil
	}
	regions := make([]string, 0, len(counts))
	for r := range counts {
		regions = append(regions, r)
	}
	sort.Strings(regions)
	return regions
}
