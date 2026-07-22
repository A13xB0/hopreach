// Package gpujob defines the wire format shared between the VPS-side
// broker (cmd/hopreach-shareapi's gpubroker routes), the batch job that
// submits work to it (internal/compute's remote dispatch), and the remote
// GPU worker that actually executes it (cmd/hopreach-gpuworker). Kept as
// its own tiny package so cmd/hopreach-gpuworker (a separate binary) can
// share the schema without needing to import internal/compute or the root
// binary's package main.
package gpujob

import (
	"encoding/binary"
	"math"

	"hopreach/internal/propagation"
)

// Job describes one whole coverage pass — bounds, sites, dimensions, and
// the propagation model to use — everything the worker needs except the
// elevation data itself. The worker fetches/caches its own DEM tiles
// locally (DemTileURLBase identifies the same upstream source the VPS
// itself is configured with) rather than the VPS shipping the (potentially
// multi-GB) grid over what may be a modest-bandwidth link — only this
// small job description and the resulting margins array cross the wire.
type Job struct {
	ID             string             `json:"id"`
	Sites          []propagation.Site `json:"sites"`
	Bounds         propagation.Bounds `json:"bounds"`
	ImageWidth     int                `json:"image_width"`
	ImageHeight    int                `json:"image_height"`
	RangeKm        float64            `json:"range_km"`
	Propagation    propagation.Params `json:"propagation"`
	DemZoom        int                `json:"dem_zoom"`
	DemTileURLBase string             `json:"dem_tile_url_base"`
}

// Result is sent back by the worker once a job completes. Margins is the
// row-major imageWidth*imageHeight float32 array, NaN-encoded as
// gpucompute's noCoverageSentinel would be inconvenient over JSON, so
// Result travels as a JSON envelope (this struct, Margins omitted) followed
// immediately by the raw margins bytes as a separate binary frame — see
// the broker/worker implementations for the exact framing. Kept here only
// for the Error/ID fields both sides need to agree on.
type Result struct {
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
}

// Float32ToBytesLE and BytesToFloat32LE (below) are the shared
// little-endian margins-array codec used by the broker, the batch job's
// remote-dispatch path, and the worker itself — one canonical copy rather
// than three independently-drifting ones.
func Float32ToBytesLE(v []float32) []byte {
	b := make([]byte, len(v)*4)
	for i, f := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(f))
	}
	return b
}

// BytesToFloat32LE is Float32ToBytesLE's inverse.
func BytesToFloat32LE(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out
}
