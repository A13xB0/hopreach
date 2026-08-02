package meshapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"hopreach/internal/meshsource"
)

// The point of this layer is that the browser sees one shape whichever
// backend is behind it. These pin the parts that would silently mislead:
// "never heard" surviving as null, hop positions staying truthful when a hop
// is unresolved, and the origin field the front end actually reads.

type fakeSource struct {
	caps    meshsource.Capabilities
	nodes   []meshsource.Node
	links   []meshsource.ReachLink
	scopes  []string
	packets []meshsource.Packet
	detail  meshsource.Packet
}

func (f *fakeSource) Name() string                          { return "fake" }
func (f *fakeSource) Capabilities() meshsource.Capabilities { return f.caps }
func (f *fakeSource) FetchRepeaters(context.Context) ([]meshsource.Node, error) {
	return f.nodes, nil
}
func (f *fakeSource) FetchReach(context.Context, string, int) ([]meshsource.ReachLink, error) {
	return f.links, nil
}
func (f *fakeSource) FetchScopes(context.Context) ([]string, error) { return f.scopes, nil }
func (f *fakeSource) FetchPacketsBetween(
	context.Context, time.Time, time.Time, int,
) ([]meshsource.Packet, error) {
	return f.packets, nil
}
func (f *fakeSource) FetchPacketDetail(context.Context, string) (meshsource.Packet, error) {
	return f.detail, nil
}
func (f *fakeSource) FetchAllNodes(context.Context) ([]meshsource.Node, error) {
	return f.nodes, nil
}
func (f *fakeSource) FetchRegionParticipation(
	context.Context, time.Time, []string,
) (meshsource.Participation, error) {
	return meshsource.Participation{}, nil
}

func serve(t *testing.T, src meshsource.Source, path string) map[string]any {
	t.Helper()
	mux := http.NewServeMux()
	New(src).Register(mux)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s → %d: %s", path, rec.Code, rec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad JSON from %s: %v", path, err)
	}
	return out
}

func TestNodesKeepNeverHeardAsNull(t *testing.T) {
	lat := 56.3
	src := &fakeSource{nodes: []meshsource.Node{
		{PublicKey: "aa", Role: "repeater", Lat: &lat,
			LastHeard: time.UnixMilli(1_700_000_000_000)},
		{PublicKey: "bb", Role: "repeater"}, // never heard
	}}
	got := serve(t, src, Prefix+"api/nodes")
	nodes := got["nodes"].([]any)
	if len(nodes) != 2 {
		t.Fatalf("got %d nodes", len(nodes))
	}
	if nodes[0].(map[string]any)["last_heard"] == nil {
		t.Error("a heard node lost its timestamp")
	}
	if lh := nodes[1].(map[string]any)["last_heard"]; lh != nil {
		t.Errorf("never-heard node reported last_heard=%v — must stay null, "+
			"not become the epoch", lh)
	}
}

func TestUnresolvedHopKeepsItsPositionInThePath(t *testing.T) {
	// Dropping an unknown hop would turn a 3-hop flood into a 2-hop one and
	// silently change the topology the replay reconstructs.
	src := &fakeSource{packets: []meshsource.Packet{{
		Hash: "bb03", HeardAt: time.UnixMilli(1_700_000_000_000), RouteType: 1,
		Path: []meshsource.Hop{
			{PublicKey: "r1", Confidence: meshsource.HopResolved},
			{Confidence: meshsource.HopUnknown},
			{PublicKey: "r3", Confidence: meshsource.HopResolved},
		},
	}}}
	got := serve(t, src, Prefix+"api/packets?since=1&until=9999999999999")
	p := got["packets"].([]any)[0].(map[string]any)
	path := p["resolved_path"].([]any)
	if len(path) != 3 {
		t.Fatalf("path = %v, want 3 entries with the unknown one preserved", path)
	}
	if path[1] != "" {
		t.Errorf("unknown hop = %q, want empty placeholder", path[1])
	}
	if p["path_complete"] != false {
		t.Error("a path with an unresolved hop must not claim to be complete")
	}
}

func TestFullyResolvedPathReportsComplete(t *testing.T) {
	src := &fakeSource{packets: []meshsource.Packet{{
		Hash: "aa", HeardAt: time.Now(), RouteType: 1,
		Path: []meshsource.Hop{{PublicKey: "r1", Confidence: meshsource.HopResolved}},
	}}}
	got := serve(t, src, Prefix+"api/packets?since=1&until=9999999999999")
	if got["packets"].([]any)[0].(map[string]any)["path_complete"] != true {
		t.Error("a fully resolved path must report complete")
	}
}

