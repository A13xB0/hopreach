package main

import (
	"context"
	"fmt"
	"log"
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

func run(cfg appConfig) error {
	ctx := context.Background()

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

	var img *imageResult
	var calibratedImg *imageResult
	var precisionImg *imageResult
	var calibratedPrecisionImg *imageResult
	var sites []propagation.Site
	var calibratedSites []propagation.Site
	var calResults []calibration.Result
	var grid *demgrid.Grid

	if haveBounds {
		demBounds := demgrid.Bounds{South: bounds.South, North: bounds.North, West: bounds.West, East: bounds.East}
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

		if !cfg.standardRequiresGPU || engine.Available() {
			prog.Update("computing_coverage", 0, 1, "Computing terrain-aware coverage")
			raster := coverage.Raster(engine, grid, sites, bounds, cfg.coverageImageWidth, cfg.propagation, cfg.coverageMaxAlpha,
				func(done, total int) {
					prog.Update("computing_coverage", done, total, fmt.Sprintf("Computing coverage: row %d/%d", done, total))
				})
			img = &imageResult{raster: raster, bounds: bounds}
		} else {
			log.Printf("coverage: coverage.standard_requires_gpu=true but no GPU (local or remote) is available — skipping standard coverage raster")
		}

		{
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

			// The calibration search above always runs regardless of GPU
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
				calibratedImg = &imageResult{raster: calibratedRaster, bounds: bounds}
			} else {
				log.Printf("coverage: coverage.calibrated_requires_gpu=true but no GPU (local or remote) is available — skipping calibrated coverage raster")
			}
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

		// A wider output raster alone can't show more real detail than the
		// elevation data backing it — at the standard DEM_ZOOM this grid is
		// already coarser than the Precision raster's pixel size, so a
		// separate, finer DEM grid is loaded here rather than reusing the
		// one above. Site ground heights are resampled against it too
		// (subtly different from the standard-zoom heights). Skipped
		// entirely (not just the rasters) if neither precision tier is
		// allowed to run — no point fetching a multi-GB grid for nothing.
		if precisionAllowed || calibratedPrecisionAllowed {
			prog.Update("loading_precision_terrain", 0, 1, "Fetching high-resolution elevation tiles")
			precisionGrid, err := demgrid.Load(demBounds, cfg.coveragePrecisionDemZoom, cfg.demCacheDir, cfg.demTileURLBase, httpClient, func(done, total int) {
				prog.Update("loading_precision_terrain", done, total, fmt.Sprintf("Fetching high-resolution elevation tiles (%d/%d)", done, total))
			})
			if err != nil {
				prog.Update("error", 0, 0, err.Error())
				return err
			}
			defer precisionGrid.Close()

			if precisionAllowed {
				precisionSites := make([]propagation.Site, len(selected))
				for i, n := range selected {
					groundM := precisionGrid.At(*n.Lat, *n.Lon)
					precisionSites[i] = propagation.Site{
						Lat:       *n.Lat,
						Lon:       *n.Lon,
						GroundM:   groundM,
						TxHeightM: groundM + cfg.propagation.AntennaHeightM,
					}
				}
				prog.Update("computing_coverage_precision", 0, 1, "Computing high-resolution coverage")
				precisionRaster := coverage.RasterSupersampled(engine, precisionGrid, precisionSites, bounds, cfg.coveragePrecisionWidth, cfg.coveragePrecisionSupersample, cfg.propagation, cfg.coverageMaxAlpha,
					func(done, total int) {
						prog.Update("computing_coverage_precision", done, total, fmt.Sprintf("Computing precision coverage: row %d/%d", done, total))
					})
				precisionImg = &imageResult{raster: precisionRaster, bounds: bounds}
			}

			if calibratedPrecisionAllowed {
				precisionCalibratedSites := make([]propagation.Site, len(selected))
				for i := range selected {
					groundM := precisionGrid.At(calibratedSites[i].Lat, calibratedSites[i].Lon)
					precisionCalibratedSites[i] = propagation.Site{
						Lat:       calibratedSites[i].Lat,
						Lon:       calibratedSites[i].Lon,
						GroundM:   groundM,
						TxHeightM: groundM + cfg.propagation.AntennaHeightM,
					}
				}
				prog.Update("computing_coverage_calibrated_precision", 0, 1, "Computing high-resolution coverage from calibrated positions")
				calibratedPrecisionRaster := coverage.RasterSupersampled(engine, precisionGrid, precisionCalibratedSites, bounds, cfg.coveragePrecisionWidth, cfg.coveragePrecisionSupersample, cfg.propagation, cfg.coverageMaxAlpha,
					func(done, total int) {
						prog.Update("computing_coverage_calibrated_precision", done, total, fmt.Sprintf("Computing calibrated precision coverage: row %d/%d", done, total))
					})
				calibratedPrecisionImg = &imageResult{raster: calibratedPrecisionRaster, bounds: bounds}
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

	// Each tier's tiles are written independently — gating one tier (see
	// coverage.*_requires_gpu) must not prevent another, still-computed
	// tier from being written too.
	if img != nil && img.raster != nil {
		tiles, err := coverage.WriteTiles(cfg.outputDir, "coverage", img.raster, img.bounds)
		if err != nil {
			prog.Update("error", 0, 0, err.Error())
			return err
		}
		standard := buildCoverageMeta(tiles, rangeKm, cfg,
			"Terrain-aware estimate: free-space path loss + single-knife-edge diffraction over real elevation data (earth curvature included). Does not model foliage or buildings, and assumes one dominant obstruction per path.")
		m.Coverage = &coverageOutputs{Standard: &standard}
	}

	if calibratedImg != nil && calibratedImg.raster != nil {
		tiles, err := coverage.WriteTiles(cfg.outputDir, "coverage-calibrated", calibratedImg.raster, calibratedImg.bounds)
		if err != nil {
			prog.Update("error", 0, 0, err.Error())
			return err
		}
		calibrated := buildCoverageMeta(tiles, rangeKm, cfg,
			"As above, but positions are nudged (within a bounded radius) toward wherever the terrain model best explains each repeater's actually-observed reach data. See each repeater's calibration_offset_m/calibration_score_before/calibration_score_after properties.")
		if m.Coverage == nil {
			m.Coverage = &coverageOutputs{}
		}
		m.Coverage.Calibrated = &calibrated
	}

	if precisionImg != nil && precisionImg.raster != nil {
		tiles, err := coverage.WriteTiles(cfg.outputDir, "coverage-precision", precisionImg.raster, precisionImg.bounds)
		if err != nil {
			prog.Update("error", 0, 0, err.Error())
			return err
		}
		precision := buildCoverageMeta(tiles, rangeKm, cfg,
			"Same model and reported positions as Standard, rendered at a much higher pixel resolution for a sharper result.")
		if m.Coverage == nil {
			m.Coverage = &coverageOutputs{}
		}
		m.Coverage.Precision = &precision
	}

	if calibratedPrecisionImg != nil && calibratedPrecisionImg.raster != nil {
		tiles, err := coverage.WriteTiles(cfg.outputDir, "coverage-calibrated-precision", calibratedPrecisionImg.raster, calibratedPrecisionImg.bounds)
		if err != nil {
			prog.Update("error", 0, 0, err.Error())
			return err
		}
		calibratedPrecision := buildCoverageMeta(tiles, rangeKm, cfg,
			"Same model and calibrated positions as Calibrated, rendered at a much higher pixel resolution for a sharper result.")
		if m.Coverage == nil {
			m.Coverage = &coverageOutputs{}
		}
		m.Coverage.CalibratedPrecision = &calibratedPrecision
	}

	metaPath := filepath.Join(cfg.outputDir, "meta.json")
	if err := writeJSONFile(metaPath, m); err != nil {
		prog.Update("error", 0, 0, err.Error())
		return fmt.Errorf("writing %s: %w", metaPath, err)
	}

	prog.Update("done", 1, 1, fmt.Sprintf("%d repeaters, coverage up to date", len(features)))

	log.Printf("wrote %d/%d repeaters within region (scope=%q) -> %s (active=%d degraded=%d silent=%d)",
		len(features), len(nodes), cfg.requiredScope, geoPath, counts["active"], counts["degraded"], counts["silent"])
	return nil
}
