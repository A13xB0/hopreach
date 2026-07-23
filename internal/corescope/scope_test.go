package corescope

import "testing"

func TestPrefixIndexResolvesUniquePrefix(t *testing.T) {
	nodes := []Node{
		{PublicKey: "096eb3d593c3f3e1ea14df4fa16432668b332cef40fe64cbe80e1a43870ffddb"},
		{PublicKey: "f1d961795545305dad9e43393e48292af377d5d63f7bac330da5056a6e60fb1a"},
	}
	idx := newPrefixIndex(nodes)

	got, ok := idx.resolve("096EB3") // mixed case, matches real CoreScope path casing
	if !ok || got != "096eb3d593c3f3e1ea14df4fa16432668b332cef40fe64cbe80e1a43870ffddb" {
		t.Errorf("resolve(096EB3) = (%q, %v), want the matching full pubkey", got, ok)
	}
}

func TestPrefixIndexAmbiguousPrefixDoesNotResolve(t *testing.T) {
	nodes := []Node{
		{PublicKey: "aabbccdd11223344"},
		{PublicKey: "aabbccee55667788"}, // shares the "aabbcc" prefix
	}
	idx := newPrefixIndex(nodes)

	if _, ok := idx.resolve("aabbcc"); ok {
		t.Error("expected an ambiguous prefix (matches 2 real nodes) to not resolve")
	}
}

func TestPrefixIndexUnknownPrefixDoesNotResolve(t *testing.T) {
	idx := newPrefixIndex([]Node{{PublicKey: "aabbccdd"}})
	if _, ok := idx.resolve("112233"); ok {
		t.Error("expected a prefix matching no known node to not resolve")
	}
}

// realTransportFloodPacketRawHex is a genuine packet captured from
// production CoreScope data (route_type=0/ROUTE_TYPE_TRANSPORT_FLOOD,
// payload_type=4/ADVERT, an "CRUMLIN-REPEATER" advert). Its embedded
// transport_code_1 (bytes 1-2, little-endian) is 0x3fee — independently
// verified, before this code was written, to match candidate region name
// "#ioi" and no other plausible candidate, confirming the HMAC-SHA256
// derivation in decodePacketRegion against real data rather than only
// synthetic test vectors.
const realTransportFloodPacketRawHex = "10EE3F00000461396EE460B91E7F95BB536D7156EA99773CB3330ED48125D374CFEE3D6637B9689876B7FA9B626A093F48F5C76A01216A86C37E1E35B962A4DDA8C2D314C753816797A5E7EEC200B47EFB22FC88FAF7D51A893AF72674EAFDA9886D559964416FBB1827F65E980492816941037C18A1FF4352554D4C494E2D5245504541544552"

func candidateKeysFor(names ...string) map[string][16]byte {
	keys := make(map[string][16]byte, len(names))
	for _, n := range names {
		keys[n] = regionKey(n)
	}
	return keys
}

func TestDecodePacketRegionMatchesRealCapturedPacket(t *testing.T) {
	keys := candidateKeysFor("#sco", "#ioi", "#ioi-admin", "#edi", "#fif", "#wls", "#noc")
	region, ok := decodePacketRegion(realTransportFloodPacketRawHex, keys)
	if !ok || region != "#ioi" {
		t.Errorf("decodePacketRegion = (%q, %v), want (\"#ioi\", true)", region, ok)
	}
}

func TestDecodePacketRegionNoMatchAmongWrongCandidates(t *testing.T) {
	keys := candidateKeysFor("#sco", "#edi", "#fif") // deliberately excludes the real "#ioi"
	_, ok := decodePacketRegion(realTransportFloodPacketRawHex, keys)
	if ok {
		t.Error("expected no match when the real region isn't in the candidate set")
	}
}

func TestDecodePacketRegionRejectsNonTransportRouteTypes(t *testing.T) {
	// Flip the route-type bits (bits 0-1) from 00 (TRANSPORT_FLOOD) to 01
	// (plain FLOOD, no transport code at all) on an otherwise-identical
	// packet — must never produce a match, transport code or not, since a
	// plain-flood packet carries no such field on the wire.
	raw := []byte(realTransportFloodPacketRawHex)
	raw[1] = '1' // header byte's low nibble: 0x10 -> 0x11 (route_type 0 -> 1)
	keys := candidateKeysFor("#sco", "#ioi", "#edi", "#fif")
	_, ok := decodePacketRegion(string(raw), keys)
	if ok {
		t.Error("expected no match for a non-transport route type")
	}
}

func TestDecodePacketRegionHandlesMalformedHex(t *testing.T) {
	keys := candidateKeysFor("#sco")
	if _, ok := decodePacketRegion("not-hex", keys); ok {
		t.Error("expected malformed hex to fail gracefully, not match")
	}
	if _, ok := decodePacketRegion("10", keys); ok {
		t.Error("expected a too-short packet to fail gracefully, not match")
	}
}

func TestTallyPacketCountsResolvedHopsForTheDecodedRegion(t *testing.T) {
	// Real path from the captured packet above: 61 39 6e e4 (4 one-byte
	// hops, hash_size=1 per path_length byte 0x04).
	nodes := []Node{
		{PublicKey: "61aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
		{PublicKey: "39bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
		{PublicKey: "6ecccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"},
		{PublicKey: "e4dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"},
	}
	idx := newPrefixIndex(nodes)
	keys := candidateKeysFor("#sco", "#ioi", "#edi", "#fif")
	counts := make(map[string]map[string]int)

	tallyPacket(counts, idx, keys, packetSummary{
		RawHex:     realTransportFloodPacketRawHex,
		ParsedPath: []string{"61", "39", "6e", "e4"},
	})

	for _, n := range nodes {
		pk := n.PublicKey
		if counts[pk]["#ioi"] != 1 {
			t.Errorf("expected %s to be tallied once for #ioi, got %+v", pk, counts[pk])
		}
	}
}

func TestTallyPacketSkipsUnresolvableHops(t *testing.T) {
	idx := newPrefixIndex([]Node{{PublicKey: "aabbccdd"}})
	keys := candidateKeysFor("#sco", "#ioi", "#edi", "#fif")
	counts := make(map[string]map[string]int)

	tallyPacket(counts, idx, keys, packetSummary{
		RawHex:     realTransportFloodPacketRawHex,
		ParsedPath: []string{"ffffff"}, // matches no known node
	})

	if len(counts) != 0 {
		t.Errorf("expected no tallies for an unresolvable hop, got %+v", counts)
	}
}

func TestObservedScopesReturnsEveryConfirmedRegion(t *testing.T) {
	// A real repeater can genuinely have more than one region enabled at
	// once — every region with a confirmed observation must come back,
	// not just the most-observed one.
	got := ObservedScopes(map[string]int{"#sco": 5, "#ioi": 12, "#fif": 3})
	want := []string{"#fif", "#ioi", "#sco"} // sorted alphabetically
	if len(got) != len(want) {
		t.Fatalf("ObservedScopes = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("ObservedScopes[%d] = %q, want %q (full: %v)", i, got[i], want[i], got)
		}
	}
}

func TestObservedScopesEmptyCountsReturnsNil(t *testing.T) {
	got := ObservedScopes(map[string]int{})
	if len(got) != 0 {
		t.Errorf("expected ObservedScopes to return empty for an empty counts map, got %v", got)
	}
}

func TestObservedScopesSingleRegion(t *testing.T) {
	got := ObservedScopes(map[string]int{"#sco": 1})
	if len(got) != 1 || got[0] != "#sco" {
		t.Errorf("ObservedScopes = %v, want [#sco]", got)
	}
}
