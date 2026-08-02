// Package meshapi is the translation layer: it serves whatever backend is
// configured (CoreScope, Beacon, …) to the browser in ONE stable shape.
//
// Before this, `simulator.js` fetched a vendor's API directly through an nginx
// passthrough and parsed that vendor's field names, envelopes and timestamp
// formats. That made the browser depend on a third party's JSON — every shape
// surprise (list wrapping, one-row-per-observation, offsetless timestamps)
// landed in front-end code, and a second backend would have meant a second
// parser for every response.
//
// The wire shape served here is deliberately **CoreScope's**, because that is
// what the browser already speaks: adopting it means the front end switches
// backends by changing a base path and nothing else. It is a compatibility
// contract now, not a vendor's API — documented in docs/DATA_SOURCE_SPEC.md
// and produced from meshsource's canonical types, so a Beacon-only deployment
// serves byte-identical JSON.
package meshapi

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"hopreach/internal/meshsource"
)

// Prefix is where these handlers mount.
const Prefix = "/mesh-api/"

// Handler serves the canonical mesh API from a [meshsource.Source].
type Handler struct {
	Source meshsource.Source

	// PacketWindowLimit caps how many packets one window request may return.
	PacketWindowLimit int
}

func New(src meshsource.Source) *Handler {
	return &Handler{Source: src, PacketWindowLimit: 500}
}

// Register mounts the routes on mux under [Prefix].
func (h *Handler) Register(mux *http.ServeMux) {
	mux.HandleFunc(Prefix+"api/nodes", h.handleNodes)
	mux.HandleFunc(Prefix+"api/nodes/", h.handleNodeSub) // …/{pubkey}/reach
	mux.HandleFunc(Prefix+"api/scope-stats", h.handleScopes)
	mux.HandleFunc(Prefix+"api/packets", h.handlePackets)
	mux.HandleFunc(Prefix+"api/packets/", h.handlePacketDetail)
	mux.HandleFunc(Prefix+"api/source", h.handleSource)
}

// ── wire shapes (CoreScope-compatible; see the package doc) ────────────────

type wireNode struct {
	PublicKey     string   `json:"public_key"`
	Name          *string  `json:"name"`
	Role          string   `json:"role"`
	Lat           *float64 `json:"lat"`
	Lon           *float64 `json:"lon"`
	LastHeard     *string  `json:"last_heard"`
	FirstSeen     *string  `json:"first_seen"`
	RelayCount24h *int     `json:"relay_count_24h"`
	HashSize      *int     `json:"hash_size"`
	DefaultScope  *string  `json:"default_scope"`
}

type wireLink struct {
	Pubkey     string   `json:"pubkey"`
	Name       string   `json:"name"`
	Lat        *float64 `json:"lat"`
	Lon        *float64 `json:"lon"`
	Bottleneck int      `json:"bottleneck"`
	Bidir      bool     `json:"bidir"`
}

type wirePacket struct {
	Hash         string   `json:"hash"`
	Timestamp    string   `json:"timestamp"`
	ObserverID   string   `json:"observer_id"`
	ResolvedPath []string `json:"resolved_path"`
	RouteType    int      `json:"route_type"`
	SNR          *float64 `json:"snr"`
	DecodedJSON  string   `json:"decoded_json"`

	// PathComplete is false when the backend could not pin down every hop
	// (Beacon reports resolution confidence; CoreScope has no such signal and
	// always reports true). A replay built on an incomplete path is less
	// certain and the front end can say so instead of presenting a guess.
	PathComplete bool `json:"path_complete"`

	// Everything below is decoded from the packet's own over-the-air bytes
	// by whichever backend has them, so the browser never sees raw_hex.
	// Scope is the region the packet was actually sent on, empty for a
	// genuinely unscoped flood or one whose region we cannot name — never a
	// guess. Zeroes elsewhere mean "the backend could not tell us", which is
	// why they are omitted rather than sent as 0.
	Scope       string `json:"scope,omitempty"`
	PayloadType int    `json:"payload_type,omitempty"`
	HashSize    int    `json:"hash_size,omitempty"`
	HopCount    int    `json:"hop_count,omitempty"`
	PayloadLen  int    `json:"payload_len,omitempty"`
	FrameBytes  int    `json:"frame_bytes,omitempty"`
}

// toWirePacket is the single conversion both the window and detail handlers
// use, so a field added to one can never be forgotten by the other.
func toWirePacket(p meshsource.Packet) wirePacket {
	path, complete := hopKeys(p.Path)
	return wirePacket{
		Hash:         p.Hash,
		Timestamp:    p.HeardAt.UTC().Format(time.RFC3339),
		ObserverID:   p.ObserverKey,
		ResolvedPath: path,
		RouteType:    p.RouteType,
		SNR:          p.SNR,
		DecodedJSON:  originJSON(p.OriginKey),
		PathComplete: complete,
		Scope:        p.Scope,
		PayloadType:  p.PayloadType,
		HashSize:     p.HashSize,
		HopCount:     p.HopCount,
		PayloadLen:   p.PayloadLen,
		FrameBytes:   p.FrameBytes,
	}
}

type wireObservation struct {
	ObserverID   string   `json:"observer_id"`
	ObserverName string   `json:"observer_name"`
	Timestamp    string   `json:"timestamp"`
	ResolvedPath []string `json:"resolved_path"`
	SNR          *float64 `json:"snr"`
	PathComplete bool     `json:"path_complete"`
}

// ── conversions ────────────────────────────────────────────────────────────

