package meshsim

import (
	"container/heap"
)

// SimNode is one node's static simulation properties. NodePrefs governs its
// own relay-delay behavior; CanRelay lets a plain client be modeled
// distinctly from a repeater (a client that only originates/receives
// traffic, never re-floods it).
type SimNode struct {
	Prefs    NodePrefs `json:"prefs"`
	CanRelay bool      `json:"canRelay"`
	// Regions lists every MeshCore region this node holds a transport key
	// for (see corescope.ObservedScopes/inferred_scopes — real region
	// membership, not a guess). Empty means "no known region membership,"
	// which still relays ordinary unscoped flood traffic (a plain flood
	// carries no region-specific transport code, so any repeater can
	// process it — see docs.meshcore.io's `region default`), but such a
	// node can never relay a Message tagged with a specific Region: real
	// firmware verifies a region-scoped packet's transport code against
	// its own loaded region keys before re-flooding it, and a node with no
	// matching key can't validate (or legitimately re-encode) it at all.
	// The single entry "*" is a simulator-only wildcard (not a real
	// MeshCore concept) meaning "accept every region" — used as the
	// default for a planned repeater, whose real region configuration is
	// unknown, so a what-if run isn't silently sabotaged by an unrelated
	// scope gate the user never set (see acceptsRegion).
	Regions []string `json:"regions,omitempty"`
	// LoopDetect mirrors `set loop.detect <off|minimal|moderate|strict>`
	// (see docs.meshcore.io/cli_commands): a repeater configured with this
	// on rejects (won't relay) a flood packet whose accumulated path
	// already shows *this node's own* path-hash appearing at least as many
	// times as the level's own threshold — see loopDetectThreshold. Empty
	// or "off" (the real firmware default) never rejects anything.
	LoopDetect string `json:"loopDetect,omitempty"`
	// HashSize mirrors this node's own configured path-hash size in bytes
	// (1-3, matching corescope.Node.HashSize for a real repeater) — but
	// only for packets THIS node originates (real firmware:
	// Mesh::sendFlood(packet, delay, path_hash_size), src/Mesh.cpp:634,
	// which stamps the size onto the packet itself at send time). It has
	// no bearing on how this node evaluates loop.detect on packets it
	// merely relays: a relay appends its own hash at the PACKET's own
	// size, never its own configured one (Mesh::routeRecvPacket,
	// src/Mesh.cpp:335), and loop.detect's thresholds are likewise read at
	// the packet's size (MyMesh::isLooped, examples/simple_repeater/
	// MyMesh.cpp:404) — see Message.HashSize, which is what actually
	// drives both of those. Defaults to defaultMessageHashSize if
	// unset/zero, matching nodeHash's own floor.
	HashSize int `json:"hashSize,omitempty"`
	// FloodMax/FloodMaxUnscoped/FloodMaxAdvert mirror real firmware's
	// `flood.max` / `flood.max.unscoped` / `flood.max.advert` settings
	// (docs.meshcore.io/cli_commands; verified against
	// examples/simple_repeater/MyMesh.cpp's own forwarding gate, which
	// checks all three independently and cumulatively — a packet is
	// refused the moment ANY applicable one is reached):
	//
	//	if (packet->getPathHashCount() >= _prefs.flood_max) return false;
	//	if (packet->getRouteType() == ROUTE_TYPE_FLOOD && packet->getPathHashCount() >= _prefs.flood_max_unscoped) return false;
	//	if (packet->getPayloadType() == PAYLOAD_TYPE_ADVERT && packet->getPathHashCount() >= _prefs.flood_max_advert) return false;
	//
	// FloodMax always applies. FloodMaxUnscoped additionally applies when
	// the packet carries no region (see Message.Region) — an ordinary
	// unscoped flood. FloodMaxAdvert would additionally apply to
	// MeshCore's ADVERT payload type specifically; this simulator doesn't
	// yet model a distinct advert traffic kind (every Message here is an
	// ordinary flood send), so the field exists for configuration
	// completeness but has no effect yet. Zero/unset on any of the three
	// falls back to the real firmware default for that setting — 64, 64,
	// 8 respectively (see effectiveFloodMax/effectiveFloodMaxUnscoped).
	FloodMax         int `json:"floodMax,omitempty"`
	FloodMaxUnscoped int `json:"floodMaxUnscoped,omitempty"`
	FloodMaxAdvert   int `json:"floodMaxAdvert,omitempty"`
	// DenyUnscoped inverts the sense of "allow unscoped" so the zero value
	// (false) matches real firmware's default: regions are additive —
	// holding region keys lets a node relay *extra* scoped traffic, it
	// doesn't stop it relaying ordinary unscoped floods (see acceptsRegion).
	// Setting this true is a simulator what-if knob (model a repeater
	// that's had unscoped relaying explicitly disabled), not a claim about
	// what any real repeater actually does by default.
	DenyUnscoped bool `json:"denyUnscoped,omitempty"`
}

