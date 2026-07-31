package meshsim

import (
	"container/heap"
	"math"
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

// Scenario is one whole simulated mesh: every node's own prefs, and the
// directed connectivity graph between them (see Link — asymmetric and
// SNR-valued, sourced from whichever combination of CoreScope-observed data
// and the propagation model the caller chooses; this package only consumes
// the result).
type Scenario struct {
	Nodes []SimNode `json:"nodes"`
	Links []Link    `json:"links"`
	// Channel governs the physical-layer reception model — see
	// ChannelParams. Its zero value ({0, 0}) is the legacy behaviour: a
	// hard SNR threshold and a fixed per-link SNR, no channel randomness.
	// Every existing Go test constructs a Scenario without setting this and
	// so gets exactly that legacy behaviour; the browser-side caller
	// (public/simulator.js) passes real values to enable the more faithful
	// probabilistic model. Same "zero value preserves prior behaviour"
	// discipline as AblationFlags.
	Channel ChannelParams `json:"channel"`
}

// ChannelParams turns the reception model from an all-or-nothing hard SNR
// threshold with a fixed per-link SNR into a probabilistic one, closing the
// two physical-fidelity gaps a hard threshold has: real reception near the
// sensitivity floor is a smooth
// packet-error-rate curve over a few dB, not a step, and a real link's
// instantaneous SNR varies packet-to-packet (fast fading) rather than
// sitting at one fixed value forever. Both default off (zero value) so
// existing behaviour is unchanged unless a caller opts in.
type ChannelParams struct {
	// PERWidthDB, when > 0, replaces the hard SNR-threshold cutoff with a
	// logistic packet-error-rate curve of this width in dB: a reception
	// exactly at its SF's threshold decodes ~50% of the time, one PERWidthDB
	// above it ~73%, two above ~88%, and symmetrically below. 0 keeps the
	// legacy hard step (decode iff snr >= threshold). A small value (~2)
	// models a realistically steep LoRa waterfall without making
	// comfortably-strong links unreliable.
	PERWidthDB float64 `json:"perWidthDb"`
	// FadingSigmaDB, when > 0, adds a per-reception zero-mean Gaussian
	// perturbation of this standard deviation (dB) to the WANTED signal's
	// SNR before both the capture comparison and the decode check — a
	// first-order fast-fading model. This is what makes a marginal link
	// genuinely flicker between Monte-Carlo trials (the fixed-SNR model
	// never did, so trial-to-trial delivery variance came only from relay
	// timing, understating real uncertainty — see the optimizer's own
	// confidence machinery, which assumes trial variance reflects real
	// variance). Each interferer's SNR also draws its own independent
	// fade (one draw per signal per reception). Known limit: the draws are
	// independent per reception even for the same physical signal pair, so
	// in rare tails one demodulator can win both sides of an overlap —
	// see SIMULATION_REVIEW.md A6. 0 = no fading.
	FadingSigmaDB float64 `json:"fadingSigmaDb"`
}

// Message is one test-bench-scheduled flood transmission: node Origin
// sends a PayloadLen-byte flood packet at SendAtMs (simulation time, ms
// from t=0).
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
	// Direct marks this as ROUTE_TYPE_DIRECT rather than ROUTE_TYPE_FLOOD
	// traffic (see Packet.h's real route-type constants). Two concrete,
	// deliberately narrow effects, both verified against firmware:
	// relaying uses NodePrefs.DirectTxDelayFactor instead of TxDelayFactor
	// (real firmware default 0.3 vs flood's 0.5 — far fewer nodes contend
	// for a single addressed packet than for a flood), and
	// FloodMaxUnscoped never applies (examples/simple_repeater/MyMesh.cpp
	// gates it on ROUTE_TYPE_FLOOD specifically). What this does NOT model:
	// real direct traffic is addressed to one specific next hop and only
	// relayed by nodes actually on that path — this simulator has no path-
	// selection/routing-table concept at all, so a Direct message still
	// propagates to every reachable node exactly like a flood, just timed
	// and hop-limited differently. Modeling genuine point-to-point routing
	// is a materially larger feature than this flag; this is a deliberately
	// scoped first step, not a claim of full route-type fidelity.
	Direct bool `json:"direct,omitempty"`
	// HashSize is the path-hash size in bytes (1-3) this message's
	// originator stamps onto the packet at send time — real firmware:
	// Mesh::sendFlood(packet, delay, path_hash_size) (src/Mesh.cpp:634),
	// which calls packet->setPathHashSizeAndCount(path_hash_size, 0) and
	// stores it in the packet's own wire-format path_len byte
	// (Packet.h:83). It is a property of the PACKET, not of any relay
	// along the way: a relay appends its own hash at the packet's size,
	// never its own configured one (Mesh::routeRecvPacket,
	// src/Mesh.cpp:335) — so a single path can never mix hash sizes
	// hop-to-hop, and loop.detect's thresholds are evaluated at this size
	// too (see shouldDropForLoop). Carried unchanged through every relay
	// of this message. Zero/unset falls back to defaultMessageHashSize —
	// see effectiveHashSize.
	HashSize int `json:"hashSize,omitempty"`
	// Background marks this as a FIXED, non-relaying transmission rather than
	// a flood to propagate — the "tune the floods, replay everything else as
	// background" split a packet replay relies on. It models one real observed hop
	// of surrounding traffic (a direct/channel/anon packet, or a specific
	// relay of a flood we're not itself reproducing): node Origin keys the
	// radio at SendAtMs for FrameBytes' worth of airtime and nothing more.
	// It occupies the channel exactly like any transmission — so it causes
	// collisions, CAD deferrals, and half-duplex tx_busy at the nodes that
	// hear it — but it never triggers a relay, generates no reception of its
	// own, and is never deferred by CAD or the duty-cycle budget (it already
	// happened at its observed time; only the floods being TUNED respect the
	// channel around it). This is what lets a reconstructed real episode
	// carry realistic contention from traffic we can't (or don't need to)
	// route.
	Background bool `json:"background,omitempty"`
	// FrameBytes, when > 0, is the exact total on-air byte count for this
	// message's airtime — used instead of the onAirLen reconstruction. Only
	// meaningful for a Background message, where the real frame size is known
	// exactly from CoreScope's raw_hex, so the background's airtime (and thus
	// how long it occupies the channel) is exact rather than reconstructed
	// from payload + path assumptions.
	FrameBytes int `json:"frameBytes,omitempty"`
}

