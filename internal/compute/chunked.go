package compute

import (
	"fmt"
	"log"
	"math"
	"net/http"
	"runtime"

	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
	"hopreach/internal/sysinfo"
)

// chunkGridBudgetBytes bounds how much elevation grid memory a single
// geographic tile's demgrid.Load call is allowed to need — see
// MarginsChunked and Engine.effectiveChunkBudgetBytes, which computes this
// per pass rather than using one fixed value. A whole-Scotland grid at the
// Precision tier's DEM zoom runs into several GB loaded all at once, which
// is what OOM-killed the remote GPU worker in production before per-tile
// chunking existed.
//
// At Scotland's latitude and a realistic ~78km link-budget range, the
// *padding* a single tile needs around its own edges (see padBounds) —
// required for correctness near any tile boundary, not a tunable safety
// margin — already costs ~1.1GB on its own at zoom 13, before any real tile
// content: no amount of splitting can get a tile smaller than that floor.
//
// This used to be one fixed value, hand-picked and re-picked by hand every
// time either box's RAM changed during a real production incident (the
// same "how much RAM does this box actually have free right now" question,
// answered manually each time) — and picking it too small has a real,
// separate cost: a tile budget small enough to be safe but far below what
// the box could actually support means hundreds of unnecessarily tiny
// tiles, each paying its own broker round trip, worker-side terrain
// fetch/cache-lookup, and GPU dispatch overhead — which is what made a
// real run take well over an hour per tier instead of the roughly a
// minute a single whole-raster job used to take before per-tile chunking
// existed at all. effectiveChunkBudgetBytes auto-sizes this from whichever
// box will actually load a tile's grid instead.
//
// defaultChunkGridBudgetBytes is only the fallback for when auto-sizing
// can't determine any box's available memory at all (sysinfo fails, and no
// remote worker is connected or has reported yet) — chosen to match what
// this project's own boxes have needed in practice.
const defaultChunkGridBudgetBytes = 1_400_000_000

// chunkBudgetReserveBytes/chunkBudgetSafetyDivisor turn a box's raw
// available-memory figure into a nominal per-tile budget:
// chunkBudgetReserveBytes is set aside up front for fixed overhead (the Go
// runtime, the OS, and — for the GPU worker specifically — the
// Vulkan/Mesa driver's own baseline footprint, none of which scales with
// tile size), and the remainder is divided by chunkBudgetSafetyDivisor to
// account for the *transient* extra memory a tile's grid needs beyond its
// own nominal size while actually being processed (the mmap'd grid plus a
// CPU-side upload copy for the GPU path). Chosen conservatively — safe
// (more, smaller tiles; slower) over aggressive (fewer, bigger tiles; a
// real OOM risk if this guess is wrong) — because getting this wrong is a
// production outage, not just a slow pass.
const chunkBudgetReserveBytes = 1_500_000_000
const chunkBudgetSafetyDivisor = 2.0

// minAutoChunkBudgetBytes floors auto-sizing so a box that's nearly out of
// memory still gets a workable (if very conservative) budget instead of
// one so small planTiles' own per-DEM-tile floor dominates every decision.
const minAutoChunkBudgetBytes = 300_000_000

// budgetFromAvailable turns a box's available-memory figure into a nominal
// per-tile chunk budget — see chunkBudgetReserveBytes/
// chunkBudgetSafetyDivisor. Only meaningful for availableBytes > 0 (the
// caller should treat 0 as "unknown" and fall back to
// defaultChunkGridBudgetBytes instead of calling this).
func budgetFromAvailable(availableBytes uint64) float64 {
	usable := float64(availableBytes) - chunkBudgetReserveBytes
	if usable < 0 {
		usable = 0
	}
	budget := usable / chunkBudgetSafetyDivisor
	if budget < minAutoChunkBudgetBytes {
		budget = minAutoChunkBudgetBytes
	}
	return budget
}

