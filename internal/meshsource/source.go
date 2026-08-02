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

	RelayCount24h int
	HashSize      int    // path-hash width this node adverts with (1..3), 0 = unknown
	DefaultScope  string // region/scope name, "" = unknown
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
}