func isoOrNil(t time.Time) *string {
	if t.IsZero() {
		return nil // "never heard" — not the epoch
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

func strOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func intOrNil(v int) *int {
	if v == 0 {
		return nil
	}
	return &v
}

// hopKeys flattens hops to the public-key list the front end expects, and
// reports whether every hop was actually resolved. An unknown hop becomes an
// empty string rather than being dropped, so hop *positions* stay truthful —
// silently shortening a path would turn a 3-hop flood into a 2-hop one.
func hopKeys(hops []meshsource.Hop) ([]string, bool) {
	out := make([]string, 0, len(hops))
	complete := true
	for _, h := range hops {
		if h.Confidence != meshsource.HopResolved {
			complete = false
			out = append(out, "")
			continue
		}
		out = append(out, h.PublicKey)
	}
	return out, complete
}

// ── handlers ───────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// handleSource lets the UI say which backend it is looking at.
func (h *Handler) handleSource(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]string{"source": h.Source.Name()})
}

func (h *Handler) handleNodes(w http.ResponseWriter, r *http.Request) {
	nodes, err := h.Source.FetchRepeaters(r.Context())
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := make([]wireNode, 0, len(nodes))
	for _, n := range nodes {
		out = append(out, wireNode{
			PublicKey:     n.PublicKey,
			Name:          strOrNil(n.Name),
			Role:          n.Role,
			Lat:           n.Lat,
			Lon:           n.Lon,
			LastHeard:     isoOrNil(n.LastHeard),
			FirstSeen:     isoOrNil(n.FirstSeen),
			RelayCount24h: intOrNil(n.RelayCount24h),
			HashSize:      intOrNil(n.HashSize),
			DefaultScope:  strOrNil(n.DefaultScope),
		})
	}
	writeJSON(w, map[string]any{"nodes": out, "total": len(out)})
}

// handleNodeSub serves /api/nodes/{pubkey}/reach.
func (h *Handler) handleNodeSub(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, Prefix+"api/nodes/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 || parts[1] != "reach" {
		httpError(w, http.StatusNotFound, "unknown node sub-resource")
		return
	}
	days := 7
	if v := r.URL.Query().Get("days"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		}
	}
	links, err := h.Source.FetchReach(r.Context(), parts[0], days)
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := make([]wireLink, 0, len(links))
	for _, l := range links {
		out = append(out, wireLink{
			Pubkey: l.PublicKey, Name: l.Name, Lat: l.Lat, Lon: l.Lon,
			Bottleneck: l.Bottleneck, Bidir: l.Bidir,
		})
	}
	writeJSON(w, map[string]any{"links": out})
}

func (h *Handler) handleScopes(w http.ResponseWriter, r *http.Request) {
	names, err := h.Source.FetchScopes(r.Context())
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	regions := make([]map[string]string, 0, len(names))
	for _, n := range names {
		regions = append(regions, map[string]string{"name": n})
	}
	writeJSON(w, map[string]any{"byRegion": regions})
}

// handlePackets serves a time window.
//
// The parameters are `since`/`until` (epoch ms) — intent, not mechanism. The
// old browser code binary-searched `offset` because CoreScope has no time
// filter; that workaround now lives behind the interface (or disappears
// entirely, on a backend that filters server-side).
func (h *Handler) handlePackets(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sinceMs, err1 := strconv.ParseInt(q.Get("since"), 10, 64)
	untilMs, err2 := strconv.ParseInt(q.Get("until"), 10, 64)
	if err1 != nil || err2 != nil || untilMs < sinceMs {
		httpError(w, http.StatusBadRequest,
			"since and until (epoch ms, until >= since) are required")
		return
	}
	limit := h.PacketWindowLimit
	if v := q.Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < limit {
			limit = n
		}
	}
	packets, err := h.Source.FetchPacketsBetween(
		r.Context(), time.UnixMilli(sinceMs), time.UnixMilli(untilMs), limit)
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := make([]wirePacket, 0, len(packets))
	for _, p := range packets {
		out = append(out, toWirePacket(p))
	}
	writeJSON(w, map[string]any{"packets": out, "total": len(out)})
}

func (h *Handler) handlePacketDetail(w http.ResponseWriter, r *http.Request) {
	hash := strings.Trim(strings.TrimPrefix(r.URL.Path, Prefix+"api/packets/"), "/")
	if hash == "" {
		httpError(w, http.StatusNotFound, "packet hash required")
		return
	}
	p, err := h.Source.FetchPacketDetail(r.Context(), hash)
	if err != nil {
		httpError(w, http.StatusBadGateway, err.Error())
		return
	}
	obs := make([]wireObservation, 0, len(p.Observations))
	for _, o := range p.Observations {
		op, oc := hopKeys(o.Path)
		obs = append(obs, wireObservation{
			ObserverID:   o.ObserverKey,
			ObserverName: o.ObserverName,
			Timestamp:    o.HeardAt.UTC().Format(time.RFC3339),
			ResolvedPath: op,
			SNR:          o.SNR,
			PathComplete: oc,
		})
	}
	writeJSON(w, map[string]any{
		"packet":       toWirePacket(p),
		"observations": obs,
	})
}

// originJSON reproduces the stringified-JSON field the front end reads the
// packet originator from (`decoded_json.pubKey`).
func originJSON(originKey string) string {
	if originKey == "" {
		return "{}"
	}
	b, err := json.Marshal(map[string]string{"pubKey": originKey})
	if err != nil {
		return "{}"
	}
	return string(b)
}
