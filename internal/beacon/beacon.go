// Package beacon adapts a MeshCore Beacon server
// (github.com/MeshCore-Beacon/beacon-server) to meshsource.Source.
//
// See docs/BEACON_COMPATIBILITY_PLAN.md. The differences from CoreScope that
// this package exists to absorb:
//
//   - timestamps are unix epoch *milliseconds* as integers, not RFC3339;
//   - lists are wrapped as {"items": [...], "nextCursor": <int64>, "hasMore"};
//   - pagination is cursor-only, but `since`/`until` give real server-side
//     time filtering (better than CoreScope — one request per replay window);
//   - node path params are UUIDs, not public keys;
//   - there is no reach/links endpoint: it is synthesised from per-node
//     neighbours (SynthesiseReach);
//   - resolved paths are deliberately absent from the packet list and only
//     available on packet detail;
//   - path hops carry a resolution *confidence* and can be ambiguous.
//
// Everything is GET and unauthenticated, matching CoreScope's posture.
package beacon

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"hopreach/internal/meshsource"
)

// Beacon partitions the world by 3-letter IATA code. Without a filter a
// consumer pulls every network on the server, so IATAs is required by
// New — calibrating a Scottish map against links in another country is a
// silent, expensive mistake.
type Client struct {
	BaseURL string
	IATAs   []string
	HTTP    *http.Client

	// DetailConcurrency bounds the packet-detail fan-out (resolved paths are
	// detail-only). Zero uses a sane default.
	DetailConcurrency int

	mu       sync.Mutex
	uuidByPK map[string]string // node public key → Beacon UUID
}

// apiPrefix is Beacon's versioned API root, appended to the configured base.
const apiPrefix = "/api/v1"

func New(baseURL string, iatas []string, httpClient *http.Client) (*Client, error) {
	if strings.TrimSpace(baseURL) == "" {
		return nil, fmt.Errorf("beacon: base URL is required")
	}
	if len(iatas) == 0 {
		return nil, fmt.Errorf("beacon: at least one IATA is required " +
			"(an unfiltered server returns every network it observes)")
	}
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	// Tolerate a base URL that already includes the API prefix. Beacon's own
	// docs and every example URL show /api/v1, so configuring it that way is
	// the natural mistake — and doubling it gives a 404 that reads like the
	// server is down rather than like a config typo.
	base := strings.TrimRight(baseURL, "/")
	base = strings.TrimSuffix(base, apiPrefix)

	return &Client{
		BaseURL:  base,
		IATAs:    iatas,
		HTTP:     httpClient,
		uuidByPK: map[string]string{},
	}, nil
}

func (c *Client) Name() string { return "beacon" }

// ── wire types (mirror beacon-server's Go structs, not beacon-docs) ─────────

type page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor *int64 `json:"nextCursor"`
	HasMore    bool   `json:"hasMore"`
}

type nodeIATA struct {
	IATA      string `json:"iata"`
	LastHeard int64  `json:"lastHeard"` // epoch ms
}

type nodeSummary struct {
	ID           string     `json:"id"` // UUID — the only way to address a node
	PublicKey    string     `json:"publicKey"`
	NodeType     int        `json:"nodeType"` // 2 = repeater, 3 = room server
	NodeTypeName string     `json:"nodeTypeName"`
	Name         *string    `json:"name"`
	Lat          *float64   `json:"lat"`
	Lng          *float64   `json:"lng"` // note: lng, not lon
	IATAs        []nodeIATA `json:"iatas"`
	DefaultScope *string    `json:"defaultScope"`
	Stale        bool       `json:"stale"`
}

type nodeNeighbor struct {
	PublicKey        string   `json:"publicKey"`
	Name             *string  `json:"name"`
	Lat              *float64 `json:"lat"`
	Lng              *float64 `json:"lng"`
	IATA             string   `json:"iata"`
	ObservationCount int64    `json:"observationCount"`
	LastSeen         int64    `json:"lastSeen"` // epoch ms
	SNR              *float64 `json:"snr"`
}

type resolvedNode struct {
	PublicKey string   `json:"publicKey"`
	Name      *string  `json:"name"`
	Latitude  *float64 `json:"latitude"` // note: latitude here, lat on nodes
	Longitude *float64 `json:"longitude"`
}

type resolvedHop struct {
	Confidence string         `json:"confidence"` // high | ambiguous | none
	SNR        *float64       `json:"snr"`
	Nodes      []resolvedNode `json:"nodes"`
}

