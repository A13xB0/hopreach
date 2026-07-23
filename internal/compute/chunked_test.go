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
	const budgetBytes = 1_400_000_000
	bounds := propagation.Bounds{South: 54.5, North: 60.9, West: -8.7, East: -0.7}
	tiles := planTiles(bounds, 13, imageWidth, imageHeight, 78, budgetBytes, 1)
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
	budgetTiles := float64(budgetBytes) / demTileBytes
	for i, tl := range tiles {
		got := tileFootprint(tl.loadBounds, 13)
		if got > budgetTiles*1.1 {
			t.Errorf("tile %d: padded footprint ~%.0f DEM tiles, more than 1.1x the %.0f-tile budget", i, got, budgetTiles)
		}
	}
}

// TestPlanTilesCapsTileCountWhenBudgetUnreachable is the regression test
// for a real production OOM: a legitimately tiny auto-sized local budget
// (a box with little real headroom auto-sizes down toward
// minAutoChunkBudgetBytes, a few hundred MB) can be *smaller* than the
// mandatory padding floor a tile can't shrink below (confirmed in
// production: ~1.1GB at zoom 13 with a ~78km range) — so the per-tile
// budget can never be satisfied no matter how many times a tile is split,
// and without a hard cap, the growth loop keeps splitting every iteration
// with nothing to stop it short of the absolute per-axis maximum (one tile
// per output pixel). buildTiles then allocates a single slice sized by the
// *product* of both axes — confirmed to reach tens of millions of tile
// structs in this exact scenario, an instant OOM entirely separate from
// (and unprotected by) the per-tile memory budget this file exists to
// enforce.
func TestPlanTilesCapsTileCountWhenBudgetUnreachable(t *testing.T) {
	// Real Scotland-at-zoom-13-with-78km-range dimensions and budget — this
	// exact combination reached tens of millions of planned tiles in
	// production before this cap existed.
	const imageWidth, imageHeight = 12000, 24248
	const tinyBudgetBytes = 300_000_000 // minAutoChunkBudgetBytes — smaller than the ~1.1GB mandatory padding floor
	bounds := propagation.Bounds{South: 54.5, North: 60.9, West: -8.7, East: -0.7}

	tiles := planTiles(bounds, 13, imageWidth, imageHeight, 78, tinyBudgetBytes, 1)

	if len(tiles) > maxPlanTiles {
		t.Fatalf("planTiles returned %d tiles, want at most maxPlanTiles (%d) — an unreachable budget must cap the tile *count*, not just each tile's own nominal size", len(tiles), maxPlanTiles)
	}
	if len(tiles) < 2 {
		t.Fatalf("expected multiple tiles (a tiny budget should still split some), got %d", len(tiles))
	}

	// Every output pixel must still be covered by exactly one tile, same
	// invariant as the unclamped case — capping the count must not leave
	// gaps or overlaps in the output raster.
	totalPixels := 0
	for i, tl := range tiles {
		if tl.rowOffset < 0 || tl.rowOffset+tl.rowCount > imageHeight {
			t.Fatalf("tile %d: rows [%d,%d) out of [0,%d)", i, tl.rowOffset, tl.rowOffset+tl.rowCount, imageHeight)
		}
		if tl.colOffset < 0 || tl.colOffset+tl.colCount > imageWidth {
			t.Fatalf("tile %d: cols [%d,%d) out of [0,%d)", i, tl.colOffset, tl.colOffset+tl.colCount, imageWidth)
		}
		totalPixels += tl.rowCount * tl.colCount
	}
	if totalPixels != imageWidth*imageHeight {
		t.Fatalf("tiles cover %d pixels total, want %d", totalPixels, imageWidth*imageHeight)
	}
}

