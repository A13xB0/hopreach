// Package meshsource is the seam between HopReach and whoever is observing
// the mesh for it.
//
// HopReach does not watch the mesh itself — it consumes someone else's record
// of what was heard. Historically that was always CoreScope, and its JSON
// shapes leaked all the way into the browser. This package defines one
// canonical shape (docs/DATA_SOURCE_SPEC.md) that every backend is adapted
// into, so the pipeline and the simulator only ever see one vocabulary.
//
// Implementations live alongside: CoreScope in this package, MeshCore Beacon
// in internal/beacon (docs/BEACON_COMPATIBILITY_PLAN.md).
package meshsource

import (
	"context"
	"sort"
	"time"
)

// Node is one mesh node as the backend knows it.
type Node struct {
	PublicKey string // full-length lowercase hex
	Name      string
	Role      string // "repeater", "companion", "room_server", …

	// Position. Absent (nil) means the node can't contribute coverage —
	// that's a normal state, not an error.
	Lat *float64
	Lon *float64

	// LastHeard is zero when the backend has never heard it. Callers use it
	// for liveness, so "never" and "at the epoch" must not be confused.
	LastHeard time.Time
	FirstSeen time.Time

	// Activity counters. The pipeline renders these in the map popup, so
	// "backend didn't say" and "genuinely zero" both arrive as 0 — a
	// distinction no consumer currently makes.
	AdvertCount   int
	RelayCount1h  int
	RelayCount24h int

	HashSize     int    // path-hash width this node adverts with (1..3), 0 = unknown
	DefaultScope string // region/scope name, "" = unknown
}

// ReachLink is an *observed* link from one node to another — evidence, never
// prediction. HopReach scores its own propagation model against these, so a
// backend that returns predictions here makes calibration meaningless.
type ReachLink struct {
	PublicKey string
	Name      string
	Lat       *float64
	Lon       *float64

	// Bottleneck is the observation count of the weaker direction: "how sure
	// are we this link is real and mutually usable". Used directly as a
	// confidence weight.
	Bottleneck int
	Bidir      bool
}

// HopConfidence says how certain the backend is that a path hash resolved to
// a particular node. A 1-byte hash can match several nodes; a backend that
// admits this is more useful than one that guesses.
type HopConfidence int

const (
	// HopUnknown: unresolved, or resolved ambiguously. Treat the hop as an
	// unknown relay — never pick one of the candidates arbitrarily, that
	// invents a relay which may not exist.
	HopUnknown HopConfidence = iota
	// HopResolved: exactly one node matched.
	HopResolved
)

// Hop is one relay in a packet's path.
type Hop struct {
	PublicKey  string // "" when Confidence is HopUnknown
	Confidence HopConfidence
	SNR        *float64
}

// Observation is one receiver's hearing of a packet.
type Observation struct {
	ObserverKey  string // observer identity (pubkey or opaque id, lowercased)
	ObserverName string
	HeardAt      time.Time
	Path         []Hop
	SNR          *float64
	RSSI         *int
}

// Packet is one transmission, deduplicated across observers.
type Packet struct {
	Hash        string
	HeardAt     time.Time // first hearing
	RouteType   int       // 0/1 = flood
	PayloadType int
	HashSize    int
	HopCount    int
	Scope       string

	// PayloadLen and FrameBytes describe the frame as transmitted: the
	// application payload alone, and the whole thing including header,
	// transport code and accumulated path. FrameBytes is what airtime is
	// computed from, so the two are not interchangeable. Zero means the
	// backend could not tell us.
	PayloadLen int
	FrameBytes int

	// OriginKey is the originating node when the backend could decode it.
	OriginKey string

	// Path is a representative path (from the reporting observer). Empty
	// means heard direct.
	Path []Hop
	// ObserverKey is whose hearing Path came from.
	ObserverKey string
	SNR         *float64

	// Observations is populated only by FetchPacketDetail, and must then be
	// *complete* — the replay compares who heard a packet against who was
	// listening, so a missing observation reads as a delivery failure.
	Observations []Observation
}

// AnyHopUnknown reports whether the representative path contains a hop the
// backend could not pin down. Replays built on such a path are less certain
// and should say so rather than presenting a guess as fact.
func (p Packet) AnyHopUnknown() bool {
	for _, h := range p.Path {
		if h.Confidence != HopResolved {
			return true
		}
	}
	return false
}

// Source is what HopReach needs from an observation backend.
//
// Note FetchPacketsBetween takes a time range rather than an offset: the
// intent is "the packets around this moment". Modelling it as offset paging
// would bake in CoreScope's lack of a time filter, which Beacon does not
// share.
type Source interface {
	// Name identifies the backend in logs and diagnostics.
	Name() string

	// FetchRepeaters returns every repeater the backend knows.
	FetchRepeaters(ctx context.Context) ([]Node, error)

	// FetchReach returns observed links from one node.
	FetchReach(ctx context.Context, pubkey string, days int) ([]ReachLink, error)

	// FetchScopes returns known region/scope names.
	FetchScopes(ctx context.Context) ([]string, error)

	// FetchPacketsBetween returns packets heard in [from, to], newest first,
	// capped at limit. One entry per packet, never one per observation.
	FetchPacketsBetween(ctx context.Context, from, to time.Time, limit int) ([]Packet, error)

	// FetchPacketDetail returns one packet with *every* observation of it.
	FetchPacketDetail(ctx context.Context, hash string) (Packet, error)

	// FetchAllNodes returns every node the backend knows, any role — not
	// just repeaters. A flood's relay path runs through room servers and
	// companions too, so anything resolving a path needs the full directory.
	FetchAllNodes(ctx context.Context) ([]Node, error)

	// FetchRegionParticipation observes, over a window, which regions each
	// node is actually seen relaying in — and which are seen relaying plain
	// unscoped traffic.
	//
	// This is deliberately a backend capability rather than something
	// derived here from FetchPacketsBetween. Both backends can answer it far
	// more cheaply than a generic caller could: CoreScope decodes each
	// packet's transport code as it walks its own history, and Beacon
	// already stores the scope per packet. Doing it generically would mean
	// pulling every packet in the window across the network to recompute
	// what the backend already knows.
	FetchRegionParticipation(ctx context.Context, since time.Time, regionNames []string) (Participation, error)
}

// Participation is one window's worth of observed region membership.
//
// Scoped is pubkey -> region name -> observation count: which regions this
// node was actually seen relaying in, confirmed from real traffic rather
// than from its own self-reported default_scope (empty for ~76% of real
// repeaters, so not something a map can be built on).
//
// Unscoped is pubkey -> how many plain, unscoped floods it was seen
// relaying. Absence means "never observed relaying unscoped traffic in this
// window", which is weaker evidence than Scoped's cryptographic confirmation
// — see ObservedUnscoped.
type Participation struct {
	Scoped   map[string]map[string]int
	Unscoped map[string]int
}

// ObservedScopes lists every region a node has at least one confirmed
// observation in, sorted. A repeater can genuinely run more than one region
// at once, so this is not "the most-observed region".
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

// ObservedUnscoped reports whether a node was seen relaying unscoped traffic.
// Unlike ObservedScopes this is an absence-based signal: never having been
// observed is suggestive, not proof, that the node denies unscoped traffic.
func ObservedUnscoped(count int) bool {
	return count > 0
}