// defaultMessageHashSize is what a Message with no explicit HashSize uses.
// This is a deliberate SIMULATOR default, not a firmware one — real
// firmware has no built-in default at all, since every real caller of
// Mesh::sendFlood passes path_hash_size explicitly (see HashSize's own doc
// comment). 3 bytes minimises hash collisions between unrelated nodes, so
// loop.detect false positives don't silently confound a run's results —
// the opposite tradeoff from nodeHash's own 1-byte floor, which exists to
// make small-hash-size collisions reachable at all when a scenario asks
// for them.
const defaultMessageHashSize = 3

// effectiveHashSize returns m's own path-hash size, clamped to the real
// 1-3 byte range and defaulting to defaultMessageHashSize when unset.
func (m Message) effectiveHashSize() int {
	switch {
	case m.HashSize <= 0:
		return defaultMessageHashSize
	case m.HashSize > 3:
		return 3
	default:
		return m.HashSize
	}
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
	WasRelayed bool   `json:"wasRelayed"` // true if Node went on to relay this packet onward (false if already seen by the time it arrived, or CanRelay is false, or hop limit reached)
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
	// radio's own SF threshold — the packet was never actually decoded,
	// so it does NOT mark this node as having seen it), "already_seen"
	// (this exact node already decoded this exact packet once before —
	// MeshCore's own real dedup rule, SimpleMeshTables::hasSeen — checked
	// against every *decoded* reception, not just ones that went on to
	// relay: a copy dropped for e.g. loop_detect still counts as seen, so
	// a later copy of the same packet arriving via a different path is
	// correctly dropped here too instead of relaying), "cannot_relay" (a
	// plain client, not a repeater), "hop_limit" (the packet's own
	// accumulated hop count has reached this node's FloodMax — applies to
	// every packet), "hop_limit_unscoped" (reached FloodMaxUnscoped
	// specifically — only possible for an unscoped packet, and only ever
	// reported when FloodMax itself hadn't already been hit first),
	// "region_mismatch" (see SimNode.acceptsRegion — includes an unscoped
	// packet refused by DenyUnscoped, not just a genuine region mismatch),
	// "loop_detect" (see SimNode.shouldDropForLoop — note this can trigger
	// even when Node never actually saw a real loop, if its own path-hash
	// merely collided with a different node's, which is the real,
	// documented risk of a small hash_size), or "tx_busy" (Node's own
	// transmitter was keyed for some part of this packet's airtime window
	// — real LoRa radios are half-duplex, so it was never heard at all,
	// not corrupted; like weak_signal, does NOT mark this node as having
	// seen it). Empty when WasRelayed is true, or when Collided is true
	// (nothing to explain beyond that — see CollisionKind for why,
	// in that case).
	DropReason string `json:"dropReason,omitempty"`
	// SenderWasCADDeferred is true if FromNode's own transmission of this
	// packet was pushed back at least once because it detected the
	// channel busy before sending (see channelBusy/cadFailRetryDelayMs) —
	// i.e. AtMs is later than a naive "instant send" would predict, not
	// because of anything Node itself did.
	SenderWasCADDeferred bool `json:"senderWasCadDeferred,omitempty"`
	// SenderWasBudgetDeferred is true if FromNode's own transmission of
	// this packet was pushed back at least once because its own duty-cycle
	// airtime budget was too low to send yet (see txBudget) — same idea as
	// SenderWasCADDeferred, a different real cause.
	SenderWasBudgetDeferred bool `json:"senderWasBudgetDeferred,omitempty"`
	// SurvivedCapture is true if at least one other transmission's airtime
	// window overlapped this one and was itself audible to Node, but real
	// LoRa's capture effect (see loraCaptured) let this signal be decoded
	// anyway rather than destroying both. Always false when Collided is
	// true (the interference that mattered wasn't survived) and always
	// false when no interferer was present at all (nothing to have
	// survived) — exists purely so a caller can distinguish "genuinely
	// silent reception" from "won a contest against real interference" in
	// the UI, even though both leave Collided false.
	SurvivedCapture bool `json:"survivedCapture,omitempty"`
	// CollisionKind explains WHY Collided is true — empty whenever Collided
	// is false. "no_lock": at least one interferer was on the air during
	// this packet's own preamble/sync-word acquisition window (see
	// loraCaptureOutcome), so the demodulator never locked on and nothing
	// at all was received — no partial packet, no CRC failure, the
	// physical-layer equivalent of tx_busy above but caused by another
	// node's transmission rather than Node's own. "corrupted": lock WAS
	// achieved, but at least one interferer overlapping the payload was
	// not beaten by captureMarginDB, so symbols were corrupted and the CRC
	// failed. "no_lock" dominates "corrupted" whenever both are present
	// among Node's interferers for this reception — without lock,
	// payload-level interference from a different interferer is moot.
	CollisionKind string `json:"collisionKind,omitempty"`
}

