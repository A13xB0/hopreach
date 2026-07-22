package compute

import (
	"fmt"
	"math"
	"net/http"

	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
)

// chunkGridBudgetBytes bounds how much elevation grid memory a single
// geographic tile's demgrid.Load call is allowed to need — see
// MarginsChunked. 500MB comfortably fits alongside everything else sharing
// RAM on the smallest boxes this project actually runs on (a 2GB website
// VPS, a 4GB GPU worker LXC): a whole-Scotland grid at the Precision tier's
// DEM zoom runs into several GB loaded all at once, which is what
// OOM-killed the remote GPU worker in production before this existed. A
// var, not a const, so tests can shrink it to exercise multi-tile behaviour
// against a small synthetic region instead of a real whole-Scotland fetch.
var chunkGridBudgetBytes float64 = 500_000_000

// demTileBytes is one decoded 256x256 terrarium tile's footprint in the
// in-memory grid (float32 per pixel) — used only to estimate how many
// tiles a region needs, not for anything load-bearing.
const demTileBytes = 256 * 256 * 4

// kmPerDegLat approximates km per degree of latitude — used throughout this
// file as a deliberately-conservative conversion (applying it to longitude
// padding too over-estimates the km covered there away from the equator,
// which only means fetching a little extra terrain, never too little).
const kmPerDegLat = 110.574

// padBounds expands b by rangeKm in every direction. Needed wherever a
// chunk boundary runs through the middle of a live region (tile edges in
// MarginsChunked) so a site or path near that edge still sees real terrain
// beyond it instead of the grid clamping at the chunk's own boundary.
func padBounds(b propagation.Bounds, rangeKm float64) propagation.Bounds {
	padDeg := rangeKm / kmPerDegLat
	return propagation.Bounds{
		South: b.South - padDeg, North: b.North + padDeg,
		West: b.West - padDeg, East: b.East + padDeg,
	}
}

// tile is one geographic rectangle of a coverage pass: rows
// [rowOffset, rowOffset+rowCount) and columns [colOffset, colOffset+colCount)
// of the full output raster, the exact lat/lon bounds that rectangle covers
// (outputBounds), and a wider bounds (loadBounds) padded by the
// propagation range so terrain just outside the tile is still visible to
// path calculations that cross its edge.
type tile struct {
	rowOffset, rowCount int
	colOffset, colCount int
	outputBounds        propagation.Bounds
	loadBounds          propagation.Bounds
}

// planTiles splits bounds into a 2D grid of geographic tiles, each sized so
// its own padded elevation grid (loadBounds) stays around
// chunkGridBudgetBytes at zoom.
//
// Both axes are chunked, not just latitude: for a propagation range that's
// a meaningful fraction of the region's own size (a realistic MeshCore
// link budget can reach 70-80km, versus Scotland's ~500km span), the
// rangeKm padding alone — added on both edges of a row spanning the full
// width — can already exceed the budget before a single output row is even
// considered, making width-spanning bands unable to shrink no matter how
// short they are. Splitting columns too keeps a tile's *padded* footprint,
// not just its raw output slice, bounded by the budget.
func planTiles(bounds propagation.Bounds, zoom int, imageWidth, imageHeight int, rangeKm float64) []tile {
	tilesPerDeg := math.Exp2(float64(zoom)) / 360.0
	tilesPerChunkBudget := chunkGridBudgetBytes / demTileBytes
	rangeDeg := rangeKm / kmPerDegLat

	// Side length (degrees, applied to both axes — see padBounds for why
	// using the latitude conversion for longitude too is a safe,
	// conservative over-estimate) of a square output tile whose *padded*
	// footprint holds exactly tilesPerChunkBudget tiles.
	sideDeg := math.Sqrt(tilesPerChunkBudget)/tilesPerDeg - 2*rangeDeg
	minSideDeg := 1.0 / tilesPerDeg // never finer than one DEM tile per side
	if sideDeg < minSideDeg {
		sideDeg = minSideDeg
	}

	totalHeightDeg := bounds.North - bounds.South
	totalWidthDeg := bounds.East - bounds.West

	numRowTiles := clampTileCount(int(math.Ceil(totalHeightDeg/sideDeg)), imageHeight)
	numColTiles := clampTileCount(int(math.Ceil(totalWidthDeg/sideDeg)), imageWidth)

	tiles := make([]tile, 0, numRowTiles*numColTiles)
	for r := 0; r < numRowTiles; r++ {
		rowOffset := r * imageHeight / numRowTiles
		rowEnd := (r + 1) * imageHeight / numRowTiles
		if r == numRowTiles-1 {
			rowEnd = imageHeight
		}
		// Row 0 is the northernmost row — mirrors the lat/lon pixel mapping
		// used by both propagation.ComputeMarginsCPU and the GPU shader.
		tileNorth := bounds.North - float64(rowOffset)/float64(imageHeight)*totalHeightDeg
		tileSouth := bounds.North - float64(rowEnd)/float64(imageHeight)*totalHeightDeg

		for c := 0; c < numColTiles; c++ {
			colOffset := c * imageWidth / numColTiles
			colEnd := (c + 1) * imageWidth / numColTiles
			if c == numColTiles-1 {
				colEnd = imageWidth
			}
			tileWest := bounds.West + float64(colOffset)/float64(imageWidth)*totalWidthDeg
			tileEast := bounds.West + float64(colEnd)/float64(imageWidth)*totalWidthDeg

			outputBounds := propagation.Bounds{South: tileSouth, North: tileNorth, West: tileWest, East: tileEast}
			loadBounds := padBounds(outputBounds, rangeKm)
			loadBounds.South = math.Max(loadBounds.South, bounds.South)
			loadBounds.North = math.Min(loadBounds.North, bounds.North)
			loadBounds.West = math.Max(loadBounds.West, bounds.West)
			loadBounds.East = math.Min(loadBounds.East, bounds.East)

			tiles = append(tiles, tile{
				rowOffset: rowOffset, rowCount: rowEnd - rowOffset,
				colOffset: colOffset, colCount: colEnd - colOffset,
				outputBounds: outputBounds, loadBounds: loadBounds,
			})
		}
	}
	return tiles
}

