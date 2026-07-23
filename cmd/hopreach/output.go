package main

import (
	"encoding/json"
	"image"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hopreach/internal/calibration"
	"hopreach/internal/corescope"
	"hopreach/internal/coverage"
	"hopreach/internal/propagation"
)

func classifyStatus(lastHeard *string, cfg appConfig) string {
	if lastHeard == nil {
		return "silent"
	}
	t, err := time.Parse(time.RFC3339, *lastHeard)
	if err != nil {
		return "silent"
	}
	age := time.Since(t)
	switch {
	case age <= time.Duration(cfg.activeHours*float64(time.Hour)):
		return "active"
	case age <= time.Duration(cfg.degradedHours*float64(time.Hour)):
		return "degraded"
	default:
		return "silent"
	}
}

type feature struct {
	Type       string         `json:"type"`
	Geometry   geometry       `json:"geometry"`
	Properties map[string]any `json:"properties"`
}

type geometry struct {
	Type        string    `json:"type"`
	Coordinates []float64 `json:"coordinates"`
}

type featureCollection struct {
	Type     string    `json:"type"`
	Features []feature `json:"features"`
}

// buildFeatures builds the repeater GeoJSON. calResults, if non-nil, must be
// parallel to nodes/sites (one calibration.Result per repeater, as produced
// by calibration.Position) and adds calibrated_lat/lon plus offset/score
// properties for the frontend's Standard/Calibrated dropdown; nil (the
// default, calibration disabled) omits those properties entirely.
// inferredScopes (pubkey, lowercase -> channel name), if non-nil, adds
// inferred_scope wherever a repeater has one — see inferRepeaterScopes.
func buildFeatures(nodes []corescope.Node, sites []propagation.Site, calResults []calibration.Result, inferredScopes map[string]string, cfg appConfig) []feature {
	features := make([]feature, 0, len(nodes))
	for i, n := range nodes {
		name := "Unnamed repeater"
		if n.Name != nil && *n.Name != "" {
			name = *n.Name
		}
		props := map[string]any{
			"name": name,
			// Full key (not truncated): CoreScope's public keys are
			// already exposed openly by its own API, and the planning
			// tools need the full key to query /api/nodes/:pubkey/reach
			// for real observed neighbour data.
			"public_key":      n.PublicKey,
			"status":          classifyStatus(n.LastHeard, cfg),
			"last_heard":      n.LastHeard,
			"first_seen":      n.FirstSeen,
			"advert_count":    n.AdvertCount,
			"relay_count_1h":  n.RelayCount1h,
			"relay_count_24h": n.RelayCount24h,
			"hash_size":       n.HashSize,
			"elevation_m":     round1(sites[i].GroundM),
			// Powers the map's client-side scope filter checkboxes
			// (public/app.js) — not used for server-side filtering
			// unless REQUIRED_SCOPE is also set.
			"default_scope": n.DefaultScope,
		}
		if scope, ok := inferredScopes[strings.ToLower(n.PublicKey)]; ok {
			// Which channel this repeater actually relays most, observed
			// from real traffic — see corescope.ScopeInference. Distinct
			// from default_scope (self-reported, sparse in practice) —
			// shown alongside it in the frontend popup, not merged, since
			// they can legitimately disagree and that's itself useful
			// information.
			props["inferred_scope"] = scope
		}
		if calResults != nil {
			cr := calResults[i]
			props["calibrated_lat"] = cr.Lat
			props["calibrated_lon"] = cr.Lon
			props["calibration_offset_m"] = round1(cr.OffsetM)
			props["calibration_score_before"] = round1(cr.ScoreBefore)
			props["calibration_score_after"] = round1(cr.ScoreAfter)
			props["calibrated"] = cr.Calibrated
		}
		features = append(features, feature{
			Type: "Feature",
			Geometry: geometry{
				Type:        "Point",
				Coordinates: []float64{*n.Lon, *n.Lat},
			},
			Properties: props,
		})
	}
	return features
}

// round1 rounds f to one decimal place. Uses math.Round (rather than the
// int(f*10+0.5)/10 idiom, which truncates incorrectly for negative numbers,
// e.g. int(-0.05*10+0.5) = int(0) = 0 instead of rounding to -0.1) so it
// behaves symmetrically for both signs — relevant here since offsets/scores
// can be negative.
func round1(f float64) float64 {
	return math.Round(f*10) / 10
}

type coverageMeta struct {
	Tiles        []coverage.Tile `json:"tiles"`
	FrequencyMHz float64         `json:"frequency_mhz"`
	MaxSearchKm  float64         `json:"max_search_range_km"`
	DEMZoom      int             `json:"dem_zoom_level"`
	Assumptions  coverageAssumps `json:"assumptions"`
}

type coverageAssumps struct {
	TxPowerDBm      float64 `json:"tx_power_dbm"`
	TxAntennaGainDB float64 `json:"tx_antenna_gain_dbi"`
	RxAntennaGainDB float64 `json:"rx_antenna_gain_dbi"`
	RxSensitivityDB float64 `json:"rx_sensitivity_dbm"`
	FadeMarginDB    float64 `json:"fade_margin_db"`
	AntennaHeightM  float64 `json:"antenna_height_m"`
	RxHeightM       float64 `json:"rx_height_m"`
	Note            string  `json:"note"`
}

