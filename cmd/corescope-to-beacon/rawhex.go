package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// Raw frame bytes, fetched from CoreScope's own API.
//
// This is the one place the tool speaks a vendor's wire format, and it is
// deliberate: migrating between two stores is exactly the job that has to know
// both. meshsource.Packet carries what a packet's bytes *mean* — scope, route
// type, hash size, path — which is what HopReach needs and what makes the
// backends interchangeable. It does not carry the bytes themselves, and it
// should not: no HopReach feature reads them.
//
// Beacon does. Its packet-detail endpoint parses raw_payload with the real
// MeshCore decoders, so a placeholder there is not a harmless gap — the
// endpoint returns 500, which takes packet replay and region participation
// down with it. Copying the real bytes is the only honest fix; synthesising
// something parseable would put fabricated payloads in a database that
// presents them as observed traffic.

// rawFrames maps packet hash to its raw over-the-air hex.
type rawFrames map[string]string

// fetchRawFrames pulls CoreScope's own packet list for the raw_hex column.
//
// One paged walk rather than a request per packet: the list carries raw_hex
// already, so the per-packet detail calls the rest of the migration makes are
// for observations, not bytes.
func (m *migration) fetchRawFrames(ctx context.Context, apiURL string, want int) (rawFrames, error) {
	out := make(rawFrames, want)
	const page = 500
	for offset := 0; offset < want*4 && len(out) < want; offset += page {
		url := fmt.Sprintf("%s/api/packets?limit=%d&offset=%d&sort=timestamp&order=desc",
			strings.TrimRight(apiURL, "/"), page, offset)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		resp, err := m.http.Do(req)
		if err != nil {
			return nil, fmt.Errorf("fetching raw frames: %w", err)
		}
		var parsed struct {
			Packets []struct {
				Hash   string `json:"hash"`
				RawHex string `json:"raw_hex"`
			} `json:"packets"`
		}
		err = json.NewDecoder(resp.Body).Decode(&parsed)
		resp.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("decoding raw frames: %w", err)
		}
		if len(parsed.Packets) == 0 {
			break
		}
		for _, p := range parsed.Packets {
			if p.Hash != "" && p.RawHex != "" {
				out[strings.ToLower(p.Hash)] = strings.ToLower(p.RawHex)
			}
		}
	}
	return out, nil
}

// splitFrame divides a raw frame into the header and payload halves Beacon
// stores separately, using the frame's own path_len byte to find the boundary
// — the same layout ParseFrame reads.
//
// Returns false when the frame is too short or internally inconsistent, so the
// caller can skip the packet rather than store a truncated one.
func splitFrame(rawHex string) (header, payload string, ok bool) {
	raw, err := hex.DecodeString(rawHex)
	if err != nil || len(raw) < 2 {
		return "", "", false
	}
	routeType := int(raw[0] & 0x03)
	i := 1
	if routeType == 0 || routeType == 3 { // transport flood / direct
		i += 4
	}
	if i >= len(raw) {
		return "", "", false
	}
	pathLen := raw[i]
	i++
	hopCount := int(pathLen & 0x3F)
	hashSize := int(pathLen>>6) + 1
	start := i + hopCount*hashSize
	if start > len(raw) {
		return "", "", false
	}
	return hex.EncodeToString(raw[:start]), hex.EncodeToString(raw[start:]), true
}
