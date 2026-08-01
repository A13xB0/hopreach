package meshapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hopreach/internal/meshsource"
)

// The point of this layer is that the browser sees one shape whichever
// backend is behind it. These pin the parts that would silently mislead:
// "never heard" surviving as null, hop positions staying truthful when a hop
// is unresolved, and the origin field the front end actually reads.

type fakeSource struct {
	nodes   []meshsource.Node
	links   []meshsource.ReachLink
	scopes  []string
	packets []meshsource.Packet
	detail  meshsource.Packet
}

func (f *fakeSource) Name() string { return "fake" }
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

func TestSourceEndpointNamesTheBackend(t *testing.T) {
	got := serve(t, &fakeSource{}, Prefix+"api/source")
	if got["source"] != "fake" {
		t.Errorf("source = %v", got["source"])
	}
}