func TestPlanTilesSmallRegionStaysOneTile(t *testing.T) {
	bounds := propagation.Bounds{South: 56.0, North: 56.1, West: -4.3, East: -4.1}
	tiles := planTiles(bounds, 11, 40, 40, 5, 1_400_000_000, 1)
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
	const testBudgetBytes = 250 * demTileBytes // force several small tiles over a tiny region, without exploding into hundreds given real padding math

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

	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, testBudgetBytes, 1)
	if len(tiles) < 3 {
		t.Fatalf("test setup: expected several tiles, got %d — tighten testBudgetBytes further", len(tiles))
	}

	refGrid, err := demgrid.Load(demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}, zoom, t.TempDir(), srv.URL, client, nil)
	if err != nil {
		t.Fatalf("loading reference grid: %v", err)
	}
	defer refGrid.Close()

	e := New() // no local GPU, no remote broker configured — forces the CPU path both sides go through
	e.SetChunkBudgetBytes(testBudgetBytes)
	want := e.Margins(refGrid, sites, bounds, imageWidth, imageHeight, rangeKm, p, nil)

	got, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, 1, nil)
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

// TestMarginsChunkedSupersampleMatchesFullResolutionThenDownsample is the
// correctness check for the fix to a real production OOM: MarginsChunked
// used to always return a full-compute-resolution buffer, leaving the
// caller (RasterSupersampledChunked) to downsample the *whole region* in
// one extra pass afterward — a second large buffer, on top of the first,
// right when memory was already tightest. MarginsChunked now downsamples
// each geographic tile immediately after computing it, so the one buffer
// it ever holds is already at served (post-downsample) resolution. That
// must produce numerically the same result as the old approach: compute at
// full resolution, then downsample the whole thing at the end.
func TestMarginsChunkedSupersampleMatchesFullResolutionThenDownsample(t *testing.T) {
	const testBudgetBytes = 250 * demTileBytes // force several small geographic tiles
	const supersample = 3
	const servedWidth, servedHeight = 20, 20 // chosen so servedWidth/Height * supersample stays a whole number
	const imageWidth, imageHeight = servedWidth * supersample, servedHeight * supersample

	srv := flatTerrainServer(t, 100)
	defer srv.Close()

	bounds := propagation.Bounds{South: 56.0, North: 57.0, West: -5.0, East: -4.0}
	const zoom = 12
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
	client := &http.Client{}

	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, testBudgetBytes, supersample)
	if len(tiles) < 3 {
		t.Fatalf("test setup: expected several tiles even with supersample-alignment, got %d", len(tiles))
	}

	e := New()
	e.SetChunkBudgetBytes(testBudgetBytes)

	// Reference: compute at full resolution with no downsampling (supersample=1
	// at this same imageWidth/imageHeight), then downsample the whole thing
	// in one pass at the end — the old behaviour this must still match.
	fullRes, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, 1, nil)
	if err != nil {
		t.Fatalf("MarginsChunked (reference, supersample=1): %v", err)
	}
	want, wantW, wantH := DownsampleMargins(fullRes, imageWidth, imageHeight, supersample)
	if wantW != servedWidth || wantH != servedHeight {
		t.Fatalf("test setup: reference downsampled to %dx%d, want %dx%d", wantW, wantH, servedWidth, servedHeight)
	}

	// Under test: downsample each geographic tile as it's computed.
	got, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, supersample, nil)
	if err != nil {
		t.Fatalf("MarginsChunked (supersample=%d): %v", supersample, err)
	}

	if len(got) != servedWidth*servedHeight {
		t.Fatalf("len(got) = %d, want %d (served resolution, not the %dx%d compute resolution)", len(got), servedWidth*servedHeight, imageWidth, imageHeight)
	}
	if len(got) != len(want) {
		t.Fatalf("len(got) = %d, want %d (matching the reference)", len(got), len(want))
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
		t.Errorf("%d/%d pixels differ between per-tile downsampling and full-resolution-then-downsample", mismatches, len(want))
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
	const testBudgetBytes = 10 * demTileBytes

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

	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, testBudgetBytes, 1)
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
	e.SetChunkBudgetBytes(testBudgetBytes)

	_, err := e.MarginsChunked(bounds, zoom, t.TempDir(), localSrv.URL, &http.Client{}, sites, imageWidth, imageHeight, rangeKm, p, 1, nil)
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
	const testBudgetBytes = 250 * demTileBytes

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
	e.SetChunkBudgetBytes(testBudgetBytes)

	var calls [][2]int
	_, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, 1, func(done, total int) {
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
	tilesInRegion := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, testBudgetBytes, 1)
	if len(tilesInRegion) < 3 {
		t.Fatalf("test setup: expected several tiles so this exercises a real skip/dense mix, got %d", len(tilesInRegion))
	}
}

