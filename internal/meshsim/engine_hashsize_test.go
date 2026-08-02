package meshsim

import "testing"

// Phase 3: path-hash size is a property of the packet, not of whichever
// node happens to be relaying it.

// --- phase 3: path-hash size is a packet property, not a node one --------
//
// Real firmware: the ORIGINATOR picks a message's path-hash size
// (Mesh::sendFlood(packet, delay, path_hash_size), src/Mesh.cpp:634) and it
// travels unchanged with the packet — a relay appends its own hash at the
// PACKET's size, never its own configured one (Mesh::routeRecvPacket,
// src/Mesh.cpp:335), and loop.detect reads the packet's size too
// (MyMesh::isLooped, examples/simple_repeater/MyMesh.cpp:404).

// TestMessageEffectiveHashSizeDefaultsAndClamps proves Message.HashSize's
// resolution: unset/zero falls back to defaultMessageHashSize, and
// out-of-range values clamp into the real 1-3 byte range the same way
// nodeHash's own hashSize parameter does.
func TestMessageEffectiveHashSizeDefaultsAndClamps(t *testing.T) {
	tests := []struct {
		name string
		in   int
		want int
	}{
		{"zero falls back to default", 0, defaultMessageHashSize},
		{"negative falls back to default", -1, defaultMessageHashSize},
		{"above 3 clamps to 3", 4, 3},
		{"1 passes through", 1, 1},
		{"2 passes through", 2, 2},
		{"3 passes through", 3, 3},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			m := Message{HashSize: tt.in}
			if got := m.effectiveHashSize(); got != tt.want {
				t.Errorf("Message{HashSize: %d}.effectiveHashSize() = %d, want %d", tt.in, got, tt.want)
			}
		})
	}
}

// TestOnAirLenIncludesPathBytes is a table-driven check against
// Packet::getRawLength's own wire layout (src/Packet.cpp): 2 framing bytes
// (header + path_len) + hash_count*hash_size accumulated path bytes +
// payload + 4 transport-code bytes when the packet carries them.
func TestOnAirLenIncludesPathBytes(t *testing.T) {
	tests := []struct {
		payloadLen, hashCount, hashSize int
		transport                       bool
		want                            int
	}{
		{20, 0, 3, false, 22}, // origin's own first send: no accumulated path yet, 2 framing bytes
		{20, 1, 3, false, 25}, // one relay hop at 3 bytes
		{20, 5, 1, false, 27}, // five hops at 1 byte
		{20, 2, 2, false, 26}, // two hops at 2 bytes
		{0, 0, 3, false, 2},   // zero-length payload still carries the 2 framing bytes
		{20, 0, 3, true, 26},  // region-scoped: + 4 transport-code bytes
		{20, 1, 3, true, 29},  // scoped, one relay hop
	}
	for _, tt := range tests {
		if got := onAirLen(tt.payloadLen, tt.hashCount, tt.hashSize, tt.transport); got != tt.want {
			t.Errorf("onAirLen(%d, %d, %d, %v) = %d, want %d", tt.payloadLen, tt.hashCount, tt.hashSize, tt.transport, got, tt.want)
		}
	}
}

