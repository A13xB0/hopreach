package main

import (
	"context"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hopreach/internal/calibration"
	"hopreach/internal/compute"
	"hopreach/internal/corescope"
	"hopreach/internal/coverage"
	"hopreach/internal/demgrid"
	"hopreach/internal/geo"
	"hopreach/internal/progress"
	"hopreach/internal/propagation"
)

// selectRepeaters keeps nodes that have coordinates, fall within the
// configured region boundary, and (if cfg.requiredScope is set) are scoped
// to it.
func selectRepeaters(nodes []corescope.Node, region geo.Boundary, cfg appConfig) []corescope.Node {
	selected := make([]corescope.Node, 0, len(nodes))
	for _, n := range nodes {
		if n.Lat == nil || n.Lon == nil {
			continue
		}
		if !region.Contains(*n.Lat, *n.Lon) {
			continue
		}
		if cfg.requiredScope != "" {
			if n.DefaultScope == nil || strings.TrimPrefix(*n.DefaultScope, "#") != cfg.requiredScope {
				continue
			}
		}
		selected = append(selected, n)
	}
	return selected
}

// loadLocalGrid loads a small demgrid covering just the given points
// (padded slightly for bilinear interpolation neighbours), for one-off
// ground-elevation lookups at a specific point — e.g. Precision-zoom site
// heights. Deliberately not the same grid used for a coverage raster
// itself: that's now loaded in geographic bands by
// coverage.RasterSupersampledChunked instead, since a whole-region grid at
// the Precision tier's DEM zoom can run into several GB (see
// compute.Engine.MarginsChunked), while the handful of points this is
// called with cover a tiny fraction of that area.
func loadLocalGrid(points []coverage.Point, zoom int, cacheDir, tileURLBase string, client *http.Client) (*demgrid.Grid, error) {
	b := propagation.Bounds{South: points[0].Lat, North: points[0].Lat, West: points[0].Lon, East: points[0].Lon}
	for _, pt := range points[1:] {
		b.South = math.Min(b.South, pt.Lat)
		b.North = math.Max(b.North, pt.Lat)
		b.West = math.Min(b.West, pt.Lon)
		b.East = math.Max(b.East, pt.Lon)
	}
	const padDeg = 0.02 // a couple of km either side, enough for bilinear interpolation neighbours at any DEM zoom this project uses
	b.South -= padDeg
	b.North += padDeg
	b.West -= padDeg
	b.East += padDeg
	return demgrid.Load(demgrid.Bounds{South: b.South, North: b.North, West: b.West, East: b.East}, zoom, cacheDir, tileURLBase, client, nil)
}

// cleanStaleGridScratch removes any leftover demgrid mmap scratch files
// (see internal/demgrid's mmapFloat32) from a previous run that never
// reached grid.Close() — see its call site in run() for why this is
// always safe. Missing directory (nothing ever cached yet) or a file that
// won't remove for some other reason are both logged-and-ignored rather
// than failing the run: this is disk hygiene, not correctness.
func cleanStaleGridScratch(demCacheDir string) {
	dir := filepath.Join(demCacheDir, "grid-scratch")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		path := filepath.Join(dir, e.Name())
		if err := os.Remove(path); err != nil {
			log.Printf("coverage: could not remove stale grid-scratch file %s: %v", path, err)
		}
	}
}

