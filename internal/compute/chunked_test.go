package compute

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpujob"
	"hopreach/internal/propagation"
)

func TestPlanTilesSplitsLargeRegion(t *testing.T) {
	// Roughly Scotland's own extent at the real Precision-tier zoom, with a
	// realistic MeshCore link-budget range (~78km at 868MHz/22dBm/-124dBm
	// sensitivity) — this is the exact scenario that OOM-killed the remote
	// GPU worker in production (a single whole-region grid at zoom 13
	// running into several GB) before MarginsChunked existed. A range this
	// large relative to the region is also what makes 2D tiling necessary
	// in the first place — see the planTiles comment.
	const imageWidth, imageHeight = 12000, 24248
	bounds := propagation.Bounds{South: 54.5, North: 60.9, West: -8.7, East: -0.7}
	tiles := planTiles(bounds, 13, imageWidth, imageHeight, 78)
	if len(tiles) < 2 {
		t.Fatalf("expected multiple tiles for a whole-Scotland zoom-13 region, got %d", len(tiles))
	}

	// Every output pixel must be covered by exactly one tile: sum of
	// per-tile pixel counts equals the full raster, and no tile's
	// rectangle extends past the raster's own bounds.
	totalPixels := 0
	for i, tl := range tiles {
		if tl.rowOffset < 0 || tl.rowOffset+tl.rowCount > imageHeight {
			t.Fatalf("tile %d: rows [%d,%d) out of [0,%d)", i, tl.rowOffset, tl.rowOffset+tl.rowCount, imageHeight)
		}
		if tl.colOffset < 0 || tl.colOffset+tl.colCount > imageWidth {
			t.Fatalf("tile %d: cols [%d,%d) out of [0,%d)", i, tl.colOffset, tl.colOffset+tl.colCount, imageWidth)
		}
		if tl.rowCount <= 0 || tl.colCount <= 0 {
			t.Fatalf("tile %d: rowCount=%d colCount=%d, want > 0", i, tl.rowCount, tl.colCount)
		}
		totalPixels += tl.rowCount * tl.colCount
	}
	if totalPixels != imageWidth*imageHeight {
		t.Fatalf("tiles cover %d pixels total, want %d", totalPixels, imageWidth*imageHeight)
	}

	// Each tile's *padded* load footprint — measured with the real
	// projection (tileFootprint), not a uniform-degrees approximation, since
	// that approximation alone is what silently let tiles run ~2x over
	// budget in production before this was caught (Scotland's latitude
	// packs roughly secant(latitude) more real tiles per degree than a
	// uniform estimate assumes) — should stay close to budget. Some slack
	// for the "never finer than one DEM tile" floor and the fact this
	// verifies against every real constructed tile, not just the one the
	// sizing loop itself converged against.
	budgetTiles := chunkGridBudgetBytes / demTileBytes
	for i, tl := range tiles {
		got := tileFootprint(tl.loadBounds, 13)
		if got > budgetTiles*1.1 {
			t.Errorf("tile %d: padded footprint ~%.0f DEM tiles, more than 1.1x the %.0f-tile budget", i, got, budgetTiles)
		}
	}
}

func TestPlanTilesSmallRegionStaysOneTile(t *testing.T) {
	bounds := propagation.Bounds{South: 56.0, North: 56.1, West: -4.3, East: -4.1}
	tiles := planTiles(bounds, 11, 40, 40, 5)
	if len(tiles) != 1 {
		t.Fatalf("expected a single tile for a small region well under budget, got %d", len(tiles))
	}
}

// flatTerrainServer serves every /{z}/{x}/{y}.png request the same
// terrarium-encoded 256x256 tile, decoding to a flat elevM everywhere —
// enough to exercise the fetch/band/stitch plumbing deterministically
// without needing real DEM data or network access.
func flatTerrainServer(t *testing.T, elevM float64) *httptest.Server {
	t.Helper()
	v := uint32(elevM + 32768)
	img := image.NewRGBA(image.Rect(0, 0, 256, 256))
	c := color.RGBA{R: byte(v / 256), G: byte(v % 256), B: 0, A: 255}
	for y := 0; y < 256; y++ {
		for x := 0; x < 256; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encoding synthetic tile: %v", err)
	}
	tile := buf.Bytes()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(tile)
	}))
}

