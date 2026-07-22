// Package geo provides point-in-polygon boundary checks used to filter
// repeaters to the region of interest. DefaultGeoJSON is Scotland's ADM1
// boundary (mainland + all islands, ~166 sub-polygons) from
// geoBoundaries.org (source: Eurostat-GISCO, CC BY 4.0), embedded at build
// time — the built-in default region, used whenever no other boundary is
// configured. LoadBoundary also accepts a local file or a downloaded
// GeoJSON of any other region, so HopReach isn't hard-wired to Scotland.
package geo

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

//go:embed scotland.geojson
var DefaultGeoJSON []byte

type point struct {
	lon, lat float64
}

// pointInRing reports whether pt lies inside a single linear ring using the
// standard ray-casting algorithm.
func pointInRing(pt point, ring []point) bool {
	inside := false
	n := len(ring)
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		pi, pj := ring[i], ring[j]
		if (pi.lat > pt.lat) != (pj.lat > pt.lat) {
			lonAtLat := (pj.lon-pi.lon)*(pt.lat-pi.lat)/(pj.lat-pi.lat) + pi.lon
			if pt.lon < lonAtLat {
				inside = !inside
			}
		}
	}
	return inside
}

// pointInPolygon checks membership in a polygon whose first ring is the
// exterior boundary and any remaining rings are holes to subtract.
func pointInPolygon(pt point, rings [][]point) bool {
	if len(rings) == 0 || !pointInRing(pt, rings[0]) {
		return false
	}
	for _, hole := range rings[1:] {
		if pointInRing(pt, hole) {
			return false
		}
	}
	return true
}

// Boundary holds one or more polygons (e.g. a mainland plus islands, or
// several unconnected sub-regions) used for containment checks.
type Boundary struct {
	polygons [][][]point
}

// Contains reports whether (lat, lon) falls inside the boundary — a real
// ray-casting polygon test, not a bounding-box approximation.
func (b Boundary) Contains(lat, lon float64) bool {
	pt := point{lon: lon, lat: lat}
	for _, poly := range b.polygons {
		if pointInPolygon(pt, poly) {
			return true
		}
	}
	return false
}

type geoJSONFeature struct {
	Geometry geoJSONGeometry `json:"geometry"`
}

type geoJSONGeometry struct {
	Type        string          `json:"type"`
	Coordinates json.RawMessage `json:"coordinates"`
}

// Parse parses a boundary from raw GeoJSON bytes into a ray-casting-ready
// Boundary. Accepts a bare Polygon/MultiPolygon geometry, a Feature
// wrapping one, or a FeatureCollection of several Features (their polygons
// are all merged into one Boundary — e.g. a collection of separate
// administrative areas that together make up the region of interest).
// Pass DefaultGeoJSON for the built-in Scotland default, or the bytes of
// any other region's boundary GeoJSON (see LoadBoundary, which handles
// fetching those bytes from a local file or URL).
func Parse(data []byte) (Boundary, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return Boundary{}, fmt.Errorf("geo: parse boundary geojson: %w", err)
	}

	switch head.Type {
	case "FeatureCollection":
		var fc struct {
			Features []geoJSONFeature `json:"features"`
		}
		if err := json.Unmarshal(data, &fc); err != nil {
			return Boundary{}, fmt.Errorf("geo: parse boundary geojson: %w", err)
		}
		var all [][][]point
		for _, feat := range fc.Features {
			polys, err := parseGeometry(feat.Geometry)
			if err != nil {
				return Boundary{}, err
			}
			all = append(all, polys...)
		}
		if len(all) == 0 {
			return Boundary{}, fmt.Errorf("geo: boundary geojson: FeatureCollection has no Polygon/MultiPolygon features")
		}
		return Boundary{polygons: all}, nil

	case "Feature":
		var feat geoJSONFeature
		if err := json.Unmarshal(data, &feat); err != nil {
			return Boundary{}, fmt.Errorf("geo: parse boundary geojson: %w", err)
		}
		polys, err := parseGeometry(feat.Geometry)
		if err != nil {
			return Boundary{}, err
		}
		return Boundary{polygons: polys}, nil

	case "Polygon", "MultiPolygon":
		var geom geoJSONGeometry
		if err := json.Unmarshal(data, &geom); err != nil {
			return Boundary{}, fmt.Errorf("geo: parse boundary geojson: %w", err)
		}
		polys, err := parseGeometry(geom)
		if err != nil {
			return Boundary{}, err
		}
		return Boundary{polygons: polys}, nil

	default:
		return Boundary{}, fmt.Errorf("geo: boundary geojson: unsupported top-level type %q (expected Feature, FeatureCollection, Polygon, or MultiPolygon)", head.Type)
	}
}

