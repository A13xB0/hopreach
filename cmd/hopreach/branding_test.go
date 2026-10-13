package main

import (
	"os"
	"path/filepath"
	"testing"
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
	// Accepted exactly as public/site-brand.js's safeUrl accepts them.
	for _, ok := range []string{"", "https://meshcore.example/", "http://x.example", "/", "../", "/about", "./map"} {
		if err := checkHomeURL(ok); err != nil {
			t.Errorf("checkHomeURL(%q) = %v, want no warning", ok, err)
		}
	}
	for _, bad := range []string{"javascript:alert(1)", "data:text/html,x", "example.org", "net.example/home"} {
		if err := checkHomeURL(bad); err == nil {
			t.Errorf("checkHomeURL(%q) should warn", bad)
		}
	}
}

func TestInstallLogoSourceInsideTheWebRoot(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "site-logo.png")
	os.WriteFile(src, []byte("png"), 0o644)

	url, err := installLogo(src, root)
	if err != nil || url != "site-logo.png" {
		t.Fatalf("got (%q, %v), want site-logo.png", url, err)
	}
	if got := readFile(t, src); got != "png" {
		t.Errorf("the configured logo must survive the clear-out; got %q", got)
	}
}

func TestCheckLogoURL(t *testing.T) {
	if checkLogoURL("http://cdn.example/l.png") == nil {
		t.Error("plain-http logo should warn about mixed content")
	}
	for _, ok := range []string{"", "https://cdn.example/l.png", "/config/logo.svg"} {
		if err := checkLogoURL(ok); err != nil {
			t.Errorf("checkLogoURL(%q) = %v", ok, err)
		}
	}
}