func TestPacketCarriesOriginInTheFieldTheFrontEndReads(t *testing.T) {
	src := &fakeSource{packets: []meshsource.Packet{
		{Hash: "aa", HeardAt: time.Now(), OriginKey: "origin1"},
		{Hash: "bb", HeardAt: time.Now()}, // undecodable origin
	}}
	got := serve(t, src, Prefix+"api/packets?since=1&until=9999999999999")
	packets := got["packets"].([]any)

	var decoded map[string]string
	raw := packets[0].(map[string]any)["decoded_json"].(string)
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("decoded_json is not stringified JSON: %v", err)
	}
	if decoded["pubKey"] != "origin1" {
		t.Errorf("pubKey = %q", decoded["pubKey"])
	}
	if packets[1].(map[string]any)["decoded_json"] != "{}" {
		t.Error("an unknown origin must be an empty object, not null")
	}
}

func TestPacketWindowRequiresATimeRange(t *testing.T) {
	mux := http.NewServeMux()
	New(&fakeSource{}).Register(mux)
	for _, path := range []string{
		Prefix + "api/packets",
		Prefix + "api/packets?since=5&until=1", // until before since
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET %s → %d, want 400", path, rec.Code)
		}
	}
}

func TestReachAndScopesUseTheShapeTheBrowserExpects(t *testing.T) {
	src := &fakeSource{
		links:  []meshsource.ReachLink{{PublicKey: "bb", Bottleneck: 3, Bidir: true}},
		scopes: []string{"#sco", "#fif"},
	}
	reach := serve(t, src, Prefix+"api/nodes/aa/reach?days=7")
	link := reach["links"].([]any)[0].(map[string]any)
	if link["pubkey"] != "bb" || link["bottleneck"].(float64) != 3 || link["bidir"] != true {
		t.Errorf("link = %v", link)
	}

	scopes := serve(t, src, Prefix+"api/scope-stats")
	regions := scopes["byRegion"].([]any)
	if len(regions) != 2 || regions[0].(map[string]any)["name"] != "#sco" {
		t.Errorf("byRegion = %v", regions)
	}
}

func TestDetailExposesEveryObservation(t *testing.T) {
	src := &fakeSource{detail: meshsource.Packet{
		Hash: "bb03", HeardAt: time.Now(),
		Observations: []meshsource.Observation{
			{ObserverKey: "o1", ObserverName: "Cadham", HeardAt: time.Now(),
				Path: []meshsource.Hop{{PublicKey: "r1", Confidence: meshsource.HopResolved}}},
			{ObserverKey: "o2", ObserverName: "Lucklaw", HeardAt: time.Now(),
				Path: []meshsource.Hop{{Confidence: meshsource.HopUnknown}}},
		},
	}}
	got := serve(t, src, Prefix+"api/packets/bb03")
	obs := got["observations"].([]any)
	if len(obs) != 2 {
		t.Fatalf("got %d observations — a missing one reads as a delivery "+
			"failure in the replay", len(obs))
	}
	if obs[1].(map[string]any)["path_complete"] != false {
		t.Error("the ambiguous observation must not claim a complete path")
	}
}

func TestPacketCarriesTheDecodedFieldsTheBrowserNoLongerComputes(t *testing.T) {
	// The browser used to receive raw_hex and decode these itself — a
	// hand-rolled SHA-256 and a frame parser in front-end code. It now reads
	// them off the wire, so anything missing here is a silently unscoped
	// replay rather than a visible error.
	src := &fakeSource{packets: []meshsource.Packet{{
		Hash: "aa", HeardAt: time.Now(), RouteType: 0,
		Scope: "#fife", PayloadType: 3, HashSize: 2, HopCount: 4,
		PayloadLen: 40, FrameBytes: 105,
	}}}
	got := serve(t, src, Prefix+"api/packets?since=1&until=9999999999999")
	p := got["packets"].([]any)[0].(map[string]any)
	for field, want := range map[string]any{
		"scope": "#fife", "payload_type": 3.0, "hash_size": 2.0,
		"hop_count": 4.0, "payload_len": 40.0, "frame_bytes": 105.0,
	} {
		if p[field] != want {
			t.Errorf("%s = %v, want %v", field, p[field], want)
		}
	}
	if _, ok := p["raw_hex"]; ok {
		t.Error("raw_hex must not reach the browser — decoding it there is what " +
			"put a vendor's wire format in front-end code")
	}
}

