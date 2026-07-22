package main

import (
	"encoding/json"
	"fmt"
	"os"
	"text/template"

	yconfig "hopreach/internal/config"
)

// These paths are container-internal plumbing, not user configuration —
// they mirror nginx/cron's own fixed layout inside the image, set up by
// Dockerfile, and have no meaning for a non-containerized run (which never
// passes -prepare).
const (
	configJSPath      = "/usr/share/nginx/html/config.js"
	nginxConfTemplate = "/etc/nginx/conf.d/default.conf.template"
	nginxConfOut      = "/etc/nginx/conf.d/default.conf"
	cronFilePath      = "/etc/cron.d/hopreach"
)

// runPrepare renders every file the container needs at startup but that
// depends on config.yaml — replacing the old envsubst-based templating with
// plain Go, now that config.yaml (not four dozen env vars) is what actually
// holds these values. configPath is embedded in the cron file so the cron
// daemon's child processes (which don't inherit the container's own
// environment) know where to find it.
func runPrepare(yc yconfig.Config, configPath string) error {
	if err := writeConfigJS(yc); err != nil {
		return fmt.Errorf("config.js: %w", err)
	}
	if err := writeNginxConf(yc); err != nil {
		return fmt.Errorf("nginx config: %w", err)
	}
	if err := writeCronFile(yc, configPath); err != nil {
		return fmt.Errorf("cron file: %w", err)
	}
	return nil
}

// jsConfig mirrors window.HOPREACH_CONFIG's shape (see public/config.js,
// the local-development copy of this same structure) — built and
// json.Marshal'd rather than text-templated, so site names/subtitles with
// quotes or other special characters are always encoded safely.
type jsConfig struct {
	SiteName        string    `json:"siteName"`
	SiteSubtitle    string    `json:"siteSubtitle"`
	MapCenter       []float64 `json:"mapCenter"`
	MapZoom         int       `json:"mapZoom"`
	DataURL         string    `json:"dataUrl"`
	MetaURL         string    `json:"metaUrl"`
	MapScopeFilters []string  `json:"mapScopeFilters"`
	DemZoom         int       `json:"demZoom"`
	DemTileURLBase  string    `json:"demTileURLBase"`
	Propagation     struct {
		FrequencyMhz     float64 `json:"frequencyMhz"`
		TxPowerDbm       float64 `json:"txPowerDbm"`
		TxAntennaGainDbi float64 `json:"txAntennaGainDbi"`
		RxAntennaGainDbi float64 `json:"rxAntennaGainDbi"`
		RxSensitivityDbm float64 `json:"rxSensitivityDbm"`
		FadeMarginDb     float64 `json:"fadeMarginDb"`
		AntennaHeightM   float64 `json:"antennaHeightM"`
		RxHeightM        float64 `json:"rxHeightM"`
		MaxRangeKm       float64 `json:"maxRangeKm"`
		MarginGreenDb    float64 `json:"marginGreenDb"`
	} `json:"propagation"`
}

func writeConfigJS(yc yconfig.Config) error {
	var c jsConfig
	c.SiteName = yc.Site.Name
	c.SiteSubtitle = yc.Site.Subtitle
	c.MapCenter = []float64{yc.Map.CenterLat, yc.Map.CenterLon}
	c.MapZoom = yc.Map.Zoom
	c.DataURL = "data/repeaters.geojson"
	c.MetaURL = "data/meta.json"
	c.MapScopeFilters = yc.Site.ScopeFilters
	c.DemZoom = yc.Terrain.DEMZoom
	// Always proxied same-origin through nginx (see nginxConfTemplate),
	// never the upstream tile host directly — see terrain.js for why
	// (CORS/canvas).
	c.DemTileURLBase = "/dem-tiles"
	c.Propagation.FrequencyMhz = yc.Propagation.FrequencyMHz
	c.Propagation.TxPowerDbm = yc.Propagation.TxPowerDBm
	c.Propagation.TxAntennaGainDbi = yc.Propagation.TxAntennaGainDB
	c.Propagation.RxAntennaGainDbi = yc.Propagation.RxAntennaGainDB
	c.Propagation.RxSensitivityDbm = yc.Propagation.RxSensitivityDB
	c.Propagation.FadeMarginDb = yc.Propagation.FadeMarginDB
	c.Propagation.AntennaHeightM = yc.Propagation.AntennaHeightM
	c.Propagation.RxHeightM = yc.Propagation.RxHeightM
	c.Propagation.MaxRangeKm = yc.Propagation.MaxRangeKm
	c.Propagation.MarginGreenDb = yc.Propagation.MarginGreenDB

	body, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	out := "// Generated at container startup by `hopreach -prepare` from config.yaml.\n" +
		"// See public/config.js for the local-development default.\n" +
		"window.HOPREACH_CONFIG = " + string(body) + ";\n"

	return os.WriteFile(configJSPath, []byte(out), 0o644)
}

// nginxTemplateData is the fields available to nginxConfTemplate.
type nginxTemplateData struct {
	CoreScopeAPIURL string
}

func writeNginxConf(yc yconfig.Config) error {
	tmplBytes, err := os.ReadFile(nginxConfTemplate)
	if err != nil {
		return err
	}
	tmpl, err := template.New("default.conf").Parse(string(tmplBytes))
	if err != nil {
		return fmt.Errorf("parsing %s: %w", nginxConfTemplate, err)
	}

	f, err := os.Create(nginxConfOut)
	if err != nil {
		return err
	}
	defer f.Close()

	return tmpl.Execute(f, nginxTemplateData{CoreScopeAPIURL: yc.CoreScope.APIURL})
}

func writeCronFile(yc yconfig.Config, configPath string) error {
	content := fmt.Sprintf(
		"HOPREACH_CONFIG=%s\n"+
			"%s root /app/hopreach >> /var/log/fetch.log 2>&1\n"+
			"17 4 * * * root /app/hopreach-shareapi -prune >> /var/log/prune.log 2>&1\n",
		configPath, yc.Schedule.Cron,
	)
	if err := os.WriteFile(cronFilePath, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Chmod(cronFilePath, 0o644)
}
