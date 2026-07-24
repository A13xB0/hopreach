package meshsim

import "container/heap"

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
	Regions []string `json:"regions,omitempty"`
	// LoopDetect mirrors `set loop.detect <off|minimal|moderate|strict>`
	// (see docs.meshcore.io/cli_commands): a repeater configured with this
	// on rejects (won't relay) a flood packet whose accumulated path
	// already shows *this node's own* path-hash appearing at least as many
	// times as the level's own threshold — see loopDetectThreshold. Empty
	// or "off" (the real firmware default) never rejects anything.
	LoopDetect string `json:"loopDetect,omitempty"`
	// HashSize mirrors this node's own configured path-hash size in bytes
	// (1-3, matching corescope.Node.HashSize for a real repeater) — what
	// loop.detect's thresholds are actually defined in terms of. This
	// isn't optional flavor: a 1-byte hash has only 256 possible values,
	// so two *unrelated* repeaters legitimately sharing the same hash byte
	// is common, not rare — which is exactly what makes strict/moderate
	// loop.detect settings risk dropping a perfectly legitimate
	// (non-looping) flood at small hash sizes. Defaults to 1 (the
	// smallest, most collision-prone size) if unset/zero, matching
	// hashNode's own floor.
	HashSize int `json:"hashSize,omitempty"`
}