type pathLength struct {
	HashSize int `json:"hashSize"`
	HopCount int `json:"hopCount"`
}

type latestObserver struct {
	ID           string        `json:"id"`
	DisplayName  *string       `json:"displayName"`
	PathLength   *pathLength   `json:"pathLength"`
	ResolvedPath []resolvedHop `json:"resolvedPath"` // nil on REST list, by design
}

type packetSummary struct {
	PacketHash     string          `json:"packetHash"`
	PayloadType    int             `json:"payloadType"`
	RouteType      int             `json:"routeType"`
	Scope          *string         `json:"scope"`
	FirstHeardAt   int64           `json:"firstHeardAt"` // epoch ms
	LastHeardAt    int64           `json:"lastHeardAt"`
	LatestObserver *latestObserver `json:"latestObserver"`
}

type packetHeader struct {
	RouteType   int `json:"routeType"`
	PayloadType int `json:"payloadType"`
}

type observationDetail struct {
	ObserverID   string        `json:"observerId"`
	ObserverName *string       `json:"observerName"`
	HeardAt      int64         `json:"heardAt"`
	PathLength   pathLength    `json:"pathLength"`
	RSSI         *int          `json:"rssi"`
	SNR          *float64      `json:"snr"`
	ResolvedPath []resolvedHop `json:"resolvedPath"`
}

type packetDetail struct {
	PacketHash string       `json:"packetHash"`
	Header     packetHeader `json:"header"`

	// RawPayload is the application payload as hex — the frame minus its
	// header, transport code and accumulated path. Only the detail response
	// carries it; the packet list does not, which is why frame sizing is
	// only available once a packet has been looked at individually.
	RawPayload string `json:"rawPayload"`

	OriginPubkey *string             `json:"originPubkey"`
	Scope        *string             `json:"scope"`
	FirstHeardAt int64               `json:"firstHeardAt"`
	Observations []observationDetail `json:"observations"`
}

// frameSizes derives the payload and whole-frame byte counts the simulator
// needs for airtime, from the payload Beacon reports plus the framing implied
// by the packet's own route type and path.
//
// Reconstructed rather than measured, because Beacon stores the payload and
// the framing separately and never reports the assembled frame length. The
// arithmetic is the wire format's, not a guess: one header byte, four more for
// a transport code when the route type carries one, one path_len byte, and
// hopCount*hashSize accumulated path bytes.
//
// Returns zeroes when the payload is absent, so a caller can tell "not
// reported" from "a zero-length frame" — airtime computed from a fabricated
// zero would be confidently wrong.
func frameSizes(d packetDetail, hashSize, hopCount int) (payloadLen, frameBytes int) {
	payloadLen = len(d.RawPayload) / 2
	if payloadLen == 0 {
		return 0, 0
	}
	framing := 1 + 1 + hopCount*hashSize
	if d.Header.RouteType == routeTransportFlood || d.Header.RouteType == routeTransportDirect {
		framing += 4
	}
	return payloadLen, payloadLen + framing
}

// MeshCore route types that carry a 4-byte transport code.
const (
	routeTransportFlood  = 0
	routeTransportDirect = 3
)

type scopeSummary struct {
	Name string `json:"name"`
}

// ── conversions ────────────────────────────────────────────────────────────

// msTime converts Beacon's epoch-milliseconds to a time. Zero stays zero, so
// "never heard" is not silently turned into 1970.
func msTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms).UTC()
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// convertHop flattens Beacon's richer, honest hop into ours.
//
// The rule matters: an "ambiguous" hop means several nodes share that path
// hash. Picking nodes[0] would invent a relay that may not have been
// involved — precisely the class of error SIMULATION_REVIEW.md documents. An
// ambiguous or unresolved hop is reported as unknown.
func convertHop(h resolvedHop) meshsource.Hop {
	if strings.EqualFold(h.Confidence, "high") && len(h.Nodes) == 1 {
		return meshsource.Hop{
			PublicKey:  strings.ToLower(h.Nodes[0].PublicKey),
			Confidence: meshsource.HopResolved,
			SNR:        h.SNR,
		}
	}
	return meshsource.Hop{Confidence: meshsource.HopUnknown, SNR: h.SNR}
}

