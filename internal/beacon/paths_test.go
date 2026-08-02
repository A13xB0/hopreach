package beacon

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Beacon omits resolvedPath from list responses by design, so the replay
// window has to be completed with detail calls. These pin that the fan-out
// happens, is bounded, and degrades rather than fails.

func newPacketServer(t *testing.T, hashes []string, failFor map[string]bool,
	inFlight *int32, maxSeen *int32) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/api/v1/packets/") {
			hash := strings.TrimPrefix(r.URL.Path, "/api/v1/packets/")
			if failFor[hash] {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			cur := atomic.AddInt32(inFlight, 1)
			for {
				old := atomic.LoadInt32(maxSeen)
				if cur <= old || atomic.CompareAndSwapInt32(maxSeen, old, cur) {
					break
				}
			}
			time.Sleep(5 * time.Millisecond)
			atomic.AddInt32(inFlight, -1)

			_ = json.NewEncoder(w).Encode(packetDetail{
				PacketHash:   hash,
				Header:       packetHeader{RouteType: 1},
				FirstHeardAt: 1_500_000,
				Observations: []observationDetail{{
					ObserverID: "obs-" + hash,
					HeardAt:    1_500_000,
					PathLength: pathLength{HashSize: 1, HopCount: 1},
					ResolvedPath: []resolvedHop{
						{Confidence: "high", Nodes: []resolvedNode{{PublicKey: "RELAY-" + hash}}},
					},
				}},
			})
			return
		}
		items := make([]packetSummary, 0, len(hashes))
		for _, h := range hashes {
			items = append(items, packetSummary{
				PacketHash: h, RouteType: 1, FirstHeardAt: 1_500_000,
				LatestObserver: &latestObserver{ID: "obs", PathLength: &pathLength{HashSize: 1}},
			})
		}
		_ = json.NewEncoder(w).Encode(page[packetSummary]{Items: items})
	}))
}

func TestFetchPacketsWithPathsFillsPathsFromDetail(t *testing.T) {
	var inFlight, maxSeen int32
	srv := newPacketServer(t, []string{"aa", "bb", "cc"}, nil, &inFlight, &maxSeen)
	defer srv.Close()

	c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
	got, failed, err := c.FetchPacketsWithPaths(
		context.Background(), time.UnixMilli(1), time.UnixMilli(9_000_000), 100)
	if err != nil {
		t.Fatal(err)
	}
	if failed != 0 {
		t.Errorf("failed = %d, want 0", failed)
	}
	if len(got) != 3 {
		t.Fatalf("got %d packets, want 3", len(got))
	}
	for _, p := range got {
		if len(p.Path) != 1 {
			t.Fatalf("packet %s has no path — the list omits it, so detail "+
				"must have been fetched", p.Hash)
		}
		if p.Path[0].PublicKey != "relay-"+p.Hash {
			t.Errorf("packet %s resolved to %q", p.Hash, p.Path[0].PublicKey)
		}
		if len(p.Observations) == 0 {
			t.Errorf("packet %s lost its observations", p.Hash)
		}
	}
}

func TestFetchPacketsWithPathsToleratesOneBadPacket(t *testing.T) {
	// A window is evidence: losing one packet's path degrades the
	// reconstruction, it doesn't invalidate it.
	var inFlight, maxSeen int32
	srv := newPacketServer(t, []string{"aa", "bb"}, map[string]bool{"bb": true},
		&inFlight, &maxSeen)
	defer srv.Close()

	c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
	got, failed, err := c.FetchPacketsWithPaths(
		context.Background(), time.UnixMilli(1), time.UnixMilli(9_000_000), 100)
	if err != nil {
		t.Fatalf("one bad packet must not fail the window: %v", err)
	}
	if failed != 1 {
		t.Errorf("failed = %d, want 1 reported", failed)
	}
	if len(got) != 2 {
		t.Fatalf("got %d packets, want both kept", len(got))
	}
	var withPath int
	for _, p := range got {
		if len(p.Path) > 0 {
			withPath++
		}
	}
	if withPath != 1 {
		t.Errorf("%d packets have paths, want the one that succeeded", withPath)
	}
}

func TestFetchPacketsWithPathsBoundsConcurrency(t *testing.T) {
	var inFlight, maxSeen int32
	hashes := make([]string, 20)
	for i := range hashes {
		hashes[i] = string(rune('a'+i/4)) + string(rune('a'+i%4))
	}
	srv := newPacketServer(t, hashes, nil, &inFlight, &maxSeen)
	defer srv.Close()

	c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
	c.DetailConcurrency = 3
	if _, _, err := c.FetchPacketsWithPaths(
		context.Background(), time.UnixMilli(1), time.UnixMilli(9_000_000), 100); err != nil {
		t.Fatal(err)
	}
	if peak := atomic.LoadInt32(&maxSeen); peak > 3 {
		t.Errorf("peak concurrent detail requests = %d, want <= 3 — this is "+
			"someone else's server", peak)
	}
}

func TestFetchPacketsWithPathsSkipsDetailWhenListAlreadyResolves(t *testing.T) {
	// If Beacon ever grows ?resolve=true on the list, this path must get
	// faster without getting wrong.
	var detailCalls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasPrefix(r.URL.Path, "/api/v1/packets/") {
			atomic.AddInt32(&detailCalls, 1)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(page[packetSummary]{Items: []packetSummary{{
			PacketHash: "aa", RouteType: 1, FirstHeardAt: 1_500_000,
			LatestObserver: &latestObserver{
				ID:         "obs",
				PathLength: &pathLength{HashSize: 1, HopCount: 1},
				ResolvedPath: []resolvedHop{
					{Confidence: "high", Nodes: []resolvedNode{{PublicKey: "RELAY"}}},
				},
			},
		}}})
	}))
	defer srv.Close()

	c, _ := New(srv.URL, []string{"EDI"}, srv.Client())
	got, failed, err := c.FetchPacketsWithPaths(
		context.Background(), time.UnixMilli(1), time.UnixMilli(9_000_000), 100)
	if err != nil || failed != 0 {
		t.Fatalf("err=%v failed=%d", err, failed)
	}
	if n := atomic.LoadInt32(&detailCalls); n != 0 {
		t.Errorf("made %d detail calls for an already-resolved list", n)
	}
	if got[0].Path[0].PublicKey != "relay" {
		t.Errorf("path = %+v", got[0].Path)
	}
}
