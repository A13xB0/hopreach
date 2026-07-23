package compute

import (
	"fmt"
	"math"
	"net/http"
	"runtime"

	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
)

// chunkGridBudgetBytes bounds how much elevation grid memory a single
// geographic tile's demgrid.Load call is allowed to need — see
// MarginsChunked. A whole-Scotland grid at the Precision tier's DEM zoom
// runs into several GB loaded all at once, which is what OOM-killed the
// remote GPU worker in production before this existed.
//
// 500MB was the original target, but at Scotland's latitude and a
// realistic ~78km link-budget range, the *padding* a single tile needs
// around its own edges (see padBounds) — required for correctness near any
// tile boundary, not a tunable safety margin — already costs ~1.1GB on its
// own at zoom 13, before any real tile content: no amount of splitting can
// get a tile smaller than that floor. 1.4GB budget leaves some genuine
// core area beyond that floor while still fitting the GPU worker's box
// (raised to 7GB specifically to give this room; a real Precision-tier
// tile was observed to actually need roughly 3x its nominal decoded size —
// the mmap'd grid, a CPU-side upload copy, and the integrated GPU's own
// driver-side buffer all count separately against the same system RAM).
// A var, not a const, so tests can shrink it to exercise multi-tile
// behaviour against a small synthetic region instead of a real
// whole-Scotland fetch.
var chunkGridBudgetBytes float64 = 1_400_000_000

// demTileBytes is one decoded 256x256 terrarium tile's footprint in the
// in-memory grid (float32 per pixel) — used only to estimate how many
// tiles a region needs, not for anything load-bearing.
const demTileBytes = 256 * 256 * 4

// kmPerDegLat is km per degree of latitude — constant everywhere, unlike
// longitude (see kmPerDegLon).
const kmPerDegLat = 110.574

// kmPerDegLon is km per degree of longitude at latDeg — shrinks toward the
// poles (111.320*cos(lat) at the equator's own per-degree distance).
// Needed because a flat rangeKm-to-degrees conversion using kmPerDegLat for
// *both* axes (an earlier version of this file did that, on the theory
// that over-padding longitude was merely conservative) is actually
// backwards: at Scotland's ~55-61°N, kmPerDegLon is only about half
// kmPerDegLat, so reusing kmPerDegLat under-pads east/west by roughly 2x —
// a real correctness gap, not a safety margin, since a site's westward or
// eastward path could then run past the loaded grid's edge and clamp to
// the wrong terrain instead of seeing the real thing.
func kmPerDegLon(latDeg float64) float64 {
	return 111.320 * math.Cos(latDeg*math.Pi/180)
}

// padBounds expands b by rangeKm in every direction, using the real
// per-axis km-per-degree at b's own latitude. Needed wherever a chunk
// boundary runs through the middle of a live region (tile edges in
// MarginsChunked) so a site or path near that edge still sees real terrain
// beyond it instead of the grid clamping at the chunk's own boundary.
func padBounds(b propagation.Bounds, rangeKm float64) propagation.Bounds {
	latPadDeg := rangeKm / kmPerDegLat
	lonPadDeg := rangeKm / kmPerDegLon((b.South+b.North)/2)
	return propagation.Bounds{
		South: b.South - latPadDeg, North: b.North + latPadDeg,
		West: b.West - lonPadDeg, East: b.East + lonPadDeg,
	}
}

// tileXAt/tileYAt mirror demgrid's own (unexported) tile-index math
// exactly — duplicated here rather than plumbed through an export because
// sizing tiles against the *real* projection, not a uniform
// degrees-per-tile approximation, is the whole point: latToTileY's
// Mercator projection packs roughly secant(latitude) more tiles into the
// same degree span at higher latitude than a naive uniform estimate
// assumes (secant(61°) ≈ 2.05, matching almost exactly the ~2x
// per-tile-budget overshoot that OOM-killed the GPU worker in production
// on a real Scotland-latitude tile before this was corrected). Getting
// this right requires measuring against the same math demgrid.Load will
// actually use, not an approximation of it.
func tileXAt(lon float64, zoom int) float64 {
	n := math.Exp2(float64(zoom))
	return (lon + 180.0) / 360.0 * n
}

func tileYAt(lat float64, zoom int) float64 {
	n := math.Exp2(float64(zoom))
	latRad := lat * math.Pi / 180
	return (1 - math.Asinh(math.Tan(latRad))/math.Pi) / 2 * n
}

