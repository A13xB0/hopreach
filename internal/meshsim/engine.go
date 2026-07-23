package meshsim

import "container/heap"

// SimNode is one node's static simulation properties. NodePrefs governs its
// own relay-delay behavior; CanRelay lets a plain client be modeled
// distinctly from a repeater (a client that only originates/receives
// traffic, never re-floods it).
type SimNode struct {
	Prefs    NodePrefs `json:"prefs"`
	CanRelay bool      `json:"canRelay"`
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

// transmission is one node's single over-the-air send of one packet —
// tracked globally for the lifetime of the simulation so collision checks
// can scan for time-overlapping transmissions audible to the same listener.
type transmission struct {
	sender         int
	packetID       int
	startMs, endMs uint32
	payloadLen     int
	radio          LoRaParams
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
		heap.Push(&q, event{atMs: m.SendAtMs, kind: eventSend, sender: m.Origin, packetID: i, payloadLen: m.PayloadLen, hopCount: 0})
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
			node := scenario.Nodes[e.sender]
			airtime := AirtimeMs(node.Prefs.Radio, e.payloadLen)
			txIndex := len(transmissions)
			transmissions = append(transmissions, transmission{
				sender: e.sender, packetID: e.packetID,
				startMs: e.atMs, endMs: e.atMs + airtime,
				payloadLen: e.payloadLen, radio: node.Prefs.Radio,
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
			collided := false
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
				collided = true
				break
			}

			willRelay := false
			if !collided {
				snr := linkSNR(adj, tx.sender, e.listener)
				sf := scenario.Nodes[e.listener].Prefs.Radio.SF
				if snr >= snrThresholdForSF(sf) {
					listenerNode := scenario.Nodes[e.listener]
					if listenerNode.CanRelay && e.hopCount < MaxHopCount && !relayed[e.packetID][e.listener] {
						willRelay = true
						score := PacketScore(snr, sf, tx.payloadLen)
						rxDelay := RxDelayMs(listenerNode.Prefs.RxDelayBase, score, tx.endMs-tx.startMs)
						txDelay := RetransmitDelayMs(rng, tx.endMs-tx.startMs, listenerNode.Prefs.TxDelayFactor)
						relayAt := e.atMs + uint32(rxDelay) + txDelay
						heap.Push(&q, event{
							atMs: relayAt, kind: eventSend,
							sender: e.listener, packetID: e.packetID,
							payloadLen: tx.payloadLen, hopCount: e.hopCount + 1,
						})
						if relayed[e.packetID] == nil {
							relayed[e.packetID] = make(map[int]bool)
						}
						relayed[e.packetID][e.listener] = true
					}
				}
			}

			report.Receptions = append(report.Receptions, Reception{
				PacketID: e.packetID, Node: e.listener, AtMs: e.atMs,
				FromNode: tx.sender, Collided: collided,
				HopCount: e.hopCount, WasRelayed: willRelay,
			})
		}
	}

	return report
}

func overlaps(aStart, aEnd, bStart, bEnd uint32) bool {
	return aStart < bEnd && bStart < aEnd
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
