package meshsource

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"hopreach/internal/corescope"
)

// These pin the half of the replay path that moved out of the browser: the
// region a packet was sent on, the frame structure airtime is computed from,
// and the promise that an unknown hop stays unknown.

// floodFrameFor builds a frame whose transport code genuinely matches region.
func floodFrameFor(region string, payload []byte) string {
	digest := sha256.Sum256([]byte(region))
	mac := hmac.New(sha256.New, digest[:16])
	payloadType := byte(3)
	mac.Write(append([]byte{payloadType}, payload...))
	sum := mac.Sum(nil)
	return hex.EncodeToString(
		append([]byte{payloadType << 2, sum[0], sum[1], 0, 0, 0}, payload...))
}

// fakeCoreScope serves just enough of CoreScope for the source to work, and
// counts scope-stats hits so the region cache can be asserted.
type fakeCoreScope struct {
	scopeHits atomic.Int32
	regions   []string
	packets   []corescope.PacketRow
	detail    any
	scopeFail bool
}

func (f *fakeCoreScope) start(t *testing.T) *CoreScopeSource {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/scope-stats", func(w http.ResponseWriter, r *http.Request) {
		f.scopeHits.Add(1)
		if f.scopeFail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		regions := make([]map[string]string, 0, len(f.regions))
		for _, n := range f.regions {
			regions = append(regions, map[string]string{"name": n})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"byRegion": regions})
	})
	mux.HandleFunc("/api/packets", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") == "1" { // an offset probe
			_ = json.NewEncoder(w).Encode(map[string]any{"packets": f.packets[:min(1, len(f.packets))]})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"packets": f.packets})
	})
	mux.HandleFunc("/api/packets/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(f.detail)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return NewCoreScopeSource(corescope.NewClient(srv.URL, srv.Client()))
}

func TestCoreScopeSourceDecodesRegionAndFrameServerSide(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	f := &fakeCoreScope{
		regions: []string{"#scotland", "#fife"},
		packets: []corescope.PacketRow{{
			Hash:         "BB03",
			Timestamp:    now.Format(time.RFC3339),
			RawHex:       floodFrameFor("#fife", []byte{1, 2, 3, 4}),
			RouteType:    0,
			ObserverID:   "OBS1",
			ResolvedPath: []string{"R1", ""},
			DecodedJSON:  `{"pubKey":"ORIGIN1"}`,
		}},
	}
	src := f.start(t)

	got, err := src.FetchPacketsBetween(context.Background(), now.Add(-time.Minute), now, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d packets", len(got))
	}
	p := got[0]
	if p.Scope != "#fife" {
		t.Errorf("scope = %q, want #fife decoded from the packet's own bytes", p.Scope)
	}
	if p.FrameBytes == 0 || p.PayloadLen == 0 {
		t.Errorf("frame not parsed: bytes=%d payloadLen=%d", p.FrameBytes, p.PayloadLen)
	}
	// Keys are lowercased so the browser can compare them to node public
	// keys without caring which case a backend happened to use.
	if p.Hash != "bb03" || p.ObserverKey != "obs1" || p.OriginKey != "origin1" {
		t.Errorf("not normalised: hash=%q observer=%q origin=%q",
			p.Hash, p.ObserverKey, p.OriginKey)
	}
	if len(p.Path) != 2 {
		t.Fatalf("path has %d hops, want 2 with the unknown one kept", len(p.Path))
	}
	if p.Path[0].Confidence != HopResolved || p.Path[0].PublicKey != "r1" {
		t.Errorf("hop 0 = %+v", p.Path[0])
	}
	if p.Path[1].Confidence != HopUnknown {
		t.Error("an empty hop must stay unknown, not be dropped — that would " +
			"turn a 2-hop flood into a 1-hop one")
	}
}

