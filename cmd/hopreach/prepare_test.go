package main

import (
	"testing"

	yconfig "hopreach/internal/config"
)

func TestBuildJSConfigCarriesBranding(t *testing.T) {
	yc := yconfig.Default()
	yc.Site.HomeURL = "https://net.example/"
	c := buildJSConfig(yc, "site-logo.png")
	if c.LogoURL != "site-logo.png" || c.HomeURL != "https://net.example/" {
		t.Errorf("got logoUrl=%q homeUrl=%q", c.LogoURL, c.HomeURL)
	}
}