// effectiveChunkBudgetBytes decides the per-tile memory budget for this
// pass: an explicit override (SetChunkBudgetBytes) always wins; otherwise
// auto-size from whichever box will actually load each tile's grid.
//
// A tile can fall back from remote to local/CPU mid-pass if the remote
// worker drops out (a real, observed production scenario — see
// MarginsChunked's own per-tile local/remote choice), so the auto-sized
// budget is the *smaller* of what's safe for this process's own box and
// what's safe for a connected remote worker's box, not just whichever one
// is expected to serve most tiles: a tile sized only for a large remote
// worker's RAM could OOM this process's own, much smaller box if it ends
// up having to load that same tile locally.
func (e *Engine) effectiveChunkBudgetBytes() float64 {
	if e.chunkBudgetBytes > 0 {
		return e.chunkBudgetBytes
	}

	localBudget := float64(defaultChunkGridBudgetBytes)
	if avail, err := sysinfo.AvailableMemoryBytes(); err == nil {
		localBudget = budgetFromAvailable(avail)
	}

	connected, remoteAvail := e.remoteStatus()
	if !connected || remoteAvail == 0 {
		return localBudget
	}
	if remoteBudget := budgetFromAvailable(remoteAvail); remoteBudget < localBudget {
		return remoteBudget
	}
	return localBudget
}

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

// maxPlanTiles bounds how many tiles planTiles will ever actually build,
// independent of budgetBytes' own per-tile sizing target — the regression
// test/fix for a real production OOM. The per-tile budget can't always be
// satisfied by splitting alone: a tile's *padding* (rangeKm on every edge,
// mandatory for correctness near any tile boundary — see padBounds) stays
// roughly constant in real terrain-tile terms as a tile shrinks, while only
// its own content shrinks, so footprint approaches a floor no amount of
// splitting can get under — confirmed in production at zoom 13 with a
// ~78km range, that floor is itself ~4,200 DEM tiles' worth (~1.1GB), which
// can easily be *larger* than a legitimately tiny auto-sized local budget
// (a box with little real headroom auto-sizes down toward
// minAutoChunkBudgetBytes, a few hundred MB). Without this cap, the growth
// loop below — unable to ever satisfy an unreachable budget — keeps
// growing tile counts every iteration with nothing to stop it short of the
// absolute per-axis maximum (one tile per output pixel), and the resulting
// buildTiles call is a single make([]tile, ...) sized by the *product* of
// both axes: tens of millions of tile structs, an instant OOM entirely
// separate from (and unprotected by) the per-tile memory budget this whole
// file exists to enforce. Bounded here instead: once a few thousand tiles
// still aren't enough, accept that each one will end up somewhat over the
// nominal per-tile target rather than let the tile *count* explode — a
// bounded overage on a bounded number of tiles is safe; an unbounded count
// is not, no matter how small each individual tile nominally is.
const maxPlanTiles = 4000

