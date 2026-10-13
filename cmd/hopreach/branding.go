package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// webRoot is nginx's document root inside the image — the same fixed
// container layout as configJSPath.
const webRoot = "/usr/share/nginx/html"

// themeFileName is the stylesheet every page loads last (see
// public/index.html). The repo ships it as a comment-only placeholder.
const themeFileName = "site-theme.css"

const themePlaceholder = "/* No site.theme_css configured: the built-in look. */\n"

// logoExts are the image types a local site.logo may be. The extension
// picks the Content-Type nginx serves it with, so it is checked rather
// than trusted.
var logoExts = map[string]bool{".svg": true, ".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}

// installTheme writes root/site-theme.css from site.theme_css. It always
// writes something: a container restarted with the setting removed must
// lose the old theme, not keep it from the previous start.
func installTheme(themePath, root string) error {
	dst := filepath.Join(root, themeFileName)
	if themePath == "" {
		return os.WriteFile(dst, []byte(themePlaceholder), 0o644)
	}
	css, err := os.ReadFile(themePath)
	if err != nil {
		// Fall back to the built-in look rather than leave a stale theme.
		if werr := os.WriteFile(dst, []byte(themePlaceholder), 0o644); werr != nil {
			return werr
		}
		return fmt.Errorf("site.theme_css: %w", err)
	}
	return os.WriteFile(dst, css, 0o644)
}

// installLogo resolves site.logo to the URL the page should load. An
// http(s) URL is used as-is; a local file is copied to root/site-logo.<ext>.
// Returns "" (no logo) when unset or unusable.
func installLogo(logo, root string) (string, error) {
	if logo == "" || isHTTPURL(logo) {
		clearLogos(root)
		return logo, nil
	}
	ext := strings.ToLower(filepath.Ext(logo))
	if !logoExts[ext] {
		clearLogos(root)
		return "", fmt.Errorf("site.logo: %q is not an http(s) URL or a .svg/.png/.jpg/.jpeg/.webp/.gif file", logo)
	}
	// Read before clearing: the configured file may itself be one of the
	// site-logo.* files the clear would remove.
	img, err := os.ReadFile(logo)
	clearLogos(root)
	if err != nil {
		return "", fmt.Errorf("site.logo: %w", err)
	}
	name := "site-logo" + ext
	if err := os.WriteFile(filepath.Join(root, name), img, 0o644); err != nil {
		return "", err
	}
	return name, nil
}

// clearLogos removes any logo a previous start installed, whatever its
// extension.
func clearLogos(root string) {
	old, _ := filepath.Glob(filepath.Join(root, "site-logo.*"))
	for _, f := range old {
		os.Remove(f)
	}
}

func isHTTPURL(u string) bool {
	lower := strings.ToLower(u)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

// checkLogoURL reports a plain-http logo URL: on an https deployment the
// browser blocks or upgrades it as mixed content, so it may not show.
func checkLogoURL(logo string) error {
	if strings.HasPrefix(strings.ToLower(logo), "http://") {
		return fmt.Errorf("site.logo: %q is plain http; on an https site the browser may block it as mixed content — prefer https", logo)
	}
	return nil
}

// checkHomeURL reports a site.home_url the page will refuse to link to.
// Mirrors safeUrl in public/site-brand.js: http(s) URLs and relative
// paths are kept; anything else with a scheme (javascript:, data:, …) is
// dropped.
func checkHomeURL(u string) error {
	t := strings.TrimSpace(u)
	if t == "" || isHTTPURL(t) {
		return nil
	}
	colon, slash := strings.Index(t, ":"), strings.Index(t, "/")
	if colon < 0 || (slash >= 0 && slash < colon) {
		// A relative path — linked as-is. "example.org/x" is one too, but
		// almost certainly meant https://example.org/x, so say so.
		first := t
		if slash >= 0 {
			first = t[:slash]
		}
		if strings.Contains(first, ".") && first != "." && first != ".." {
			return fmt.Errorf("site.home_url: %q looks like a domain without https://; it will be linked as a path on this site", u)
		}
		return nil
	}
	return fmt.Errorf("site.home_url: %q is not an http(s) URL or a relative path; the header will not link to it", u)
}