// tileFootprint returns the real number of DEM tiles bounds b spans at
// zoom, using the exact same projection demgrid.Load itself uses.
func tileFootprint(b propagation.Bounds, zoom int) float64 {
	width := math.Abs(tileXAt(b.East, zoom) - tileXAt(b.West, zoom))
	height := math.Abs(tileYAt(b.South, zoom) - tileYAt(b.North, zoom))
	return width * height
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
	tilesPerChunkBudget := chunkGridBudgetBytes / demTileBytes
	totalHeightDeg := bounds.North - bounds.South
	totalWidthDeg := bounds.East - bounds.West

	// Rough starting guess (uniform tiles-per-degree, i.e. treating
	// longitude's own — always-uniform — tile density as if it applied to
	// latitude too) — fast, but not trustworthy on its own; see
	// tileXAt/tileYAt for why. Corrected against the real projection below.
	lonTilesPerDeg := math.Exp2(float64(zoom)) / 360.0
	rangeDeg := rangeKm / kmPerDegLat
	sideDeg := math.Sqrt(tilesPerChunkBudget)/lonTilesPerDeg - 2*rangeDeg
	minSideDeg := 1.0 / lonTilesPerDeg // never finer than one DEM tile per side
	if sideDeg < minSideDeg {
		sideDeg = minSideDeg
	}
	numRowTiles := clampTileCount(int(math.Ceil(totalHeightDeg/sideDeg)), imageHeight)
	numColTiles := clampTileCount(int(math.Ceil(totalWidthDeg/sideDeg)), imageWidth)

	// Verify against the real (Mercator) tile math and grow both axes
	// together by whatever factor the worst *actual* tile is still over
	// budget by — bounded iteration since each step only ever increases
	// tile counts. Deliberately measures every real constructed tile's
	// footprint here, not a single representative "worst case" sample: an
	// earlier version sampled the tile touching the region's own north and
	// west edges on the theory that Mercator compression makes the
	// northernmost row worst — true for latitude alone, but that same
	// sample tile also has its padding *clipped* on those two edges (see
	// the West/East/North/South clamp below), which more than cancels the
	// effect out. The actual worst tile in practice is an interior one,
	// unclipped on all four sides, which no single hand-picked sample
	// reliably represents.
	for iter := 0; iter < 8; iter++ {
		candidates := buildTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, numRowTiles, numColTiles)
		maxFootprint := 0.0
		for _, c := range candidates {
			if fp := tileFootprint(c.loadBounds, zoom); fp > maxFootprint {
				maxFootprint = fp
			}
		}
		if maxFootprint <= tilesPerChunkBudget {
			return candidates
		}
		if numRowTiles >= imageHeight && numColTiles >= imageWidth {
			return candidates // can't split any finer than one output row/column per tile
		}
		growth := math.Sqrt(maxFootprint / tilesPerChunkBudget)
		numRowTiles = clampTileCount(int(math.Ceil(float64(numRowTiles)*growth)), imageHeight)
		numColTiles = clampTileCount(int(math.Ceil(float64(numColTiles)*growth)), imageWidth)
	}
	return buildTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, numRowTiles, numColTiles)
}

