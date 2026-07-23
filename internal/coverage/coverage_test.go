package coverage

import (
	"bytes"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	imagepkg "image"

	"hopreach/internal/compute"
	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
)

// flatTerrainServer serves every /{z}/{x}/{y}.png request the same
// terrarium-encoded 256x256 tile, decoding to a flat elevM everywhere —
// enough to exercise the real fetch/render pipeline deterministically
// without needing real DEM data or network access.
func flatTerrainServer(t *testing.T, elevM float64) *httptest.Server {
	t.Helper()
	v := uint32(elevM + 32768)
	img := imagepkg.NewRGBA(imagepkg.Rect(0, 0, 256, 256))
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

// TestRasterSupersampledChunkedMatchesUnchunked is the end-to-end
// correctness check (through the real image-rendering pipeline, not just
// the raw margins array) for the fix to a real production OOM: chunked
// Precision-tier rendering now downsamples each geographic tile as it's
// computed rather than materializing one whole-region buffer at full
// compute resolution before downsampling it all at once. That change must
// be invisible to the final rendered image — chunking (and now, per-tile
// downsampling) is only supposed to change how much memory is resident at
// once, never the result.
func TestRasterSupersampledChunkedMatchesUnchunked(t *testing.T) {
	const testBudgetBytes = 250 * 256 * 256 * 4 // force several small geographic tiles
	const supersample = 2
	const servedWidth = 20

	srv := flatTerrainServer(t, 100)
	defer srv.Close()

	bounds := propagation.Bounds{South: 56.0, North: 57.0, West: -5.0, East: -4.0}
	const zoom = 12
	p := propagation.Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, AntennaHeightM: 1.6, RxHeightM: 2,
		MaxRangeKm: 40, MarginGreenDB: 15,
	}
	sites := []propagation.Site{
		{Lat: 56.15, Lon: -4.7, GroundM: 100, TxHeightM: 101.6},
		{Lat: 56.25, Lon: -4.4, GroundM: 100, TxHeightM: 101.6},
	}
	client := &http.Client{}

	grid, err := demgrid.Load(demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}, zoom, t.TempDir(), srv.URL, client, nil)
	if err != nil {
		t.Fatalf("loading reference grid: %v", err)
	}
	defer grid.Close()

	eUnchunked := compute.New()
	want := RasterSupersampled(eUnchunked, grid, sites, bounds, servedWidth, supersample, p, 190, nil)
	if want == nil {
		t.Fatal("RasterSupersampled returned nil")
	}

	eChunked := compute.New()
	eChunked.SetChunkBudgetBytes(testBudgetBytes)
	got, err := RasterSupersampledChunked(eChunked, bounds, zoom, t.TempDir(), srv.URL, client, sites, servedWidth, supersample, p, 190, nil)
	if err != nil {
		t.Fatalf("RasterSupersampledChunked: %v", err)
	}
	if got == nil {
		t.Fatal("RasterSupersampledChunked returned nil")
	}

	wb, gb := want.Bounds(), got.Bounds()
	if wb != gb {
		t.Fatalf("image bounds = %v, want %v", gb, wb)
	}

	mismatches := 0
	for y := wb.Min.Y; y < wb.Max.Y; y++ {
		for x := wb.Min.X; x < wb.Max.X; x++ {
			wc := want.NRGBAAt(x, y)
			gc := got.NRGBAAt(x, y)
			if wc != gc {
				mismatches++
			}
		}
	}
	if mismatches > 0 {
		t.Errorf("%d/%d pixels differ between chunked and unchunked rendering", mismatches, wb.Dx()*wb.Dy())
	}
}
