package compute

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"hopreach/internal/demgrid"
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

	// Each tile's *padded* load footprint should stay within a small
	// multiple of the budget (some slack for the "never finer than one DEM
	// tile" floor and rounding) — this is the actual point of the feature.
	tilesPerDeg := math.Exp2(13) / 360.0
	budgetTiles := chunkGridBudgetBytes / demTileBytes
	for i, tl := range tiles {
		heightTiles := (tl.loadBounds.North - tl.loadBounds.South) * tilesPerDeg
		widthTiles := (tl.loadBounds.East - tl.loadBounds.West) * tilesPerDeg
		got := heightTiles * widthTiles
		if got > budgetTiles*1.5 {
			t.Errorf("tile %d: padded footprint ~%.0f DEM tiles, more than 1.5x the %.0f-tile budget", i, got, budgetTiles)
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
	chunkGridBudgetBytes = 10 * demTileBytes // force many small bands over a tiny region
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