func run(cfg appConfig) error {
	ctx := context.Background()

	// Always safe here, even before deciding whether a real pass is due:
	// the cross-process lock (see lock.go, held by the caller for the
	// entirety of run()) guarantees only one run() is ever active at a
	// time, so nothing left in grid-scratch could still be in use by
	// another process. Left uncleaned, these accumulate — a crashed run
	// (OOM, kill, panic) never reaches grid.Close(), and a single
	// Precision-tier grid can be a gigabyte or more — silently filling the
	// host's disk over repeated crashes (confirmed in production: 13
	// orphaned files, 17GB total, from one night of debugging GPU
	// dispatch issues).
	cleanStaleGridScratch(cfg.demCacheDir)

	if !cfg.forceRecompute {
		if last, ok := lastGeneratedAt(cfg.outputDir); ok {
			if age := time.Since(last); age < time.Duration(cfg.minRecomputeIntervalHours*float64(time.Hour)) {
				log.Printf("coverage: last run finished %s ago, younger than coverage.min_recompute_interval_hours=%.1fh — nothing to do (pass -force to override)", age.Round(time.Second), cfg.minRecomputeIntervalHours)
				return nil
			}
		}
	}

	engine := compute.New()
	engine.Setup(cfg.gpuMode)
	engine.SetRemote(cfg.gpuBrokerAddr, cfg.demTileURLBase)

	httpClient := &http.Client{Timeout: cfg.timeout}
	if err := os.MkdirAll(cfg.outputDir, 0o755); err != nil {
		return fmt.Errorf("creating output dir: %w", err)
	}
	prog := progress.New(cfg.outputDir)
	engine.SetProgress(prog) // read by engine.Margins to report which backend is serving the current pass
	prog.Update("fetching_repeaters", 0, 1, "Fetching repeater list from CoreScope")

	boundaryCacheDir := filepath.Join(cfg.demCacheDir, "boundary")
	region, err := geo.LoadBoundary(cfg.regionBoundaryPath, cfg.regionBoundaryURL, boundaryCacheDir, httpClient)
	if err != nil {
		prog.Update("error", 0, 0, err.Error())
		return err
	}

	client := corescope.NewClient(cfg.apiURL, httpClient)
	nodes, err := client.FetchRepeaters(ctx)
	if err != nil {
		prog.Update("error", 0, 0, err.Error())
		return err
	}

	selected := selectRepeaters(nodes, region, cfg)
	prog.Update("fetching_repeaters", 1, 1, fmt.Sprintf("%d repeaters in region", len(selected)))

	rangeKm := propagation.LinkBudgetMaxRangeKm(cfg.propagation)
	points := make([]coverage.Point, len(selected))
	for i, n := range selected {
		points[i] = coverage.Point{Lat: *n.Lat, Lon: *n.Lon}
	}
	bounds, haveBounds := coverage.RasterBounds(points, rangeKm)

	var sites []propagation.Site
	var calibratedSites []propagation.Site
	var calResults []calibration.Result
	var grid *demgrid.Grid
	demBounds := demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}

	if haveBounds {
		grid, err = demgrid.Load(demBounds, cfg.demZoom, cfg.demCacheDir, cfg.demTileURLBase, httpClient, func(done, total int) {
			prog.Update("loading_terrain", done, total, fmt.Sprintf("Fetching elevation tiles (%d/%d)", done, total))
		})
		if err != nil {
			prog.Update("error", 0, 0, err.Error())
			return err
		}
		defer grid.Close() // safety net if we return early below; also closed explicitly right after its last real use, before the (much bigger) precision grid loads

		sites = make([]propagation.Site, len(selected))
		for i, n := range selected {
			groundM := grid.At(*n.Lat, *n.Lon)
			sites[i] = propagation.Site{
				Lat:       *n.Lat,
				Lon:       *n.Lon,
				GroundM:   groundM,
				TxHeightM: groundM + cfg.propagation.AntennaHeightM,
			}
		}

		// Calibration doesn't depend on any coverage raster — computed here,
		// ahead of every raster below, so repeaters.geojson/meta.json (see
		// after this block) can include calibrated positions and be written
		// well before the first coverage tile exists, rather than everyone
		// having to wait for the entire run just to see the repeater list.
		prog.Update("fetching_reach_data", 0, 1, "Fetching observed reach data from CoreScope")
		reachByPubkey := corescope.FetchAllReach(ctx, client, selected, cfg.calibration.ReachDays, func(done, total int) {
			prog.Update("fetching_reach_data", done, total, fmt.Sprintf("Fetching reach data (%d/%d)", done, total))
		})
		calResults = make([]calibration.Result, len(selected))
		calibratedSites = make([]propagation.Site, len(selected))
		for i, n := range selected {
			links := reachByPubkey[n.PublicKey]
			cr := calibration.Position(grid, cfg.propagation, cfg.calibration, *n.Lat, *n.Lon, links)
			calResults[i] = cr
			calibratedSites[i] = propagation.Site{
				Lat:       cr.Lat,
				Lon:       cr.Lon,
				GroundM:   cr.GroundM,
				TxHeightM: cr.GroundM + cfg.propagation.AntennaHeightM,
			}
		}
	} else {
		sites = make([]propagation.Site, len(selected))
	}

	features := buildFeatures(selected, sites, calResults, cfg)
	fc := featureCollection{Type: "FeatureCollection", Features: features}

	counts := map[string]int{"active": 0, "degraded": 0, "silent": 0}
	for _, f := range features {
		status := f.Properties["status"].(string)
		counts[status]++
	}

	geoPath := filepath.Join(cfg.outputDir, "repeaters.geojson")
	if err := writeJSONFile(geoPath, fc); err != nil {
		prog.Update("error", 0, 0, err.Error())
		return fmt.Errorf("writing %s: %w", geoPath, err)
	}

	m := meta{
		GeneratedAt:           time.Now().UTC().Format(time.RFC3339),
		Source:                cfg.apiURL,
		Boundary:              cfg.regionBoundaryLabel,
		RequiredScope:         cfg.requiredScope,
		TotalRepeatersFetched: len(nodes),
		RepeatersInRegion:     len(features),
		Counts:                counts,
	}
	metaPath := filepath.Join(cfg.outputDir, "meta.json")
	writeMeta := func() error {
		return writeJSONFile(metaPath, m)
	}
	// Written now (coverage still nil at this point for a first-ever run,
	// or still describing the *previous* run's tiles otherwise) so the
	// repeater list and its calibration data show up immediately, without
	// waiting for any coverage tier — the tiers below each rewrite this
	// same file as soon as they're individually ready.
	if err := writeMeta(); err != nil {
		prog.Update("error", 0, 0, err.Error())
		return fmt.Errorf("writing %s: %w", metaPath, err)
	}

	// writeTier writes one tier's tiles, folds them into m.Coverage, and
	// immediately rewrites meta.json — so that tier becomes visible (the
	// frontend reloads meta.json on every progress-stage change, not just
	// once the whole run finishes) as soon as it's done, independent of
	// whichever tiers are still being computed after it.
	writeTier := func(baseName string, img *imageResult, note string, assign func(cm *coverageMeta)) error {
		if img == nil || img.raster == nil {
			return nil
		}
		tiles, err := coverage.WriteTiles(cfg.outputDir, baseName, img.raster, img.bounds)
		if err != nil {
			return err
		}
		cm := buildCoverageMeta(tiles, rangeKm, cfg, note)
		if m.Coverage == nil {
			m.Coverage = &coverageOutputs{}
		}
		assign(&cm)
		return writeMeta()
	}

	if haveBounds {
		if !cfg.standardRequiresGPU || engine.Available() {
			prog.Update("computing_coverage", 0, 1, "Computing terrain-aware coverage")
			raster := coverage.Raster(engine, grid, sites, bounds, cfg.coverageImageWidth, cfg.propagation, cfg.coverageMaxAlpha,
				func(done, total int) {
					prog.Update("computing_coverage", done, total, fmt.Sprintf("Computing coverage: row %d/%d", done, total))
				})
			img := &imageResult{raster: raster, bounds: bounds}
			if err := writeTier("coverage", img,
				"Terrain-aware estimate: free-space path loss + single-knife-edge diffraction over real elevation data (earth curvature included). Does not model foliage or buildings, and assumes one dominant obstruction per path.",
				func(cm *coverageMeta) { m.Coverage.Standard = cm }); err != nil {
				prog.Update("error", 0, 0, err.Error())
				return err
			}
		} else {
			log.Printf("coverage: coverage.standard_requires_gpu=true but no GPU (local or remote) is available — skipping standard coverage raster")
		}

		// The calibration search itself already ran above regardless of GPU
		// gating — it's a cheap CPU-only ring search, and its per-repeater
		// results (calibration_offset_m etc.) are valuable on their own
		// even without rendering a full calibrated coverage raster. Only
		// the raster itself (which goes through engine.Margins/GPU) is
		// gated.
		if !cfg.calibratedRequiresGPU || engine.Available() {
			prog.Update("computing_coverage_calibrated", 0, 1, "Computing coverage from calibrated positions")
			calibratedRaster := coverage.Raster(engine, grid, calibratedSites, bounds, cfg.coverageImageWidth, cfg.propagation, cfg.coverageMaxAlpha,
				func(done, total int) {
					prog.Update("computing_coverage_calibrated", done, total, fmt.Sprintf("Computing calibrated coverage: row %d/%d", done, total))
				})
			calibratedImg := &imageResult{raster: calibratedRaster, bounds: bounds}
			if err := writeTier("coverage-calibrated", calibratedImg,
				"As above, but positions are nudged (within a bounded radius) toward wherever the terrain model best explains each repeater's actually-observed reach data. See each repeater's calibration_offset_m/calibration_score_before/calibration_score_after properties.",
				func(cm *coverageMeta) { m.Coverage.Calibrated = cm }); err != nil {
				prog.Update("error", 0, 0, err.Error())
				return err
			}
		} else {
			log.Printf("coverage: coverage.calibrated_requires_gpu=true but no GPU (local or remote) is available — skipping calibrated coverage raster")
		}

		// grid's last use was the calibrated raster just above — release its
		// (mmap-backed, but still actively touched while in use) memory
		// before loading the much bigger precision grid below, rather than
		// letting both be resident at once for the rest of the run.
		grid.Close()

		precisionAllowed := !cfg.precisionRequiresGPU || engine.Available()
		calibratedPrecisionAllowed := !cfg.calibratedPrecisionRequiresGPU || engine.Available()

		if !precisionAllowed {
			log.Printf("coverage: coverage.precision_requires_gpu=true but no GPU (local or remote) is available — skipping precision coverage raster")
		}
		if !calibratedPrecisionAllowed {
			log.Printf("coverage: coverage.calibrated_precision_requires_gpu=true but no GPU (local or remote) is available — skipping calibrated precision coverage raster")
		}

		// The Precision raster's own terrain is no longer loaded as one
		// whole-region grid here — a grid spanning all of Scotland at this
		// DEM zoom can run into several GB, which is what OOM-killed the
		// remote GPU worker in production. coverage.RasterSupersampledChunked
		// loads it in geographic tiles instead (see
		// compute.Engine.MarginsChunked), each released before the next
		// starts. Site ground heights still need one point lookup each —
		// loadLocalGrid below covers just the repeaters themselves, not the
		// whole region, since that's a tiny fraction of the area.
		if precisionAllowed || calibratedPrecisionAllowed {
			sitePoints := make([]coverage.Point, 0, len(selected)+len(calibratedSites))
			for _, n := range selected {
				sitePoints = append(sitePoints, coverage.Point{Lat: *n.Lat, Lon: *n.Lon})
			}
			for _, s := range calibratedSites {
				sitePoints = append(sitePoints, coverage.Point{Lat: s.Lat, Lon: s.Lon})
			}
			prog.Update("loading_precision_terrain", 0, 1, "Fetching high-resolution elevation tiles for repeater sites")
			siteGrid, err := loadLocalGrid(sitePoints, cfg.coveragePrecisionDemZoom, cfg.demCacheDir, cfg.demTileURLBase, httpClient)
			if err != nil {
				prog.Update("error", 0, 0, err.Error())
				return err
			}

			if precisionAllowed {
				precisionSites := make([]propagation.Site, len(selected))
				for i, n := range selected {
					groundM := siteGrid.At(*n.Lat, *n.Lon)
					precisionSites[i] = propagation.Site{
						Lat:       *n.Lat,
						Lon:       *n.Lon,
						GroundM:   groundM,
						TxHeightM: groundM + cfg.propagation.AntennaHeightM,
					}
				}
				prog.Update("computing_coverage_precision", 0, 1, "Computing high-resolution coverage")
				precisionRaster, err := coverage.RasterSupersampledChunked(engine, bounds, cfg.coveragePrecisionDemZoom, cfg.demCacheDir, cfg.demTileURLBase, httpClient, precisionSites, cfg.coveragePrecisionWidth, cfg.coveragePrecisionSupersample, cfg.propagation, cfg.coverageMaxAlpha,
					func(done, total int) {
						prog.Update("computing_coverage_precision", done, total, fmt.Sprintf("Computing precision coverage: %d%%", done*100/total))
					})
				if err != nil {
					siteGrid.Close()
					prog.Update("error", 0, 0, err.Error())
					return err
				}
				precisionImg := &imageResult{raster: precisionRaster, bounds: bounds}
				if err := writeTier("coverage-precision", precisionImg,
					"Same model and reported positions as Standard, rendered at a much higher pixel resolution for a sharper result.",
					func(cm *coverageMeta) { m.Coverage.Precision = cm }); err != nil {
					siteGrid.Close()
					prog.Update("error", 0, 0, err.Error())
					return err
				}
			}

			if calibratedPrecisionAllowed {
				precisionCalibratedSites := make([]propagation.Site, len(selected))
				for i := range selected {
					groundM := siteGrid.At(calibratedSites[i].Lat, calibratedSites[i].Lon)
					precisionCalibratedSites[i] = propagation.Site{
						Lat:       calibratedSites[i].Lat,
						Lon:       calibratedSites[i].Lon,
						GroundM:   groundM,
						TxHeightM: groundM + cfg.propagation.AntennaHeightM,
					}
				}
				siteGrid.Close()
				prog.Update("computing_coverage_calibrated_precision", 0, 1, "Computing high-resolution coverage from calibrated positions")
				calibratedPrecisionRaster, err := coverage.RasterSupersampledChunked(engine, bounds, cfg.coveragePrecisionDemZoom, cfg.demCacheDir, cfg.demTileURLBase, httpClient, precisionCalibratedSites, cfg.coveragePrecisionWidth, cfg.coveragePrecisionSupersample, cfg.propagation, cfg.coverageMaxAlpha,
					func(done, total int) {
						prog.Update("computing_coverage_calibrated_precision", done, total, fmt.Sprintf("Computing calibrated precision coverage: %d%%", done*100/total))
					})
				if err != nil {
					prog.Update("error", 0, 0, err.Error())
					return err
				}
				calibratedPrecisionImg := &imageResult{raster: calibratedPrecisionRaster, bounds: bounds}
				if err := writeTier("coverage-calibrated-precision", calibratedPrecisionImg,
					"Same model and calibrated positions as Calibrated, rendered at a much higher pixel resolution for a sharper result.",
					func(cm *coverageMeta) { m.Coverage.CalibratedPrecision = cm }); err != nil {
					prog.Update("error", 0, 0, err.Error())
					return err
				}
			} else {
				siteGrid.Close()
			}
		}
	}

	m.Complete = true
	if err := writeMeta(); err != nil {
		prog.Update("error", 0, 0, err.Error())
		return fmt.Errorf("writing %s: %w", metaPath, err)
	}

	prog.Update("done", 1, 1, fmt.Sprintf("%d repeaters, coverage up to date", len(features)))

	log.Printf("wrote %d/%d repeaters within region (scope=%q) -> %s (active=%d degraded=%d silent=%d)",
		len(features), len(nodes), cfg.requiredScope, geoPath, counts["active"], counts["degraded"], counts["silent"])
	return nil
}