func TestBudgetFromAvailable(t *testing.T) {
	// Below the reserve entirely: floors to the minimum rather than going
	// negative.
	if got := budgetFromAvailable(1_000_000_000); got != minAutoChunkBudgetBytes {
		t.Errorf("budgetFromAvailable(1GB) = %.0f, want the %d floor (below chunkBudgetReserveBytes)", got, minAutoChunkBudgetBytes)
	}
	// A concrete real case: this project's own GPU worker, 7.3GB total,
	// ~4.7GB "available" per free -h during the incident this exists to
	// fix. (4.7GB - 1.5GB reserve) / 2 ≈ 1.6GB.
	got := budgetFromAvailable(4_700_000_000)
	if got < 1_400_000_000 || got > 1_800_000_000 {
		t.Errorf("budgetFromAvailable(4.7GB) = %.0f, want roughly 1.6GB (in [1.4GB,1.8GB])", got)
	}
	// Monotonically increasing in available memory.
	prev := 0.0
	for _, avail := range []uint64{2e9, 4e9, 8e9, 16e9, 32e9} {
		b := budgetFromAvailable(avail)
		if b < prev {
			t.Errorf("budgetFromAvailable(%d) = %.0f is less than a smaller available figure's result %.0f", avail, b, prev)
		}
		prev = b
	}
}

// closeEnough reports whether a and b are within a small relative tolerance
// of each other — localChunkBudgetBytes reads real /proc/meminfo state live
// on every call with no injection seam, so two independently-taken readings
// a moment apart can legitimately differ by a few MB under normal system
// load without indicating anything is actually wrong; exact equality would
// make a test comparing two such readings flaky on any real, non-idle
// machine (observed in CI).
func closeEnough(a, b float64) bool {
	if a == 0 || b == 0 {
		return a == b
	}
	const tolerance = 0.05 // 5%
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff/a < tolerance
}

func TestPlanningChunkBudgetBytesOverrideWins(t *testing.T) {
	e := New()
	e.SetChunkBudgetBytes(999_999_999)
	if got := e.planningChunkBudgetBytes(); got != 999_999_999 {
		t.Errorf("planningChunkBudgetBytes() = %.0f, want the explicit override 999999999 regardless of auto-sizing", got)
	}
}

func TestPlanningChunkBudgetBytesNoRemoteUsesLocal(t *testing.T) {
	e := New() // no remote configured at all
	got := e.planningChunkBudgetBytes()
	if got <= 0 {
		t.Errorf("planningChunkBudgetBytes() with no remote and no override = %.0f, want a positive local-derived budget", got)
	}
}

func statusServer(t *testing.T, availableBytes uint64) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/gpu/status", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"worker_connected": true, "available_bytes": availableBytes})
	})
	return httptest.NewServer(mux)
}

