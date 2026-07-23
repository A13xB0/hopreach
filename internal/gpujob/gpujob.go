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
	ID          string             `json:"id"`
	Sites       []propagation.Site `json:"sites"`
	Bounds      propagation.Bounds `json:"bounds"`
	ImageWidth  int                `json:"image_width"`
	ImageHeight int                `json:"image_height"`
	RangeKm     float64            `json:"range_km"`
	Propagation propagation.Params `json:"propagation"`
	DemZoom     int                `json:"dem_zoom"`
	// DemBounds is Bounds padded by RangeKm — what the worker should
	// actually load its own elevation grid for, so a site or path near the
	// edge of Bounds still sees real terrain up to RangeKm beyond it rather
	// than the grid clamping at Bounds' own edge. Distinct from Bounds
	// (which stays exact, since it also drives the output raster's
	// pixel-to-lat/lon mapping) specifically so a geographically chunked
	// pass (see compute.Engine.MarginsChunked) can submit one small job per
	// band without each band's grid being artificially clamped at that
	// band's own boundary. Falls back to Bounds if left unset (zero value),
	// for any client that predates this field.
	DemBounds      propagation.Bounds `json:"dem_bounds"`
	DemTileURLBase string             `json:"dem_tile_url_base"`
}

// KindHello/KindProgress/KindResult discriminate the JSON text-frame shapes
// the worker sends over its one WebSocket connection to the broker: one
// Hello right after connecting and then again periodically as a heartbeat
// (see cmd/hopreach-gpuworker's helloInterval) so the broker's view of this
// box's available memory doesn't go stale over a long-lived connection,
// interleaved with zero or more Progress frames while a job is in flight and
// exactly one Result each time one finishes. Kind is omitted (empty) on
// Result when it's used as the HTTP-level error envelope from POST
// /gpu/submit instead of a WS frame — that context only ever has one
// possible shape, so there's nothing to discriminate there.
const (
	KindHello    = "hello"
	KindProgress = "progress"
	KindResult   = "result"
)

// Hello is sent by the worker right after connecting, and then again every
// helloInterval as a heartbeat, reporting its own available memory (see
// internal/sysinfo) so the batch job can size MarginsChunked's per-tile
// memory budget to whatever box will actually load each tile's elevation
// grid, instead of a fixed guess that has to be hand-tuned again every time
// either box's RAM changes — and so the analytics memory-over-time graph
// has fresh samples for this box for as long as the connection stays up.
// AvailableBytes/TotalBytes are 0 if the worker couldn't determine them
// (e.g. not running on Linux) — callers should treat that as "unknown", not
// "zero RAM". CPUModel/GPUAdapter are static hardware descriptions, sent
// alongside for the analytics page's hardware panel rather than requiring a
// separate request/response round trip for information that never changes
// for the lifetime of one connection.
type Hello struct {
	Kind           string `json:"kind"`
	AvailableBytes uint64 `json:"available_bytes"`
	TotalBytes     uint64 `json:"total_bytes,omitempty"`
	CPUModel       string `json:"cpu_model,omitempty"`
	GPUAdapter     string `json:"gpu_adapter,omitempty"`
}

// Result is sent back by the worker once a job completes. Margins is the
// row-major imageWidth*imageHeight float32 array, NaN-encoded as
// gpucompute's noCoverageSentinel would be inconvenient over JSON, so
// Result travels as a JSON envelope (this struct, Margins omitted) followed
// immediately by the raw margins bytes as a separate binary frame — see
// the broker/worker implementations for the exact framing.
type Result struct {
	Kind  string `json:"kind,omitempty"`
	ID    string `json:"id"`
	Error string `json:"error,omitempty"`
}

// Progress is sent by the worker over the same WebSocket connection while a
// job is still being computed, so the broker (and, via its /gpu/progress
// polling endpoint, whatever submitted the job) can report real granular
// progress instead of just "started"/"done" either side of one long
// blocking wait. Done/Total mirror gpucompute.ComputeMargins' own
// progress-callback contract (rows of the raster completed so far, out of
// ImageHeight) — the same shape every other compute path already reports.
type Progress struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
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