// TestRunAirtimeGrowsWithHopCount is the regression guard for phase 3's
// airtime fix: two otherwise-identical relay chains of different depth
// must show STRICTLY increasing AirtimeMs per hop, since each additional
// hop's accumulated path bytes really are on the air (previously, airtime
// was computed from PayloadLen alone and never grew with path depth at
// all).
func TestRunAirtimeGrowsWithHopCount(t *testing.T) {
	// An 8-node chain: 0 -> 1 -> ... -> 7, all relays. Airtime is quantized
	// into whole LoRa symbols (see AirtimeMs's own ceil()), so consecutive
	// hops (each +3 accumulated path bytes) don't always cross a symbol
	// boundary — two adjacent hops can legitimately report identical
	// AirtimeMs (verified directly against AirtimeMs: at the default radio
	// params, hops 2->3 and 6->7 both plateau). So this only asserts
	// monotonic NON-decrease hop to hop, plus a strict increase between the
	// first and last hop reached — the real, hop-agnostic claim: a deeper
	// relay chain's packet costs strictly more airtime overall than a
	// shallow one's, even though not literally every single hop must.
	const chainLen = 8
	nodes := make([]SimNode, chainLen)
	var links []Link
	for i := 0; i < chainLen; i++ {
		nodes[i] = testNode(true)
		if i > 0 {
			links = append(links, Link{From: i - 1, To: i, SNRdB: 20})
		}
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	airtimeByHop := map[int]uint32{}
	for _, tx := range report.Transmissions {
		if tx.PacketID != 0 {
			continue
		}
		airtimeByHop[tx.HopCount] = tx.AirtimeMs
	}
	maxHop := -1
	for hop := range airtimeByHop {
		if hop > maxHop {
			maxHop = hop
		}
	}
	if maxHop < 3 {
		t.Fatalf("test setup: expected the chain to propagate at least 3 hops deep within the sim window, got hops up to %d: %+v", maxHop, airtimeByHop)
	}
	for hop := 0; hop < maxHop; hop++ {
		cur, ok := airtimeByHop[hop]
		if !ok {
			continue
		}
		next, ok := airtimeByHop[hop+1]
		if !ok {
			continue
		}
		if next < cur {
			t.Errorf("expected hop %d's airtime (%dms) to be at least hop %d's (%dms) — airtime must never SHRINK as the accumulated path grows", hop+1, next, hop, cur)
		}
	}
	if airtimeByHop[maxHop] <= airtimeByHop[0] {
		t.Errorf("expected the deepest hop's airtime (%dms, hop %d) to strictly exceed the origin's own (%dms, hop 0) — %d hops' worth of accumulated path bytes must cost something overall", airtimeByHop[maxHop], maxHop, airtimeByHop[0], maxHop)
	}
}

// TestRunRelayAppendsAtPacketHashSizeNotItsOwn proves a relay's own
// SimNode.HashSize has no bearing on the packet it merely relays — only on
// packets it originates. A message sent at 3-byte hash size through a
// relay configured with HashSize 1 must still be reported (and evaluated
// for loop.detect) at 3 bytes throughout.
func TestRunRelayAppendsAtPacketHashSizeNotItsOwn(t *testing.T) {
	const origin, relay, listener = 0, 1, 2
	nodes := []SimNode{testNode(false), testNode(true), testNode(false)}
	nodes[relay].HashSize = 1 // what this node stamps on packets IT originates — irrelevant here
	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: origin, To: relay, SNRdB: 20},
			{From: relay, To: listener, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var relayTx *Transmission
	for i := range report.Transmissions {
		if report.Transmissions[i].Node == relay && report.Transmissions[i].PacketID == 0 {
			relayTx = &report.Transmissions[i]
		}
	}
	if relayTx == nil {
		t.Fatal("expected node 1 to relay packet 0")
	}
	if relayTx.HashSize != 3 {
		t.Errorf("relay's own transmission HashSize = %d, want 3 (the packet's own size, not the relay's configured HashSize of 1)", relayTx.HashSize)
	}
	wantOnAir := onAirLen(20, 1, 3, false) // 1 accumulated hop (origin's own hash) at 3 bytes, unscoped (no transport codes)
	if relayTx.OnAirLen != wantOnAir {
		t.Errorf("relay's own transmission OnAirLen = %d, want %d", relayTx.OnAirLen, wantOnAir)
	}
}

// TestRunLoopDetectUsesPacketHashSizeNotListeners is a direct regression
// test: a listener's own
// configured SimNode.HashSize must never drive its own loop.detect
// evaluation — only the packet's own HashSize does (MyMesh::isLooped reads
// packet->getPathHashSize(), examples/simple_repeater/MyMesh.cpp:404).
//
// Listener D is configured with HashSize 1 (minimal threshold there would
// be 4 — see loopDetectThreshold), but the packet itself carries hash size
// 3 (minimal threshold 1). If the engine incorrectly used the listener's
// own HashSize, a single appearance of D's hash in the path would NOT
// trigger loop_detect (threshold 4 needs 4 appearances); using the
// packet's own size (3), it must trigger on the very first appearance.
func TestRunLoopDetectUsesPacketHashSizeNotListeners(t *testing.T) {
	// Find a node index X whose 3-byte hash collides with D's 3-byte hash
	// — same technique as the existing hash-collision tests, just at a
	// different hash size so this test can't accidentally pass via the
	// 1-byte table instead.
	var x, d int
	found := false
	seenHash := map[uint32]int{}
	for i := 0; i < 5000; i++ {
		h := nodeHash(i, 3)
		if j, ok := seenHash[h]; ok {
			x, d = j, i
			found = true
			break
		}
		seenHash[h] = i
	}
	if !found {
		t.Fatal("expected to find a 3-byte hash collision among node indices 0..4999")
	}

	n := x
	if d > n {
		n = d
	}
	origin := n + 1
	nodes := make([]SimNode, n+2)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	nodes[d].HashSize = 1 // the listener's own configured size — must NOT be what gates its own loop detect
	nodes[d].LoopDetect = "minimal"

	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: origin, To: x, SNRdB: 20},
			{From: x, To: d, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: origin, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atD *Reception
	for i := range report.Receptions {
		if report.Receptions[i].Node == d {
			atD = &report.Receptions[i]
		}
	}
	if atD == nil {
		t.Fatal("expected node d to receive the packet")
	}
	if atD.DropReason != "loop_detect" {
		t.Errorf("DropReason = %q, want %q — the packet's own 3-byte hash size gives a minimal threshold of 1 (loopDetectThreshold(\"minimal\", 3) == 1), which node d's single colliding hop should trip regardless of d's own configured HashSize of 1", atD.DropReason, "loop_detect")
	}
}

// SIMULATION_REVIEW.md A1: a single radio strictly serializes its own
// sends — two messages scheduled to overlap from one node must air
// back-to-back, never concurrently.
func TestRunOwnTransmissionsAreSerialized(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false)},
		Links: []Link{{From: 0, To: 1, SNRdB: 20}},
	}
	// Two sends 10ms apart, each frame far longer than 10ms of airtime.
	messages := []Message{
		{Origin: 0, SendAtMs: 0, PayloadLen: 200},
		{Origin: 0, SendAtMs: 10, PayloadLen: 200},
	}
	report := Run(scenario, messages, zeroRNG{}, 60000)
	if len(report.Transmissions) < 2 {
		t.Fatalf("expected both messages transmitted, got %d transmissions", len(report.Transmissions))
	}
	var spans [][2]uint32
	for _, tx := range report.Transmissions {
		if tx.Node == 0 {
			spans = append(spans, [2]uint32{tx.AtMs, tx.AtMs + tx.AirtimeMs})
		}
	}
	if len(spans) != 2 {
		t.Fatalf("expected exactly 2 transmissions from node 0, got %d", len(spans))
	}
	for i := 0; i < len(spans); i++ {
		for j := i + 1; j < len(spans); j++ {
			a, b := spans[i], spans[j]
			if a[0] < b[1] && b[0] < a[1] {
				t.Errorf("node 0 aired two packets concurrently: %v overlaps %v — a single radio cannot do that", a, b)
			}
		}
	}
}