// Real firmware defaults (examples/simple_repeater/MyMesh.cpp) for
// FloodMax/FloodMaxUnscoped/FloodMaxAdvert respectively.
const (
	DefaultFloodMax         = 64
	DefaultFloodMaxUnscoped = 64
	DefaultFloodMaxAdvert   = 8
)

func (n SimNode) effectiveFloodMax() int {
	if n.FloodMax <= 0 {
		return DefaultFloodMax
	}
	return n.FloodMax
}

func (n SimNode) effectiveFloodMaxUnscoped() int {
	if n.FloodMaxUnscoped <= 0 {
		return DefaultFloodMaxUnscoped
	}
	return n.FloodMaxUnscoped
}

// acceptsRegion reports whether node can relay a message tagged with
// region — see Regions' own doc comment. An empty region (ordinary,
// unscoped flood traffic) is accepted regardless of the node's own Regions,
// unless DenyUnscoped explicitly turns that off.
func (n SimNode) acceptsRegion(region string) bool {
	if region == "" {
		return !n.DenyUnscoped
	}
	for _, r := range n.Regions {
		if r == "*" || r == region {
			return true
		}
	}
	return false
}

// nodeHash returns nodeIndex's own deterministic path-hash byte value at
// hashSize bytes (1-3, floored to 1) — real MeshCore derives this from a
// node's public key; since this simulator doesn't model full key material,
// this derives a stable pseudo-hash from the node's own index instead.
// What matters for faithfully reproducing loop.detect's real failure mode
// (see SimNode.HashSize) isn't the exact hash value, only that two
// different node indices collide at small hash sizes roughly as often as
// two different real keys would — a well-mixed multiplicative hash,
// truncated, does that.
func nodeHash(nodeIndex int, hashSize int) uint32 {
	if hashSize < 1 {
		hashSize = 1
	}
	if hashSize > 3 {
		hashSize = 3
	}
	// A single multiply-add is a *bijection* on its own low bits for
	// sequential input (nodeIndex 0, 1, 2, ...), since multiplying by an
	// odd constant mod 2^32 can't collide until the input range actually
	// exceeds the output range — which would make consecutive small node
	// indices artificially collision-free, exactly backwards from a real
	// (effectively random) public-key-derived hash. This is the standard
	// 32-bit integer finalizer (as used in MurmurHash3's fmix32/splitmix32)
	// instead — its xor-shift/multiply rounds give real avalanche, so even
	// sequential input produces the same birthday-paradox-style collision
	// behavior a real key-derived hash would.
	h := uint32(nodeIndex)
	h ^= h >> 16
	h *= 0x7feb352d
	h ^= h >> 15
	h *= 0x846ca68b
	h ^= h >> 16
	return h & (uint32(1)<<(8*hashSize) - 1)
}

// loopDetectThreshold returns how many times node's own path-hash must
// already appear in a packet's accumulated path before node's LoopDetect
// level rejects relaying it — mirrors the real, documented thresholds
// exactly (see docs.meshcore.io/cli_commands's `loop.detect`). 0 means
// "never triggers" (an unrecognized/empty level, treated the same as
// "off").
func loopDetectThreshold(level string, hashSize int) int {
	switch level {
	case "minimal":
		switch hashSize {
		case 1:
			return 4
		case 2:
			return 2
		default:
			return 1
		}
	case "moderate":
		if hashSize == 1 {
			return 2
		}
		return 1
	case "strict":
		return 1
	default:
		return 0
	}
}

// shouldDropForLoop reports whether node (whose own path-hash is myHash —
// see nodeHash) would reject relaying a packet whose accumulated
// path-hash sequence is pathHashes, per node's own LoopDetect level.
// packetHashSize is the SENDING packet's own path-hash size (see
// Message.HashSize) — real firmware's MyMesh::isLooped reads
// packet->getPathHashSize(), not anything configured on the node doing the
// checking (examples/simple_repeater/MyMesh.cpp:404), since a relay can
// never change the hash size an already-in-flight packet was stamped with.
func (n SimNode) shouldDropForLoop(myHash uint32, pathHashes []uint32, packetHashSize int) bool {
	threshold := loopDetectThreshold(n.LoopDetect, packetHashSize)
	if threshold <= 0 {
		return false
	}
	count := 0
	for _, h := range pathHashes {
		if h == myHash {
			count++
		}
	}
	return count >= threshold
}

