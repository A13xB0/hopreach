package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDefaultIsValid(t *testing.T) {
	if err := Default().Validate(); err != nil {
		t.Fatalf("Default() should validate cleanly: %v", err)
	}
}

func TestDefaultSpotChecks(t *testing.T) {
	d := Default()
	if d.GPU.Mode != "auto" {
		t.Errorf("GPU.Mode = %q, want auto", d.GPU.Mode)
	}
	if d.Coverage.ImageWidth <= 0 {
		t.Errorf("Coverage.ImageWidth = %d, want positive", d.Coverage.ImageWidth)
	}
	if d.CoreScope.APIURL == "" {
		t.Error("CoreScope.APIURL should have a default")
	}
	if d.Region.BoundaryPath != "" || d.Region.BoundaryURL != "" {
		t.Error("Region boundary_path/boundary_url should default empty (embedded Scotland boundary)")
	}
}

func TestLoadMissingDefaultPathUsesDefaults(t *testing.T) {
	t.Setenv(EnvVar, "")
	dir := t.TempDir()
	old, _ := os.Getwd()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(old)

	// No config.yaml in dir, and no -config/-env override — should fall
	// back to Default() with no error (a fresh checkout is expected to
	// look like this).
	cfg, path, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if path != DefaultPath {
		t.Errorf("path = %q, want %q", path, DefaultPath)
	}
	if cfg.CoreScope.APIURL != Default().CoreScope.APIURL {
		t.Errorf("expected default config, got %+v", cfg)
	}
}

func TestLoadExplicitMissingPathIsFatal(t *testing.T) {
	t.Setenv(EnvVar, "")
	_, _, err := Load(filepath.Join(t.TempDir(), "does-not-exist.yaml"))
	if err == nil {
		t.Fatal("expected an error for an explicitly-requested missing config file")
	}
}

func TestLoadOverridesOnTopOfDefaults(t *testing.T) {
	t.Setenv(EnvVar, "")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	yaml := `
site:
  name: "Test Site"
region:
  name: "Test Region"
  required_scope: "sco"
coverage:
  image_width: 123
gpu:
  mode: cpu
`
	if err := os.WriteFile(path, []byte(yaml), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, gotPath, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if gotPath != path {
		t.Errorf("path = %q, want %q", gotPath, path)
	}
	if cfg.Site.Name != "Test Site" {
		t.Errorf("Site.Name = %q, want %q", cfg.Site.Name, "Test Site")
	}
	if cfg.Region.RequiredScope != "sco" {
		t.Errorf("Region.RequiredScope = %q, want %q", cfg.Region.RequiredScope, "sco")
	}
	if cfg.Coverage.ImageWidth != 123 {
		t.Errorf("Coverage.ImageWidth = %d, want 123", cfg.Coverage.ImageWidth)
	}
	if cfg.GPU.Mode != "cpu" {
		t.Errorf("GPU.Mode = %q, want cpu", cfg.GPU.Mode)
	}
	// Fields not present in the override YAML should keep their defaults.
	if cfg.Site.Subtitle != Default().Site.Subtitle {
		t.Errorf("Site.Subtitle = %q, want default %q", cfg.Site.Subtitle, Default().Site.Subtitle)
	}
	if cfg.Coverage.PrecisionWidth != Default().Coverage.PrecisionWidth {
		t.Errorf("Coverage.PrecisionWidth = %d, want default %d", cfg.Coverage.PrecisionWidth, Default().Coverage.PrecisionWidth)
	}
}

func TestLoadEnvVarPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "from-env.yaml")
	if err := os.WriteFile(path, []byte("site:\n  name: \"From Env\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvVar, path)

	cfg, gotPath, err := Load("") // no -config flag — should fall back to $HOPREACH_CONFIG
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if gotPath != path {
		t.Errorf("path = %q, want %q", gotPath, path)
	}
	if cfg.Site.Name != "From Env" {
		t.Errorf("Site.Name = %q, want %q", cfg.Site.Name, "From Env")
	}
}

func TestLoadInvalidYAML(t *testing.T) {
	t.Setenv(EnvVar, "")
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("not: valid: yaml: [["), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Load(path); err == nil {
		t.Fatal("expected an error for malformed YAML")
	}
}

func TestValidate(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(*Config)
		wantErr bool
	}{
		{"valid default", func(c *Config) {}, false},
		{"empty output_dir", func(c *Config) { c.OutputDir = "" }, true},
		{"empty api_url", func(c *Config) { c.CoreScope.APIURL = "" }, true},
		{"non-positive image_width", func(c *Config) { c.Coverage.ImageWidth = 0 }, true},
		{"non-positive precision_width", func(c *Config) { c.Coverage.PrecisionWidth = -1 }, true},
		{"invalid gpu.mode", func(c *Config) { c.GPU.Mode = "turbo" }, true},
		{"scope_inference enabled with non-positive window_hours", func(c *Config) {
			c.CoreScope.ScopeInference.Enabled = true
			c.CoreScope.ScopeInference.WindowHours = 0
		}, true},
		{"scope_inference disabled with non-positive window_hours is fine", func(c *Config) {
			c.CoreScope.ScopeInference.Enabled = false
			c.CoreScope.ScopeInference.WindowHours = 0
		}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := Default()
			tc.mutate(&cfg)
			err := cfg.Validate()
			if tc.wantErr && err == nil {
				t.Error("expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Errorf("expected no error, got %v", err)
			}
		})
	}
}
