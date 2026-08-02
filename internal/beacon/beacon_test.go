package beacon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"hopreach/internal/meshsource"
)

// The adapter's job is absorbing Beacon's shape differences without letting a
// wrong guess through. These pin the ones that fail silently rather than
// loudly: epoch-ms timestamps, lat/lng naming, the {"items":…} envelope, and
// above all the ambiguous-hop rule.

func TestConvertHopRefusesToGuessAnAmbiguousNode(t *testing.T) {
	// A 1-byte path hash can match several nodes. Beacon says so; picking one
	// would invent a relay that may not have been involved.
	ambiguous := resolvedHop{
		Confidence: "ambiguous",
		Nodes: []resolvedNode{
			{PublicKey: "AAAA"}, {PublicKey: "BBBB"},
		},
	}
	got := convertHop(ambiguous)
	if got.Confidence != meshsource.HopUnknown {
		t.Fatalf("ambiguous hop = %v, want HopUnknown", got.Confidence)
	}
	if got.PublicKey != "" {
		t.Errorf("ambiguous hop leaked a public key %q — must not pick nodes[0]",
			got.PublicKey)
	}
}

func TestConvertHopResolvesOnlyHighConfidenceSingletons(t *testing.T) {
	high := resolvedHop{Confidence: "high", Nodes: []resolvedNode{{PublicKey: "AbCd"}}}
	got := convertHop(high)
	if got.Confidence != meshsource.HopResolved || got.PublicKey != "abcd" {
		t.Fatalf("high/single = %+v, want resolved lowercase abcd", got)
	}

	// "high" with several nodes is a contradiction; treat as unknown rather
	// than trusting the label.
	if convertHop(resolvedHop{
		Confidence: "high",
		Nodes:      []resolvedNode{{PublicKey: "a"}, {PublicKey: "b"}},
	}).Confidence != meshsource.HopUnknown {
		t.Error("high confidence with multiple candidates must not resolve")
	}

	if convertHop(resolvedHop{Confidence: "none"}).Confidence != meshsource.HopUnknown {
		t.Error(`"none" must be unknown`)
	}
}

func TestAnyHopUnknownFlagsUncertainChains(t *testing.T) {
	p := meshsource.Packet{Path: []meshsource.Hop{
		{PublicKey: "aa", Confidence: meshsource.HopResolved},
		{Confidence: meshsource.HopUnknown},
	}}
	if !p.AnyHopUnknown() {
		t.Error("a chain with an unresolved hop must report itself uncertain")
	}
	clean := meshsource.Packet{Path: []meshsource.Hop{
		{PublicKey: "aa", Confidence: meshsource.HopResolved},
	}}
	if clean.AnyHopUnknown() {
		t.Error("a fully resolved chain must not be flagged")
	}
}

func TestMsTimeKeepsNeverHeardDistinctFromEpoch(t *testing.T) {
	if got := msTime(0); !got.IsZero() {
		t.Errorf("0 ms = %v, want zero time (never heard, not 1970)", got)
	}
	want := time.UnixMilli(1785511452680).UTC()
	if got := msTime(1785511452680); !got.Equal(want) {
		t.Errorf("msTime = %v, want %v", got, want)
	}
}

func TestConvertNodeDerivesLastHeardFromIatas(t *testing.T) {
	// NodeSummary has no top-level lastSeen — the newest per-IATA hearing is
	// the liveness signal.
	lat, lng := 56.36, -2.94
	n := convertNode(nodeSummary{
		PublicKey:    "AABB",
		NodeTypeName: "repeater",
		Lat:          &lat,
		Lng:          &lng,
		IATAs: []nodeIATA{
			{IATA: "EDI", LastHeard: 1000},
			{IATA: "GLA", LastHeard: 5000},
		},
	})
	if n.PublicKey != "aabb" {
		t.Errorf("public key = %q, want lowercased", n.PublicKey)
	}
	if n.Lon == nil || *n.Lon != lng {
		t.Error("lng must map to Lon")
	}
	if !n.LastHeard.Equal(time.UnixMilli(5000).UTC()) {
		t.Errorf("LastHeard = %v, want the newest IATA hearing", n.LastHeard)
	}
}

func TestSynthesiseReachUsesTheWeakerDirection(t *testing.T) {
	forward := []nodeNeighbor{
		{PublicKey: "BB", ObservationCount: 10, LastSeen: 9_000_000_000_000},
		{PublicKey: "CC", ObservationCount: 4, LastSeen: 9_000_000_000_000},
	}
	// B hears us back only 3 times; C never reports us.
	reverse := map[string]int64{"bb": 3}

	got := SynthesiseReach(forward, reverse, time.Time{})
	if len(got) != 2 {
		t.Fatalf("got %d links, want 2", len(got))
	}
	byKey := map[string]meshsource.ReachLink{}
	for _, l := range got {
		byKey[l.PublicKey] = l
	}
	if b := byKey["bb"]; b.Bottleneck != 3 || !b.Bidir {
		t.Errorf("bb = %+v, want bottleneck 3 (the weaker direction), bidir", b)
	}
	if c := byKey["cc"]; c.Bottleneck != 4 || c.Bidir {
		t.Errorf("cc = %+v, want bottleneck 4, bidir false", c)
	}
}

