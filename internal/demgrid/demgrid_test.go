package demgrid

import "testing"

func TestNewFromElevSizeMismatch(t *testing.T) {
	_, err := NewFromElev(11, 0, 0, 2, 2, make([]float32, 10))
	if err == nil {
		t.Fatal("expected an error for a mismatched elev length")
	}
}

func TestNewFromElevAt(t *testing.T) {
	// 2x2 tiles = 512x512, a simple west-to-east ramp so bilinear
	// interpolation has something non-trivial to do and so we can check
	// monotonicity.
	const tilesWide, tilesHigh = 2, 2
	width, height := tilesWide*tileSize, tilesHigh*tileSize
	elev := make([]float32, width*height)
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			elev[y*width+x] = float32(x)
		}
	}
	zoom, minTileX, minTileY := 11, 1000, 600
	g, err := NewFromElev(zoom, minTileX, minTileY, tilesWide, tilesHigh, elev)
	if err != nil {
		t.Fatalf("NewFromElev: %v", err)
	}
	defer g.Close() // no-op for a NewFromElev grid, exercised here anyway

	if g.Width != width || g.Height != height {
		t.Fatalf("Width/Height = %d/%d, want %d/%d", g.Width, g.Height, width, height)
	}

	// Two lat/lon points a quarter and three-quarters of the way across
	// the grid's own tile span, derived from lonToTileX/latToTileY (the
	// same forward math At() itself uses) rather than hand-computed
	// coordinates, so this doesn't depend on the tile math's exact formula.
	lonAt := func(fracX float64) float64 {
		// Binary search the inverse of lonToTileX over a generous range —
		// simplest robust way to invert it without duplicating the formula.
		lo, hi := -180.0, 180.0
		targetTileX := float64(minTileX) + fracX*float64(tilesWide)
		for i := 0; i < 60; i++ {
			mid := (lo + hi) / 2
			if lonToTileX(mid, zoom) < targetTileX {
				lo = mid
			} else {
				hi = mid
			}
		}
		return (lo + hi) / 2
	}
	const lat = 56.0 // arbitrary, doesn't affect an x-only ramp
	west := g.At(lat, lonAt(0.25))
	east := g.At(lat, lonAt(0.75))
	if !(east > west) {
		t.Errorf("expected At() to increase eastward: west=%v east=%v", west, east)
	}

	// Points outside the grid clamp to the nearest edge rather than
	// extrapolating or panicking.
	if g.At(89, 179) < 0 {
		t.Errorf("expected a clamped, non-negative elevation far outside the grid")
	}
}