// buildTiles constructs the numRowTiles x numColTiles grid of tile
// rectangles covering bounds — factored out of planTiles so its sizing
// loop can measure real candidate tiles' footprints before committing to a
// division.
func buildTiles(bounds propagation.Bounds, zoom int, imageWidth, imageHeight int, rangeKm float64, numRowTiles, numColTiles int) []tile {
	totalHeightDeg := bounds.North - bounds.South
	totalWidthDeg := bounds.East - bounds.West

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

// stubGrid is a cheap 1x1-DEM-tile grid (all sea level) carrying only a
// real Zoom, for the case where a tile's actual terrain is known to never
// be read locally — see its call site in MarginsChunked. Deliberately not
// a genuinely-empty/zero-value Grid: if a connected-at-the-time-of-check
// remote worker disconnects mid-call and Margins falls through to the CPU
// path, that path *does* dereference the grid via At(), and a zero-value
// Grid's Width/Height of 0 would index out of range and panic. A real
// (if degenerate) 1x1-tile grid instead just degrades that one unlucky
// tile to flat sea-level terrain — wrong, but safe, matching how a failed
// individual DEM tile fetch elsewhere in this codebase already degrades to
// the same fallback rather than failing the whole pass.
func stubGrid(zoom int) *demgrid.Grid {
	g, _ := demgrid.NewFromElev(zoom, 0, 0, 1, 1, make([]float32, 256*256))
	return g
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

// weightedTile pairs a tile with the sites relevant to it and an estimated
// compute-cost weight — see the "Progress is weighted..." comment in
// MarginsChunked for why this exists.
type weightedTile struct {
	tl     tile
	sites  []propagation.Site
	weight int
}

// tileWeight estimates a tile's relative compute cost as pixels ×
// sites-in-range (never below 1 site's worth, so a skipped tile still gets
// a small but non-zero weight rather than vanishing from the total
// entirely). This mirrors the real cost driver: both the GPU shader and
// propagation.ComputeMarginsCPU loop over every site for every pixel, so
// wall-clock cost scales with both dimensions, not pixel count alone.
func tileWeight(tl tile, tileSites []propagation.Site) int {
	sitesForWeight := len(tileSites)
	if sitesForWeight < 1 {
		sitesForWeight = 1
	}
	return tl.rowCount * tl.colCount * sitesForWeight
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
// Margins; the caller no longer loads a grid up front at all.
func (e *Engine) MarginsChunked(bounds propagation.Bounds, zoom int, cacheDir, tileURLBase string, client *http.Client, sites []propagation.Site, imageWidth, imageHeight int, rangeKm float64, p propagation.Params, progress func(done, total int)) ([]float32, error) {
	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm)

	// out is the one genuinely large, whole-pass-lifetime allocation this
	// function makes (imageWidth*imageHeight float32s — order of a
	// gigabyte for a real Precision-tier raster). On a memory-constrained
	// box (the website VPS this batch job usually runs on has 2GB, no
	// swap) that's tight enough on its own; back-to-back tiers (Precision
	// then Calibrated Precision) each allocate their own such buffer, and
	// without forcing a collection here, the *previous* tier's buffer can
	// still be sitting around uncollected — Go's GC has no reason to run
	// early — right as this tier allocates its own, doubling the peak for
	// no real reason. Confirmed in production: a run survived Precision's
	// own memory peak but was OOM-killed moments into Calibrated
	// Precision, immediately after Precision's tiles had already been
	// written — consistent with exactly this overlap.
	runtime.GC()
	out := make([]float32, imageWidth*imageHeight)
	for i := range out {
		out[i] = float32(math.NaN())
	}

	// Progress is weighted by estimated compute cost (pixels x
	// sites-in-range), not raw pixel count: a skipped tile (no sites)
	// completes near-instantly regardless of its pixel count, while a
	// dense tile (many nearby sites — a real repeater cluster) can take
	// well over a minute for the same pixel count, since both the GPU
	// shader and the CPU fallback loop over every site for every pixel.
	// Reporting raw pixels made the ETA (internal/progress's exponential
	// rate estimate) swing wildly depending on the local mix of skipped
	// vs. dense tiles in the most recent sampling window — confirmed in
	// production: the same run's reported ETA bounced between under a
	// minute and over half an hour, tile to tile, despite steady real
	// progress underneath. Sites are looked up once here (not repeated
	// per-tile below) since this pre-pass already needs them to compute
	// each tile's weight.
	weighted := make([]weightedTile, len(tiles))
	totalWork := 0
	for i, tl := range tiles {
		tileSites := sitesNear(sites, tl.outputBounds, rangeKm)
		weighted[i] = weightedTile{tl: tl, sites: tileSites, weight: tileWeight(tl, tileSites)}
		totalWork += weighted[i].weight
	}

	doneWork := 0
	for i, wt := range weighted {
		tl := wt.tl
		tileSites := wt.sites
		if len(tileSites) == 0 {
			doneWork += wt.weight
			if progress != nil {
				progress(doneWork, totalWork)
			}
			continue
		}

		// A connected remote worker never reads this grid's contents (only
		// its Zoom, to set the job's DemZoom — see marginsRemote) since it
		// loads its own copy from DemBounds. Skipping the load here when
		// remote is the path that will actually serve this tile matters:
		// this process (the batch job, often the same modest box that also
		// runs the website) would otherwise pay real memory for a grid
		// nothing here ever looks at, on top of the full-raster margins
		// buffer (out, above) it's already holding for the whole pass —
		// together enough to OOM a 2GB box. If local GPU is configured
		// (e.localBE != nil), the real grid is still needed, since that
		// path *does* read it directly.
		var grid *demgrid.Grid
		if e.localBE == nil && e.remoteAvailable() {
			grid = stubGrid(zoom)
		} else {
			loadBounds := demgrid.Bounds{South: tl.loadBounds.South, North: tl.loadBounds.North, West: tl.loadBounds.West, East: tl.loadBounds.East}
			var err error
			grid, err = demgrid.Load(loadBounds, zoom, cacheDir, tileURLBase, client, nil)
			if err != nil {
				return nil, fmt.Errorf("chunked margins: tile %d/%d terrain: %w", i+1, len(tiles), err)
			}
		}

		base := doneWork
		colCount := tl.colCount
		sitesForWeight := wt.weight / (tl.rowCount * colCount) // == max(1, len(tileSites)), recovered rather than recomputed
		tileMargins := e.Margins(grid, tileSites, tl.outputBounds, colCount, tl.rowCount, rangeKm, p, func(done, total int) {
			if progress != nil {
				// done/total from Margins are rows within this tile;
				// scale by the same per-pixel weight used for this tile's
				// total so intermediate progress lines up with it exactly
				// once done reaches rowCount.
				progress(base+done*colCount*sitesForWeight, totalWork)
			}
		})
		grid.Close()

		for row := 0; row < tl.rowCount; row++ {
			srcStart := row * colCount
			dstStart := (tl.rowOffset+row)*imageWidth + tl.colOffset
			copy(out[dstStart:dstStart+colCount], tileMargins[srcStart:srcStart+colCount])
		}

		doneWork += wt.weight
		if progress != nil {
			progress(doneWork, totalWork)
		}
	}

	if progress != nil {
		progress(totalWork, totalWork)
	}
	return out, nil
}
