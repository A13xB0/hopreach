package main

import (
	"fmt"
	"strings"
	"time"

	"hopreach/internal/calibration"
	yconfig "hopreach/internal/config"
	"hopreach/internal/propagation"
)

type appConfig struct {
	apiURL        string
	activeHours   float64
	degradedHours float64
	outputDir     string
	timeout       time.Duration

	// requiredScope, if non-empty, restricts results to nodes whose
	// default_scope matches "#"+requiredScope. Empty disables this filter.
	requiredScope string

	// regionBoundaryPath/regionBoundaryURL configure geo.LoadBoundary — a
	// local file, a downloaded GeoJSON, or (both empty, the default) the
	// embedded Scotland boundary. regionBoundaryLabel is what's written to
	// meta.json's "boundary" field describing whichever of those was used.
	regionBoundaryPath  string
	regionBoundaryURL   string
	regionBoundaryLabel string

	demZoom        int
	demCacheDir    string
	demTileURLBase string

	propagation propagation.Params

	coverageImageWidth           int
	coveragePrecisionWidth       int
	coveragePrecisionDemZoom     int
	coveragePrecisionSupersample int
	coverageMaxAlpha             uint8

	// coveragePrecisionChunkBudgetMB overrides compute.Engine's automatic
	// per-tile memory budget for the chunked Precision/Calibrated Precision
	// tiers — see compute.Engine.SetChunkBudgetBytes. 0 (the default) means
	// "auto-size from real available memory", which is right for almost
	// every deployment.
	coveragePrecisionChunkBudgetMB int

	// "auto" (default): use the GPU if a compatible Vulkan device is found
	// and its output verifies against the CPU path, otherwise CPU. "cpu":
	// skip the GPU probe entirely. "gpu": force GPU, hard error instead of
	// falling back if it's unavailable or fails verification. See
	// internal/compute.
	gpuMode string

	// gpuBrokerAddr, if set, points at the local hopreach-shareapi process's
	// GPU broker routes (e.g. "127.0.0.1:8081") — enables the remote-GPU
	// dispatch path in compute.Engine for a VPS with no GPU of its own but a
	// connected remote worker. Empty disables the whole feature (the
	// default): no attempt is ever made to reach a broker that was never
	// configured.
	gpuBrokerAddr string

	// Per-tier GPU gating: when true, that tier is skipped entirely
	// (omitted from meta.json, same as an always-optional tier like
	// Calibrated) unless a GPU — local or a connected remote worker — is
	// available. All default false (nothing changes for anyone who
	// doesn't set these) — but Precision/Calibrated Precision are exactly
	// the tiers a low-powered, GPU-less VPS shouldn't attempt on CPU.
	standardRequiresGPU            bool
	calibratedRequiresGPU          bool
	precisionRequiresGPU           bool
	calibratedPrecisionRequiresGPU bool

	calibration calibration.Config

	// minRecomputeIntervalHours/forceRecompute: run() skips the whole
	// fetch+compute pipeline entirely if the last successful run (per the
	// existing meta.json's generated_at) is younger than this — every
	// container restart shouldn't re-run a multi-minute (or, at Precision
	// zoom, much longer) computation that only just finished, e.g. during
	// iterative debugging. The real cron schedule (config.yaml's
	// schedule.cron, rendered by -prepare, not this Go binary) still fires
	// on its own terms; this is a separate, additional guard specifically
	// against redundant *startup* runs. The -force flag bypasses it
	// outright.
	minRecomputeIntervalHours float64
	forceRecompute            bool
}

// toAppConfig maps the YAML config schema onto the subset of fields run()
// and output.go actually need — kept as a separate, narrower struct (rather
// than passing yconfig.Config straight through) so those files don't need
// to know about config sections (site/schedule/share/...) that are none of
// their concern.
func toAppConfig(yc yconfig.Config) appConfig {
	return appConfig{
		apiURL:        yc.CoreScope.APIURL,
		activeHours:   yc.Site.ActiveHours,
		degradedHours: yc.Site.DegradedHours,
		outputDir:     yc.OutputDir,
		timeout:       time.Duration(yc.CoreScope.RequestTimeoutSeconds * float64(time.Second)),

		requiredScope: strings.TrimPrefix(yc.Region.RequiredScope, "#"),

		regionBoundaryPath:  yc.Region.BoundaryPath,
		regionBoundaryURL:   yc.Region.BoundaryURL,
		regionBoundaryLabel: regionBoundaryLabel(yc.Region),

		demZoom:        yc.Terrain.DEMZoom,
		demCacheDir:    yc.Terrain.DEMCacheDir,
		demTileURLBase: yc.Terrain.DEMTileURLBase,

		propagation: propagation.Params{
			FrequencyMHz:    yc.Propagation.FrequencyMHz,
			TxPowerDBm:      yc.Propagation.TxPowerDBm,
			TxAntennaGainDB: yc.Propagation.TxAntennaGainDB,
			RxAntennaGainDB: yc.Propagation.RxAntennaGainDB,
			RxSensitivityDB: yc.Propagation.RxSensitivityDB,
			FadeMarginDB:    yc.Propagation.FadeMarginDB,
			AntennaHeightM:  yc.Propagation.AntennaHeightM,
			RxHeightM:       yc.Propagation.RxHeightM,
			MaxRangeKm:      yc.Propagation.MaxRangeKm,
			MarginGreenDB:   yc.Propagation.MarginGreenDB,
		},

		coverageImageWidth:             yc.Coverage.ImageWidth,
		coveragePrecisionWidth:         yc.Coverage.PrecisionWidth,
		coveragePrecisionDemZoom:       yc.Coverage.PrecisionDEMZoom,
		coveragePrecisionSupersample:   yc.Coverage.PrecisionSupersample,
		coverageMaxAlpha:               uint8(yc.Coverage.MaxAlpha),
		coveragePrecisionChunkBudgetMB: yc.Coverage.PrecisionChunkBudgetMB,

		gpuMode:       yc.GPU.Mode,
		gpuBrokerAddr: yc.GPU.Remote.BrokerAddr,

		standardRequiresGPU:            yc.Coverage.StandardRequiresGPU,
		calibratedRequiresGPU:          yc.Coverage.CalibratedRequiresGPU,
		precisionRequiresGPU:           yc.Coverage.PrecisionRequiresGPU,
		calibratedPrecisionRequiresGPU: yc.Coverage.CalibratedPrecisionRequiresGPU,

		calibration: calibration.Config{
			MinLinks:          yc.Calibration.MinLinks,
			NeedsScore:        yc.Calibration.NeedsScore,
			MaxOffsetM:        yc.Calibration.MaxOffsetM,
			MinImprovementPct: yc.Calibration.MinImprovementPct,
			ReachDays:         yc.Calibration.ReachDays,
		},

		minRecomputeIntervalHours: yc.Coverage.MinRecomputeIntervalHours,
	}
}

// regionBoundaryLabel describes which boundary a run used, for meta.json's
// "boundary" field. An explicit region.name always wins; otherwise it
// describes the boundary_path/boundary_url source, falling back to the
// built-in default's own description when neither is configured.
func regionBoundaryLabel(r yconfig.RegionConfig) string {
	if r.Name != "" {
		return r.Name
	}
	switch {
	case r.BoundaryPath != "":
		return fmt.Sprintf("Custom region (local file: %s)", r.BoundaryPath)
	case r.BoundaryURL != "":
		return fmt.Sprintf("Custom region (downloaded: %s)", r.BoundaryURL)
	default:
		return "Scotland (ADM1, geoBoundaries.org / Eurostat-GISCO, CC BY 4.0)"
	}
}
