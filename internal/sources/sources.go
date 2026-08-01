// Package sources builds the configured observation backend.
//
// It lives apart from meshsource because the adapters depend on that package
// for the canonical types — a factory inside it would be an import cycle.
package sources

import (
	"fmt"
	"net/http"
	"time"

	"hopreach/internal/beacon"
	"hopreach/internal/config"
	"hopreach/internal/corescope"
	"hopreach/internal/meshsource"
)

// FromConfig builds the configured observation backend.
//
// CoreScope remains the default; a Beacon block with `enabled: true` replaces
// it. Selection is deliberately explicit rather than "whichever URL is set",
// so a half-filled config can't silently swap the data underneath a map.
func FromConfig(cfg config.Config) (meshsource.Source, error) {
	if cfg.Beacon.Enabled {
		timeout := time.Duration(cfg.Beacon.RequestTimeoutSeconds * float64(time.Second))
		if timeout <= 0 {
			timeout = 30 * time.Second
		}
		c, err := beacon.New(
			cfg.Beacon.APIURL,
			cfg.Beacon.IATAs,
			&http.Client{Timeout: timeout},
		)
		if err != nil {
			// Refuse to start rather than fall back to CoreScope: silently
			// serving a different network's data is worse than not starting.
			return nil, fmt.Errorf("beacon data source: %w", err)
		}
		c.DetailConcurrency = cfg.Beacon.DetailConcurrency
		return c, nil
	}

	timeout := time.Duration(cfg.CoreScope.RequestTimeoutSeconds * float64(time.Second))
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return meshsource.NewCoreScopeSource(
		corescope.NewClient(cfg.CoreScope.APIURL, &http.Client{Timeout: timeout}),
	), nil
}