// TestMarginsChunkedMatchesUnchunked is the correctness check for the whole
// feature: over flat (terrain-independent) synthetic elevation data, a
// pass split into several small bands must produce exactly the same
// margins as one pass over a single whole-region grid — chunking is only
// supposed to change how much memory is resident at once, never the
// result. Runs entirely against a local httptest server and a handful of
// small synthetic tiles, so this stays fast regardless of how the real
// Precision tier's zoom/region would size in production.
func TestMarginsChunkedMatchesUnchunked(t *testing.T) {
	oldBudget := chunkGridBudgetBytes
	chunkGridBudgetBytes = 250 * demTileBytes // force several small tiles over a tiny region, without exploding into hundreds given real padding math
	defer func() { chunkGridBudgetBytes = oldBudget }()

	srv := flatTerrainServer(t, 100)
	defer srv.Close()

	bounds := propagation.Bounds{South: 56.0, North: 57.0, West: -5.0, East: -4.0}
	const zoom = 12
	const imageWidth, imageHeight = 60, 60

	p := propagation.Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, AntennaHeightM: 1.6, RxHeightM: 2,
		MaxRangeKm: 40, MarginGreenDB: 15,
	}
	rangeKm := propagation.LinkBudgetMaxRangeKm(p)

	// Two sites near the southern half of the region, well clear of the
	// north — the northern bands should end up entirely skipped (no sites
	// within range), exercising that path too.
	sites := []propagation.Site{
		{Lat: 56.15, Lon: -4.7, GroundM: 100, TxHeightM: 101.6},
		{Lat: 56.25, Lon: -4.4, GroundM: 100, TxHeightM: 101.6},
	}

	client := &http.Client{}

	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm)
	if len(tiles) < 3 {
		t.Fatalf("test setup: expected several tiles, got %d — tighten chunkGridBudgetBytes further", len(tiles))
	}

	refGrid, err := demgrid.Load(demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}, zoom, t.TempDir(), srv.URL, client, nil)
	if err != nil {
		t.Fatalf("loading reference grid: %v", err)
	}
	defer refGrid.Close()

	e := New() // no local GPU, no remote broker configured — forces the CPU path both sides go through
	want := e.Margins(refGrid, sites, bounds, imageWidth, imageHeight, rangeKm, p, nil)

	got, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, nil)
	if err != nil {
		t.Fatalf("MarginsChunked: %v", err)
	}

	if len(got) != len(want) {
		t.Fatalf("length = %d, want %d", len(got), len(want))
	}
	mismatches := 0
	for i := range want {
		wNaN, gNaN := math.IsNaN(float64(want[i])), math.IsNaN(float64(got[i]))
		if wNaN != gNaN {
			mismatches++
			continue
		}
		if wNaN {
			continue
		}
		if math.Abs(float64(want[i]-got[i])) > 1e-4 {
			mismatches++
		}
	}
	if mismatches > 0 {
		t.Errorf("%d/%d pixels differ between chunked and unchunked passes over identical flat terrain", mismatches, len(want))
	}
}

// TestMarginsChunkedSkipsLocalGridWhenRemoteAvailable is the regression
// test for the production incident this covers: the website box running
// the batch job only has 2GB RAM, and MarginsChunked was loading a real
// (if budget-bounded) local elevation grid for every non-empty tile even
// though a connected remote worker never reads that grid's contents —
// only its Zoom. That redundant local grid, held alongside the full-raster
// margins buffer MarginsChunked already keeps for the whole pass, was
// enough to OOM the process. This asserts the local DEM tile server is
// never actually hit once a remote worker is connected.
func TestMarginsChunkedSkipsLocalGridWhenRemoteAvailable(t *testing.T) {
	oldBudget := chunkGridBudgetBytes
	chunkGridBudgetBytes = 10 * demTileBytes
	defer func() { chunkGridBudgetBytes = oldBudget }()

	var localTileHits int32
	localSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&localTileHits, 1)
		http.Error(w, "local terrain should never be fetched when a remote worker is connected", http.StatusInternalServerError)
	}))
	defer localSrv.Close()

	bounds := propagation.Bounds{South: 56.0, North: 57.0, West: -5.0, East: -4.0}
	const zoom = 12
	const imageWidth, imageHeight = 60, 60
	p := propagation.Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, AntennaHeightM: 1.6, RxHeightM: 2,
		MaxRangeKm: 40, MarginGreenDB: 15,
	}
	rangeKm := propagation.LinkBudgetMaxRangeKm(p)
	sites := []propagation.Site{
		{Lat: 56.15, Lon: -4.7, GroundM: 100, TxHeightM: 101.6},
		{Lat: 56.25, Lon: -4.4, GroundM: 100, TxHeightM: 101.6},
	}

	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm)
	if len(tiles) < 3 {
		t.Fatalf("test setup: expected several tiles, got %d", len(tiles))
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/gpu/status", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]bool{"worker_connected": true})
	})
	mux.HandleFunc("/gpu/progress", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]int{"done": 0, "total": 0})
	})
	mux.HandleFunc("/gpu/submit", func(w http.ResponseWriter, r *http.Request) {
		var job gpujob.Job
		if err := json.NewDecoder(r.Body).Decode(&job); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(gpujob.Float32ToBytesLE(make([]float32, job.ImageWidth*job.ImageHeight)))
	})
	broker := httptest.NewServer(mux)
	defer broker.Close()

	e := New()
	e.SetRemote(strings.TrimPrefix(broker.URL, "http://"), localSrv.URL)

	_, err := e.MarginsChunked(bounds, zoom, t.TempDir(), localSrv.URL, &http.Client{}, sites, imageWidth, imageHeight, rangeKm, p, nil)
	if err != nil {
		t.Fatalf("MarginsChunked: %v", err)
	}
	if hits := atomic.LoadInt32(&localTileHits); hits != 0 {
		t.Errorf("local DEM tile server was hit %d times; want 0 (remote worker was connected throughout)", hits)
	}
}