func TestCoreScopeSourceLeavesAnUnknownRegionUnscoped(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	f := &fakeCoreScope{
		regions: []string{"#scotland"}, // the packet is on #fife
		packets: []corescope.PacketRow{{
			Hash:      "aa",
			Timestamp: now.Format(time.RFC3339),
			RawHex:    floodFrameFor("#fife", []byte{9}),
		}},
	}
	got, err := f.start(t).FetchPacketsBetween(context.Background(), now.Add(-time.Minute), now, 100)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Scope != "" {
		t.Errorf("scope = %q — a region we can't name must stay empty, not be "+
			"attributed to the nearest candidate", got[0].Scope)
	}
}

func TestCoreScopeSourceCachesRegionNamesButNotFailures(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	f := &fakeCoreScope{
		scopeFail: true,
		packets:   []corescope.PacketRow{{Hash: "aa", Timestamp: now.Format(time.RFC3339)}},
	}
	src := f.start(t)

	if _, err := src.FetchPacketsBetween(context.Background(), now.Add(-time.Minute), now, 10); err == nil {
		t.Fatal("a failing scope fetch must surface, not silently unscope everything")
	}
	// Recovering must actually recover: a cached failure would leave every
	// packet unscoped for the life of the process.
	f.scopeFail = false
	f.regions = []string{"#fife"}
	if _, err := src.FetchPacketsBetween(context.Background(), now.Add(-time.Minute), now, 10); err != nil {
		t.Fatalf("after recovery: %v", err)
	}

	before := f.scopeHits.Load()
	if _, err := src.FetchPacketsBetween(context.Background(), now.Add(-time.Minute), now, 10); err != nil {
		t.Fatal(err)
	}
	if f.scopeHits.Load() != before {
		t.Error("region names must be cached once fetched — otherwise every " +
			"packet window re-fetches them")
	}
}

func TestCoreScopeSourceDetailCarriesEveryObservation(t *testing.T) {
	f := &fakeCoreScope{
		regions: []string{"#fife"},
		detail: map[string]any{
			"packet": corescope.PacketRow{
				Hash: "bb03", Timestamp: "2026-08-01T12:00:00Z",
				RawHex: floodFrameFor("#fife", []byte{7}),
			},
			"observations": []corescope.PacketObservation{
				{ObserverID: "O1", ObserverName: "Cadham", Timestamp: "2026-08-01T12:00:00Z",
					ResolvedPath: []string{"R1"}},
				{ObserverID: "O2", ObserverName: "Lucklaw", Timestamp: "2026-08-01T12:00:01Z"},
			},
		},
	}
	p, err := f.start(t).FetchPacketDetail(context.Background(), "bb03")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Observations) != 2 {
		t.Fatalf("got %d observations — a missing one reads as a delivery failure "+
			"that never happened", len(p.Observations))
	}
	if p.Observations[0].ObserverKey != "o1" || p.Observations[0].ObserverName != "Cadham" {
		t.Errorf("observation 0 = %+v", p.Observations[0])
	}
	if p.Scope != "#fife" {
		t.Errorf("detail scope = %q, want the same decode the list does", p.Scope)
	}
}

func TestCoreScopeSourceFetchScopesReportsTheRealList(t *testing.T) {
	f := &fakeCoreScope{regions: []string{"#scotland", "#fife"}}
	got, err := f.start(t).FetchScopes(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "#scotland,#fife" {
		t.Errorf("scopes = %v — an empty list reads as 'this mesh has no "+
			"regions', which is a different claim from 'we didn't ask'", got)
	}
}

func TestOriginFromDecodedJSONToleratesRubbish(t *testing.T) {
	for in, want := range map[string]string{
		`{"pubKey":"ABC"}`: "abc",
		`{}`:               "",
		``:                 "",
		`not json`:         "",
	} {
		if got := originFromDecodedJSON(in); got != want {
			t.Errorf("originFromDecodedJSON(%q) = %q, want %q", in, got, want)
		}
	}
}