func convertPath(hops []resolvedHop) []meshsource.Hop {
	if len(hops) == 0 {
		return nil
	}
	out := make([]meshsource.Hop, 0, len(hops))
	for _, h := range hops {
		out = append(out, convertHop(h))
	}
	return out
}

func convertNode(n nodeSummary) meshsource.Node {
	// NodeSummary carries no top-level lastSeen (the SQL selects and sorts on
	// it but it isn't serialised), so liveness comes from the newest per-IATA
	// hearing.
	var newest int64
	for _, ia := range n.IATAs {
		if ia.LastHeard > newest {
			newest = ia.LastHeard
		}
	}
	return meshsource.Node{
		PublicKey:    strings.ToLower(n.PublicKey),
		Name:         deref(n.Name),
		Role:         n.NodeTypeName,
		Lat:          n.Lat,
		Lon:          n.Lng,
		LastHeard:    msTime(newest),
		DefaultScope: deref(n.DefaultScope),
	}
}

// SynthesiseReach builds bidirectional reach links from Beacon's directed
// per-node neighbour edges.
//
// Beacon has no reach/links endpoint, but node_neighbors holds the right
// data: a directed edge with an observation_count. The weaker direction is
// the bottleneck — "how sure are we this link is real and mutually usable".
//
// [staleBefore] drops edges last seen before it: Beacon never deletes an edge
// when it stops being reported, so without ageing, calibration is fed links
// that no longer exist.
func SynthesiseReach(
	forward []nodeNeighbor,
	reverseCounts map[string]int64,
	staleBefore time.Time,
) []meshsource.ReachLink {
	out := make([]meshsource.ReachLink, 0, len(forward))
	for _, n := range forward {
		if !staleBefore.IsZero() {
			if seen := msTime(n.LastSeen); !seen.IsZero() && seen.Before(staleBefore) {
				continue
			}
		}
		key := strings.ToLower(n.PublicKey)
		fwd := n.ObservationCount
		rev, bidir := reverseCounts[key]
		bottleneck := fwd
		if bidir && rev < fwd {
			bottleneck = rev
		}
		if bottleneck < 0 {
			bottleneck = 0
		}
		out = append(out, meshsource.ReachLink{
			PublicKey:  key,
			Name:       deref(n.Name),
			Lat:        n.Lat,
			Lon:        n.Lng,
			Bottleneck: int(bottleneck),
			Bidir:      bidir,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PublicKey < out[j].PublicKey })
	return out
}

// ── HTTP ───────────────────────────────────────────────────────────────────

func (c *Client) get(ctx context.Context, path string, q url.Values, out any) error {
	u := c.BaseURL + apiPrefix + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return fmt.Errorf("beacon: GET %s: %w", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("beacon: GET %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (c *Client) iataParam() string { return strings.Join(c.IATAs, ",") }

// FetchRepeaters pages through the node list, keeping repeaters, and records
// the pubkey→UUID mapping the neighbour calls need (node paths take UUIDs).
func (c *Client) FetchRepeaters(ctx context.Context) ([]meshsource.Node, error) {
	nodes, err := c.fetchNodes(ctx, url.Values{"type": []string{"2"}}) // 2 = repeater
	if err != nil {
		return nil, err
	}
	return nodes, c.fillDefaultScopes(ctx, nodes)
}

// fillDefaultScopes populates each node's self-reported default scope.
//
// Beacon's node LIST omits defaultScope (its per-node detail endpoint reports
// it, and the list query selects it, but the list response does not carry it).
// Asking for detail per node would be one request per repeater; asking
// /nodes?scope=NAME — which filters on exactly that field — is one request per
// region, and there are single-digit numbers of those.
//
// A failure here is logged rather than fatal: default_scope is what a repeater
// says about itself, sparse in practice, and shown alongside the observed
// scopes rather than relied on.
func (c *Client) fillDefaultScopes(ctx context.Context, nodes []meshsource.Node) error {
	scopes, err := c.FetchScopes(ctx)
	if err != nil || len(scopes) == 0 {
		return nil
	}
	byKey := make(map[string]int, len(nodes))
	for i := range nodes {
		byKey[strings.ToLower(nodes[i].PublicKey)] = i
	}
	for _, name := range scopes {
		members, err := c.fetchNodes(ctx, url.Values{"scope": []string{name}})
		if err != nil {
			log.Printf("beacon: default scope %q: %v", name, err)
			continue
		}
		for _, m := range members {
			if i, ok := byKey[strings.ToLower(m.PublicKey)]; ok {
				nodes[i].DefaultScope = name
			}
		}
	}
	return nil
}

// fetchNodes pages /nodes with an optional filter, recording each node's
// Beacon UUID against its public key on the way past — FetchReach needs that
// mapping and there is no endpoint to look one up directly.
func (c *Client) fetchNodes(ctx context.Context, filter url.Values) ([]meshsource.Node, error) {
	const limit = 500
	var (
		nodes  []meshsource.Node
		cursor *int64
	)
	for {
		q := url.Values{}
		for k, vs := range filter {
			for _, v := range vs {
				q.Set(k, v)
			}
		}
		q.Set("iatas", c.iataParam())
		q.Set("limit", fmt.Sprint(limit))
		if cursor != nil {
			q.Set("cursor", fmt.Sprint(*cursor))
		}
		var pg page[nodeSummary]
		if err := c.get(ctx, "/nodes", q, &pg); err != nil {
			return nil, err
		}
		c.mu.Lock()
		for _, n := range pg.Items {
			nodes = append(nodes, convertNode(n))
			if n.ID != "" && n.PublicKey != "" {
				c.uuidByPK[strings.ToLower(n.PublicKey)] = n.ID
			}
		}
		c.mu.Unlock()
		if !pg.HasMore || pg.NextCursor == nil || len(pg.Items) == 0 {
			break
		}
		cursor = pg.NextCursor
	}
	return nodes, nil
}

// FetchAllNodes returns every node Beacon knows in the configured IATAs,
// any role — relay paths run through room servers and companions too.
func (c *Client) FetchAllNodes(ctx context.Context) ([]meshsource.Node, error) {
	return c.fetchNodes(ctx, nil)
}

func (c *Client) uuidFor(pubkey string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id, ok := c.uuidByPK[strings.ToLower(pubkey)]
	return id, ok
}

// FetchReach synthesises reach for one node from its neighbours, and the
// neighbours' own neighbour lists for the reverse direction.
func (c *Client) FetchReach(ctx context.Context, pubkey string, days int) ([]meshsource.ReachLink, error) {
	id, ok := c.uuidFor(pubkey)
	if !ok {
		// The map is filled by FetchRepeaters; a cold call needs it first.
		if _, err := c.FetchRepeaters(ctx); err != nil {
			return nil, err
		}
		if id, ok = c.uuidFor(pubkey); !ok {
			return nil, fmt.Errorf("beacon: no node with public key %s", pubkey)
		}
	}
	var forward []nodeNeighbor
	if err := c.get(ctx, "/nodes/"+id+"/neighbors", nil, &forward); err != nil {
		return nil, err
	}
	// Reverse counts make the bottleneck meaningful; without them every link
	// would look as strong as its better direction.
	reverse := map[string]int64{}
	for _, n := range forward {
		nid, ok := c.uuidFor(n.PublicKey)
		if !ok {
			continue
		}
		var back []nodeNeighbor
		if err := c.get(ctx, "/nodes/"+nid+"/neighbors", nil, &back); err != nil {
			continue // one unreachable neighbour must not fail the whole node
		}
		for _, b := range back {
			if strings.EqualFold(b.PublicKey, pubkey) {
				reverse[strings.ToLower(n.PublicKey)] = b.ObservationCount
				break
			}
		}
	}
	var staleBefore time.Time
	if days > 0 {
		staleBefore = time.Now().UTC().AddDate(0, 0, -days)
	}
	return SynthesiseReach(forward, reverse, staleBefore), nil
}

func (c *Client) FetchScopes(ctx context.Context) ([]string, error) {
	// /scopes is polymorphic: a bare []string unfiltered, []ScopeSummary when
	// filtered by IATA. We always filter, so decode the object form and fall
	// back to strings.
	q := url.Values{}
	q.Set("iatas", c.iataParam())
	var raw json.RawMessage
	if err := c.get(ctx, "/scopes", q, &raw); err != nil {
		return nil, err
	}
	var objs []scopeSummary
	if err := json.Unmarshal(raw, &objs); err == nil {
		out := make([]string, 0, len(objs))
		for _, o := range objs {
			if o.Name != "" {
				out = append(out, o.Name)
			}
		}
		return out, nil
	}
	var names []string
	if err := json.Unmarshal(raw, &names); err != nil {
		return nil, fmt.Errorf("beacon: unexpected /scopes shape: %w", err)
	}
	return names, nil
}

// FetchPacketsBetween uses Beacon's server-side time filter — one request per
// window, instead of CoreScope's offset binary search.
func (c *Client) FetchPacketsBetween(
	ctx context.Context, from, to time.Time, limit int,
) ([]meshsource.Packet, error) {
	return c.fetchPacketList(ctx, from, to, limit, nil)
}

// fetchPacketList is the shared window query. extra carries any additional
// server-side filter — participation asks for one route type, which is far
// cheaper than pulling every packet and discarding most of them here.
func (c *Client) fetchPacketList(
	ctx context.Context, from, to time.Time, limit int, extra url.Values,
) ([]meshsource.Packet, error) {
	if limit <= 0 {
		limit = 500
	}
	q := url.Values{}
	for k, vs := range extra {
		for _, v := range vs {
			q.Set(k, v)
		}
	}
	q.Set("iatas", c.iataParam())
	q.Set("since", fmt.Sprint(from.UnixMilli()))
	q.Set("until", fmt.Sprint(to.UnixMilli()))
	q.Set("limit", fmt.Sprint(limit))

	var pg page[packetSummary]
	if err := c.get(ctx, "/packets", q, &pg); err != nil {
		return nil, err
	}
	out := make([]meshsource.Packet, 0, len(pg.Items))
	for _, p := range pg.Items {
		out = append(out, convertSummary(p))
	}
	return out, nil
}

func convertSummary(p packetSummary) meshsource.Packet {
	pk := meshsource.Packet{
		Hash:        strings.ToLower(p.PacketHash),
		HeardAt:     msTime(p.FirstHeardAt),
		RouteType:   p.RouteType,
		PayloadType: p.PayloadType,
		Scope:       deref(p.Scope),
	}
	if p.LatestObserver != nil {
		pk.ObserverKey = strings.ToLower(p.LatestObserver.ID)
		// resolvedPath is deliberately nil on REST list responses; when it is
		// absent the caller must use FetchPacketDetail to learn the path.
		pk.Path = convertPath(p.LatestObserver.ResolvedPath)
		if p.LatestObserver.PathLength != nil {
			pk.HashSize = p.LatestObserver.PathLength.HashSize
			pk.HopCount = p.LatestObserver.PathLength.HopCount
		}
	}
	return pk
}

// FetchPacketDetail returns the packet with every observation of it.
func (c *Client) FetchPacketDetail(ctx context.Context, hash string) (meshsource.Packet, error) {
	var d packetDetail
	if err := c.get(ctx, "/packets/"+url.PathEscape(strings.ToLower(hash)), nil, &d); err != nil {
		return meshsource.Packet{}, err
	}
	return convertDetail(d), nil
}

func convertDetail(d packetDetail) meshsource.Packet {
	pk := meshsource.Packet{
		Hash:        strings.ToLower(d.PacketHash),
		HeardAt:     msTime(d.FirstHeardAt),
		RouteType:   d.Header.RouteType,
		PayloadType: d.Header.PayloadType,
		Scope:       deref(d.Scope),
		OriginKey:   strings.ToLower(deref(d.OriginPubkey)),
	}
	for _, o := range d.Observations {
		obs := meshsource.Observation{
			ObserverKey:  strings.ToLower(o.ObserverID),
			ObserverName: deref(o.ObserverName),
			HeardAt:      msTime(o.HeardAt),
			Path:         convertPath(o.ResolvedPath),
			SNR:          o.SNR,
			RSSI:         o.RSSI,
		}
		pk.Observations = append(pk.Observations, obs)
	}
	// Representative path = the first (earliest) observation, matching how the
	// list endpoint reports one path per packet.
	if len(pk.Observations) > 0 {
		pk.Path = pk.Observations[0].Path
		pk.ObserverKey = pk.Observations[0].ObserverKey
		pk.SNR = pk.Observations[0].SNR
	}
	if len(d.Observations) > 0 {
		pk.HashSize = d.Observations[0].PathLength.HashSize
		pk.HopCount = d.Observations[0].PathLength.HopCount
		// Airtime is computed from the frame length, which Beacon reports only
		// here — its packet list carries no payload at all.
		pk.PayloadLen, pk.FrameBytes = frameSizes(d, pk.HashSize, pk.HopCount)
	}
	return pk
}

var _ meshsource.Source = (*Client)(nil)