// planTiles splits bounds into a 2D grid of geographic tiles, each sized so
// its own padded elevation grid (loadBounds) stays around budgetBytes at
// zoom (see Engine.effectiveChunkBudgetBytes for how a caller picks that;
// see maxPlanTiles for why that target isn't always reachable). supersample
// must evenly divide imageWidth/imageHeight (1 means no downsampling at
// all, the common case) — see buildTiles for why.
//
// Both axes are chunked, not just latitude: for a propagation range that's
// a meaningful fraction of the region's own size (a realistic MeshCore
// link budget can reach 70-80km, versus Scotland's ~500km span), the
// rangeKm padding alone — added on both edges of a row spanning the full
// width — can already exceed the budget before a single output row is even
// considered, making width-spanning bands unable to shrink no matter how
// short they are. Splitting columns too keeps a tile's *padded* footprint,
// not just its raw output slice, bounded by the budget.
func planTiles(bounds propagation.Bounds, zoom int, imageWidth, imageHeight int, rangeKm float64, budgetBytes float64, supersample int) []tile {
	tilesPerChunkBudget := budgetBytes / demTileBytes
	totalHeightDeg := bounds.North - bounds.South
	totalWidthDeg := bounds.East - bounds.West

	// maxRowTiles/maxColTiles cap how finely this can split: never finer
	// than one supersample-sized block per tile, since buildTiles rounds
	// every boundary down to a multiple of supersample — splitting any
	// finer than that would round two adjacent (non-final) tiles' shared
	// boundary to the same value, degenerating one of them to zero rows or
	// columns. With supersample==1 this is just imageHeight/imageWidth, the
	// original (pre-supersample-awareness) behaviour.
	maxRowTiles, maxColTiles := imageHeight, imageWidth
	if supersample > 1 {
		maxRowTiles, maxColTiles = imageHeight/supersample, imageWidth/supersample
	}

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
	numRowTiles := clampTileCount(int(math.Ceil(totalHeightDeg/sideDeg)), maxRowTiles)
	numColTiles := clampTileCount(int(math.Ceil(totalWidthDeg/sideDeg)), maxColTiles)
	numRowTiles, numColTiles = clampTileProduct(numRowTiles, numColTiles, maxPlanTiles)

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
		candidates := buildTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, numRowTiles, numColTiles, supersample)
		maxFootprint := 0.0
		for _, c := range candidates {
			if fp := tileFootprint(c.loadBounds, zoom); fp > maxFootprint {
				maxFootprint = fp
			}
		}
		if maxFootprint <= tilesPerChunkBudget {
			return candidates
		}
		reachedTileCap := numRowTiles*numColTiles >= maxPlanTiles
		if (numRowTiles >= maxRowTiles && numColTiles >= maxColTiles) || reachedTileCap {
			return candidates // can't split any finer without violating the supersample-alignment invariant above, or would exceed maxPlanTiles
		}
		growth := math.Sqrt(maxFootprint / tilesPerChunkBudget)
		numRowTiles = clampTileCount(int(math.Ceil(float64(numRowTiles)*growth)), maxRowTiles)
		numColTiles = clampTileCount(int(math.Ceil(float64(numColTiles)*growth)), maxColTiles)
		numRowTiles, numColTiles = clampTileProduct(numRowTiles, numColTiles, maxPlanTiles)
	}
	return buildTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, numRowTiles, numColTiles, supersample)
}

// roundDownTo rounds v down to the nearest multiple of n (n<=1 is a no-op).
func roundDownTo(v, n int) int {
	if n <= 1 {
		return v
	}
	return (v / n) * n
}

