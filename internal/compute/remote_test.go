package compute

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpujob"
	"hopreach/internal/propagation"
)

// TestMarginsRemotePollsProgress simulates a broker whose /gpu/submit call
// takes a while and whose /gpu/progress endpoint reports increasing values
// in the meantime, then calls the real (unmodified) marginsRemote against
// it — deterministic and fast (no real GPU, no network round trip, no DEM
// tile fetch), unlike relying on a real worker's dispatch timing to
// coincidentally straddle a poll interval.
func TestMarginsRemotePollsProgress(t *testing.T) {
	const imageWidth, imageHeight = 10, 10
	marginsBytes := gpujob.Float32ToBytesLE(make([]float32, imageWidth*imageHeight))

	var polls int32
	mux := http.NewServeMux()
	mux.HandleFunc("/gpu/submit", func(w http.ResponseWriter, r *http.Request) {
		// Long enough for several polls at marginsRemote's real 500ms
		// interval to land before this returns.
		time.Sleep(1700 * time.Millisecond)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(marginsBytes)
	})
	mux.HandleFunc("/gpu/progress", func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&polls, 1)
		done := int(n) * 3
		if done > imageHeight {
			done = imageHeight
		}
		json.NewEncoder(w).Encode(map[string]int{"done": done, "total": imageHeight})
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	e := New()
	e.SetRemote(strings.TrimPrefix(srv.URL, "http://"), "")

	elev := make([]float32, 512*512)
	grid, err := demgrid.NewFromElev(11, 1000, 600, 2, 2, elev)
	if err != nil {
		t.Fatal(err)
	}
	sites := []propagation.Site{{Lat: 56.5, Lon: -3.5, GroundM: 0, TxHeightM: 1}}
	bounds := propagation.Bounds{South: 56.3, North: 56.7, West: -3.7, East: -3.3}
	p := propagation.Params{FrequencyMHz: 868, TxPowerDBm: 22, RxSensitivityDB: -124, FadeMarginDB: 20, MaxRangeKm: 50}

	var calls [][2]int
	got, err := e.marginsRemote(grid, sites, bounds, imageWidth, imageHeight, 40, p, func(done, total int) {
		calls = append(calls, [2]int{done, total})
	})
	if err != nil {
		t.Fatalf("marginsRemote: %v", err)
	}
	if len(got) != imageWidth*imageHeight {
		t.Fatalf("len(margins) = %d, want %d", len(got), imageWidth*imageHeight)
	}

	t.Logf("progressFn calls: %v", calls)
	if len(calls) < 3 {
		t.Fatalf("expected at least 3 progressFn calls (open, >=1 incremental, close), got %d: %v", len(calls), calls)
	}
	if calls[0] != [2]int{0, imageHeight} {
		t.Errorf("first call = %v, want opening (0, %d)", calls[0], imageHeight)
	}
	last := calls[len(calls)-1]
	if last != [2]int{imageHeight, imageHeight} {
		t.Errorf("last call = %v, want closing (%d, %d)", last, imageHeight, imageHeight)
	}
	sawIncremental := false
	for _, c := range calls[1 : len(calls)-1] {
		if c[0] > 0 && c[0] < c[1] {
			sawIncremental = true
		}
	}
	if !sawIncremental {
		t.Errorf("expected at least one incremental (0 < done < total) call between open/close, got %v", calls)
	}
}
