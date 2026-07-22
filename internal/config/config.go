// Package config is HopReach's single source of runtime configuration: one
// YAML file, resolved from (in order) an explicit -config flag, the
// HOPREACH_CONFIG environment variable, or the default path "config.yaml".
// Every other setting — site branding, the coverage/propagation model, GPU
// gating, calibration, the remote-GPU-worker broker, and plan sharing — is
// read from that one file rather than scattered across dozens of env vars.
//
// A config file at an explicitly-requested path (flag or env) that doesn't
// exist is a fatal error — the operator pointed somewhere on purpose, and a
// silent fallback would hide a typo'd path. A config file missing only at
// the bare default path is not: that's the expected shape of a fresh local
// checkout, so Load logs a notice and proceeds with built-in defaults
// instead.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// Config is the full YAML schema. Every field has a sensible built-in
// default (see Default) — a user's config.yaml only needs to set the values
// they actually want to change.
type Config struct {
	// OutputDir is where repeaters.geojson, meta.json, progress.json, and
	// the coverage tile PNGs are written. In the Docker image this is
	// baked into the image's shipped config.yaml as an absolute path
	// (/usr/share/nginx/html/data) so nginx can serve it directly; for a
	// bare-metal/local run the default below is relative to the working
	// directory.
	OutputDir string `yaml:"output_dir"`

	Site        SiteConfig        `yaml:"site"`
	Map         MapConfig         `yaml:"map"`
	Region      RegionConfig      `yaml:"region"`
	CoreScope   CoreScopeConfig   `yaml:"corescope"`
	Terrain     TerrainConfig     `yaml:"terrain"`
	Propagation PropagationConfig `yaml:"propagation"`
	Coverage    CoverageConfig    `yaml:"coverage"`
	Calibration CalibrationConfig `yaml:"calibration"`
	GPU         GPUConfig         `yaml:"gpu"`
	Schedule    ScheduleConfig    `yaml:"schedule"`
	Share       ShareConfig       `yaml:"share"`

	// RemoteWorker configures cmd/hopreach-shareapi's GPU broker — the
	// bearer token a remote cmd/hopreach-gpuworker must present, and how
	// long to wait for a submitted job before giving up. Distinct from
	// GPU.Remote (below), which is how cmd/hopreach itself finds that
	// broker; RemoteWorker is the broker's own, server-side configuration.
	RemoteWorker RemoteWorkerConfig `yaml:"remote_worker"`
}

// SiteConfig controls the frontend's branding and the active/degraded/
// silent status thresholds shown for each repeater.
type SiteConfig struct {
	Name          string   `yaml:"name"`
	Subtitle      string   `yaml:"subtitle"`
	ActiveHours   float64  `yaml:"active_hours"`
	DegradedHours float64  `yaml:"degraded_hours"`
	ScopeFilters  []string `yaml:"scope_filters"`
}

// MapConfig is the frontend's initial map view.
type MapConfig struct {
	CenterLat float64 `yaml:"center_lat"`
	CenterLon float64 `yaml:"center_lon"`
	Zoom      int     `yaml:"zoom"`
}

// RegionConfig scopes which repeaters are included — both a geographic
// boundary (see internal/geo.LoadBoundary) and, optionally, a CoreScope
// scope tag.
type RegionConfig struct {
	// Name labels the region in meta.json's "boundary" field and (if
	// BoundaryPath/BoundaryURL are also set) is otherwise just cosmetic.
	// Empty (the default) describes the built-in Scotland boundary.
	Name string `yaml:"name"`

	// BoundaryPath, if set, loads the region boundary from a local GeoJSON
	// file (Feature, FeatureCollection, or bare Polygon/MultiPolygon
	// geometry) instead of the embedded Scotland default. Takes priority
	// over BoundaryURL if both are set.
	BoundaryPath string `yaml:"boundary_path"`

	// BoundaryURL, if set (and BoundaryPath is not), downloads the region
	// boundary from this URL instead of the embedded Scotland default —
	// e.g. a geoBoundaries.org gjDownloadURL for any other country/region.
	// Cached under terrain.dem_cache_dir/boundary after the first
	// successful download.
	BoundaryURL string `yaml:"boundary_url"`

	// RequiredScope, if non-empty, additionally restricts results to nodes
	// whose default_scope matches "#"+RequiredScope. Empty (the default)
	// keeps every repeater inside the boundary regardless of scope.
	RequiredScope string `yaml:"required_scope"`
}