func clampTileCount(n, maxDim int) int {
	if n < 1 {
		return 1
	}
	if n > maxDim {
		return maxDim // never split finer than one output row/column per tile
	}
	return n
}

// sitesNear returns the subset of sites within rangeKm of bounds — a tile
// with none can skip fetching terrain and computing margins for it
// entirely (left as no-coverage), which for a repeater network sparse
// relative to a whole-region pass often skips most of the region's area.
func sitesNear(sites []propagation.Site, bounds propagation.Bounds, rangeKm float64) []propagation.Site {
	var out []propagation.Site
	for _, s := range sites {
		clampedLat := clampF(s.Lat, bounds.South, bounds.North)
		clampedLon := clampF(s.Lon, bounds.West, bounds.East)
		if propagation.HaversineKm(s.Lat, s.Lon, clampedLat, clampedLon) <= rangeKm {
			out = append(out, s)
		}
	}
	return out
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

// MarginsChunked computes one whole coverage pass the same way Margins
// does, but never asks demgrid.Load for the whole region's elevation grid
// at once. It splits bounds into a 2D grid of geographic tiles (see
// planTiles), loads and releases one tile's grid at a time, and assembles
// the results into one full margins array — see chunkGridBudgetBytes for
// why: a whole-region grid at a high DEM zoom (the Precision tier, all of
// Scotland, zoom 13) can run into several GB, which OOM-killed the remote
// GPU worker (4GB RAM) in production, and would be just as unsafe on the
// website box's own 2GB if a pass ever fell back to local/CPU.
//
// This is the entry point Precision-tier rendering uses instead of
// Margins; the caller no longer loads a grid up front at all. progress is
// reported in output pixels (not rows) completed out of the full raster,
// since a tile only ever covers part of a row.
func (e *Engine) MarginsChunked(bounds propagation.Bounds, zoom int, cacheDir, tileURLBase string, client *http.Client, sites []propagation.Site, imageWidth, imageHeight int, rangeKm float64, p propagation.Params, progress func(done, total int)) ([]float32, error) {
	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm)

	out := make([]float32, imageWidth*imageHeight)
	for i := range out {
		out[i] = float32(math.NaN())
	}

	totalPixels := imageWidth * imageHeight
	donePixels := 0
	for i, tl := range tiles {
		tileSites := sitesNear(sites, tl.outputBounds, rangeKm)
		tilePixels := tl.rowCount * tl.colCount
		if len(tileSites) == 0 {
			donePixels += tilePixels
			if progress != nil {
				progress(donePixels, totalPixels)
			}
			continue
		}

		loadBounds := demgrid.Bounds{South: tl.loadBounds.South, North: tl.loadBounds.North, West: tl.loadBounds.West, East: tl.loadBounds.East}
		grid, err := demgrid.Load(loadBounds, zoom, cacheDir, tileURLBase, client, nil)
		if err != nil {
			return nil, fmt.Errorf("chunked margins: tile %d/%d terrain: %w", i+1, len(tiles), err)
		}

		base := donePixels
		colCount := tl.colCount
		tileMargins := e.Margins(grid, tileSites, tl.outputBounds, colCount, tl.rowCount, rangeKm, p, func(done, total int) {
			if progress != nil {
				// done/total from Margins are rows within this tile; scale
				// to pixels so progress stays monotonic and comparable
				// across tiles of different sizes.
				progress(base+done*colCount, totalPixels)
			}
		})
		grid.Close()

		for row := 0; row < tl.rowCount; row++ {
			srcStart := row * colCount
			dstStart := (tl.rowOffset+row)*imageWidth + tl.colOffset
			copy(out[dstStart:dstStart+colCount], tileMargins[srcStart:srcStart+colCount])
		}

		donePixels += tilePixels
		if progress != nil {
			progress(donePixels, totalPixels)
		}
	}

	if progress != nil {
		progress(totalPixels, totalPixels)
	}
	return out, nil
}