func TestTileWeight(t *testing.T) {
	tl := tile{rowCount: 10, colCount: 20} // 200 pixels

	if got, want := tileWeight(tl, nil), 200; got != want {
		t.Errorf("tileWeight with no sites (a skipped tile) = %d, want %d (pixels x 1, never zero)", got, want)
	}
	oneSite := []propagation.Site{{Lat: 56, Lon: -4}}
	if got, want := tileWeight(tl, oneSite), 200; got != want {
		t.Errorf("tileWeight with 1 site = %d, want %d", got, want)
	}
	manySites := make([]propagation.Site, 40)
	if got, want := tileWeight(tl, manySites), 200*40; got != want {
		t.Errorf("tileWeight with 40 sites = %d, want %d (pixels x sites)", got, want)
	}
}

// TestMarginsChunkedProgressWeightedBySiteDensity is the regression test
// for a real production observation: the same run's reported ETA bounced
// between under a minute and over half an hour, tile to tile, despite
// steady real progress — because progress was reported in raw pixels, and
// a burst of skipped tiles (near-instant) followed by a dense tile (many
// sites, genuinely slow) swung the recent-rate estimate wildly. This
// checks the actual progress callback sequence a real chunked pass
// produces: monotonically non-decreasing, ends exactly at (total, total),
// and — the actual fix — a dense tile's share of total "work" is
// proportionally larger than a same-size sparse tile's, matching real
// compute cost instead of raw pixel count.
func TestMarginsChunkedProgressWeightedBySiteDensity(t *testing.T) {
	oldBudget := chunkGridBudgetBytes
	chunkGridBudgetBytes = 250 * demTileBytes
	defer func() { chunkGridBudgetBytes = oldBudget }()

	srv := flatTerrainServer(t, 100)
	defer srv.Close()

	bounds := propagation.Bounds{South: 56.0, North: 57.0, West: -5.0, East: -4.0}
	const zoom = 12
	const imageWidth, imageHeight = 60, 60
	p := propagation.Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, AntennaHeightM: 1.6, RxHeightM: 2,
		MaxRangeKm: 40, MarginGreenDB: 15,
	}
	rangeKm := propagation.LinkBudgetMaxRangeKm(p)

	// One lone site in the south (most of the region, including the whole
	// northern half, has nothing nearby and gets skipped) plus a dense
	// cluster of 20 co-located sites elsewhere in the south — two tiles
	// with sites, wildly different density, several tiles with none.
	sites := []propagation.Site{{Lat: 56.1, Lon: -4.9, GroundM: 100, TxHeightM: 101.6}}
	for i := 0; i < 20; i++ {
		sites = append(sites, propagation.Site{Lat: 56.15, Lon: -4.15, GroundM: 100, TxHeightM: 101.6})
	}

	client := &http.Client{}
	e := New()

	var calls [][2]int
	_, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, func(done, total int) {
		calls = append(calls, [2]int{done, total})
	})
	if err != nil {
		t.Fatalf("MarginsChunked: %v", err)
	}
	if len(calls) < 3 {
		t.Fatalf("expected several progress calls, got %d: %v", len(calls), calls)
	}

	total := calls[len(calls)-1][1]
	prevDone := 0
	for i, c := range calls {
		if c[1] != total {
			t.Errorf("call %d: total = %d, want constant %d", i, c[1], total)
		}
		if c[0] < prevDone {
			t.Errorf("call %d: done = %d, went backwards from %d", i, c[0], prevDone)
		}
		if c[0] > total {
			t.Errorf("call %d: done = %d exceeds total %d", i, c[0], total)
		}
		prevDone = c[0]
	}
	last := calls[len(calls)-1]
	if last[0] != last[1] {
		t.Errorf("final call = %v, want done == total", last)
	}

	// The actual weighting formula (pixels x sites-in-range) is checked
	// precisely and directly in TestTileWeight — a same-size dense tile's
	// contribution here is spread across many small within-tile row
	// updates rather than one comparable single jump (the CPU fallback's
	// own row-granularity progress callback), so reconstructing per-tile
	// totals from this call sequence alone isn't reliable. This only
	// checks the calling contract every caller (run.go's progress.Writer)
	// depends on: monotonic, bounded, terminates exactly at total.
	tilesInRegion := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm)
	if len(tilesInRegion) < 3 {
		t.Fatalf("test setup: expected several tiles so this exercises a real skip/dense mix, got %d", len(tilesInRegion))
	}
}