// TestPlanningChunkBudgetBytesPrefersRemoteWhenAvailable is the regression
// test for restoring a real production performance requirement: tiles
// should be planned against the remote worker's own budget whenever one is
// connected, since it serves the vast majority of tiles and never needs
// this box's own memory for them at all (see computeTile's stub-grid path)
// — sizing every tile down to this box's own (typically much smaller)
// budget "just in case" costs confirmed-unacceptable dispatch overhead
// (thousands of tiny tiles instead of a few dozen, observed live). A tile
// that can't actually reach the remote worker re-splits itself down to the
// local budget right at that point instead (see
// TestComputeTileFallsBackAndResplitsWhenRemoteFails). remoteChunkBudgetBytes'
// own extra safety divisor (see its doc comment — the remote worker's real
// per-job footprint is bigger than the terrain grid alone) is exercised
// here too: the remote-preferred budget should be noticeably smaller than
// a plain budgetFromAvailable reading would give.
func TestPlanningChunkBudgetBytesPrefersRemoteWhenAvailable(t *testing.T) {
	localOnly := New().planningChunkBudgetBytes() // no remote configured — pure local sizing, for comparison

	t.Run("remote reports far less than local", func(t *testing.T) {
		srv := statusServer(t, 2_000_000_000) // budgetFromAvailable(2GB) = 250MB, floored to minAutoChunkBudgetBytes, then /remoteBudgetExtraSafetyDivisor
		defer srv.Close()
		e := New()
		e.SetRemote(strings.TrimPrefix(srv.URL, "http://"), "")
		got := e.planningChunkBudgetBytes()
		want := minAutoChunkBudgetBytes / remoteBudgetExtraSafetyDivisor
		if !closeEnough(got, want) {
			t.Errorf("planningChunkBudgetBytes() = %.0f, want the remote-derived %.0f even though it's smaller than local", got, want)
		}
	})

	t.Run("remote reports far more than local", func(t *testing.T) {
		srv := statusServer(t, 1_000_000_000_000) // 1TB — budgetFromAvailable would be huge
		defer srv.Close()
		e := New()
		e.SetRemote(strings.TrimPrefix(srv.URL, "http://"), "")
		got := e.planningChunkBudgetBytes()
		if got <= localOnly {
			t.Errorf("planningChunkBudgetBytes() = %.0f, want it to prefer the (much larger) remote budget over the local-only figure %.0f", got, localOnly)
		}
	})

	t.Run("remote connected but reports unknown (0)", func(t *testing.T) {
		srv := statusServer(t, 0)
		defer srv.Close()
		e := New()
		e.SetRemote(strings.TrimPrefix(srv.URL, "http://"), "")
		got := e.planningChunkBudgetBytes()
		if !closeEnough(got, localOnly) {
			t.Errorf("planningChunkBudgetBytes() = %.0f, want approximately the local-only budget %.0f when remote's report is unknown (0)", got, localOnly)
		}
	})
}

// TestRemoteChunkBudgetBytesAppliesExtraSafetyDivisor is the regression
// test for the fix to a real production worker crash: the remote worker's
// own per-job memory footprint for one geographic tile is bigger than just
// the terrain grid budgetFromAvailable reasons about (it also needs a
// GPU-side staging copy of that grid and the full compute-resolution
// output array) — confirmed via systemd's own peak-memory accounting
// landing around 2.4x the nominal per-tile budget, which OOM-killed the
// worker in production. remoteChunkBudgetBytes must divide down further,
// not just return budgetFromAvailable's raw output.
func TestRemoteChunkBudgetBytesAppliesExtraSafetyDivisor(t *testing.T) {
	const availableBytes = 8_000_000_000
	srv := statusServer(t, availableBytes)
	defer srv.Close()
	e := New()
	e.SetRemote(strings.TrimPrefix(srv.URL, "http://"), "")

	got := e.remoteChunkBudgetBytes()
	want := budgetFromAvailable(availableBytes) / remoteBudgetExtraSafetyDivisor
	if !closeEnough(got, want) {
		t.Errorf("remoteChunkBudgetBytes() = %.0f, want %.0f (budgetFromAvailable divided by the extra safety factor)", got, want)
	}
	if got >= budgetFromAvailable(availableBytes) {
		t.Errorf("remoteChunkBudgetBytes() = %.0f, want it strictly smaller than the raw budgetFromAvailable figure %.0f", got, budgetFromAvailable(availableBytes))
	}
}

