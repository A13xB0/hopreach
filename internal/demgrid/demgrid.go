// Package demgrid loads and caches Mapzen/AWS "terrarium" elevation tiles
// (standard Web Mercator slippy-map tiles, 256x256, elevation in metres
// encoded as R*256+G+B/256-32768 — global coverage, no API key; see
// https://github.com/tilezen/joerd/blob/master/docs/formats.md) into an
// in-memory mosaic ready for fast bilinear lookups.
//
// Extracted into its own package (rather than living in the root binary's
// package main, where it originated) so cmd/hopreach-gpuworker — a separate
// binary that runs on a remote machine and needs to build its own local
// elevation grid for whatever job it's given — can import the exact same
// tile fetch/cache/decode logic instead of a second, drifting copy.
//
// Grid/At/NewFromElev (this file) are platform-agnostic, pure in-memory
// math with no I/O — compiled for every target including GOOS=js, so
// wasm/main.go can reuse the exact same bilinear lookup the native
// binaries use. Load (load.go, //go:build !js) is the disk/network-backed
// tile fetcher — mmap'd scratch file + concurrent HTTP fetches — which has
// no meaning in a browser sandbox; the WASM build instead receives an
// already-decoded elevation mosaic from the frontend's own tile fetch/cache
// (still JS, since the browser's own fetch/canvas tooling is what actually
// retrieves and decodes the tiles there) and hands it to NewFromElev.
package demgrid

import (
	"fmt"
	"math"
)

const tileSize = 256

// Bounds is the tile-aligned lat/lon extent a Grid covers.
type Bounds struct{ South, North, West, East float64 }

// Grid is an elevation mosaic covering a padded bounding box around all
// repeaters, assembled from cached tiles at a fixed zoom level. Sized so
// millions of profile samples can be answered as plain array lookups
// instead of network calls. Elev is backed by a memory-mapped scratch file
// rather than a plain heap slice — at high zoom levels this mosaic can run
// into the gigabytes for a region the size of Scotland, and path sampling
// only ever touches a neighbourhood around each site/point at a time, not
// the whole area uniformly, so there's no need for it all to be
// simultaneously resident: the OS pages the working set in/out under
// memory pressure instead. (The WASM build's grids, built via NewFromElev,
// are plain heap slices instead — no mmap available in a browser sandbox,
// and those grids are small local previews, not whole-region mosaics.)
type Grid struct {
	Zoom               int
	MinTileX, MinTileY int
	TilesWide          int
	TilesHigh          int
	Width, Height      int
	Elev               []float32 // row-major, Width*Height, mmap-backed
	release            func() error
}

// Close releases the grid's backing scratch file. Idempotent — safe to
// call explicitly as soon as a grid's last use is known (to free the
// memory/disk promptly) and again via defer as an error-path safety net,
// without double-unmapping. A no-op for grids built via NewFromElev
// (nothing to release).
func (g *Grid) Close() error {
	if g.release == nil {
		return nil
	}
	release := g.release
	g.release = nil
	return release()
}

// NewFromElev builds a Grid directly from an already-decoded elevation
// mosaic — used by the WASM build, where tile fetching/decoding happens in
// JS (browser fetch + canvas, not Go's net/http + image/png) and only the
// resulting flat array crosses into Go for At's bilinear lookup and
// propagation.PathMargin's terrain sampling. The returned Grid owns elev
// directly (no copy); Close is a no-op since there's nothing to release.
func NewFromElev(zoom, minTileX, minTileY, tilesWide, tilesHigh int, elev []float32) (*Grid, error) {
	width := tilesWide * tileSize
	height := tilesHigh * tileSize
	if len(elev) != width*height {
		return nil, fmt.Errorf("demgrid: elev length %d doesn't match %dx%d grid (%d tiles wide x %d tiles high)", len(elev), width, height, tilesWide, tilesHigh)
	}
	return &Grid{
		Zoom:      zoom,
		MinTileX:  minTileX,
		MinTileY:  minTileY,
		TilesWide: tilesWide,
		TilesHigh: tilesHigh,
		Width:     width,
		Height:    height,
		Elev:      elev,
	}, nil
}

func lonToTileX(lon float64, z int) float64 {
	n := math.Exp2(float64(z))
	return (lon + 180.0) / 360.0 * n
}

func latToTileY(lat float64, z int) float64 {
	n := math.Exp2(float64(z))
	latRad := lat * math.Pi / 180
	return (1 - math.Asinh(math.Tan(latRad))/math.Pi) / 2 * n
}

// At returns the elevation in metres at lat/lon using bilinear
// interpolation. Points outside the grid are clamped to the nearest edge
// pixel. Satisfies propagation.Grid.
func (g *Grid) At(lat, lon float64) float64 {
	xf := lonToTileX(lon, g.Zoom) - float64(g.MinTileX)
	yf := latToTileY(lat, g.Zoom) - float64(g.MinTileY)
	px := xf * tileSize
	py := yf * tileSize

	px = clampF(px, 0, float64(g.Width-1))
	py = clampF(py, 0, float64(g.Height-1))

	x0 := int(px)
	y0 := int(py)
	x1 := minInt(x0+1, g.Width-1)
	y1 := minInt(y0+1, g.Height-1)
	fx := px - float64(x0)
	fy := py - float64(y0)

	e00 := float64(g.Elev[y0*g.Width+x0])
	e10 := float64(g.Elev[y0*g.Width+x1])
	e01 := float64(g.Elev[y1*g.Width+x0])
	e11 := float64(g.Elev[y1*g.Width+x1])

	top := e00 + (e10-e00)*fx
	bottom := e01 + (e11-e01)*fx
	return top + (bottom-top)*fy
}

func clampF(v, lo, hi float64) float64 {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
