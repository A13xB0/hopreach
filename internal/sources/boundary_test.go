package sources_test

import (
	"go/build"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The whole point of meshsource.Source is that HopReach does not know which
// backend it is talking to. That property is not something the compiler
// checks — it erodes one convenient import at a time, and each one looks
// harmless in review.
//
// It happened once already: the render pipeline kept a *corescope.Client, so
// the web app could switch backends while the thing that draws the coverage
// maps could not. This test is what stops that coming back.

// Only these packages may name a backend directly: the backends themselves,
// the adapter that converts one into canonical types, and the factory that
// chooses between them.
var allowed = map[string]bool{
	"hopreach/internal/corescope":  true,
	"hopreach/internal/beacon":     true,
	"hopreach/internal/meshsource": true,
	"hopreach/internal/sources":    true,
}

const (
	corescopePkg = "hopreach/internal/corescope"
	beaconPkg    = "hopreach/internal/beacon"
)

func TestOnlyTheAdapterLayerImportsABackend(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}

	var offenders []string
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return nil
		}
		base := info.Name()
		if base == ".git" || base == "node_modules" || base == "public" ||
			base == "web" || base == "tests" {
			return filepath.SkipDir
		}

		pkg, err := build.ImportDir(path, 0)
		if err != nil {
			return nil // not a Go package
		}
		rel, _ := filepath.Rel(root, path)
		importPath := "hopreach/" + filepath.ToSlash(rel)
		if rel == "." {
			importPath = "hopreach"
		}
		if allowed[importPath] {
			return nil
		}
		for _, imp := range append(pkg.Imports, pkg.TestImports...) {
			if imp == corescopePkg || imp == beaconPkg {
				offenders = append(offenders,
					importPath+" imports "+imp)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(offenders) > 0 {
		t.Errorf("a backend is being used directly instead of through "+
			"meshsource.Source:\n  %s\n\n"+
			"Anything a caller needs from a backend belongs on the Source "+
			"interface, implemented by both. Reaching past it means that code "+
			"path only works on one backend, which is how the render pipeline "+
			"ended up CoreScope-only while the web app was already portable.",
			strings.Join(offenders, "\n  "))
	}
}