// CoreScopeConfig points at the CoreScope instance to pull repeater nodes
// and reach data from.
type CoreScopeConfig struct {
	APIURL                string  `yaml:"api_url"`
	RequestTimeoutSeconds float64 `yaml:"request_timeout_seconds"`
}

// TerrainConfig controls elevation data fetching for the standard-tier
// coverage passes (Precision has its own separate DEM zoom, see
// CoverageConfig.PrecisionDEMZoom).
type TerrainConfig struct {
	DEMZoom        int    `yaml:"dem_zoom"`
	DEMCacheDir    string `yaml:"dem_cache_dir"`
	DEMTileURLBase string `yaml:"dem_tile_url_base"`
}

// PropagationConfig is the RF link-budget/terrain model, shared verbatim by
// the frontend's in-browser planning tools (see cmd/hopreach's -prepare
// mode, which mirrors this into config.js).
type PropagationConfig struct {
	FrequencyMHz    float64 `yaml:"frequency_mhz"`
	TxPowerDBm      float64 `yaml:"tx_power_dbm"`
	TxAntennaGainDB float64 `yaml:"tx_antenna_gain_dbi"`
	RxAntennaGainDB float64 `yaml:"rx_antenna_gain_dbi"`
	RxSensitivityDB float64 `yaml:"rx_sensitivity_dbm"`
	FadeMarginDB    float64 `yaml:"fade_margin_db"`
	AntennaHeightM  float64 `yaml:"antenna_height_m"`
	RxHeightM       float64 `yaml:"rx_height_m"`
	MaxRangeKm      float64 `yaml:"max_range_km"`
	MarginGreenDB   float64 `yaml:"margin_green_db"`
}

// CoverageConfig controls the four coverage-raster tiers (Standard,
// Calibrated, Precision, Calibrated Precision) and the per-tier GPU gating.
type CoverageConfig struct {
	ImageWidth           int `yaml:"image_width"`
	PrecisionWidth       int `yaml:"precision_width"`
	PrecisionDEMZoom     int `yaml:"precision_dem_zoom"`
	PrecisionSupersample int `yaml:"precision_supersample"`
	MaxAlpha             int `yaml:"max_alpha"`

	// MinRecomputeIntervalHours: run() skips the whole fetch+compute
	// pipeline entirely if the last successful run finished more recently
	// than this — see -force (cmd/hopreach's flag) to bypass it for one run.
	MinRecomputeIntervalHours float64 `yaml:"min_recompute_interval_hours"`

	StandardRequiresGPU            bool `yaml:"standard_requires_gpu"`
	CalibratedRequiresGPU          bool `yaml:"calibrated_requires_gpu"`
	PrecisionRequiresGPU           bool `yaml:"precision_requires_gpu"`
	CalibratedPrecisionRequiresGPU bool `yaml:"calibrated_precision_requires_gpu"`
}

// CalibrationConfig controls the position-calibration search — see
// internal/calibration for the scoring/search model itself.
type CalibrationConfig struct {
	MinLinks          int     `yaml:"min_links"`
	NeedsScore        float64 `yaml:"needs_score"`
	MaxOffsetM        float64 `yaml:"max_offset_m"`
	MinImprovementPct float64 `yaml:"min_improvement_pct"`
	ReachDays         int     `yaml:"reach_days"`
}