// cadFailRetryDelayMs/cadFailMaxDurationMs mirror Dispatcher::
// getCADFailRetryDelay()/getCADFailMaxDuration() exactly: real firmware's
// checkSend() won't key the radio to transmit while _radio->isReceiving()
// says the channel is currently busy (some other audible transmission is
// mid-flight) — it backs off and retries every 200ms, up to 4 real
// seconds, after which it forces the transmission through anyway (treating
// a channel that's been "busy" that long as a stuck radio, not a real
// collision risk worth waiting out further). This is a genuinely separate
// mechanism from the random relay-delay spread (RetransmitDelayMs) — that
// spread only reduces the *chance* two nodes pick the same instant; CAD is
// what actually looks at the channel immediately before transmitting and
// defers if it's not clear. Previously unmodeled entirely, which
// overstated collisions specifically in the (very common) case where two
// contending nodes *can* hear each other directly — CAD can't help at all
// in the classic hidden-node case (two senders that can't hear each other
// but share a downstream listener), so that scenario's collision rate is
// unaffected by this.
// Firmware note: Dispatcher's base implementation returns a fixed 200ms,
// but Mesh overrides it with a randomized nextInt(1,4)*120 — 120/240/360ms
// (src/Mesh.cpp) — and that override is what every repeater build runs.
// The randomization exists to break retry lockstep between two deferring
// nodes; a fixed cadence made them re-collide every round
// (SIMULATION_REVIEW.md A4).
func cadFailRetryDelayMs(rng RNG) uint32 {
	return uint32(1+rng.IntN(3)) * 120
}

const cadFailMaxDurationMs = 4000

// maxPathSizeBytes mirrors MeshCore's MAX_PATH_SIZE (MeshCore.h): the
// accumulated relay-path buffer a packet can carry. A relay refuses to
// append its own hash past this.
const maxPathSizeBytes = 64

// transmission is one node's single over-the-air send of one packet —
// tracked globally for the lifetime of the simulation so collision checks
// can scan for time-overlapping transmissions audible to the same listener.
type transmission struct {
	sender         int
	packetID       int
	startMs, endMs uint32
	payloadLen     int
	radio          LoRaParams
	region         string
	direct         bool // see Message.Direct
	hopCount       int  // 0 for the origin's own first send, incremented per relay — see Transmission.HopCount
	// hashSize is the originating Message's own path-hash size (see
	// Message.HashSize) — set once at the origin and carried unchanged by
	// every relay's own re-push, never recomputed from the relaying
	// node's own SimNode.HashSize (see shouldDropForLoop's doc comment on
	// why a relay can't do that).
	hashSize int
	// path is the sequence of path-hashes (see nodeHash) every relay of
	// this packet has appended so far, in relay order — what
	// SimNode.shouldDropForLoop checks a prospective next relay against.
	// The original send carries an empty path (real MeshCore packets
	// start with none too).
	path []uint32
	// pathNodes is path's counterpart in real node indices rather than
	// hashes — kept separately because loop.detect's whole real failure
	// mode is that a hash *doesn't* uniquely identify a node (see
	// nodeHash), so path can't be used to reconstruct which actual nodes
	// relayed this packet. Reception.Path is copied from this.
	pathNodes []int
	// budgetDeferred is true if this specific transmission was pushed back
	// at least once by the sender's own duty-cycle budget (see txBudget)
	// before actually going out.
	budgetDeferred bool
	// cadDeferred is true if this specific transmission was pushed back
	// at least once by CAD before actually going out — see
	// Reception.SenderWasCADDeferred.
	cadDeferred bool
}

// eventKind distinguishes the two things that can happen at a point in
// simulated time.
type eventKind int

const (
	eventSend eventKind = iota
	eventRxComplete
)

type event struct {
	atMs uint32
	kind eventKind

	// eventSend fields
	sender     int
	packetID   int
	payloadLen int
	hopCount   int
	region     string   // carried unchanged from the originating Message through every relay — see Message.Region
	direct     bool     // carried unchanged from the originating Message through every relay — see Message.Direct
	hashSize   int      // carried unchanged from the originating Message through every relay — see transmission.hashSize
	path       []uint32 // this send's own accumulated path-hash sequence so far — see transmission.path
	pathNodes  []int    // this send's own accumulated real-node-index path so far — see transmission.pathNodes
	// cadDeferred/cadBusyStart track a send that's already been pushed back
	// once by CAD (see channelBusy) — cadBusyStart is when the channel was
	// *first* observed busy for this particular pending send, so a chain of
	// 200ms retries can measure its own total wait against
	// cadFailMaxDurationMs, matching real firmware's cad_busy_start.
	cadDeferred  bool
	cadBusyStart uint32
	// budgetDeferred marks a send that's already been pushed back at least
	// once by the sender's own duty-cycle budget — see txBudget.
	budgetDeferred bool
	// background/frameBytes carry a fixed replayed background transmission
	// (see Message.Background/FrameBytes) — a background send never defers,
	// never relays, and uses frameBytes for its airtime directly.
	background bool
	frameBytes int

	// eventRxComplete fields
	txIndex  int // index into engine.transmissions
	listener int
}

// eventQueue is a container/heap min-heap ordered by event.atMs.
type eventQueue []event

func (q eventQueue) Len() int           { return len(q) }
func (q eventQueue) Less(i, j int) bool { return q[i].atMs < q[j].atMs }
func (q eventQueue) Swap(i, j int)      { q[i], q[j] = q[j], q[i] }
func (q *eventQueue) Push(x any)        { *q = append(*q, x.(event)) }
func (q *eventQueue) Pop() any {
	old := *q
	n := len(old)
	item := old[n-1]
	*q = old[:n-1]
	return item
}