func TestSynthesiseReachDropsStaleEdges(t *testing.T) {
	// Beacon never deletes an edge when it stops being reported, so without
	// ageing, calibration is fed links that no longer exist.
	old := time.Now().UTC().AddDate(0, 0, -30)
	fresh := time.Now().UTC()
	forward := []nodeNeighbor{
		{PublicKey: "OLD", ObservationCount: 99, LastSeen: old.UnixMilli()},
		{PublicKey: "NEW", ObservationCount: 1, LastSeen: fresh.UnixMilli()},
	}
	got := SynthesiseReach(forward, nil, time.Now().UTC().AddDate(0, 0, -7))
	if len(got) != 1 || got[0].PublicKey != "new" {
		t.Fatalf("got %+v, want only the fresh edge", got)
	}
}

func TestFetchRepeatersUnwrapsItemsAndFollowsCursor(t *testing.T) {
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Query().Get("iatas"); got != "EDI" {
			t.Errorf("iatas = %q, want the configured filter (an unfiltered "+
				"call pulls every network on the server)", got)
		}
		// FetchRepeaters also fills in each node's self-reported default
		// scope, which Beacon's node list omits — that is a second, differently
		// shaped query (see fillDefaultScopes). Answer it emptily and let the
		// assertions below stay about the repeater walk.
		if r.URL.Path == "/api/v1/scopes" {
			_ = json.NewEncoder(w).Encode([]string{})
			return
		}
		if got := r.URL.Query().Get("type"); got != "2" {
			t.Errorf("type = %q, want 2 (repeater)", got)
		}
		calls++
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("cursor") == "" {
			cursor := int64(1234)
			_ = json.NewEncoder(w).Encode(page[nodeSummary]{
				Items: []nodeSummary{{
					ID: "uuid-1", PublicKey: "AA", NodeTypeName: "repeater",
					IATAs: []nodeIATA{{IATA: "EDI", LastHeard: 5000}},
				}},
				NextCursor: &cursor, HasMore: true,
			})
			return
		}
		_ = json.NewEncoder(w).Encode(page[nodeSummary]{
			Items: []nodeSummary{{
				ID: "uuid-2", PublicKey: "BB", NodeTypeName: "repeater",
			}},
			HasMore: false,
		})
	}))
	defer srv.Close()

	c, err := New(srv.URL, []string{"EDI"}, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := c.FetchRepeaters(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Errorf("made %d requests, want 2 (cursor followed)", calls)
	}
	if len(nodes) != 2 {
		t.Fatalf("got %d nodes, want 2", len(nodes))
	}
	// The UUID map is what neighbour lookups need — node paths take UUIDs.
	if id, ok := c.uuidFor("aa"); !ok || id != "uuid-1" {
		t.Errorf("uuid map = %q/%v, want uuid-1", id, ok)
	}
}

func TestNewRequiresAnIATAFilter(t *testing.T) {
	if _, err := New("http://x", nil, nil); err == nil {
		t.Fatal("an unfiltered client must be refused: Beacon partitions by " +
			"IATA and would otherwise return every network it observes")
	}
}

func TestFetchPacketsBetweenUsesServerSideTimeFilter(t *testing.T) {
	from := time.UnixMilli(1_000_000).UTC()
	to := time.UnixMilli(2_000_000).UTC()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("since") != "1000000" || q.Get("until") != "2000000" {
			t.Errorf("since/until = %q/%q, want the window in epoch ms",
				q.Get("since"), q.Get("until"))
		}
		if q.Get("offset") != "" {
			t.Error("must not use offset paging — Beacon filters by time")
		}
		_ = json.NewEncoder(w).Encode(page[packetSummary]{
			Items: []packetSummary{{
				PacketHash: "BB03", RouteType: 1, FirstHeardAt: 1_500_000,
				LatestObserver: &latestObserver{
					ID:         "obs-1",
					PathLength: &pathLength{HashSize: 1, HopCount: 2},
					// resolvedPath deliberately absent on list responses.
				},
			}},
		})
	}))
	defer srv.Close()

	c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
	got, err := c.FetchPacketsBetween(context.Background(), from, to, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d packets, want 1", len(got))
	}
	p := got[0]
	if p.Hash != "bb03" {
		t.Errorf("hash = %q, want lowercased", p.Hash)
	}
	if !p.HeardAt.Equal(time.UnixMilli(1_500_000).UTC()) {
		t.Errorf("HeardAt = %v", p.HeardAt)
	}
	if p.HashSize != 1 || p.HopCount != 2 {
		t.Errorf("hash size/hop count = %d/%d, want 1/2 (from pathLength, no "+
			"raw frame parsing needed)", p.HashSize, p.HopCount)
	}
	if len(p.Path) != 0 {
		t.Error("list responses carry no resolved path; caller must fetch detail")
	}
}

