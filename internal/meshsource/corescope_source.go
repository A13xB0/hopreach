package meshsource

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"hopreach/internal/corescope"
)

// CoreScopeSource adapts the original CoreScope client to [Source].
//
// Packet access included: region decoding and frame parsing happen here,
// from the raw over-the-air bytes, so the browser is handed answers rather
// than a vendor's raw_hex to decode for itself.
type CoreScopeSource struct {
	Client *corescope.Client

	regionMu    sync.Mutex
	regionNames map[string]bool
}

func NewCoreScopeSource(c *corescope.Client) *CoreScopeSource {
	return &CoreScopeSource{Client: c}
}

func (s *CoreScopeSource) Name() string { return "corescope" }

// Capabilities: CoreScope keeps a global region list, so the catalogue is
// complete and everything region-shaped can be built on it.
func (s *CoreScopeSource) Capabilities() Capabilities {
	return Capabilities{ScopeCatalog: true}
}

func (s *CoreScopeSource) FetchRepeaters(ctx context.Context) ([]Node, error) {
	raw, err := s.Client.FetchRepeaters(ctx)
	if err != nil {
		return nil, err
	}
	return nodesFromCoreScope(raw), nil
}

func (s *CoreScopeSource) FetchReach(ctx context.Context, pubkey string, days int) ([]ReachLink, error) {
	raw, err := s.Client.FetchReach(ctx, pubkey, days)
	if err != nil {
		return nil, err
	}
	out := make([]ReachLink, 0, len(raw))
	for _, l := range raw {
		out = append(out, ReachLink{
			PublicKey:  strings.ToLower(l.Pubkey),
			Name:       l.Name,
			Lat:        l.Lat,
			Lon:        l.Lon,
			Bottleneck: l.Bottleneck,
			Bidir:      l.Bidir,
		})
	}
	return out, nil
}

func (s *CoreScopeSource) FetchScopes(ctx context.Context) ([]string, error) {
	return s.Client.FetchKnownRegionNames(ctx)
}

func (s *CoreScopeSource) FetchAllNodes(ctx context.Context) ([]Node, error) {
	raw, err := s.Client.FetchAllNodes(ctx)
	if err != nil {
		return nil, err
	}
	return nodesFromCoreScope(raw), nil
}

// FetchRegionParticipation walks CoreScope's packet history, decoding each
// packet's own transport code. The node directory is needed to resolve the
// short hop-hashes in each relay path back to full public keys, so it is
// fetched here rather than asked of the caller.
func (s *CoreScopeSource) FetchRegionParticipation(
	ctx context.Context, since time.Time, regionNames []string,
) (Participation, error) {
	allNodes, err := s.Client.FetchAllNodes(ctx)
	if err != nil {
		return Participation{}, err
	}
	p, err := s.Client.FetchRegionParticipation(ctx, since, allNodes, regionNames)
	if err != nil {
		return Participation{}, err
	}
	return Participation{Scoped: p.Scoped, Unscoped: p.Unscoped}, nil
}

// nodesFromCoreScope is the one place CoreScope's node shape becomes the
// canonical one, shared by FetchRepeaters and FetchAllNodes.
func nodesFromCoreScope(raw []corescope.Node) []Node {
	out := make([]Node, 0, len(raw))
	for _, n := range raw {
		out = append(out, Node{
			PublicKey:     strings.ToLower(n.PublicKey),
			Name:          derefString(n.Name),
			Role:          n.Role,
			Lat:           n.Lat,
			Lon:           n.Lon,
			LastHeard:     parseTime(n.LastHeard),
			FirstSeen:     parseTime(n.FirstSeen),
			AdvertCount:   derefInt(n.AdvertCount),
			RelayCount1h:  derefInt(n.RelayCount1h),
			RelayCount24h: derefInt(n.RelayCount24h),
			HashSize:      derefInt(n.HashSize),
			DefaultScope:  derefString(n.DefaultScope),
		})
	}
	return out
}

func (s *CoreScopeSource) FetchPacketsBetween(
	ctx context.Context, from, to time.Time, limit int,
) ([]Packet, error) {
	rows, err := s.Client.FetchPacketsBetween(ctx, from, to, limit)
	if err != nil {
		return nil, err
	}
	keys, err := s.regionKeys(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Packet, 0, len(rows))
	for _, r := range rows {
		out = append(out, s.packetFromRow(r, keys))
	}
	return out, nil
}

