package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hopreach/internal/analytics"
	"hopreach/internal/buildinfo"
	"hopreach/internal/calibration"
	"hopreach/internal/compute"
	"hopreach/internal/corescope"
	"hopreach/internal/coverage"
	"hopreach/internal/demgrid"
	"hopreach/internal/geo"
	"hopreach/internal/progress"
	"hopreach/internal/propagation"
	"hopreach/internal/sysinfo"
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

// inferRepeaterScopes fetches CoreScope's full node directory, its list of
// real known region names, and a real window's worth of packet traffic,
// then resolves each of the given repeaters' real region(s) — see
// internal/corescope's FetchKnownRegionNames/FetchRegionParticipation doc
// comments for why this decodes each packet's own cryptographic transport
// code (MeshCore's actual region-scoping mechanism) rather than trusting
// each node's own (frequently absent) self-reported default_scope, or
// (an earlier, incorrect version of this feature) a packet's channel name,
// which is a related but distinct concept. A repeater can genuinely have
// more than one region enabled at once, so this returns every region with
// at least one confirmed observation, not just the single most-observed
// one — see corescope.ObservedScopes. Also returns the real, currently-known
// region name list itself (regardless of whether any repeater matched one)
// — the caller uses this to know which per-scope coverage rasters to
// generate, see the "computing_scope_coverage" block in run(). Errors are
// logged and treated as "no scope data available" rather than fatal: this
// is an enrichment nothing downstream depends on.
func inferRepeaterScopes(ctx context.Context, client *corescope.Client, selected []corescope.Node, windowHours float64) (scopes map[string][]string, regionNames []string) {
	allNodes, err := client.FetchAllNodes(ctx)
	if err != nil {
		log.Printf("scope inference: fetching node directory failed, skipping: %v", err)
		return nil, nil
	}
	regionNames, err = client.FetchKnownRegionNames(ctx)
	if err != nil {
		log.Printf("scope inference: fetching known region names failed, skipping: %v", err)
		return nil, nil
	}
	since := time.Now().Add(-time.Duration(windowHours * float64(time.Hour)))
	counts, err := client.FetchRegionParticipation(ctx, since, allNodes, regionNames)
	if err != nil {
		log.Printf("scope inference: fetching region participation failed, skipping: %v", err)
		return nil, regionNames
	}
	scopes = make(map[string][]string, len(selected))
	for _, n := range selected {
		observed := corescope.ObservedScopes(counts[strings.ToLower(n.PublicKey)])
		if len(observed) > 0 {
			scopes[strings.ToLower(n.PublicKey)] = observed
		}
	}
	return scopes, regionNames
}

// repeaterInScope reports whether n is a member of region scopeName, via
// either its inferred scope set (real, cryptographically confirmed
// observations — see inferRepeaterScopes) or its own self-reported
// default_scope — the same union public/app.js's repeaterScopesOf uses
// client-side, so "which repeaters are in this scope" means the same thing
// in the per-scope coverage this generates as it does in the map's own
// scope-filter checkboxes and popups.
func repeaterInScope(n corescope.Node, scopeName string, inferredScopes map[string][]string) bool {
	for _, s := range inferredScopes[strings.ToLower(n.PublicKey)] {
		if s == scopeName {
			return true
		}
	}
	return n.DefaultScope != nil && *n.DefaultScope == scopeName
}

// scopeSlug turns a region name (e.g. "#ioi-admin") into a safe filename
// fragment ("ioi-admin") for coverage-scope-<slug>-*.png tiles.
func scopeSlug(name string) string {
	name = strings.TrimPrefix(name, "#")
	var b strings.Builder
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteRune('-')
		}
	}
	return b.String()
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

// analyticsPath joins name onto the sibling "analytics" directory next to
// outputDir — the convention cmd/hopreach and cmd/hopreach-shareapi both
// use so they agree on where this data lives without a dedicated config
// field just for the path.
func analyticsPath(outputDir, name string) string {
	return filepath.Join(outputDir, "..", "analytics", name)
}

