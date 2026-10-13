package main

import (
	"os"
	"path/filepath"
	"testing"

	yconfig "hopreach/internal/config"
)

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

func TestInstallThemeCopiesTheConfiguredFile(t *testing.T) {
	root, src := t.TempDir(), filepath.Join(t.TempDir(), "theme.css")
	css := ":root { --bg: #111827; }\n"
	os.WriteFile(src, []byte(css), 0o644)

	if err := installTheme(src, root); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(root, themeFileName)); got != css {
		t.Errorf("site-theme.css = %q, want %q", got, css)
	}
}

func TestInstallThemeUnsetRemovesAPreviousTheme(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, themeFileName), []byte(":root{--bg:red}"), 0o644)

	if err := installTheme("", root); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, filepath.Join(root, themeFileName)); got != themePlaceholder {
		t.Errorf("site-theme.css = %q, want the placeholder", got)
	}
}

func TestInstallThemeMissingFileFallsBackAndReports(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, themeFileName), []byte(":root{--bg:red}"), 0o644)

	if err := installTheme(filepath.Join(root, "nope.css"), root); err == nil {
		t.Error("want an error for a missing theme file")
	}
	if got := readFile(t, filepath.Join(root, themeFileName)); got != themePlaceholder {
		t.Errorf("a missing theme must not leave the old one in place; got %q", got)
	}
}

func TestInstallLogoCopiesALocalFile(t *testing.T) {
	root, src := t.TempDir(), filepath.Join(t.TempDir(), "Brand.SVG")
	os.WriteFile(src, []byte("<svg/>"), 0o644)

	url, err := installLogo(src, root)
	if err != nil {
		t.Fatal(err)
	}
	if url != "site-logo.svg" {
		t.Errorf("url = %q, want site-logo.svg", url)
	}
	if got := readFile(t, filepath.Join(root, "site-logo.svg")); got != "<svg/>" {
		t.Errorf("copied logo = %q", got)
	}
}

func TestInstallLogoURLPassesThrough(t *testing.T) {
	url, err := installLogo("https://example.org/logo.svg", t.TempDir())
	if err != nil || url != "https://example.org/logo.svg" {
		t.Errorf("got (%q, %v)", url, err)
	}
}

func TestInstallLogoClearsAPreviousLogo(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "site-logo.png"), []byte("old"), 0o644)

	url, err := installLogo("", root)
	if err != nil || url != "" {
		t.Errorf("got (%q, %v), want no logo", url, err)
	}
	if _, err := os.Stat(filepath.Join(root, "site-logo.png")); !os.IsNotExist(err) {
		t.Error("the previous start's logo should be gone")
	}
}

func TestInstallLogoRejectsBadInput(t *testing.T) {
	root := t.TempDir()
	exe := filepath.Join(root, "logo.html")
	os.WriteFile(exe, []byte("<script>"), 0o644)
	for _, logo := range []string{exe, filepath.Join(root, "missing.png"), "javascript:alert(1)"} {
		url, err := installLogo(logo, root)
		if err == nil || url != "" {
			t.Errorf("installLogo(%q) = (%q, %v), want an error and no logo", logo, url, err)
		}
	}
}

func TestCheckHomeURL(t *testing.T) {
	for _, ok := range []string{"", "https://meshcore.example/", "http://x.example"} {
		if err := checkHomeURL(ok); err != nil {
			t.Errorf("checkHomeURL(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"javascript:alert(1)", "example.org"} {
		if err := checkHomeURL(bad); err == nil {
			t.Errorf("checkHomeURL(%q) should warn", bad)
		}
	}
}

func TestBuildJSConfigCarriesBranding(t *testing.T) {
	yc := yconfig.Default()
	yc.Site.HomeURL = "https://net.example/"
	c := buildJSConfig(yc, "site-logo.png")
	if c.LogoURL != "site-logo.png" || c.HomeURL != "https://net.example/" {
		t.Errorf("got logoUrl=%q homeUrl=%q", c.LogoURL, c.HomeURL)
	}
}