func TestFetchPacketDetailCarriesEveryObservation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := "0RIGIN"
		name1, name2 := "Cadham", "Lucklaw"
		_ = json.NewEncoder(w).Encode(packetDetail{
			PacketHash:   "BB03",
			Header:       packetHeader{RouteType: 1, PayloadType: 4},
			OriginPubkey: &origin,
			FirstHeardAt: 1_500_000,
			Observations: []observationDetail{
				{
					ObserverID: "OBS-1", ObserverName: &name1, HeardAt: 1_500_000,
					PathLength: pathLength{HashSize: 1, HopCount: 1},
					ResolvedPath: []resolvedHop{
						{Confidence: "high", Nodes: []resolvedNode{{PublicKey: "RELAY1"}}},
					},
				},
				{
					ObserverID: "OBS-2", ObserverName: &name2, HeardAt: 1_500_500,
					PathLength:   pathLength{HashSize: 1, HopCount: 2},
					ResolvedPath: []resolvedHop{{Confidence: "ambiguous", Nodes: []resolvedNode{{PublicKey: "X"}, {PublicKey: "Y"}}}},
				},
			},
		})
	}))
	defer srv.Close()

	c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
	p, err := c.FetchPacketDetail(context.Background(), "BB03")
	if err != nil {
		t.Fatal(err)
	}
	// Completeness matters: a missing observation reads as a delivery failure.
	if len(p.Observations) != 2 {
		t.Fatalf("got %d observations, want both", len(p.Observations))
	}
	if p.OriginKey != "0rigin" {
		t.Errorf("origin = %q, want lowercased", p.OriginKey)
	}
	if p.Observations[0].Path[0].PublicKey != "relay1" {
		t.Errorf("resolved hop = %q", p.Observations[0].Path[0].PublicKey)
	}
	if p.Observations[1].Path[0].Confidence != meshsource.HopUnknown {
		t.Error("ambiguous hop must stay unknown in observations too")
	}
	// Representative path comes from the earliest observation.
	if len(p.Path) != 1 || p.Path[0].PublicKey != "relay1" {
		t.Errorf("representative path = %+v", p.Path)
	}
}

func TestFetchScopesHandlesBothShapes(t *testing.T) {
	// /scopes is polymorphic: []string unfiltered, []ScopeSummary filtered.
	for _, body := range []string{`[{"name":"#sco"},{"name":"#fif"}]`, `["#sco","#fif"]`} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		}))
		c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
		got, err := c.FetchScopes(context.Background())
		srv.Close()
		if err != nil {
			t.Fatalf("body %s: %v", body, err)
		}
		if len(got) != 2 || got[0] != "#sco" {
			t.Errorf("body %s → %v", body, got)
		}
	}
}

func TestNewAcceptsABaseURLThatAlreadyHasTheAPIPrefix(t *testing.T) {
	// Beacon's docs show /api/v1 in every example URL, so configuring it that
	// way is the natural thing to do. Doubling the prefix produces a 404 that
	// looks like the server is down rather than like a typo.
	for _, base := range []string{
		"http://localhost:8090",
		"http://localhost:8090/",
		"http://localhost:8090/api/v1",
		"http://localhost:8090/api/v1/",
	} {
		c, err := New(base, []string{"EDI"}, nil)
		if err != nil {
			t.Fatalf("%s: %v", base, err)
		}
		if c.BaseURL != "http://localhost:8090" {
			t.Errorf("New(%q).BaseURL = %q, want the bare host", base, c.BaseURL)
		}
	}
}

func TestFetchRepeatersFillsDefaultScopeTheListOmits(t *testing.T) {
	// Beacon's node LIST does not carry defaultScope even though its detail
	// endpoint does, so without this the map's scope filter and popups would
	// show nothing on a Beacon deployment while working fine on CoreScope.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/scopes":
			_ = json.NewEncoder(w).Encode([]string{"#sco"})
		case r.URL.Query().Get("scope") == "#sco":
			// Only AA is in this scope.
			_ = json.NewEncoder(w).Encode(page[nodeSummary]{
				Items: []nodeSummary{{ID: "uuid-1", PublicKey: "AA", NodeTypeName: "repeater"}},
			})
		default:
			_ = json.NewEncoder(w).Encode(page[nodeSummary]{
				Items: []nodeSummary{
					{ID: "uuid-1", PublicKey: "AA", NodeTypeName: "repeater"},
					{ID: "uuid-2", PublicKey: "BB", NodeTypeName: "repeater"},
				},
			})
		}
	}))
	defer srv.Close()

	c, err := New(srv.URL, []string{"EDI"}, srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	nodes, err := c.FetchRepeaters(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, n := range nodes {
		got[n.PublicKey] = n.DefaultScope
	}
	if got["aa"] != "#sco" {
		t.Errorf("AA default scope = %q, want #sco", got["aa"])
	}
	if got["bb"] != "" {
		t.Errorf("BB default scope = %q, want empty — it is in no scope, and "+
			"guessing one would be a claim the backend never made", got["bb"])
	}
}