// recordCrashedRunIfAny checks for an InProgressMarker left over from a
// previous invocation of run() that never reached its own end — the
// process was killed (OOM, a manual kill, a host reboot) partway through,
// with no chance to run any Go-level cleanup, including the defer in run()
// that would otherwise have recorded that run's own RunRecord. Finding a
// leftover marker here (called right before this run writes its own) is
// what gives that otherwise-silent failure a RunRecord at all. Best-effort
// throughout: a missing/corrupt marker is simply not treated as a crash
// (the common case — most runs finish cleanly and clear their own
// marker), never fatal to this run.
func recordCrashedRunIfAny(runsPath, markerPath, progressPath string) {
	markers, err := analytics.ReadAll[analytics.InProgressMarker](markerPath)
	if err != nil {
		log.Printf("analytics: could not check %s for a crashed previous run: %v", markerPath, err)
		return
	}
	if len(markers) == 0 {
		return // no marker — the common, expected case (the previous run finished cleanly and cleared its own)
	}

	// progress.json's last-written stage is the best available clue for
	// *where* the previous run was when it died — best-effort, since a
	// sufficiently early crash (or one predating progress.json entirely)
	// leaves nothing useful here.
	lastStage := "unknown"
	if data, err := os.ReadFile(progressPath); err == nil {
		var p struct {
			Stage string `json:"stage"`
		}
		if json.Unmarshal(data, &p) == nil && p.Stage != "" {
			lastStage = p.Stage
		}
	}

	rec := analytics.RunRecord{
		StartedAt:  markers[0].StartedAt,
		FinishedAt: time.Now(),
		DurationS:  time.Since(markers[0].StartedAt).Seconds(),
		Success:    false,
		Error:      fmt.Sprintf("process did not complete (likely killed, e.g. OOM, or crashed) — last known stage: %s", lastStage),
	}
	if aerr := analytics.Append(runsPath, rec, 2000); aerr != nil {
		log.Printf("analytics: could not record crashed run: %v", aerr)
		return
	}
	log.Printf("analytics: recorded a crashed run (started %s, last known stage: %s)", markers[0].StartedAt.Format(time.RFC3339), lastStage)
}

// recordLocalHardwareInfo records this box's static specs (CPU model, total
// RAM, and — if engine picked up a usable local GPU during Setup — its
// adapter string) for the analytics page's hardware panel. Recorded once per
// run rather than continuously: hardware doesn't change underneath a live
// deployment, so the analytics endpoint just needs whatever was recorded
// most recently. Uses analytics.Append with maxLines=1 (rather than a plain
// overwrite) purely to reuse the existing tmp-then-rename-safe write path —
// only ever one entry is kept. Best-effort: failures are logged, never fatal
// to the run itself.
func recordLocalHardwareInfo(outputDir string, engine *compute.Engine) {
	info := analytics.HardwareInfo{Box: "website", GPUAdapter: engine.LocalAdapterID()}
	if v, err := sysinfo.CPUModel(); err == nil {
		info.CPUModel = v
	}
	if v, err := sysinfo.TotalMemoryBytes(); err == nil {
		info.TotalBytes = v
	}
	path := analyticsPath(outputDir, "hardware_website.jsonl")
	if err := analytics.Append(path, info, 1); err != nil {
		log.Printf("analytics: could not record hardware info: %v", err)
	}
}

