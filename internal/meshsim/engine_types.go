package meshsim

// The simulator's public wire types: what a caller hands in
// (Scenario, ChannelParams, Message) and what it gets back
// (Reception, Report, Transmission). These marshal straight to JSON
// across the WASM boundary.

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
