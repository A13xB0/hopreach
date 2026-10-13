package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	yconfig "hopreach/internal/config"
)

func TestWriteDiscoveryIdentifiesTheInstance(t *testing.T) {
	root := t.TempDir()
	yc := yconfig.Default()
	yc.Site.Name = "Test Mesh"
	yc.Site.HomeURL = "https://mesh.example/"
	yc.Source.Type = "beacon"

	if err := writeDiscovery(yc, root); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(root, ".well-known", "hopreach.json"))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	want := map[string]any{
		"schema":   float64(1),
		"software": "HopReach",
		"name":     "Test Mesh",
		"home_url": "https://mesh.example/",
		"backend":  "beacon",
		"source":   sourceRepo,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if got["version"] == "" || got["version"] == nil {
		t.Error("version must be reported")
	}
}

// The manifest must name the backend the pipeline actually runs, so it
// goes through config.Resolve rather than reading source.type raw.
func TestDiscoveryBackendMatchesResolve(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*yconfig.Config)
		want   string
	}{
		{"unset defaults to corescope", func(c *yconfig.Config) {}, "corescope"},
		{"deprecated beacon.enabled alias", func(c *yconfig.Config) { c.Beacon.Enabled = true }, "beacon"},
		{"case and whitespace normalised", func(c *yconfig.Config) { c.Source.Type = " Beacon " }, "beacon"},
		{"unknown type is omitted, not guessed", func(c *yconfig.Config) { c.Source.Type = "mystery" }, ""},
	}
	for _, tc := range cases {
		yc := yconfig.Default()
		tc.mutate(&yc)
		if got := buildDiscovery(yc).Backend; got != tc.want {
			t.Errorf("%s: backend = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestDiscoveryOmitsEmptyHomeURL(t *testing.T) {
	d := buildDiscovery(yconfig.Default())
	raw, _ := json.Marshal(d)
	var m map[string]any
	json.Unmarshal(raw, &m)
	if _, ok := m["home_url"]; ok {
		t.Error("home_url should be omitted when unset")
	}
}