// acceptsRegion reports whether node can relay a message tagged with
// region — see Regions' own doc comment. An empty region (ordinary,
// unscoped flood traffic) is always accepted, regardless of the node's own
// Regions.
func (n SimNode) acceptsRegion(region string) bool {
	if region == "" {
		return true
	}
	for _, r := range n.Regions {
		if r == region {
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
func (n SimNode) shouldDropForLoop(myHash uint32, pathHashes []uint32) bool {
	threshold := loopDetectThreshold(n.LoopDetect, n.HashSize)
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

// Scenario is one whole simulated mesh: every node's own prefs, and the
// directed connectivity graph between them (see Link — asymmetric and
// SNR-valued, sourced from whichever combination of CoreScope-observed data
// and the propagation model the caller chooses; this package only consumes
// the result).
type Scenario struct {
	Nodes []SimNode `json:"nodes"`
	Links []Link    `json:"links"`
}

// Message is one test-bench-scheduled flood transmission: node Origin
// sends a PayloadLen-byte flood packet at SendAtMs (simulation time, ms
// from t=0). Direct/routed traffic isn't modeled yet — see the package doc
// for why flood-only is the right first scope.
type Message struct {
	Origin     int    `json:"origin"`
	SendAtMs   uint32 `json:"sendAtMs"`
	PayloadLen int    `json:"payloadLen"`
	// Region, if set, is the MeshCore region this message is sent under —
	// mirrors the real `region default <name>` CLI setting (see
	// docs.meshcore.io/cli_commands), which is what actually tags a node's
	// own outgoing messages with a region's transport code. Carried
	// forward unchanged through every relay of this same message (a
	// repeater re-floods the identical transport-coded packet, it doesn't
	// re-tag it) — see SimNode.acceptsRegion for what this gates. Empty
	// means ordinary unscoped flood traffic.
	Region string `json:"region,omitempty"`
}

// Reception is one (packet, listening node) outcome — the core unit the
// simulator reports on. A single Message can produce many Receptions, one
// per node that ever came within radio range of *some* transmission of it
// (the original send, or any of its relays).
type Reception struct {
	PacketID   int    `json:"packetId"` // index into the Report's Messages/originating relay chain — see Report
	Node       int    `json:"node"`
	AtMs       uint32 `json:"atMs"`
	FromNode   int    `json:"fromNode"`
	Collided   bool   `json:"collided"`   // true if another transmission's airtime window overlapped this one at Node
	HopCount   int    `json:"hopCount"`   // 0 = received directly from the original sender
	WasRelayed bool   `json:"wasRelayed"` // true if Node went on to relay this packet onward (false if already relayed by the time it arrived, or CanRelay is false, or hop limit reached)
	// CollidedWith lists every other sender node whose transmission's
	// airtime window overlapped this one at Node and was itself audible to
	// Node — i.e. every genuine cause of Collided, not just whether one
	// existed. Empty (never nil, see Run's report initialization) when
	// Collided is false. Lets a caller attribute contention to specific
	// *senders*, not just tally which *receptions* failed — see
	// public/simulator.js's per-repeater ranking, which uses this to
	// measure how much a given repeater's own chatter contributes to
	// collisions heard elsewhere, distinct from how often its own
	// receptions were the ones that collided.
	CollidedWith []int `json:"collidedWith"`
	// Path is the actual sequence of node indices (not the path-hashes
	// loop.detect itself checks — see nodeHash) that this exact packet
	// travelled through, in order, from the original sender up to and
	// including FromNode. A single-element slice containing just the
	// origin for a reception straight from the original sender (never
	// empty/nil — every packet has an origin). Exists so a caller can show
	// a real, human-readable hop-by-hop trail (see public/simulator.js's
	// per-repeater packet inspector) instead of just a bare HopCount.
	Path []int `json:"path"`
	// DropReason explains why Node did *not* go on to relay this packet
	// onward, whenever WasRelayed is false for a reason other than
	// Collided (a collided reception was never even eligible to relay —
	// Collided alone already explains that case, so DropReason stays
	// empty for it). One of: "weak_signal" (SNR below the listening
	// radio's own SF threshold), "cannot_relay" (a plain client, not a
	// repeater), "hop_limit" (MaxHopCount already reached),
	// "already_relayed" (this exact node already sent this exact packet
	// once — MeshCore's own real dedup rule), "region_mismatch" (see
	// SimNode.acceptsRegion), "loop_detect" (see SimNode.shouldDropForLoop
	// — note this can trigger even when Node never actually saw a real
	// loop, if its own path-hash merely collided with a different node's,
	// which is the real, documented risk of a small hash_size). Empty
	// when WasRelayed is true, or when Collided is true (nothing to
	// explain beyond that).
	DropReason string `json:"dropReason,omitempty"`
	// SenderWasCADDeferred is true if FromNode's own transmission of this
	// packet was pushed back at least once because it detected the
	// channel busy before sending (see channelBusy/cadFailRetryDelayMs) —
	// i.e. AtMs is later than a naive "instant send" would predict, not
	// because of anything Node itself did.
	SenderWasCADDeferred bool `json:"senderWasCadDeferred,omitempty"`
}

// Report is one simulation run's full result set.
type Report struct {
	Receptions []Reception `json:"receptions"`
}

// MaxHopCount bounds how many times a single packet can be relayed before
// nodes stop forwarding it — a simple, fixed hop-limit rather than
// MeshCore's own more elaborate path-accumulation/dedup rules, which don't
// matter for flood-only collision modeling.
const MaxHopCount = 8

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
const cadFailRetryDelayMs = 200
const cadFailMaxDurationMs = 4000

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
	path       []uint32 // this send's own accumulated path-hash sequence so far — see transmission.path
	pathNodes  []int    // this send's own accumulated real-node-index path so far — see transmission.pathNodes
	// cadDeferred/cadBusyStart track a send that's already been pushed back
	// once by CAD (see channelBusy) — cadBusyStart is when the channel was
	// *first* observed busy for this particular pending send, so a chain of
	// 200ms retries can measure its own total wait against
	// cadFailMaxDurationMs, matching real firmware's cad_busy_start.
	cadDeferred  bool
	cadBusyStart uint32

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

// Run simulates scenario under messages (each an originating flood send)
// out to maxSimTimeMs, using rng for every randomized retransmit delay —
// pass a seeded, deterministic RNG to make two runs (e.g. before/after a
// config change) comparable against identical random draws rather than
// confounding "did the new settings help" with "did this run just get
// luckier."
func Run(scenario Scenario, messages []Message, rng RNG, maxSimTimeMs uint32) Report {
	adj := buildAdjacency(scenario.Links)

	var q eventQueue
	heap.Init(&q)
	for i, m := range messages {
		// pathNodes seeds with the origin itself — unlike the hash-based
		// path (which only gains an entry when a node actually relays, to
		// match real loop.detect), the human-readable pathNodes reported
		// on Reception.Path is meant to show the complete hop-by-hop route
		// including where the packet started.
		heap.Push(&q, event{atMs: m.SendAtMs, kind: eventSend, sender: m.Origin, packetID: i, payloadLen: m.PayloadLen, hopCount: 0, region: m.Region, pathNodes: []int{m.Origin}})
	}

	var transmissions []transmission
	// relayed[packetID][node] marks that node has already sent (or is
	// scheduled to send) this packet onward — MeshCore's own real
	// behavior: a flood packet is relayed at most once per node,
	// regardless of how many times it's subsequently heard again.
	relayed := make(map[int]map[int]bool)

	// Explicitly non-nil so JSON callers (the WASM bridge, see
	// wasm/meshsim.go) always get "receptions":[] for a scenario with no
	// receptions, never "receptions":null — a nil slice and an empty one
	// are the same thing in Go but not in JSON, and a JS caller iterating
	// the field shouldn't need a null-guard for what's really just "zero
	// results."
	report := Report{Receptions: []Reception{}}

	for q.Len() > 0 {
		e := heap.Pop(&q).(event)
		if e.atMs > maxSimTimeMs {
			continue
		}

		switch e.kind {
		case eventSend:
			if channelBusy(transmissions, adj, e.sender, e.atMs) {
				busyStart := e.atMs
				if e.cadDeferred {
					busyStart = e.cadBusyStart
				}
				if e.atMs-busyStart < cadFailMaxDurationMs {
					heap.Push(&q, event{
						atMs: e.atMs + cadFailRetryDelayMs, kind: eventSend,
						sender: e.sender, packetID: e.packetID, payloadLen: e.payloadLen, hopCount: e.hopCount, region: e.region, path: e.path, pathNodes: e.pathNodes,
						cadDeferred: true, cadBusyStart: busyStart,
					})
					continue
				}
				// Channel's been busy for cadFailMaxDurationMs straight —
				// force the transmission through anyway, same as real
				// firmware's own CAD-timeout fallback.
			}

			node := scenario.Nodes[e.sender]
			airtime := AirtimeMs(node.Prefs.Radio, e.payloadLen)
			txIndex := len(transmissions)
			transmissions = append(transmissions, transmission{
				sender: e.sender, packetID: e.packetID,
				startMs: e.atMs, endMs: e.atMs + airtime,
				payloadLen: e.payloadLen, radio: node.Prefs.Radio, region: e.region, path: e.path, pathNodes: e.pathNodes,
				cadDeferred: e.cadDeferred,
			})
			if relayed[e.packetID] == nil {
				relayed[e.packetID] = make(map[int]bool)
			}
			relayed[e.packetID][e.sender] = true

			for _, link := range adj[e.sender] {
				heap.Push(&q, event{
					atMs: e.atMs + airtime, kind: eventRxComplete,
					txIndex: txIndex, listener: link.To,
					packetID: e.packetID, hopCount: e.hopCount,
				})
			}

		case eventRxComplete:
			tx := transmissions[e.txIndex]
			collidedWith := []int{}
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
				collidedWith = append(collidedWith, other.sender)
			}
			collided := len(collidedWith) > 0

			willRelay := false
			dropReason := ""
			if !collided {
				snr := linkSNR(adj, tx.sender, e.listener)
				sf := scenario.Nodes[e.listener].Prefs.Radio.SF
				listenerNode := scenario.Nodes[e.listener]
				switch {
				case snr < snrThresholdForSF(sf):
					dropReason = "weak_signal"
				case !listenerNode.CanRelay:
					dropReason = "cannot_relay"
				case e.hopCount >= MaxHopCount:
					dropReason = "hop_limit"
				case relayed[e.packetID][e.listener]:
					dropReason = "already_relayed"
				case !listenerNode.acceptsRegion(tx.region):
					dropReason = "region_mismatch"
				default:
					myHash := nodeHash(e.listener, listenerNode.HashSize)
					if listenerNode.shouldDropForLoop(myHash, tx.path) {
						dropReason = "loop_detect"
						break
					}
					willRelay = true
					score := PacketScore(snr, sf, tx.payloadLen)
					rxDelay := RxDelayMs(listenerNode.Prefs.RxDelayBase, score, tx.endMs-tx.startMs)
					txDelay := RetransmitDelayMs(rng, tx.endMs-tx.startMs, listenerNode.Prefs.TxDelayFactor)
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
						payloadLen: tx.payloadLen, hopCount: e.hopCount + 1, region: tx.region, path: newPath, pathNodes: newPathNodes,
					})
					if relayed[e.packetID] == nil {
						relayed[e.packetID] = make(map[int]bool)
					}
					relayed[e.packetID][e.listener] = true
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
			})
		}
	}

	return report
}

func overlaps(aStart, aEnd, bStart, bEnd uint32) bool {
	return aStart < bEnd && bStart < aEnd
}

// channelBusy reports whether sender would currently detect the radio
// channel as occupied — i.e. some other node's transmission, audible to
// sender, has an airtime window that contains atMs right now — mirroring
// real firmware's _radio->isReceiving() check in Dispatcher::checkSend().
// A node never CAD-detects its own prior transmission.
func channelBusy(transmissions []transmission, adj adjacency, sender int, atMs uint32) bool {
	for _, tx := range transmissions {
		if tx.sender == sender {
			continue
		}
		if atMs < tx.startMs || atMs >= tx.endMs {
			continue
		}
		if audibleTo(adj, tx.sender, sender) {
			return true
		}
	}
	return false
}

func audibleTo(adj adjacency, sender, listener int) bool {
	for _, l := range adj[sender] {
		if l.To == listener {
			return true
		}
	}
	return false
}

func linkSNR(adj adjacency, sender, listener int) float64 {
	for _, l := range adj[sender] {
		if l.To == listener {
			return l.SNRdB
		}
	}
	return -999 // unreachable in practice — only called after audibleTo confirms a link exists
}

func snrThresholdForSF(sf int) float64 {
	if sf < 7 || sf > 12 {
		return 999 // out of the modeled range — never passes
	}
	return snrThresholdDB[sf-7]
}
