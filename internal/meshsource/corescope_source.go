package meshsource

import (
	"context"
	"fmt"
	"strings"
	"time"

	"hopreach/internal/corescope"
)

// CoreScopeSource adapts the original CoreScope client to [Source].
//
// Behaviour is deliberately unchanged — this is the regression net for the
// abstraction, not a rewrite. The packet methods are not implemented here:
// the replay path still talks to CoreScope directly from the browser, and
// moving it is a later phase (docs/BEACON_COMPATIBILITY_PLAN.md, P2/P4).
type CoreScopeSource struct {
	Client *corescope.Client
}

func NewCoreScopeSource(c *corescope.Client) *CoreScopeSource {
	return &CoreScopeSource{Client: c}
}

func (s *CoreScopeSource) Name() string { return "corescope" }

func (s *CoreScopeSource) FetchRepeaters(ctx context.Context) ([]Node, error) {
	raw, err := s.Client.FetchRepeaters(ctx)
	if err != nil {
		return nil, err
	}
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
			RelayCount24h: derefInt(n.RelayCount24h),
			HashSize:      derefInt(n.HashSize),
			DefaultScope:  derefString(n.DefaultScope),
		})
	}
	return out, nil
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

// FetchScopes is not exposed by the Go-side CoreScope client (the scope list
// is fetched in the browser today), so it reports empty rather than pretending.
func (s *CoreScopeSource) FetchScopes(context.Context) ([]string, error) {
	return nil, nil
}

var errNotImplemented = fmt.Errorf(
	"meshsource: packet access for CoreScope still runs in the browser " +
		"(see docs/BEACON_COMPATIBILITY_PLAN.md P2/P4)")

func (s *CoreScopeSource) FetchPacketsBetween(
	context.Context, time.Time, time.Time, int,
) ([]Packet, error) {
	return nil, errNotImplemented
}

func (s *CoreScopeSource) FetchPacketDetail(context.Context, string) (Packet, error) {
	return Packet{}, errNotImplemented
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