func buildCoverageMeta(tiles []coverage.Tile, rangeKm float64, cfg appConfig, note string) coverageMeta {
	return coverageMeta{
		Tiles:        tiles,
		FrequencyMHz: cfg.propagation.FrequencyMHz,
		MaxSearchKm:  rangeKm,
		DEMZoom:      cfg.demZoom,
		Assumptions: coverageAssumps{
			TxPowerDBm:      cfg.propagation.TxPowerDBm,
			TxAntennaGainDB: cfg.propagation.TxAntennaGainDB,
			RxAntennaGainDB: cfg.propagation.RxAntennaGainDB,
			RxSensitivityDB: cfg.propagation.RxSensitivityDB,
			FadeMarginDB:    cfg.propagation.FadeMarginDB,
			AntennaHeightM:  cfg.propagation.AntennaHeightM,
			RxHeightM:       cfg.propagation.RxHeightM,
			Note:            note,
		},
	}
}

// coverageOutputs holds the standard (self-reported positions) coverage
// raster and, when ENABLE_POSITION_CALIBRATION is on, a second raster
// computed from calibrated positions. The frontend's Standard/Calibrated
// dropdown is hidden entirely when Calibrated is nil.
type coverageOutputs struct {
	Standard            *coverageMeta `json:"standard,omitempty"`
	Calibrated          *coverageMeta `json:"calibrated,omitempty"`
	Precision           *coverageMeta `json:"precision,omitempty"`
	CalibratedPrecision *coverageMeta `json:"calibrated_precision,omitempty"`
}

type meta struct {
	GeneratedAt           string           `json:"generated_at"`
	Source                string           `json:"source"`
	Boundary              string           `json:"boundary"`
	RequiredScope         string           `json:"required_scope"`
	TotalRepeatersFetched int              `json:"total_repeaters_fetched"`
	RepeatersInRegion     int              `json:"repeaters_in_region"`
	Counts                map[string]int   `json:"counts"`
	Coverage              *coverageOutputs `json:"coverage,omitempty"`
	// Complete is false from the moment meta.json is first written (before
	// any raster) until run() reaches its very end successfully — see
	// lastGeneratedAt. Left false (the zero value) if the process dies
	// partway through (crash, OOM, kill) instead of only ever being
	// overwritten by a later, complete run.
	Complete bool `json:"complete"`
	// Version is this binary's own buildinfo.Version — "dev" outside a
	// real release build. Shown in the frontend footer so it's always
	// obvious at a glance which release actually generated the data on
	// screen.
	Version string `json:"version"`
}

func writeJSONFile(path string, v any) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	if err := enc.Encode(v); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// lastGeneratedAt reads the existing meta.json's generated_at timestamp, if
// it reflects a *complete* run — absent (ok=false) on a genuine first run,
// if it's missing/unparseable for any reason, or if the last run never
// reached its own end (Complete is only ever set true right before run()
// returns successfully — see meta.Complete). That last case matters: this
// process's own meta.json is written early, before any raster, so it can
// show the repeater list immediately — a run that then crashes partway
// through (an OOM, a kill, any other abrupt exit) leaves a *recent* but
// *incomplete* meta.json behind. Without this check, the next container
// start would see that recent timestamp, believe a full render just
// happened, and skip retrying — leaving stale/partial coverage data live
// until the next scheduled interval or a manual -force, exactly the
// scenario this project hit in production (several crashed runs in a row
// while chasing GPU OOM/dispatch bugs). The caller should just proceed
// with a full run whenever this returns ok=false, regardless of age.
func lastGeneratedAt(outputDir string) (time.Time, bool) {
	data, err := os.ReadFile(filepath.Join(outputDir, "meta.json"))
	if err != nil {
		return time.Time{}, false
	}
	var m struct {
		GeneratedAt string `json:"generated_at"`
		Complete    bool   `json:"complete"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return time.Time{}, false
	}
	if !m.Complete {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, m.GeneratedAt)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// previousCoverage reads whatever coverage tiles the last run wrote (if
// any) — used to seed a fresh run's own meta.json before any tier in *this*
// run has been recomputed, so a visitor loading the page mid-run still sees
// the last real coverage instead of nothing, right up until each tier's own
// writeTier call replaces it. Unlike lastGeneratedAt, this deliberately does
// NOT check Complete: even a previous run that crashed partway through can
// have left real, valid tiles on disk for whichever tiers it did finish
// before failing, and those PNG files are still genuinely there, untouched,
// regardless of whether the run that made them ever reached its own end.
func previousCoverage(outputDir string) *coverageOutputs {
	data, err := os.ReadFile(filepath.Join(outputDir, "meta.json"))
	if err != nil {
		return nil
	}
	var m struct {
		Coverage *coverageOutputs `json:"coverage"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return nil
	}
	return m.Coverage
}

type imageResult struct {
	raster *image.NRGBA
	bounds propagation.Bounds
}