// buildTiles constructs the numRowTiles x numColTiles grid of tile
// rectangles covering bounds — factored out of planTiles so its sizing
// loop can measure real candidate tiles' footprints before committing to a
// division. Every non-final row/column boundary is rounded down to a
// multiple of supersample (1 = no rounding) so that MarginsChunked can
// downsample each tile's own result independently, without needing
// neighbouring tiles' pixels: a supersample x supersample downsample block
// then never straddles two different geographic tiles. Safe because
// imageWidth/imageHeight are themselves always exact multiples of
// supersample by construction (see RasterSupersampledChunked), so the
// final row/column — which always snaps to the true edge instead of a
// rounded one, same as the un-rounded case — is one too.
func buildTiles(bounds propagation.Bounds, zoom int, imageWidth, imageHeight int, rangeKm float64, numRowTiles, numColTiles, supersample int) []tile {
	totalHeightDeg := bounds.North - bounds.South
	totalWidthDeg := bounds.East - bounds.West

	tiles := make([]tile, 0, numRowTiles*numColTiles)
	for r := 0; r < numRowTiles; r++ {
		rowOffset := roundDownTo(r*imageHeight/numRowTiles, supersample)
		rowEnd := roundDownTo((r+1)*imageHeight/numRowTiles, supersample)
		if r == numRowTiles-1 {
			rowEnd = imageHeight
		}
		// Row 0 is the northernmost row — mirrors the lat/lon pixel mapping
		// used by both propagation.ComputeMarginsCPU and the GPU shader.
		tileNorth := bounds.North - float64(rowOffset)/float64(imageHeight)*totalHeightDeg
		tileSouth := bounds.North - float64(rowEnd)/float64(imageHeight)*totalHeightDeg

		for c := 0; c < numColTiles; c++ {
			colOffset := roundDownTo(c*imageWidth/numColTiles, supersample)
			colEnd := roundDownTo((c+1)*imageWidth/numColTiles, supersample)
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

// clampTileProduct scales rowTiles/colTiles down together, preserving their
// aspect ratio, so their product never exceeds maxProduct — see
// maxPlanTiles for why this exists (a per-axis cap alone doesn't bound the
// *product*, which is what buildTiles actually allocates on).
func clampTileProduct(rowTiles, colTiles, maxProduct int) (int, int) {
	if rowTiles*colTiles <= maxProduct {
		return rowTiles, colTiles
	}
	scale := math.Sqrt(float64(maxProduct) / float64(rowTiles*colTiles))
	r := int(float64(rowTiles) * scale)
	c := int(float64(colTiles) * scale)
	if r < 1 {
		r = 1
	}
	if c < 1 {
		c = 1
	}
	return r, c
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

// DownsampleMargins box-averages src (srcWidth x srcHeight) down by factor
// in each dimension, skipping NaN ("no coverage") samples in the average
// and only producing NaN in the output where every contributing sample was
// also NaN — so a downsampled pixel straddling a coverage boundary reads as
// partial (blended) coverage rather than a jagged all-or-nothing edge.
// Shared by MarginsChunked (downsamples one geographic tile at a time, to
// avoid ever holding a whole-region buffer at full supersampled
// resolution) and internal/coverage's non-chunked RasterSupersampled
// (downsamples the one whole-region buffer it already holds, in one call).
func DownsampleMargins(src []float32, srcWidth, srcHeight, factor int) (dst []float32, dstWidth, dstHeight int) {
	if factor <= 1 {
		return src, srcWidth, srcHeight
	}
	dstWidth = (srcWidth + factor - 1) / factor
	dstHeight = (srcHeight + factor - 1) / factor
	dst = make([]float32, dstWidth*dstHeight)
	for dy := 0; dy < dstHeight; dy++ {
		syEnd := (dy + 1) * factor
		if syEnd > srcHeight {
			syEnd = srcHeight
		}
		for dx := 0; dx < dstWidth; dx++ {
			sxEnd := (dx + 1) * factor
			if sxEnd > srcWidth {
				sxEnd = srcWidth
			}
			var sum float32
			count := 0
			for sy := dy * factor; sy < syEnd; sy++ {
				rowOff := sy * srcWidth
				for sx := dx * factor; sx < sxEnd; sx++ {
					v := src[rowOff+sx]
					if !math.IsNaN(float64(v)) {
						sum += v
						count++
					}
				}
			}
			if count == 0 {
				dst[dy*dstWidth+dx] = float32(math.NaN())
			} else {
				dst[dy*dstWidth+dx] = sum / float32(count)
			}
		}
	}
	return dst, dstWidth, dstHeight
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
// supersample matches the caller's own supersample factor (1 = none):
// imageWidth/imageHeight are the *compute* resolution (already multiplied
// by supersample), and when supersample > 1 the returned buffer is
// downsampled to imageWidth/supersample x imageHeight/supersample —
// computed one geographic tile at a time, immediately after that tile's
// own margins are ready, rather than assembling the entire
// full-supersampled-resolution raster before downsampling it in one big
// pass at the end. That distinction is what fixes a real production OOM:
// the whole-pass buffer used to be sized at full compute resolution (e.g.
// ~1.1GB for a 12000x24246 Precision raster at supersample=2) regardless of
// how small the *served* resolution actually was — a supersample=2 pass's
// own final output is only a quarter that size. Downsampling per-tile
// means the one whole-pass-lifetime buffer this function holds is sized at
// *served* resolution throughout, never the larger compute resolution.
// Requires imageWidth/imageHeight to be exact multiples of supersample
// (always true from RasterSupersampledChunked, which derives compute
// resolution as served resolution times supersample).
//
// This is the entry point Precision-tier rendering uses instead of
// Margins; the caller no longer loads a grid up front at all.
func (e *Engine) MarginsChunked(bounds propagation.Bounds, zoom int, cacheDir, tileURLBase string, client *http.Client, sites []propagation.Site, imageWidth, imageHeight int, rangeKm float64, p propagation.Params, supersample int, progress func(done, total int)) ([]float32, error) {
	if supersample < 1 {
		supersample = 1
	}
	budgetBytes := e.effectiveChunkBudgetBytes()
	tiles := planTiles(bounds, zoom, imageWidth, imageHeight, rangeKm, budgetBytes, supersample)

	outWidth, outHeight := imageWidth/supersample, imageHeight/supersample

	// One line per tier logged unconditionally (cheap — once per call, not
	// once per tile): tile count and the planned budget are exactly the
	// numbers that would have caught a real production OOM immediately —
	// planTiles kept growing tile counts trying to satisfy a budget smaller
	// than the mandatory padding floor could ever reach, right up to tens
	// of millions of tiles, before maxPlanTiles capped it. Worth keeping
	// permanently for the same reason: cheap, and the first thing worth
	// checking if a future pass is unexpectedly slow or memory-hungry.
	if avail, err := sysinfo.AvailableMemoryBytes(); err == nil {
		log.Printf("chunked margins: %d tiles planned (budget=%.0fMB, out=%dx%d=%.0fMB), %.0fMB available before allocating out",
			len(tiles), budgetBytes/1e6, outWidth, outHeight, float64(outWidth*outHeight*4)/1e6, float64(avail)/1e6)
	} else {
		log.Printf("chunked margins: %d tiles planned (budget=%.0fMB, out=%dx%d=%.0fMB)",
			len(tiles), budgetBytes/1e6, outWidth, outHeight, float64(outWidth*outHeight*4)/1e6)
	}

	// out is the one genuinely large, whole-pass-lifetime allocation this
	// function makes — sized at *served* (post-downsample) resolution, not
	// the larger compute resolution (see the doc comment above for why
	// that distinction matters). Still order-of-a-gigabyte for a real
	// Precision-tier raster at supersample=1, so back-to-back tiers
	// (Precision then Calibrated Precision) each allocating their own such
	// buffer still needs a forced collection here first: without it, the
	// *previous* tier's buffer can still be sitting around uncollected —
	// Go's GC has no reason to run early — right as this tier allocates
	// its own, doubling the peak for no real reason. Confirmed in
	// production: a run survived one tier's own memory peak but was
	// OOM-killed moments into the next, immediately after the first tier's
	// tiles had already been written — consistent with exactly this
	// overlap.
	runtime.GC()
	out := make([]float32, outWidth*outHeight)
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

		// Downsampled right here, per tile, at (at most) a few tens of MB —
		// never the whole region at once — before ever touching out. Tile
		// boundaries are always exact multiples of supersample (see
		// buildTiles), so this tile's own block never needs any neighbouring
		// tile's pixels to downsample correctly.
		tileOut, tileOutWidth, tileOutHeight := DownsampleMargins(tileMargins, colCount, tl.rowCount, supersample)
		tileOutRowOffset, tileOutColOffset := tl.rowOffset/supersample, tl.colOffset/supersample
		for row := 0; row < tileOutHeight; row++ {
			srcStart := row * tileOutWidth
			dstStart := (tileOutRowOffset+row)*outWidth + tileOutColOffset
			copy(out[dstStart:dstStart+tileOutWidth], tileOut[srcStart:srcStart+tileOutWidth])
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