// SIMULATION_REVIEW.md A2: firmware refuses to relay once the accumulated
// path would exceed MAX_PATH_SIZE (64 bytes) — 21 hops at 3-byte hashes.
// A long chain must show path_full drops instead of relaying forever.
func TestRunPathFullGateStopsDeepFloods(t *testing.T) {
	const chain = 30 // > 64/3 = 21 hops
	nodes := make([]SimNode, chain)
	links := make([]Link, 0, chain-1)
	for i := range nodes {
		nodes[i] = testNode(true)
		if i > 0 {
			links = append(links, Link{From: i - 1, To: i, SNRdB: 20})
		}
	}
	scenario := Scenario{Nodes: nodes, Links: links}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20, HashSize: 3}}
	report := Run(scenario, messages, zeroRNG{}, 10_000_000)

	maxHop := 0
	sawPathFull := false
	for _, r := range report.Receptions {
		if r.HopCount > maxHop {
			maxHop = r.HopCount
		}
		if r.DropReason == "path_full" {
			sawPathFull = true
		}
	}
	// The last APPENDER is hop index 20 (21 hashes incl. its own); the
	// packet it airs arrives with hopCount 21 and must NOT be relayed on.
	if maxHop > 21 {
		t.Errorf("flood reached hop %d — firmware's MAX_PATH_SIZE gate caps a 3-byte-hash flood at 21 accumulated hashes", maxHop)
	}
	if !sawPathFull {
		t.Error("expected at least one path_full drop on a 30-node chain")
	}
}