// AblationFlags disables individual real-firmware mechanisms this package
// models — a research instrument for explaining WHICH mechanism accounts
// for a measured
// difference (e.g. "does zero-delay behave differently with and without
// half-duplex modeled"), not a user-facing setting. All fields default
// false — the zero value means "every mechanism enabled," i.e. identical
// behaviour to Run before this type existed, which is what
// TestRunWithAblationZeroValueMatchesRun asserts byte-for-byte.
//
// Deliberately NOT exposed in the main UI: someone disabling half-duplex
// to "improve" their numbers would get
// confidently wrong answers, exactly the failure mode this whole
// simulator exists to avoid). A debug-only surface at most.
type AblationFlags struct {
	// DisableTxBusy skips the half-duplex "can't receive while
	// transmitting" gate (see the txBusy check below) — every reception
	// is evaluated as if the listener's own transmitter were never keyed.
	DisableTxBusy bool
	// DisableCAD skips the channel-busy-detection deferral (channelBusy)
	// — a node transmits immediately regardless of what it could
	// currently hear.
	DisableCAD bool
	// DisableDutyCycle skips the duty-cycle budget deferral (txBudget) —
	// a node can transmit as often as it likes, unconstrained by the
	// real ~50% airtime cap.
	DisableDutyCycle bool
	// DisableCapture skips the LoRa capture effect: any overlapping,
	// audible interferer that arrives after the wanted signal's own lock
	// deadline always corrupts it (outcomeCorrupted), never
	// outcomeCaptured, regardless of the actual SNR margin between them —
	// the pre-phase-1 model, before the capture effect was added (see
	// v0.1.22's own changelog: "every time-overlap... was treated as
	// mutual destruction").
	DisableCapture bool
	// DisablePathByteAirtime computes airtime/PacketScore from the raw
	// application payload length alone, the pre-phase-3 model — ignoring
	// the path_len byte and accumulated per-hop path bytes real firmware
	// actually transmits (see onAirLen).
	DisablePathByteAirtime bool
}

// Run simulates scenario under messages (each an originating flood send)
// out to maxSimTimeMs, using rng for every randomized retransmit delay —
// pass a seeded, deterministic RNG to make two runs (e.g. before/after a
// config change) comparable against identical random draws rather than
// confounding "did the new settings help" with "did this run just get
// luckier." Every real firmware mechanism this package models is active —
// for the ablation research instrument that selectively disables them,
// see RunWithAblation.
func Run(scenario Scenario, messages []Message, rng RNG, maxSimTimeMs uint32) Report {
	return RunWithAblation(scenario, messages, rng, maxSimTimeMs, AblationFlags{})
}