// GPUConfig controls local GPU compute and, optionally, dispatching to a
// remote GPU worker via cmd/hopreach-shareapi's broker.
type GPUConfig struct {
	// Mode is "auto" (use GPU if a compatible device verifies against CPU,
	// else CPU), "cpu" (skip the GPU probe entirely), or "gpu" (force GPU,
	// hard error instead of falling back).
	Mode   string          `yaml:"mode"`
	Remote GPURemoteConfig `yaml:"remote"`
}

// GPURemoteConfig is how cmd/hopreach finds the remote-GPU broker — the
// counterpart to RemoteWorkerConfig, which is the broker's own
// configuration.
type GPURemoteConfig struct {
	// BrokerAddr, if set, enables the remote-GPU dispatch path — normally
	// "127.0.0.1:8081", cmd/hopreach-shareapi's own listen address (the
	// same always-on process, just a different route). Empty (the default)
	// disables the whole feature.
	BrokerAddr string `yaml:"broker_addr"`
}

// ScheduleConfig controls cmd/hopreach's -prepare mode, which renders the
// cron file from this.
type ScheduleConfig struct {
	// Cron is a standard 5-field cron expression for the daily refresh job.
	Cron string `yaml:"cron"`
}

// ShareConfig controls cmd/hopreach-shareapi's plan-sharing store.
type ShareConfig struct {
	TTLDays    float64 `yaml:"ttl_days"`
	StoreDir   string  `yaml:"store_dir"`
	ListenAddr string  `yaml:"listen_addr"`
}

// RemoteWorkerConfig is cmd/hopreach-shareapi's GPU-broker-side
// configuration — see GPURemoteConfig for the client (cmd/hopreach) side.
type RemoteWorkerConfig struct {
	// Token is a real trust boundary, not a formality: the WebSocket
	// endpoint a worker connects to is reachable from the public internet
	// (nginx proxies it), and whoever holds this token can feed data into
	// the live public map. Empty (the default) disables the endpoint
	// entirely rather than defaulting to open.
	Token string `yaml:"token"`

	// JobTimeoutSeconds bounds how long the broker waits for a submitted
	// job's result before giving up and letting the caller fall back to
	// CPU. Generous by default — a large Precision-tier job on a worker
	// with a cold DEM tile cache can spend several minutes just fetching
	// tiles before GPU compute even starts.
	JobTimeoutSeconds float64 `yaml:"job_timeout_seconds"`
}

// Default returns the built-in defaults — identical to the values every
// env var defaulted to before HopReach moved to YAML config, except
// OutputDir/Terrain.DEMCacheDir/Share.StoreDir, which assume a local,
// non-containerized run; the Docker image ships its own config.yaml with
// container-correct absolute paths for those three.
func Default() Config {
	return Config{
		OutputDir: "public/data",
		Site: SiteConfig{
			Name:          "HopReach Coverage",
			Subtitle:      "MeshCore repeater map, refreshed daily",
			ActiveHours:   6,
			DegradedHours: 24,
			ScopeFilters:  []string{"sco", "ioi", "unscoped"},
		},
		Map: MapConfig{
			CenterLat: 56.8,
			CenterLon: -4.2,
			Zoom:      6,
		},
		Region: RegionConfig{
			RequiredScope: "",
		},
		CoreScope: CoreScopeConfig{
			APIURL:                "https://scotmesh-corescope.mm7roq.compute.oarc.uk",
			RequestTimeoutSeconds: 30,
		},
		Terrain: TerrainConfig{
			DEMZoom:        11,
			DEMCacheDir:    "dem-cache",
			DEMTileURLBase: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium",
		},
		Propagation: PropagationConfig{
			FrequencyMHz:    868,
			TxPowerDBm:      22,
			TxAntennaGainDB: 3,
			RxAntennaGainDB: 0,
			RxSensitivityDB: -124,
			FadeMarginDB:    20,
			AntennaHeightM:  1,
			RxHeightM:       2,
			MaxRangeKm:      100,
			MarginGreenDB:   15,
		},
		Coverage: CoverageConfig{
			ImageWidth:                     2000,
			PrecisionWidth:                 6000,
			PrecisionDEMZoom:               13,
			PrecisionSupersample:           2,
			MaxAlpha:                       190,
			MinRecomputeIntervalHours:      6,
			StandardRequiresGPU:            false,
			CalibratedRequiresGPU:          false,
			PrecisionRequiresGPU:           false,
			CalibratedPrecisionRequiresGPU: false,
		},
		Calibration: CalibrationConfig{
			MinLinks:          2,
			NeedsScore:        5,
			MaxOffsetM:        300,
			MinImprovementPct: 20,
			ReachDays:         14,
		},
		GPU: GPUConfig{
			Mode: "auto",
			Remote: GPURemoteConfig{
				BrokerAddr: "",
			},
		},
		Schedule: ScheduleConfig{
			Cron: "0 3 * * *",
		},
		Share: ShareConfig{
			TTLDays:    7,
			StoreDir:   "shared-plans",
			ListenAddr: "127.0.0.1:8081",
		},
		RemoteWorker: RemoteWorkerConfig{
			Token:             "",
			JobTimeoutSeconds: 1800,
		},
	}
}

