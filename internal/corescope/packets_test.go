package corescope

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

// The offset binary search this exercises used to live in the browser. It is
// the fiddly part of talking to CoreScope — the list is newest-first with no
// time filter — so it gets pinned here rather than being discovered wrong
// against a live instance.

// fakePackets serves a newest-first list of n packets one second apart,
// counting requests so the search's cost can be asserted.
type fakePackets struct {
	base     time.Time
	total    int
	requests int
}

func (f *fakePackets) handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests++
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))
		rows := []PacketRow{}
		for i := offset; i < offset+limit && i < f.total; i++ {
			rows = append(rows, PacketRow{
				Hash:      fmt.Sprintf("%04x", i),
				Timestamp: f.base.Add(-time.Duration(i) * time.Second).Format(time.RFC3339),
			})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"packets": rows})
	})
}

func newFake(t *testing.T, total int) (*Client, *fakePackets) {
	t.Helper()
	f := &fakePackets{base: time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC), total: total}
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)
	return NewClient(srv.URL, srv.Client()), f
}

func TestFetchPacketsBetweenReturnsExactlyTheWindow(t *testing.T) {
	c, f := newFake(t, 20000)
	// Packets sit one second apart, newest at index 0. A window 9000-9010
	// seconds back is indices 9000..9010 inclusive.
	to := f.base.Add(-9000 * time.Second)
	from := f.base.Add(-9010 * time.Second)

	got, err := c.FetchPacketsBetween(context.Background(), from, to, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 11 {
		t.Fatalf("got %d packets, want 11", len(got))
	}
	if got[0].Hash != fmt.Sprintf("%04x", 9000) {
		t.Errorf("first = %s, want the newest edge of the window", got[0].Hash)
	}
	for _, p := range got {
		ts, _ := time.Parse(time.RFC3339, p.Timestamp)
		if ts.Before(from) || ts.After(to) {
			t.Errorf("packet %s at %s falls outside [%s, %s]", p.Hash, ts, from, to)
		}
	}
}

func TestFetchPacketsBetweenFindsDeepHistoryCheaply(t *testing.T) {
	// Walking from the top would cost ~38 pages of 500 to reach index 19000.
	// The binary search should get there in a few dozen single-row probes,
	// and the cost must not scale with how old the packet is.
	c, f := newFake(t, 20000)
	to := f.base.Add(-19000 * time.Second)
	from := f.base.Add(-19005 * time.Second)

	got, err := c.FetchPacketsBetween(context.Background(), from, to, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 6 {
		t.Fatalf("got %d packets, want 6", len(got))
	}
	if f.requests > 40 {
		t.Errorf("%d requests to reach offset 19000 — the search is not bounded", f.requests)
	}
}

func TestFetchPacketsBetweenHonoursTheLimit(t *testing.T) {
	c, f := newFake(t, 5000)
	to := f.base
	from := f.base.Add(-4000 * time.Second)

	got, err := c.FetchPacketsBetween(context.Background(), from, to, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 7 {
		t.Fatalf("got %d, want the limit of 7 — a truncated tail, not the whole window", len(got))
	}
}

func TestFetchPacketsBetweenEmptyWindowIsNotAnError(t *testing.T) {
	c, f := newFake(t, 100)
	// Entirely before recorded history.
	from := f.base.Add(-10000 * time.Second)
	to := f.base.Add(-9000 * time.Second)

	got, err := c.FetchPacketsBetween(context.Background(), from, to, 500)
	if err != nil {
		t.Fatalf("a quiet window must not be an error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d packets from an empty window", len(got))
	}
}

func TestFetchPacketsBetweenSkipsMalformedRowsNotWholePages(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		base := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)
		_ = json.NewEncoder(w).Encode(map[string]any{"packets": []PacketRow{
			{Hash: "aa", Timestamp: base.Format(time.RFC3339)},
			{Hash: "bb", Timestamp: "not a timestamp"},
			{Hash: "cc", Timestamp: base.Add(-time.Second).Format(time.RFC3339)},
		}})
	}))
	defer srv.Close()
	c := NewClient(srv.URL, srv.Client())
	base := time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC)

	got, err := c.FetchPacketsBetween(context.Background(), base.Add(-time.Minute), base, 500)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d, want the 2 good rows — one bad timestamp must not drop the page", len(got))
	}
}

func TestFetchPacketDetailCarriesEveryObservation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"packet": PacketRow{Hash: "bb03", Timestamp: "2026-08-01T12:00:00Z"},
			"observations": []PacketObservation{
				{ObserverID: "o1", ObserverName: "Cadham"},
				{ObserverID: "o2", ObserverName: "Lucklaw"},
			},
		})
	}))
	defer srv.Close()

	got, err := NewClient(srv.URL, srv.Client()).FetchPacketDetail(context.Background(), "bb03")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Observations) != 2 {
		t.Fatalf("got %d observations — a missing one reads as a delivery failure", len(got.Observations))
	}
}

func TestPacketFetchesSurfaceServerErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	c := NewClient(srv.URL, srv.Client())

	if _, err := c.FetchPacketDetail(context.Background(), "bb03"); err == nil {
		t.Error("a 500 must be reported, not read as an empty packet")
	}
	now := time.Now()
	if _, err := c.FetchPacketsBetween(context.Background(), now.Add(-time.Minute), now, 10); err == nil {
		t.Error("a 500 must be reported, not read as a quiet window")
	}
}
