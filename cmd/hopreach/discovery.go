package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"hopreach/internal/buildinfo"
	yconfig "hopreach/internal/config"
)

// discoveryPath is where an instance identifies itself, under the
// RFC 8615 well-known prefix, so HopReach deployments can be found and
// confirmed without scraping the page: fetch /.well-known/hopreach.json
// and check "software". Pairs with the <meta name="generator"> tag in
// public/index.html, which is what search engines index.
const discoveryPath = ".well-known/hopreach.json"

// sourceRepo is where the software lives — the same link the map's
// attribution carries.
const sourceRepo = "https://github.com/A13xB0/hopreach"

// discoveryDoc is public by design: only what the page already shows.
// "schema" lets the shape change later without breaking readers.
type discoveryDoc struct {
	Schema   int    `json:"schema"`
	Software string `json:"software"`
	Version  string `json:"version"`
	Source   string `json:"source"`
	Name     string `json:"name"`
	Subtitle string `json:"subtitle"`
	HomeURL  string `json:"home_url,omitempty"`
	Backend  string `json:"backend"`
	Map      struct {
		Center []float64 `json:"center"`
		Zoom   int       `json:"zoom"`
	} `json:"map"`
}

func buildDiscovery(yc yconfig.Config) discoveryDoc {
	d := discoveryDoc{
		Schema:   1,
		Software: "HopReach",
		Version:  buildinfo.Version,
		Source:   sourceRepo,
		Name:     yc.Site.Name,
		Subtitle: yc.Site.Subtitle,
		HomeURL:  yc.Site.HomeURL,
		Backend:  yc.Source.Type,
	}
	if d.Backend == "" {
		d.Backend = "corescope" // see config.SourceConfig.Type
	}
	d.Map.Center = []float64{yc.Map.CenterLat, yc.Map.CenterLon}
	d.Map.Zoom = yc.Map.Zoom
	return d
}

func writeDiscovery(yc yconfig.Config, root string) error {
	body, err := json.MarshalIndent(buildDiscovery(yc), "", "  ")
	if err != nil {
		return err
	}
	dst := filepath.Join(root, discoveryPath)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	return os.WriteFile(dst, append(body, '\n'), 0o644)
}