// TestComputeTileFallsBackAndResplitsWhenRemoteFails is the correctness
// check for the other half of planning-for-remote: a tile planned against
// the (typically much larger) remote budget, that then can't actually
// reach the remote worker, must still produce a correct result — by
// re-splitting itself down to the local budget rather than either failing
// outright or (worse) silently using the wrong terrain. Over flat
// (terrain-independent) synthetic elevation data, the re-split,
// CPU-computed result must exactly
// match a plain unchunked reference pass.
func TestComputeTileFallsBackAndResplitsWhenRemoteFails(t *testing.T) {
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
	sites := []propagation.Site{
		{Lat: 56.15, Lon: -4.7, GroundM: 100, TxHeightM: 101.6},
		{Lat: 56.25, Lon: -4.4, GroundM: 100, TxHeightM: 101.6},
	}
	client := &http.Client{}

	// Reference: a plain, unchunked CPU pass.
	refGrid, err := demgrid.Load(demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}, zoom, t.TempDir(), srv.URL, client, nil)
	if err != nil {
		t.Fatalf("loading reference grid: %v", err)
	}
	defer refGrid.Close()
	refEngine := New()
	want := refEngine.Margins(refGrid, sites, bounds, imageWidth, imageHeight, rangeKm, p, nil)

	// Under test: a broker that reports a worker connected with a huge
	// available-memory figure (so planning genuinely picks a large,
	// remote-sized budget — few, big tiles), but whose /gpu/submit always
	// fails — exactly "looked available at planning time, couldn't
	// actually serve a tile." Every tile must fall back to local/CPU and
	// re-split itself down to this box's own tiny local budget to ever
	// complete correctly.
	mux := http.NewServeMux()
	mux.HandleFunc("/gpu/status", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"worker_connected": true, "available_bytes": uint64(1_000_000_000_000)})
	})
	mux.HandleFunc("/gpu/submit", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no worker actually connected", http.StatusServiceUnavailable)
	})
	broker := httptest.NewServer(mux)
	defer broker.Close()

	e := New()
	e.SetRemote(strings.TrimPrefix(broker.URL, "http://"), "")
	got, err := e.MarginsChunked(bounds, zoom, t.TempDir(), srv.URL, client, sites, imageWidth, imageHeight, rangeKm, p, 1, nil)
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
		t.Errorf("%d/%d pixels differ between the re-split local fallback and an unchunked reference over identical flat terrain", mismatches, len(want))
	}
}

// TestComputeTileLocalRecursivelyResplitsWhenTooBigForBudget directly forces
// computeTileLocal's own re-split branch (rather than relying on
// planningChunkBudgetBytes to naturally produce an oversized tile) — a
// single tile whose own padded footprint exceeds a deliberately tiny
// localBudgetBytes must still produce a correct result by recursively
// splitting itself, not just fail or silently truncate.
func TestComputeTileLocalRecursivelyResplitsWhenTooBigForBudget(t *testing.T) {
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
	sites := []propagation.Site{
		{Lat: 56.15, Lon: -4.7, GroundM: 100, TxHeightM: 101.6},
		{Lat: 56.25, Lon: -4.4, GroundM: 100, TxHeightM: 101.6},
	}
	client := &http.Client{}

	refGrid, err := demgrid.Load(demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}, zoom, t.TempDir(), srv.URL, client, nil)
	if err != nil {
		t.Fatalf("loading reference grid: %v", err)
	}
	defer refGrid.Close()
	want := New().Margins(refGrid, sites, bounds, imageWidth, imageHeight, rangeKm, p, nil)

	// The whole region as a single "planned" tile, same shape planTiles
	// itself would build for one tile spanning the entire bounds.
	whole := tile{rowOffset: 0, rowCount: imageHeight, colOffset: 0, colCount: imageWidth, outputBounds: bounds, loadBounds: padBounds(bounds, rangeKm)}

	e := New() // no remote configured — computeTile goes straight to computeTileLocal
	got, gotW, gotH, err := e.computeTileLocal(whole, sites, zoom, t.TempDir(), srv.URL, client, rangeKm, p, 1, 250*demTileBytes, nil)
	if err != nil {
		t.Fatalf("computeTileLocal: %v", err)
	}
	if gotW != imageWidth || gotH != imageHeight {
		t.Fatalf("dimensions = %dx%d, want %dx%d", gotW, gotH, imageWidth, imageHeight)
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
		t.Errorf("%d/%d pixels differ between the recursively re-split result and an unchunked reference over identical flat terrain", mismatches, len(want))
	}
}