// Report is one simulation run's full result set.
type Report struct {
	Receptions []Reception `json:"receptions"`
	// Transmissions is every node's own over-the-air send of a packet — the
	// origin's first send, or any repeater's relay of it. AtMs is when the
	// packet ACTUALLY started airing, after any CAD or duty-cycle deferral,
	// never the time it was originally scheduled for — see IsRelay and the
	// package's own doc comment on why "scheduled" and "actual" can differ.
	// (PacketID, Node) is unique: real firmware's hasSeen dedup guarantees a
	// node transmits any given packet at most once, so a caller can pair a
	// Reception with its causing Transmission by that key alone.
	Transmissions []Transmission `json:"transmissions"`
}

// Transmission is one node's own over-the-air send of one packet.
type Transmission struct {
	PacketID   int    `json:"packetId"`
	Node       int    `json:"node"`
	AtMs       uint32 `json:"atMs"`
	AirtimeMs  uint32 `json:"airtimeMs"`
	HopCount   int    `json:"hopCount"`
	PayloadLen int    `json:"payloadLen"`
	// OnAirLen is the actual byte count transmitted — PayloadLen plus the
	// path_len byte plus HopCount*HashSize accumulated path bytes (see
	// onAirLen) — what AirtimeMs was actually computed from. Kept
	// separate from PayloadLen (rather than replacing it) so existing
	// "${payloadLen}B" displays keep meaning application payload, not
	// wire size.
	OnAirLen int    `json:"onAirLen"`
	HashSize int    `json:"hashSize"`
	Region   string `json:"region,omitempty"`
	Direct   bool   `json:"direct,omitempty"`
	// IsRelay is false for the origin's own first send of a message, true
	// for every subsequent re-transmission by a repeater.
	IsRelay bool `json:"isRelay,omitempty"`
	// CADDeferred/BudgetDeferred are true if this specific transmission was
	// pushed back at least once by CAD / the sender's own duty-cycle budget
	// before actually going out — see Reception.SenderWasCADDeferred /
	// SenderWasBudgetDeferred, the same idea reported from the sender's
	// side rather than the listener's.
	CADDeferred    bool `json:"cadDeferred,omitempty"`
	BudgetDeferred bool `json:"budgetDeferred,omitempty"`
	// Background is true for a fixed replayed background transmission (see
	// Message.Background) — never relays, and never itself deferred; a UI can
	// render it distinctly from the floods being simulated.
	Background bool `json:"background,omitempty"`
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

func overlaps(aStart, aEnd, bStart, bEnd uint32) bool {
	return aStart < bEnd && bStart < aEnd
}

// captureMarginDB is how much stronger (in dB SNR at the listener) a wanted
// signal must be than a co-channel interferer for real LoRa's capture
// effect to let it be decoded anyway, rather than both being destroyed —
// unlike narrowband FM/ASK capture (which can be as low as ~1dB), LoRa's
// chirp spread spectrum needs a real margin to reject an interferer;
// ~6dB is a commonly cited same-SF LoRa co-channel rejection figure. A
// named, tunable constant rather than folded into the comparison inline,
// since this specific number is a literature figure (not verified against
// our own measured hardware behavior) and may need adjusting.
const captureMarginDB = 6.0

// preambleCaptureMarginDB is the acquisition-stage counterpart of
// captureMarginDB: how much stronger the wanted signal must be than a
// co-channel interferer arriving during its own preamble/sync window for
// the receiver to still lock onto the wanted (rather than the interferer
// preventing acquisition). Real LoRa preamble detection is a correlation
// against a known chirp sequence, so a much weaker concurrent signal does
// not stop a strong wanted packet from being acquired — the receiver locks
// onto whichever preamble dominates. Kept EQUAL to captureMarginDB absent
// evidence to differentiate the two stages; a separate named constant so it
// can diverge if measured behavior ever warrants it (correlation processing
// gain could make acquisition somewhat more forgiving than payload
// rejection). Previously this stage had no strength test at all — any
// preamble-window overlap was treated as fatal regardless of level.
const preambleCaptureMarginDB = captureMarginDB

// captureOutcome is the result of one wanted-transmission-vs-one-interferer
// comparison — see loraCaptureOutcome. Three-valued rather than a bool
// because a caller (the interferer loop in eventRxComplete) needs to know
// not just whether the wanted signal survived, but *how* it failed when it
// didn't, to populate Reception.CollisionKind.
type captureOutcome int

const (
	outcomeCaptured  captureOutcome = iota // the wanted signal survived this specific interferer
	outcomeNoLock                          // this interferer arrived during preamble/sync acquisition AND was strong enough to block lock
	outcomeCorrupted                       // lock was achieved, but this interferer wasn't beaten by captureMarginDB
)

// loraCaptureOutcome reports whether tx (the wanted transmission, arriving
// with wantedSNR at the listener) survives other's overlapping, audible
// transmission (arriving with interfererSNR) via the capture effect, and if
// not, which of the two physically distinct ways it failed. This is the
// single-interferer reference primitive; the Run loop applies the same two
// stages but aggregates the payload stage across all interferers at once
// (which a single-pair function can't express).
//
// Two stages, both real LoRa demodulator behavior, and BOTH now
// strength-aware:
//
//  1. Acquisition (timing + strength): if other starts before tx's own
//     preamble+sync window has elapsed (preambleDurationMs), it contends
//     for lock. The receiver still locks onto tx if tx dominates other by
//     preambleCaptureMarginDB (LoRa preamble correlation rejects a
//     sufficiently weaker concurrent signal); otherwise lock never
//     establishes (outcomeNoLock). This mirrors real firmware's own
//     isReceivingPacket()/isChannelActive() distinction
//     (src/helpers/radiolib/RadioLibWrappers.cpp) between merely detecting
//     channel activity and having actually locked onto a specific packet's
//     preamble. When tx wins acquisition over a weaker preamble interferer,
//     that interferer then contends at the payload stage instead (in the
//     Run loop; this single-pair function reports outcomeCaptured for it,
//     since with only that one interferer present tx also wins the payload
//     stage by the same margin).
//  2. Payload (strength): once locked (interference arrives during payload
//     symbols, after tx's own preamble window), the receiver can reject a
//     weaker co-channel interferer — captured if wantedSNR beats
//     interfererSNR by at least captureMarginDB; otherwise the payload is
//     corrupted.
func loraCaptureOutcome(wantedSNR, interfererSNR float64, tx, other transmission) captureOutcome {
	if startsBeforeLock(tx, other) {
		if wantedSNR-interfererSNR >= preambleCaptureMarginDB {
			return outcomeCaptured
		}
		return outcomeNoLock
	}
	if wantedSNR-interfererSNR >= captureMarginDB {
		return outcomeCaptured
	}
	return outcomeCorrupted
}

// loraCaptured is loraCaptureOutcome collapsed to a bool, for the one call
// site (the interferer loop) that only needs pass/fail plus its own
// captureOutcome switch for the kind, and for tests that only care whether
// capture happened at all.
func loraCaptured(wantedSNR, interfererSNR float64, tx, other transmission) bool {
	return loraCaptureOutcome(wantedSNR, interfererSNR, tx, other) == outcomeCaptured
}

// startsBeforeLock reports whether other begins before tx's own
// preamble+sync acquisition window has elapsed — i.e. whether other
// prevents the receiver from ever locking onto tx at all (condition 1 of
// loraCaptureOutcome, factored out so the aggregated interferer loop in
// Run can partition preamble-window interferers from payload-window ones).
func startsBeforeLock(tx, other transmission) bool {
	return other.startMs < tx.startMs+uint32(preambleDurationMs(tx.radio))
}

// aggregateInterfererSNRdB combines several co-channel interferers'
// individual SNRs into the single effective interferer level their COMBINED
// power presents, by summing in the linear domain and converting back to
// dB. This is the fix for pairwise capture over-optimism (docs/SIMULATOR_
// PLAN_PHASE7.md): evaluating each interferer separately lets a wanted
// signal "win" against several interferers it individually beats by the
// capture margin, even though their summed energy would corrupt it. Two
// equal interferers sum to +3 dB, three to ~+4.8 dB, and so on — so the
// effective margin the wanted signal must clear shrinks as interferers
// pile up, which is the real physical behaviour. For a single interferer
// this returns exactly that interferer's own SNR, so nothing changes in
// the (common, and only previously-tested) one-interferer case.
func aggregateInterfererSNRdB(snrs []float64) float64 {
	var linear float64
	for _, s := range snrs {
		linear += math.Pow(10, s/10)
	}
	if linear <= 0 {
		return math.Inf(-1)
	}
	return 10 * math.Log10(linear)
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

// uniformFloat draws a uniform in [0,1) from the RNG interface's only
// method (IntN) — 24 bits of resolution, far finer than any dB-scale
// perturbation here needs. Kept off the hot path: only ever called when a
// ChannelParams feature is actually enabled, so a zero-value (legacy)
// Channel consumes no RNG draws and reproduces prior behaviour exactly.
func uniformFloat(rng RNG) float64 {
	const bits = 1 << 24
	return float64(rng.IntN(bits)) / float64(bits)
}

// gaussian draws a standard-normal sample (mean 0, stddev 1) via
// Box-Muller from two uniforms — deterministic for a deterministic RNG,
// so paired-seed comparisons (the optimizer's whole confidence model)
// stay valid.
func gaussian(rng RNG) float64 {
	u1 := uniformFloat(rng)
	if u1 < 1e-12 {
		u1 = 1e-12 // guard the log; the drawn value is otherwise unbiased
	}
	u2 := uniformFloat(rng)
	return math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
}

// decodes reports whether a wanted signal arriving at effSnr (its mean SNR
// plus any fading already applied by the caller) is successfully decoded
// at spreading factor sf, under channel. With ch.PERWidthDB <= 0 this is
// the legacy hard step (effSnr >= threshold); otherwise it's a logistic
// packet-error-rate curve centred on that SF's own threshold, sampled with
// rng. Only draws from rng when the probabilistic model is active.
func decodes(effSnr float64, sf int, ch ChannelParams, rng RNG) bool {
	threshold := snrThresholdForSF(sf)
	if ch.PERWidthDB <= 0 {
		return effSnr >= threshold
	}
	p := 1.0 / (1.0 + math.Exp(-(effSnr-threshold)/ch.PERWidthDB))
	return uniformFloat(rng) < p
}

// --- item 9: airtime duty-cycle budget ----------------------------------
//
// Real firmware caps every node to roughly a 50% airtime duty cycle over a
// rolling 1-hour window (Dispatcher::updateTxBudget/checkSend,
// src/Dispatcher.cpp) — a node that's been transmitting heavily has to wait
// out its own budget before sending again, on top of every other gate this
// package already models (hop limits, loop.detect, CAD). Modeled last and
// in isolation from this package's other correctness fixes so it can't
// confound their own before/after measurements — a heavily-loaded scenario
// will now take longer to finish flooding than it did before this, which is
// correct, not a regression.
const (
	dutyCycleWindowMs = 3_600_000 // Dispatcher::getDutyCycleWindowMs()'s real default (1 hour)
	// dutyCycleFactor is 1/(1+getAirtimeBudgetFactor()); real firmware's
	// getAirtimeBudgetFactor() returns a constant 1.0, giving exactly 0.5 —
	// a 50% duty cycle. Not user-configurable in real firmware either.
	dutyCycleFactor = 0.5
	// minTxBudgetAirtimeDiv mirrors MIN_TX_BUDGET_AIRTIME_DIV: a send is
	// gated on having at least 1/N of the worst-case airtime as budget.
	minTxBudgetAirtimeDiv = 2
	// maxTransUnitBytes mirrors MAX_TRANS_UNIT: the budget gate is always
	// checked against this worst-case packet size at the sender's own
	// radio settings, never this specific message's own (usually smaller)
	// payload — a conservative pre-check real firmware performs before it
	// even knows the actual size of whatever's queued to go out next.
	maxTransUnitBytes = 255
)

// txBudget is one node's own rolling airtime allowance. Starts full (as if
// freshly booted), refills linearly with elapsed simulation time up to
// dutyCycleWindowMs*dutyCycleFactor, and is debited by the real measured
// airtime of every transmission that node actually sends — direct port of
// Dispatcher's own tx_budget_ms/updateTxBudget/checkSend.
type txBudget struct {
	remainingMs  float64
	lastUpdateMs uint32
}

func newTxBudget() txBudget {
	return txBudget{remainingMs: dutyCycleWindowMs * dutyCycleFactor}
}

// refill brings b up to date as of nowMs — direct port of
// Dispatcher::updateTxBudget(). nowMs must never decrease between calls on
// the same txBudget (guaranteed here since Run only ever refills a given
// node's own budget at that node's own next chronological eventSend).
func (b *txBudget) refill(nowMs uint32) {
	elapsed := nowMs - b.lastUpdateMs
	if elapsed == 0 {
		return
	}
	const maxBudget = dutyCycleWindowMs * dutyCycleFactor
	b.remainingMs += float64(elapsed) * dutyCycleFactor
	if b.remainingMs > maxBudget {
		b.remainingMs = maxBudget
	}
	b.lastUpdateMs = nowMs
}

// deferralMs returns how long (from the moment b was last refilled) a node
// must wait before estAirtimeMs/minTxBudgetAirtimeDiv worth of budget is
// available, or 0 if it's available now — direct port of the "needed /
// duty_cycle" formula in Dispatcher::checkSend().
func (b txBudget) deferralMs(estAirtimeMs uint32) uint32 {
	threshold := float64(estAirtimeMs) / minTxBudgetAirtimeDiv
	if b.remainingMs >= threshold {
		return 0
	}
	needed := threshold - b.remainingMs
	return uint32(needed / dutyCycleFactor)
}

// spend debits actualAirtimeMs from the budget, floored at zero — direct
// port of Dispatcher's own post-send deduction.
func (b *txBudget) spend(actualAirtimeMs uint32) {
	spend := float64(actualAirtimeMs)
	if spend >= b.remainingMs {
		b.remainingMs = 0
	} else {
		b.remainingMs -= spend
	}
}