// EnvVar is the environment variable Load checks for the config file path
// when no -config flag was given.
const EnvVar = "HOPREACH_CONFIG"

// DefaultPath is used when neither -config nor HOPREACH_CONFIG is set. A
// missing file at this bare default is not an error (see Load); the Docker
// image always sets HOPREACH_CONFIG explicitly, so this path is only ever
// actually used for a local/bare-metal run.
const DefaultPath = "config.yaml"

// resolvePath decides which config file path to use and whether it was
// explicitly requested (flag or env) as opposed to falling back to the bare
// default — Load treats a missing file differently in each case.
func resolvePath(flagVal string) (path string, explicit bool) {
	if flagVal != "" {
		return flagVal, true
	}
	if v := os.Getenv(EnvVar); v != "" {
		return v, true
	}
	return DefaultPath, false
}

// Load resolves the config file path (flagVal, then $HOPREACH_CONFIG, then
// DefaultPath), reads and parses it over top of Default(), validates the
// result, and returns it along with the path actually used. A missing file
// at an explicitly-requested path (flagVal or $HOPREACH_CONFIG) is a fatal
// error; missing only at the bare DefaultPath falls back to Default() with
// a logged notice.
func Load(flagVal string) (Config, string, error) {
	path, explicit := resolvePath(flagVal)

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) && !explicit {
			fmt.Printf("config: no config file at %q, using built-in defaults\n", path)
			return Default(), path, nil
		}
		return Config{}, path, fmt.Errorf("config: reading %s: %w", path, err)
	}

	cfg := Default()
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return Config{}, path, fmt.Errorf("config: parsing %s: %w", path, err)
	}

	if err := cfg.Validate(); err != nil {
		return Config{}, path, fmt.Errorf("config: %s: %w", path, err)
	}

	return cfg, path, nil
}

// Validate reports whether cfg is usable — deliberately light-touch (most
// fields are physical/business parameters with no wrong answer), catching
// only the handful of mistakes that would otherwise fail confusingly deep
// inside the pipeline (or, for GPU.Mode, silently do the wrong thing).
func (c Config) Validate() error {
	if c.OutputDir == "" {
		return fmt.Errorf("output_dir must not be empty")
	}
	if c.CoreScope.APIURL == "" {
		return fmt.Errorf("corescope.api_url must not be empty")
	}
	if c.Coverage.ImageWidth <= 0 {
		return fmt.Errorf("coverage.image_width must be positive")
	}
	if c.Coverage.PrecisionWidth <= 0 {
		return fmt.Errorf("coverage.precision_width must be positive")
	}
	switch c.GPU.Mode {
	case "auto", "cpu", "gpu":
	default:
		return fmt.Errorf("gpu.mode must be \"auto\", \"cpu\", or \"gpu\", got %q", c.GPU.Mode)
	}
	return nil
}