// parseGeometry converts a single Polygon or MultiPolygon geometry into
// Boundary's internal polygon representation.
func parseGeometry(geom geoJSONGeometry) ([][][]point, error) {
	switch geom.Type {
	case "Polygon":
		var raw [][][2]float64
		if err := json.Unmarshal(geom.Coordinates, &raw); err != nil {
			return nil, fmt.Errorf("geo: parse polygon coordinates: %w", err)
		}
		return [][][]point{ringsFromRaw(raw)}, nil
	case "MultiPolygon":
		var raw [][][][2]float64
		if err := json.Unmarshal(geom.Coordinates, &raw); err != nil {
			return nil, fmt.Errorf("geo: parse multipolygon coordinates: %w", err)
		}
		polys := make([][][]point, len(raw))
		for i, poly := range raw {
			polys[i] = ringsFromRaw(poly)
		}
		return polys, nil
	default:
		return nil, fmt.Errorf("geo: boundary geojson: unsupported geometry type %q (expected Polygon or MultiPolygon)", geom.Type)
	}
}

func ringsFromRaw(raw [][][2]float64) [][]point {
	rings := make([][]point, len(raw))
	for j, ring := range raw {
		pts := make([]point, len(ring))
		for k, c := range ring {
			pts[k] = point{lon: c[0], lat: c[1]}
		}
		rings[j] = pts
	}
	return rings
}

// LoadBoundary resolves a region boundary in order: a local file at
// boundaryPath (if set), a download of boundaryURL cached under cacheDir
// (if boundaryPath is empty and boundaryURL is set), or the embedded
// default (DefaultGeoJSON, Scotland) if neither is set — so HopReach works
// out of the box while remaining configurable for any other region. A nil
// httpClient uses http.DefaultClient.
func LoadBoundary(boundaryPath, boundaryURL, cacheDir string, httpClient *http.Client) (Boundary, error) {
	switch {
	case boundaryPath != "":
		data, err := os.ReadFile(boundaryPath)
		if err != nil {
			return Boundary{}, fmt.Errorf("geo: reading region.boundary_path %s: %w", boundaryPath, err)
		}
		return Parse(data)

	case boundaryURL != "":
		data, err := fetchCachedBoundary(boundaryURL, cacheDir, httpClient)
		if err != nil {
			return Boundary{}, err
		}
		return Parse(data)

	default:
		return Parse(DefaultGeoJSON)
	}
}

// fetchCachedBoundary returns boundaryURL's contents, from cacheDir if
// already downloaded there, otherwise fetching it and (best-effort) writing
// it to cacheDir for next time — a boundary file rarely changes, so there's
// no reason to re-download it on every container restart. Caching is
// skipped (not an error) if cacheDir is empty.
func fetchCachedBoundary(boundaryURL, cacheDir string, httpClient *http.Client) ([]byte, error) {
	var cachePath string
	if cacheDir != "" {
		cachePath = boundaryCachePath(cacheDir, boundaryURL)
		if data, err := os.ReadFile(cachePath); err == nil {
			return data, nil
		}
	}

	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	resp, err := httpClient.Get(boundaryURL)
	if err != nil {
		return nil, fmt.Errorf("geo: downloading region.boundary_url %s: %w", boundaryURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("geo: downloading region.boundary_url %s: unexpected status %d", boundaryURL, resp.StatusCode)
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("geo: reading region.boundary_url %s response: %w", boundaryURL, err)
	}

	if cachePath != "" {
		if err := os.MkdirAll(cacheDir, 0o755); err == nil {
			_ = os.WriteFile(cachePath, data, 0o644) // best-effort: a failed cache write shouldn't fail this LoadBoundary call
		}
	}
	return data, nil
}

// boundaryCachePath hashes boundaryURL rather than using it directly as a
// filename, since an arbitrary URL isn't a safe/valid filename as-is.
func boundaryCachePath(cacheDir, boundaryURL string) string {
	sum := sha256.Sum256([]byte(boundaryURL))
	return filepath.Join(cacheDir, hex.EncodeToString(sum[:])+".geojson")
}