// RunWithAblation is Run's own implementation, parameterized by which
// mechanisms are active — see AblationFlags' own doc comment for why this
// exists and why it isn't just Run's new signature (39 existing test call
// sites and 4 non-test callers all call Run with its original signature;
// this is additive, not a breaking change).
func RunWithAblation(scenario Scenario, messages []Message, rng RNG, maxSimTimeMs uint32, ab AblationFlags) Report {
	adj := buildAdjacency(scenario.Links)

	var q eventQueue
	heap.Init(&q)
	for i, m := range messages {
		// pathNodes seeds with the origin itself — unlike the hash-based
		// path (which only gains an entry when a node actually relays, to
		// match real loop.detect), the human-readable pathNodes reported
		// on Reception.Path is meant to show the complete hop-by-hop route
		// including where the packet started.
		heap.Push(&q, event{atMs: m.SendAtMs, kind: eventSend, sender: m.Origin, packetID: i, payloadLen: m.PayloadLen, hopCount: 0, region: m.Region, direct: m.Direct, hashSize: m.effectiveHashSize(), pathNodes: []int{m.Origin}, background: m.Background, frameBytes: m.FrameBytes})
	}

	budgets := make([]txBudget, len(scenario.Nodes))
	for i := range budgets {
		budgets[i] = newTxBudget()
	}

	var transmissions []transmission
	// seen[packetID][node] mirrors real firmware's SimpleMeshTables::
	// hasSeen() (src/helpers/SimpleMeshTables.h): mark-and-test on every
	// *successfully decoded* copy of a packet, regardless of what the node
	// does with it afterwards (relays it, can't relay, drops it for
	// loop.detect, hop limit, wrong region — doesn't matter, it's still
	// been decoded and is never processed twice). Real MeshCore's packet
	// hash (Packet::calculatePacketHash, src/Packet.cpp) covers only the
	// payload type + payload, deliberately excluding the path — every copy
	// of a flood packet hashes identically no matter which route it
	// arrived by, so hasSeen catches a duplicate regardless of path.
	//
	// This is distinct from (and was previously conflated with) relayed:
	// a node that dropped an earlier copy for loop_detect/hop_limit/
	// region_mismatch never set relayed, so a later copy of the *same*
	// packet arriving via a different path would sail through every check
	// again and relay — defeating loop detection and resurrecting floods
	// that should have already died. seen is the actual gate; relayed is
	// just what gets reported.
	seen := make(map[int]map[int]bool)
	markSeen := func(packetID, node int) {
		if seen[packetID] == nil {
			seen[packetID] = make(map[int]bool)
		}
		seen[packetID][node] = true
	}

	// Explicitly non-nil so JSON callers (the WASM bridge, see
	// wasm/meshsim.go) always get "receptions":[] for a scenario with no
	// receptions, never "receptions":null — a nil slice and an empty one
	// are the same thing in Go but not in JSON, and a JS caller iterating
	// the field shouldn't need a null-guard for what's really just "zero
	// results."
	report := Report{Receptions: []Reception{}, Transmissions: []Transmission{}}

	for q.Len() > 0 {
		e := heap.Pop(&q).(event)
		if e.atMs > maxSimTimeMs {
			continue
		}

		switch e.kind {
		case eventSend:
			node := scenario.Nodes[e.sender]
			budget := &budgets[e.sender]
			budget.refill(e.atMs)

			if e.background {
				// A fixed replayed background transmission (see
				// Message.Background): occupy the channel for its own airtime
				// and nothing else. NOT deferred by CAD or the budget — it
				// happened at its observed time — but it DOES spend the
				// emitting node's own airtime budget (it really used that
				// airtime, so it correctly leaves that node less headroom for
				// the floods being simulated). Because it's appended to
				// transmissions, the interference/CAD/tx_busy logic sees it
				// automatically; it just never schedules a relay.
				onAir := e.frameBytes
				if onAir <= 0 {
					onAir = onAirLen(e.payloadLen, 0, e.hashSize, e.region != "")
				}
				airtime := AirtimeMs(node.Prefs.Radio, onAir)
				budget.spend(airtime)
				transmissions = append(transmissions, transmission{
					sender: e.sender, packetID: e.packetID,
					startMs: e.atMs, endMs: e.atMs + airtime,
					payloadLen: e.payloadLen, radio: node.Prefs.Radio, region: e.region, direct: e.direct, hashSize: e.hashSize, hopCount: e.hopCount,
				})
				report.Transmissions = append(report.Transmissions, Transmission{
					PacketID: e.packetID, Node: e.sender, AtMs: e.atMs, AirtimeMs: airtime,
					HopCount: e.hopCount, PayloadLen: e.payloadLen, OnAirLen: onAir, HashSize: e.hashSize, Region: e.region, Direct: e.direct,
					Background: true,
				})
				continue
			}

			// Real firmware checks its duty-cycle budget before anything
			// else in checkSend() — including before the CAD/channel-busy
			// check below — gated against the WORST-CASE (MAX_TRANS_UNIT)
			// airtime at this node's own radio settings, not this
			// specific message's smaller payload (see maxTransUnitBytes).
			// A single radio strictly serializes its own sends — firmware
			// queues outbound packets (Dispatcher::checkSend + STATE_TX_WAIT)
			// and can never air two overlapping frames. Without this gate one
			// node could transmit two packets simultaneously, and (because
			// collision checks skip same-sender pairs) the physically
			// impossible overlap was also invisible to every listener
			// (SIMULATION_REVIEW.md A1).
			ownBusyUntil := uint32(0)
			for _, prior := range transmissions {
				if prior.sender == e.sender && prior.endMs > e.atMs && prior.startMs <= e.atMs && prior.endMs > ownBusyUntil {
					ownBusyUntil = prior.endMs
				}
			}
			if ownBusyUntil > 0 {
				heap.Push(&q, event{
					atMs: ownBusyUntil, kind: eventSend,
					sender: e.sender, packetID: e.packetID, payloadLen: e.payloadLen, hopCount: e.hopCount, region: e.region, direct: e.direct, hashSize: e.hashSize, path: e.path, pathNodes: e.pathNodes,
					cadDeferred: e.cadDeferred, cadBusyStart: e.cadBusyStart, budgetDeferred: e.budgetDeferred,
				})
				continue
			}

			if !ab.DisableDutyCycle {
				if wait := budget.deferralMs(AirtimeMs(node.Prefs.Radio, maxTransUnitBytes)); wait > 0 {
					heap.Push(&q, event{
						atMs: e.atMs + wait, kind: eventSend,
						sender: e.sender, packetID: e.packetID, payloadLen: e.payloadLen, hopCount: e.hopCount, region: e.region, direct: e.direct, hashSize: e.hashSize, path: e.path, pathNodes: e.pathNodes,
						cadDeferred: e.cadDeferred, cadBusyStart: e.cadBusyStart, budgetDeferred: true,
					})
					continue
				}
			}

			if !ab.DisableCAD && channelBusy(transmissions, adj, e.sender, e.atMs) {
				busyStart := e.atMs
				if e.cadDeferred {
					busyStart = e.cadBusyStart
				}
				if e.atMs-busyStart < cadFailMaxDurationMs {
					heap.Push(&q, event{
						atMs: e.atMs + cadFailRetryDelayMs(rng), kind: eventSend,
						sender: e.sender, packetID: e.packetID, payloadLen: e.payloadLen, hopCount: e.hopCount, region: e.region, direct: e.direct, hashSize: e.hashSize, path: e.path, pathNodes: e.pathNodes,
						cadDeferred: true, cadBusyStart: busyStart,
					})
					continue
				}
				// Channel's been busy for cadFailMaxDurationMs straight —
				// force the transmission through anyway, same as real
				// firmware's own CAD-timeout fallback.
			}

			onAir := e.payloadLen
			if !ab.DisablePathByteAirtime {
				// Transport codes are carried exactly by region-scoped
				// (transport-routed) packets — see onAirLen and Packet::
				// hasTransportCodes. A non-empty region is this simulator's
				// own marker for that.
				onAir = onAirLen(e.payloadLen, len(e.path), e.hashSize, e.region != "")
			}
			airtime := AirtimeMs(node.Prefs.Radio, onAir)
			budget.spend(airtime)
			txIndex := len(transmissions)
			transmissions = append(transmissions, transmission{
				sender: e.sender, packetID: e.packetID,
				startMs: e.atMs, endMs: e.atMs + airtime,
				payloadLen: e.payloadLen, radio: node.Prefs.Radio, region: e.region, direct: e.direct, hashSize: e.hashSize, hopCount: e.hopCount, path: e.path, pathNodes: e.pathNodes,
				cadDeferred: e.cadDeferred, budgetDeferred: e.budgetDeferred,
			})
			// Recorded here, at the moment this send actually goes out, so
			// AtMs reflects any CAD/budget deferral above — never the time
			// it was originally scheduled for (see Transmission's own doc
			// comment).
			report.Transmissions = append(report.Transmissions, Transmission{
				PacketID: e.packetID, Node: e.sender, AtMs: e.atMs, AirtimeMs: airtime,
				HopCount: e.hopCount, PayloadLen: e.payloadLen, OnAirLen: onAir, HashSize: e.hashSize, Region: e.region, Direct: e.direct,
				IsRelay: e.hopCount > 0, CADDeferred: e.cadDeferred, BudgetDeferred: e.budgetDeferred,
			})
			// Real firmware explicitly marks a packet as seen right after
			// sending it too ("mark this packet as already sent in case it
			// is rebroadcast back to us" — src/Mesh.cpp), so a copy that
			// loops back around to its own sender via a longer path is
			// correctly dropped as already_seen rather than re-relayed.
			markSeen(e.packetID, e.sender)

			for _, link := range adj[e.sender] {
				heap.Push(&q, event{
					atMs: e.atMs + airtime, kind: eventRxComplete,
					txIndex: txIndex, listener: link.To,
					packetID: e.packetID, hopCount: e.hopCount,
				})
			}

		case eventRxComplete:
			tx := transmissions[e.txIndex]

			// Half-duplex: a node cannot receive while its own transmitter
			// is keyed — real LoRa radios hold one mutually exclusive
			// state (RadioLibWrappers.cpp: STATE_RX vs STATE_TX_WAIT), not
			// a firmware policy choice. Checked before any interferer
			// evaluation at all: if the listener was transmitting for ANY
			// part of the wanted packet's own airtime window, nothing was
			// heard here — not corrupted, never even decoded (so, like
			// weak_signal, this must NOT mark the packet seen: a later
			// copy arriving while this node isn't transmitting must still
			// be receivable normally).
			txBusy := false
			if !ab.DisableTxBusy {
				for _, own := range transmissions {
					if own.sender != e.listener {
						continue
					}
					if overlaps(tx.startMs, tx.endMs, own.startMs, own.endMs) {
						txBusy = true
						break
					}
				}
			}

			channel := scenario.Channel
			collided := false
			collidedWith := []int{}
			survivedCapture := false
			willRelay := false
			dropReason := ""
			collisionKind := ""
			// effWantedSNR is the wanted signal's instantaneous SNR at this
			// listener — its mean link SNR plus, when fading is enabled, a
			// per-reception Gaussian draw (see ChannelParams.FadingSigmaDB).
			// Computed once and used for BOTH the capture margin comparison
			// and the decode check below, so a single fade consistently
			// governs whether this specific packet is heard. Legacy (zero
			// FadingSigmaDB) leaves it exactly equal to the mean link SNR.
			var effWantedSNR float64
			if txBusy {
				dropReason = "tx_busy"
			} else {
				effWantedSNR = linkSNR(adj, tx.sender, e.listener)
				if channel.FadingSigmaDB > 0 {
					effWantedSNR += channel.FadingSigmaDB * gaussian(rng)
				}
				// Classify every overlapping, audible interferer. An
				// interferer arriving during the wanted packet's own
				// preamble/sync acquisition window contends for LOCK; one
				// arriving after lock contends only at the PAYLOAD level.
				//
				// A preamble-window interferer no longer blocks lock
				// unconditionally — that ignored signal strength, treating a
				// 30 dB-weaker stray transmission as fatal to a strong
				// wanted packet, which real LoRa preamble correlation does
				// not (the receiver locks onto whichever preamble dominates).
				// It blocks lock only when the wanted does NOT beat it by the
				// capture margin; a preamble interferer the wanted dominates
				// is demoted to a payload interferer (it's still on the air
				// during the payload, so it still counts toward the aggregate
				// corruption check below). This, combined with the fact that
				// each reception is evaluated independently, also models the
				// first-arrival/strength interplay correctly: a much-stronger
				// packet arriving late still captures via ITS OWN reception's
				// preamble check, while the earlier weaker packet it
				// overpowers is corrupted via the aggregate.
				var lockBlockers []int
				var payloadInterferers []int
				var payloadInterfererSNRs []float64
				for i, other := range transmissions {
					if i == e.txIndex || other.sender == tx.sender {
						continue
					}
					if !overlaps(tx.startMs, tx.endMs, other.startMs, other.endMs) {
						continue
					}
					if !audibleTo(adj, other.sender, e.listener) {
						continue
					}
					// Each interferer's own instantaneous level fades
					// independently of the wanted signal — so both the
					// acquisition (preamble) and payload capture margins see
					// genuine both-sided channel variance. Only drawn when
					// fading is enabled.
					isnr := linkSNR(adj, other.sender, e.listener)
					if channel.FadingSigmaDB > 0 {
						isnr += channel.FadingSigmaDB * gaussian(rng)
					}
					if startsBeforeLock(tx, other) {
						// Acquisition-stage capture: the wanted wins lock over
						// this interferer only if it dominates it by the
						// preamble capture margin. DisableCapture forces every
						// preamble interferer to block lock (the pre-phase-1
						// "any overlap is fatal" model).
						if ab.DisableCapture || effWantedSNR-isnr < preambleCaptureMarginDB {
							lockBlockers = append(lockBlockers, other.sender)
							continue
						}
						// Wanted captured the preamble; the interferer persists
						// into the payload and still contends there.
					}
					payloadInterferers = append(payloadInterferers, other.sender)
					payloadInterfererSNRs = append(payloadInterfererSNRs, isnr)
				}
				anyInterferer := len(lockBlockers) > 0 || len(payloadInterferers) > 0
				switch {
				case len(lockBlockers) > 0:
					// Lock never acquired — nothing was decoded at all.
					// no_lock dominates: whatever a later, post-lock
					// interferer would have done is moot without lock.
					collidedWith = lockBlockers
					collisionKind = "no_lock"
				case len(payloadInterferers) > 0:
					// Lock acquired; corruption is decided by the interferers'
					// COMBINED power, not pairwise (see aggregateInterferer
					// SNRdB's own doc comment). DisableCapture forces
					// corruption regardless of margin — the pre-phase-1
					// "any overlap destroys the signal" model.
					aggDB := aggregateInterfererSNRdB(payloadInterfererSNRs)
					if ab.DisableCapture || effWantedSNR-aggDB < captureMarginDB {
						collidedWith = payloadInterferers
						collisionKind = "corrupted"
					}
					// else: captured — the wanted signal beat the combined
					// interference by the margin, so it survives.
				}
				collided = len(collidedWith) > 0
				// True if some other transmission overlapped this window
				// and was audible here, but the capture effect let this
				// signal be decoded anyway — distinct from a genuinely
				// clean reception (no interferer at all) purely for
				// reporting; both leave Collided false.
				survivedCapture = !collided && anyInterferer
			}
			if !txBusy && !collided {
				sf := scenario.Nodes[e.listener].Prefs.Radio.SF
				listenerNode := scenario.Nodes[e.listener]
				if !decodes(effWantedSNR, sf, channel, rng) {
					// Never actually decoded (below threshold, or lost the
					// probabilistic packet-error-rate draw near it) — never
					// marks seen. A later, cleaner copy of the same packet
					// must still be able to relay normally.
					dropReason = "weak_signal"
				} else {
					// Decoded successfully — read whether an EARLIER
					// reception already marked this (packetID, node) seen
					// before this one does, then mark it regardless of
					// what the switch below decides. Order mirrors real
					// firmware: hasSeen() gates dispatch before any
					// relay-eligibility logic runs at all (src/Mesh.cpp).
					alreadySeen := seen[e.packetID][e.listener]
					markSeen(e.packetID, e.listener)
					switch {
					case alreadySeen:
						dropReason = "already_seen"
					case !listenerNode.CanRelay:
						dropReason = "cannot_relay"
					case e.hopCount >= listenerNode.effectiveFloodMax():
						dropReason = "hop_limit"
					case !tx.direct && tx.region == "" && e.hopCount >= listenerNode.effectiveFloodMaxUnscoped():
						dropReason = "hop_limit_unscoped"
					case (len(tx.path)+1)*tx.hashSize > maxPathSizeBytes:
						// Firmware Mesh::routeRecvPacket refuses to relay
						// unless (n+1)*hashSize fits MAX_PATH_SIZE (64 B) —
						// real floods die at 21 hops with 3-byte hashes; the
						// sim used to flood on to its 64-hop default
						// (SIMULATION_REVIEW.md A2).
						dropReason = "path_full"
					case !listenerNode.acceptsRegion(tx.region):
						dropReason = "region_mismatch"
					default:
						// myHash and the loop-detect threshold are both
						// evaluated at the PACKET's own hash size
						// (tx.hashSize), never listenerNode.HashSize — see
						// shouldDropForLoop's doc comment.
						myHash := nodeHash(e.listener, tx.hashSize)
						if listenerNode.shouldDropForLoop(myHash, tx.path, tx.hashSize) {
							dropReason = "loop_detect"
							break
						}
						willRelay = true
						// PacketScore uses the FULL received frame length
						// (firmware: packetScore(snr, len) where len is the
						// whole on-air frame, transport codes included) — so
						// scoreLen matches the transmission airtime's own
						// onAirLen exactly.
						scoreLen := tx.payloadLen
						if !ab.DisablePathByteAirtime {
							scoreLen = onAirLen(tx.payloadLen, len(tx.path), tx.hashSize, tx.region != "")
						}
						// Firmware hardcodes SF10 here regardless of the
						// radio's actual SF (RadioLibWrappers.h packetScore:
						// "assume sf=10") — using the real SF inverted the
						// weak-signal bias either side of SF10
						// (SIMULATION_REVIEW.md A3).
						score := PacketScore(effWantedSNR, 10, scoreLen)
						// The weak-signal RX hold-back is sized on the full
						// received frame airtime (firmware calcRxDelay's own
						// air_time = getEstAirtimeFor(len), the whole frame).
						rxDelay := RxDelayMs(listenerNode.Prefs.RxDelayBase, score, tx.endMs-tx.startMs)
						// The relay (retransmit) delay, however, is sized on
						// the packet length EXCLUDING transport codes —
						// firmware getRetransmitDelay uses getEstAirtimeFor(
						// getPathByteLen() + payload_len + 2), which is
						// getRawLength minus the 4 transport bytes. Only
						// region-scoped traffic differs from the full frame
						// here (an unscoped packet has no transport codes, so
						// its full airtime already IS the delay airtime).
						// Firmware appends its own hash BEFORE computing the
						// delay window (getRetransmitDelay is called after
						// setPathHashCount(n+1)) — sizing on the received
						// frame left every window one hash of airtime narrow
						// (SIMULATION_REVIEW.md A5).
						relayDelayAirtime := tx.endMs - tx.startMs
						if !ab.DisablePathByteAirtime {
							relayDelayAirtime = AirtimeMs(tx.radio, onAirLen(tx.payloadLen, len(tx.path)+1, tx.hashSize, false))
						}
						var txDelay uint32
						if tx.direct {
							txDelay = DirectRetransmitDelayMs(rng, relayDelayAirtime, listenerNode.Prefs.DirectTxDelayFactor)
						} else {
							txDelay = RetransmitDelayMs(rng, relayDelayAirtime, listenerNode.Prefs.TxDelayFactor)
						}
						relayAt := e.atMs + uint32(rxDelay) + txDelay
						// Copy-append, never mutate tx.path/tx.pathNodes in
						// place — both are shared by every other listener of
						// this same transmission, each deciding independently.
						newPath := make([]uint32, len(tx.path)+1)
						copy(newPath, tx.path)
						newPath[len(tx.path)] = myHash
						newPathNodes := make([]int, len(tx.pathNodes)+1)
						copy(newPathNodes, tx.pathNodes)
						newPathNodes[len(tx.pathNodes)] = e.listener
						heap.Push(&q, event{
							atMs: relayAt, kind: eventSend,
							sender: e.listener, packetID: e.packetID,
							payloadLen: tx.payloadLen, hopCount: e.hopCount + 1, region: tx.region, direct: tx.direct, hashSize: tx.hashSize, path: newPath, pathNodes: newPathNodes,
						})
					}
				}
			}

			reportedPath := tx.pathNodes
			if reportedPath == nil {
				reportedPath = []int{}
			}
			report.Receptions = append(report.Receptions, Reception{
				PacketID: e.packetID, Node: e.listener, AtMs: e.atMs,
				FromNode: tx.sender, Collided: collided,
				HopCount: e.hopCount, WasRelayed: willRelay,
				CollidedWith: collidedWith, Path: reportedPath,
				DropReason: dropReason, SenderWasCADDeferred: tx.cadDeferred,
				SenderWasBudgetDeferred: tx.budgetDeferred,
				SurvivedCapture:         survivedCapture,
				CollisionKind:           collisionKind,
			})
		}
	}

	return report
}
