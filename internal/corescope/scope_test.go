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

func TestTallyPacketSkipsUndecodedPackets(t *testing.T) {
	idx := newPrefixIndex([]Node{{PublicKey: "aabbccdd"}})
	counts := make(map[string]map[string]int)

	tallyPacket(counts, idx, packetSummary{
		DecodedJSON: `{"type":"GRP_TXT","decryptionStatus":"decryption_failed"}`,
		ParsedPath:  []string{"aabbcc"},
	})

	if len(counts) != 0 {
		t.Errorf("expected no tallies from an undecoded packet, got %+v", counts)
	}
}

func TestTallyPacketCountsResolvedHops(t *testing.T) {
	nodes := []Node{{PublicKey: "aabbccdd"}, {PublicKey: "112233ff"}}
	idx := newPrefixIndex(nodes)
	counts := make(map[string]map[string]int)

	tallyPacket(counts, idx, packetSummary{
		DecodedJSON: `{"type":"CHAN","channel":"#test","decryptionStatus":"decrypted"}`,
		ParsedPath:  []string{"aabbcc", "112233"},
	})

	if counts["aabbccdd"]["#test"] != 1 {
		t.Errorf("expected aabbccdd to be tallied once for #test, got %+v", counts["aabbccdd"])
	}
	if counts["112233ff"]["#test"] != 1 {
		t.Errorf("expected 112233ff to be tallied once for #test, got %+v", counts["112233ff"])
	}
}

func TestTallyPacketSkipsUnresolvableHops(t *testing.T) {
	idx := newPrefixIndex([]Node{{PublicKey: "aabbccdd"}})
	counts := make(map[string]map[string]int)

	tallyPacket(counts, idx, packetSummary{
		DecodedJSON: `{"type":"CHAN","channel":"#test","decryptionStatus":"decrypted"}`,
		ParsedPath:  []string{"ffffff"}, // matches no known node
	})

	if len(counts) != 0 {
		t.Errorf("expected no tallies for an unresolvable hop, got %+v", counts)
	}
}

func TestDominantScopePicksHighestCount(t *testing.T) {
	scope, total, ok := DominantScope(map[string]int{"#sco": 5, "#ioi": 12, "#fif": 3})
	if !ok || scope != "#ioi" || total != 12 {
		t.Errorf("DominantScope = (%q, %d, %v), want (#ioi, 12, true)", scope, total, ok)
	}
}

func TestDominantScopeEmptyCountsNotOK(t *testing.T) {
	_, _, ok := DominantScope(map[string]int{})
	if ok {
		t.Error("expected DominantScope to report ok=false for an empty counts map")
	}
}

func TestDominantScopeBreaksTiesAlphabetically(t *testing.T) {
	// A genuine tie should still be deterministic across runs, not depend
	// on Go's randomized map iteration order.
	for i := 0; i < 5; i++ {
		scope, _, ok := DominantScope(map[string]int{"#zzz": 4, "#aaa": 4})
		if !ok || scope != "#aaa" {
			t.Fatalf("DominantScope tie-break = %q, want #aaa (alphabetically first)", scope)
		}
	}
}