func (s *CoreScopeSource) FetchPacketDetail(ctx context.Context, hash string) (Packet, error) {
	detail, err := s.Client.FetchPacketDetail(ctx, hash)
	if err != nil {
		return Packet{}, err
	}
	keys, err := s.regionKeys(ctx)
	if err != nil {
		return Packet{}, err
	}
	p := s.packetFromRow(detail.Packet, keys)
	if p.Hash == "" {
		p.Hash = hash
	}
	for _, o := range detail.Observations {
		p.Observations = append(p.Observations, Observation{
			ObserverKey:  strings.ToLower(o.ObserverID),
			ObserverName: o.ObserverName,
			HeardAt:      parseTime(&o.Timestamp),
			Path:         resolvedHops(o.ResolvedPath),
			SNR:          o.SNR,
		})
	}
	return p, nil
}

// regionKeys caches the candidate region set for the process lifetime.
//
// The names come from a second endpoint, so deriving them per packet would
// mean a fetch per packet. A transient failure is deliberately NOT cached:
// caching an empty set would silently unscope every packet for the rest of
// the process, which reads as "this mesh has no regions" rather than as an
// error.
func (s *CoreScopeSource) regionKeys(ctx context.Context) (map[string]bool, error) {
	s.regionMu.Lock()
	defer s.regionMu.Unlock()
	if s.regionNames != nil {
		return s.regionNames, nil
	}
	names, err := s.Client.FetchKnownRegionNames(ctx)
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	if len(set) > 0 {
		s.regionNames = set
	}
	return set, nil
}

// packetFromRow converts one CoreScope row to the canonical shape, decoding
// the region and frame structure from the raw bytes here rather than shipping
// raw_hex to the browser to decode.
func (s *CoreScopeSource) packetFromRow(r corescope.PacketRow, regions map[string]bool) Packet {
	names := make([]string, 0, len(regions))
	for n := range regions {
		names = append(names, n)
	}
	p := Packet{
		Hash:        strings.ToLower(r.Hash),
		HeardAt:     parseTime(&r.Timestamp),
		RouteType:   r.RouteType,
		ObserverKey: strings.ToLower(r.ObserverID),
		SNR:         r.SNR,
		Path:        resolvedHops(r.ResolvedPath),
		OriginKey:   originFromDecodedJSON(r.DecodedJSON),
		Scope:       corescope.RegionOfPacket(r.RawHex, names),
	}
	if f, ok := corescope.ParseFrame(r.RawHex); ok {
		p.PayloadType = int(f.PayloadType)
		p.HashSize = f.HashSize
		p.HopCount = f.HopCount
		p.PayloadLen = f.PayloadLen
		p.FrameBytes = f.TotalBytes
	}
	return p
}

// resolvedHops wraps CoreScope's already-resolved public keys. CoreScope
// reports no per-hop confidence, so a key it gives us is taken as resolved
// and an empty slot as genuinely unknown — never guessed at.
func resolvedHops(keys []string) []Hop {
	if len(keys) == 0 {
		return nil
	}
	hops := make([]Hop, 0, len(keys))
	for _, k := range keys {
		if k == "" {
			hops = append(hops, Hop{Confidence: HopUnknown})
			continue
		}
		hops = append(hops, Hop{PublicKey: strings.ToLower(k), Confidence: HopResolved})
	}
	return hops
}

// originFromDecodedJSON pulls the originating node out of the stringified
// JSON blob CoreScope carries it in.
func originFromDecodedJSON(raw string) string {
	if raw == "" {
		return ""
	}
	var decoded struct {
		PubKey string `json:"pubKey"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return ""
	}
	return strings.ToLower(decoded.PubKey)
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func derefInt(v *int) int {
	if v == nil {
		return 0
	}
	return *v
}

// parseTime accepts CoreScope's RFC3339 timestamps. An unparseable or absent
// value stays zero — "never heard" must not become 1970.
func parseTime(s *string) time.Time {
	if s == nil || *s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339, *s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}

var _ Source = (*CoreScopeSource)(nil)