func TestUnknownFrameFieldsAreOmittedRatherThanZero(t *testing.T) {
	// A backend that cannot tell us the frame size must not claim zero
	// bytes: airtime computed from that would be confidently wrong.
	src := &fakeSource{packets: []meshsource.Packet{
		{Hash: "aa", HeardAt: time.Now(), RouteType: 1},
	}}
	got := serve(t, src, Prefix+"api/packets?since=1&until=9999999999999")
	p := got["packets"].([]any)[0].(map[string]any)
	for _, field := range []string{"scope", "frame_bytes", "payload_len", "hash_size"} {
		if _, present := p[field]; present {
			t.Errorf("%s present as %v, want omitted so the caller can tell "+
				"'unknown' from a real zero", field, p[field])
		}
	}
}

func TestDetailAndListAgreeOnTheSamePacketShape(t *testing.T) {
	// Both handlers convert through one function precisely so a field added
	// to one can't be forgotten by the other.
	p := meshsource.Packet{
		Hash: "bb03", HeardAt: time.Now(), RouteType: 0,
		Scope: "#fife", HashSize: 2, FrameBytes: 105,
	}
	list := serve(t, &fakeSource{packets: []meshsource.Packet{p}},
		Prefix+"api/packets?since=1&until=9999999999999")
	detail := serve(t, &fakeSource{detail: p}, Prefix+"api/packets/bb03")

	fromList := list["packets"].([]any)[0].(map[string]any)
	fromDetail := detail["packet"].(map[string]any)
	if len(fromList) != len(fromDetail) {
		t.Fatalf("list has %d fields, detail %d — they have drifted apart",
			len(fromList), len(fromDetail))
	}
	for k, v := range fromList {
		if !reflect.DeepEqual(fromDetail[k], v) {
			t.Errorf("%s: list %v, detail %v", k, v, fromDetail[k])
		}
	}
}

func TestSourceEndpointNamesTheBackend(t *testing.T) {
	got := serve(t, &fakeSource{}, Prefix+"api/source")
	if got["source"] != "fake" {
		t.Errorf("source = %v", got["source"])
	}
}

func TestSourceEndpointDeclaresCapabilities(t *testing.T) {
	// The front end hides a feature outright when the backend cannot answer
	// completely. Inferring that from an empty result instead would be
	// indistinguishable from a mesh that genuinely has no regions.
	got := serve(t, &fakeSource{caps: meshsource.Capabilities{ScopeCatalog: true}},
		Prefix+"api/source")
	caps, ok := got["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("no capabilities in %v", got)
	}
	if caps["scope_catalog"] != true {
		t.Errorf("scope_catalog = %v, want true", caps["scope_catalog"])
	}

	got = serve(t, &fakeSource{}, Prefix+"api/source")
	caps = got["capabilities"].(map[string]any)
	if caps["scope_catalog"] != false {
		t.Errorf("scope_catalog = %v, want false — a backend that cannot "+
			"enumerate every region must say so, not stay silent",
			caps["scope_catalog"])
	}
}

func TestAnUnreportedPathDoesNotClaimToBeComplete(t *testing.T) {
	// Beacon's packet LIST carries hop counts but omits paths by design. With
	// only "did every hop I was given resolve?" an empty list answers yes —
	// so a 3-hop flood whose path nobody reported would present as a
	// fully-resolved direct reception.
	src := &fakeSource{packets: []meshsource.Packet{
		{Hash: "aa", HeardAt: time.Now(), RouteType: 1, HopCount: 3}, // path omitted
		{Hash: "bb", HeardAt: time.Now(), RouteType: 1, HopCount: 0}, // genuinely direct
	}}
	got := serve(t, src, Prefix+"api/packets?since=1&until=9999999999999")
	packets := got["packets"].([]any)

	if packets[0].(map[string]any)["path_complete"] != false {
		t.Error("a packet with hops but no reported path must not claim a " +
			"complete path — that is 'we were not told', not 'heard direct'")
	}
	if packets[1].(map[string]any)["path_complete"] != true {
		t.Error("a genuine direct reception has no hops and IS complete")
	}
}
