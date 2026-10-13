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

func TestDiscoveryDefaultsBackendAndOmitsEmptyHomeURL(t *testing.T) {
	d := buildDiscovery(yconfig.Default())
	if d.Backend != "corescope" {
		t.Errorf("backend = %q, want corescope (the unset default)", d.Backend)
	}
	raw, _ := json.Marshal(d)
	var m map[string]any
	json.Unmarshal(raw, &m)
	if _, ok := m["home_url"]; ok {
		t.Error("home_url should be omitted when unset")
	}
}