func run(cfg appConfig) (err error) {
	ctx := context.Background()
	startedAt := time.Now()
	var tierRecords []analytics.TierRecord
	didRun := false // set true only once past the "nothing to do yet" skip check — that path isn't a real run worth recording
	// Set once didRun becomes true (see below) — declared here so the
	// defer below (a closure, capturing these by reference) sees whatever
	// value they end up with, even though it's only assigned later.
	var runsPath, markerPath string

	// Records this run's outcome (success or failure, whichever return
	// path fired) to analytics/runs.jsonl — a defer with a named return so
	// every one of run()'s several early-return points is covered by one
	// recording site instead of needing its own. Best-effort: a failure to
	// record analytics is logged, never allowed to mask or replace the
	// real return error from run() itself. Also clears the in-progress
	// marker (see recordCrashedRunIfAny) — reaching this defer at all means
	// run() got to its own end one way or another, so there's nothing left
	// for a future run to treat as a crash.
	defer func() {
		if !didRun {
			return
		}
		rec := analytics.RunRecord{
			StartedAt:  startedAt,
			FinishedAt: time.Now(),
			DurationS:  time.Since(startedAt).Seconds(),
			Success:    err == nil,
			Version:    buildinfo.Version,
			Tiers:      tierRecords,
		}
		if err != nil {
			rec.Error = err.Error()
		}
		if aerr := analytics.Append(runsPath, rec, 2000); aerr != nil {
			log.Printf("analytics: could not record run history: %v", aerr)
		}
		if rerr := os.Remove(markerPath); rerr != nil && !os.IsNotExist(rerr) {
			log.Printf("analytics: could not clear in-progress marker: %v", rerr)
		}
	}()

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
	didRun = true
	runsPath = analyticsPath(cfg.outputDir, "runs.jsonl")
	markerPath = analyticsPath(cfg.outputDir, "in_progress.json")
	recordCrashedRunIfAny(runsPath, markerPath, filepath.Join(cfg.outputDir, "progress.json"))
	if merr := analytics.Append(markerPath, analytics.InProgressMarker{StartedAt: startedAt}, 1); merr != nil {
		log.Printf("analytics: could not write in-progress marker: %v", merr)
	}

	engine := compute.New()
	engine.Setup(cfg.gpuMode)
	engine.SetRemote(cfg.gpuBrokerAddr, cfg.demTileURLBase)
	if cfg.coveragePrecisionChunkBudgetMB > 0 {
		engine.SetChunkBudgetBytes(float64(cfg.coveragePrecisionChunkBudgetMB) * 1_000_000)
	}
	recordLocalHardwareInfo(cfg.outputDir, engine)

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

	// Optional: real per-repeater region(s), decoded from each packet's own
	// cryptographic transport code (see internal/corescope's
	// FetchRegionParticipation/ObservedScopes doc comments) — a repeater
	// can genuinely have more than one region enabled at once, so this is
	// a set per repeater, not a single value. A failure here degrades
	// gracefully — every repeater just goes without inferred_scopes, same
	// as if the feature were disabled — rather than failing the whole run
	// over what's fundamentally an enrichment, not something anything
	// downstream depends on.
	var inferredScopes map[string][]string
	var knownRegionNames []string
	if cfg.scopeInferenceEnabled {
		prog.Update("inferring_scopes", 0, 1, "Inferring repeater regions from CoreScope packet transport codes")
		inferredScopes, knownRegionNames = inferRepeaterScopes(ctx, client, selected, cfg.scopeInferenceWindowHours)
		prog.Update("inferring_scopes", 1, 1, fmt.Sprintf("Inferred region(s) for %d/%d repeaters", len(inferredScopes), len(selected)))
	}

	features := buildFeatures(selected, sites, calResults, inferredScopes, cfg)
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
		Version:               buildinfo.Version,
		// Seeded from whatever the last run wrote (nil on a genuine first
		// run) so meta.json keeps showing real, servable coverage for the
		// whole time this run is still computing its own — each tier below
		// only overwrites its own entry once it's actually ready, so a
		// tier this run skips (GPU-gated and unavailable, say) or hasn't
		// gotten to yet still shows its last known-good tiles instead of
		// briefly vanishing for anyone loading the page mid-run.
		Coverage:      previousCoverage(cfg.outputDir),
		ScopeCoverage: previousScopeCoverage(cfg.outputDir),
	}
	metaPath := filepath.Join(cfg.outputDir, "meta.json")
	writeMeta := func() error {
		return writeJSONFile(metaPath, m)
	}
	// Written now so the repeater list and its calibration data show up
	// immediately, without waiting for any coverage tier — the tiers below
	// each rewrite this same file as soon as they're individually ready.
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

	// recordTier appends one tier's timing/backend/outcome to the analytics
	// run record — called for every tier actually attempted (not one
	// skipped by GPU gating, which has no meaningful backend/duration of
	// its own to report), whether it succeeded (terr == nil) or its
	// writeTier call failed (terr != nil, right before run() itself
	// returns that same error and aborts remaining tiers) — each tier is
	// its own job dispatched to whichever backend serves it, so it can
	// fail independently of the others and the analytics run history
	// should show exactly which one did.
	recordTier := func(name string, start time.Time, terr error) {
		tr := analytics.TierRecord{
			Name:      name,
			Backend:   prog.LastBackend(),
			DurationS: time.Since(start).Seconds(),
			Success:   terr == nil,
		}
		if terr != nil {
			tr.Error = terr.Error()
		}
		tierRecords = append(tierRecords, tr)
	}

	// shouldComputeTier reports whether a tier needs recomputing: either
	// forceAllTiers is set (the blunt "ignore freshness entirely"
	// override — see its own doc comment on appConfig), or the tier's
	// previous output (nil on a genuine first run) didn't already finish
	// today. This is what lets -force mean "make sure a run happens now"
	// without also meaning "redo every expensive Precision pass that
	// already ran a few hours ago" — the exact scenario a deploy-time
	// restart or an /admin/recompute call hits.
	shouldComputeTier := func(existing *coverageMeta) bool {
		return cfg.forceAllTiers || !tierFreshToday(existing, time.Now())
	}

	if haveBounds {
		gpuOK := !cfg.standardRequiresGPU || engine.Available()
		if gpuOK && shouldComputeTier(m.Coverage.Standard) {
			tierStart := time.Now()
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
				recordTier("standard", tierStart, err)
				return err
			}
			recordTier("standard", tierStart, nil)
		} else if !gpuOK {
			log.Printf("coverage: coverage.standard_requires_gpu=true but no GPU (local or remote) is available — skipping standard coverage raster")
		} else {
			log.Printf("coverage: standard coverage raster already computed today (%s) — skipping recompute (pass -force-all-tiers to override)", m.Coverage.Standard.GeneratedAt)
		}

		// Per-scope standard-tier coverage: the same model as the "standard"
		// tier above, but each region gets its own raster computed from only
		// the repeaters actually in that region (inferred_scopes, falling
		// back to default_scope — see repeaterInScope), so e.g. "#fif"'s
		// raster shows where Fife's own repeaters actually reach, not
		// diluted by every other region's. Reuses the whole-region grid
		// already loaded above rather than refetching terrain per scope —
		// each scope's own bounds (padded rangeKm around just its own
		// repeaters, not the whole region) is a subset of what's already
		// resident. Gated on scope inference being enabled: without it,
		// there's no reliable per-repeater region membership at scale (see
		// inferRepeaterScopes — default_scope alone is sparse in practice),
		// so there'd be nothing meaningful to split by.
		if cfg.scopeInferenceEnabled && len(knownRegionNames) > 0 {
			if !cfg.standardRequiresGPU || engine.Available() {
				tierStart := time.Now()
				for i, scopeName := range knownRegionNames {
					prog.Update("computing_scope_coverage", i, len(knownRegionNames), fmt.Sprintf("Computing per-scope coverage (%d/%d): %s", i+1, len(knownRegionNames), scopeName))

					var scopeSites []propagation.Site
					var scopePoints []coverage.Point
					for j, n := range selected {
						if repeaterInScope(n, scopeName, inferredScopes) {
							scopeSites = append(scopeSites, sites[j])
							scopePoints = append(scopePoints, coverage.Point{Lat: *n.Lat, Lon: *n.Lon})
						}
					}
					if len(scopeSites) == 0 {
						continue
					}
					if !shouldComputeTier(m.ScopeCoverage[scopeName]) {
						log.Printf("coverage: per-scope coverage for %s already computed today — skipping recompute (pass -force-all-tiers to override)", scopeName)
						continue // seeded m.ScopeCoverage[scopeName] (from previousScopeCoverage) is left as-is
					}
					scopeBounds, ok := coverage.RasterBounds(scopePoints, rangeKm)
					if !ok {
						continue
					}
					scopeRaster := coverage.Raster(engine, grid, scopeSites, scopeBounds, cfg.coverageImageWidth, cfg.propagation, cfg.coverageMaxAlpha, nil)
					tiles, err := coverage.WriteTiles(cfg.outputDir, "coverage-scope-"+scopeSlug(scopeName), scopeRaster, scopeBounds)
					if err != nil {
						prog.Update("error", 0, 0, err.Error())
						recordTier("scope_coverage", tierStart, err)
						return fmt.Errorf("writing per-scope coverage tiles for %s: %w", scopeName, err)
					}
					cm := buildCoverageMeta(tiles, rangeKm, cfg, fmt.Sprintf("Standard-tier coverage computed using only repeaters observed in region %s (%d repeater(s)).", scopeName, len(scopeSites)))
					if m.ScopeCoverage == nil {
						m.ScopeCoverage = map[string]*coverageMeta{}
					}
					m.ScopeCoverage[scopeName] = &cm
					if err := writeMeta(); err != nil {
						prog.Update("error", 0, 0, err.Error())
						recordTier("scope_coverage", tierStart, err)
						return fmt.Errorf("writing %s: %w", metaPath, err)
					}
				}
				prog.Update("computing_scope_coverage", len(knownRegionNames), len(knownRegionNames), fmt.Sprintf("Computed coverage for %d region(s)", len(knownRegionNames)))
				recordTier("scope_coverage", tierStart, nil)
			} else {
				log.Printf("coverage: coverage.standard_requires_gpu=true but no GPU (local or remote) is available — skipping per-scope coverage rasters")
			}
		}

		// The calibration search itself already ran above regardless of GPU
		// gating — it's a cheap CPU-only ring search, and its per-repeater
		// results (calibration_offset_m etc.) are valuable on their own
		// even without rendering a full calibrated coverage raster. Only
		// the raster itself (which goes through engine.Margins/GPU) is
		// gated.
		calibratedGpuOK := !cfg.calibratedRequiresGPU || engine.Available()
		if calibratedGpuOK && shouldComputeTier(m.Coverage.Calibrated) {
			tierStart := time.Now()
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
				recordTier("calibrated", tierStart, err)
				return err
			}
			recordTier("calibrated", tierStart, nil)
		} else if !calibratedGpuOK {
			log.Printf("coverage: coverage.calibrated_requires_gpu=true but no GPU (local or remote) is available — skipping calibrated coverage raster")
		} else {
			log.Printf("coverage: calibrated coverage raster already computed today (%s) — skipping recompute (pass -force-all-tiers to override)", m.Coverage.Calibrated.GeneratedAt)
		}

		// grid's last use was the calibrated raster just above — release its
		// (mmap-backed, but still actively touched while in use) memory
		// before loading the much bigger precision grid below, rather than
		// letting both be resident at once for the rest of the run.
		grid.Close()

		precisionGpuOK := !cfg.precisionRequiresGPU || engine.Available()
		calibratedPrecisionGpuOK := !cfg.calibratedPrecisionRequiresGPU || engine.Available()
		// Folds the same-day freshness check in here too (not just the GPU
		// gate) — so when both precision tiers already ran today, the
		// entire high-resolution terrain fetch below is skipped as well,
		// not just the raster compute itself. This is the expensive case
		// the whole shouldComputeTier mechanism exists for.
		precisionAllowed := precisionGpuOK && shouldComputeTier(m.Coverage.Precision)
		calibratedPrecisionAllowed := calibratedPrecisionGpuOK && shouldComputeTier(m.Coverage.CalibratedPrecision)

		if !precisionGpuOK {
			log.Printf("coverage: coverage.precision_requires_gpu=true but no GPU (local or remote) is available — skipping precision coverage raster")
		} else if !precisionAllowed {
			log.Printf("coverage: precision coverage raster already computed today (%s) — skipping recompute (pass -force-all-tiers to override)", m.Coverage.Precision.GeneratedAt)
		}
		if !calibratedPrecisionGpuOK {
			log.Printf("coverage: coverage.calibrated_precision_requires_gpu=true but no GPU (local or remote) is available — skipping calibrated precision coverage raster")
		} else if !calibratedPrecisionAllowed {
			log.Printf("coverage: calibrated precision coverage raster already computed today (%s) — skipping recompute (pass -force-all-tiers to override)", m.Coverage.CalibratedPrecision.GeneratedAt)
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
				tierStart := time.Now()
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
					recordTier("precision", tierStart, err)
					return err
				}
				precisionImg := &imageResult{raster: precisionRaster, bounds: bounds}
				if err := writeTier("coverage-precision", precisionImg,
					"Same model and reported positions as Standard, rendered at a much higher pixel resolution for a sharper result.",
					func(cm *coverageMeta) { m.Coverage.Precision = cm }); err != nil {
					siteGrid.Close()
					prog.Update("error", 0, 0, err.Error())
					recordTier("precision", tierStart, err)
					return err
				}
				recordTier("precision", tierStart, nil)
			}

			if calibratedPrecisionAllowed {
				tierStart := time.Now()
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
					recordTier("calibrated_precision", tierStart, err)
					return err
				}
				calibratedPrecisionImg := &imageResult{raster: calibratedPrecisionRaster, bounds: bounds}
				if err := writeTier("coverage-calibrated-precision", calibratedPrecisionImg,
					"Same model and calibrated positions as Calibrated, rendered at a much higher pixel resolution for a sharper result.",
					func(cm *coverageMeta) { m.Coverage.CalibratedPrecision = cm }); err != nil {
					prog.Update("error", 0, 0, err.Error())
					recordTier("calibrated_precision", tierStart, err)
					return err
				}
				recordTier("calibrated_precision", tierStart, nil)
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
