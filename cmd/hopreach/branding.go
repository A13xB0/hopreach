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
	// Clear any logo from a previous start, whatever its extension.
	old, _ := filepath.Glob(filepath.Join(root, "site-logo.*"))
	for _, f := range old {
		os.Remove(f)
	}
	if logo == "" {
		return "", nil
	}
	lower := strings.ToLower(logo)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return logo, nil
	}
	ext := strings.ToLower(filepath.Ext(logo))
	if !logoExts[ext] {
		return "", fmt.Errorf("site.logo: %q is not an http(s) URL or a .svg/.png/.jpg/.jpeg/.webp/.gif file", logo)
	}
	img, err := os.ReadFile(logo)
	if err != nil {
		return "", fmt.Errorf("site.logo: %w", err)
	}
	name := "site-logo" + ext
	if err := os.WriteFile(filepath.Join(root, name), img, 0o644); err != nil {
		return "", err
	}
	return name, nil
}

// checkHomeURL reports a site.home_url the page will refuse to link to
// (public/site-brand.js keeps http(s) and relative URLs only).
func checkHomeURL(u string) error {
	if u == "" {
		return nil
	}
	lower := strings.ToLower(u)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return nil
	}
	return fmt.Errorf("site.home_url: %q is not an http(s) URL; the header will not link to it", u)
}
