// Package gpucompute implements GPU-accelerated coverage computation via
// WebGPU (wgpu-native, running on Vulkan on Linux). ComputeMargins is the
// entry point; CPU (propagation.ComputeMarginsCPU) is always the trusted
// reference and fallback — GPU output is only ever trusted after matching
// it within tolerance (see Verify).
//
// Extracted into its own package (rather than living in the root binary's
// package main, where it originated) so cmd/hopreach-gpuworker — a separate binary
// that runs on a remote machine with its own GPU — can import the exact
// same dispatch/chunking/timeout logic instead of a second, drifting copy.
package gpucompute

import (
	"encoding/binary"
	"fmt"
	"math"
	"time"

	"github.com/rajveermalviya/go-webgpu/wgpu"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpujob"
	"hopreach/internal/propagation"
)

// Backend holds the initialized device/pipeline, reused across every
// coverage pass in a run rather than reinitialized per pass.
type Backend struct {
	device    *wgpu.Device
	queue     *wgpu.Queue
	pipeline  *wgpu.ComputePipeline
	bgLayout  *wgpu.BindGroupLayout
	AdapterID string // for logging

	// maxBufferSize is a hard WebGPU-spec ceiling (exactly 2^31-1 bytes on
	// every backend observed, including this native, non-browser build —
	// wgpu-native enforces the same spec limits natively as it does
	// compiled to wasm for an actual browser, rather than exposing
	// whatever the underlying Vulkan device can really do; this host's
	// raw Vulkan reports maxStorageBufferRange/maxMemoryAllocationSize
	// around 4GB, confirmed via vulkaninfo). A whole-Scotland elevation
	// grid at higher DEM zooms routinely exceeds this per *buffer*, so it
	// gets split across up to maxElevChunks separate bindings — see
	// ComputeMargins — rather than working around it by not using the
	// GPU for large grids at all.
	maxBufferSize uint64
}

// maxElevChunks bounds how many separate elev bindings the shader declares
// (elev_at in the WGSL source below has one branch per chunk). 16 chunks
// at ~1.8GB safety margin each covers up to ~28GB grids — comfortably
// beyond even coverage.precision_dem_zoom=14 for all of Scotland.
const maxElevChunks = 16

// elevChunkBudgetBytes is the safety margin under maxBufferSize each elev
// chunk targets, leaving headroom for the other buffers (params, sites,
// output) sharing the same device memory pool.
const elevChunkBudgetBytes = 1_800_000_000

// Binding numbers: 0 = params, 1..maxElevChunks = elevation grid chunks,
// then sites, then output margins.
const (
	elevSitesBinding  = 1 + maxElevChunks
	elevOutputBinding = elevSitesBinding + 1
)

// gpuParams mirrors the WGSL Params struct field-for-field (std430 layout:
// 4-byte scalars packed in declaration order, padded to a 16-byte multiple).
// RowOffset/RowCount select the slice of the full raster the *next*
// dispatch covers — see the chunking comment on ComputeMargins.
type gpuParams struct {
	Zoom            float32
	MinTileX        float32
	MinTileY        float32
	GridWidth       uint32
	GridHeight      uint32
	ImageWidth      uint32
	ImageHeight     uint32
	NumSites        uint32
	BoundsSouth     float32
	BoundsNorth     float32
	BoundsWest      float32
	BoundsEast      float32
	RangeKm         float32
	FrequencyMHz    float32
	TxPowerDBm      float32
	TxAntennaGainDB float32
	RxAntennaGainDB float32
	RxSensitivityDB float32
	FadeMarginDB    float32
	RxHeightM       float32
	RowOffset       uint32
	RowCount        uint32
	// ElevRowsPerChunk: the elevation grid (grid_width x grid_height) is
	// split into up to maxElevChunks row-bands, each its own GPU buffer
	// binding — see the "Elevation grid, chunked" comment on
	// ComputeMargins. Row r of the grid lives in chunk r /
	// ElevRowsPerChunk, at local row r % ElevRowsPerChunk within that
	// chunk's buffer.
	ElevRowsPerChunk uint32
	_pad0            uint32
}

// gpuSite mirrors the WGSL Site struct (16 bytes, natural array stride).
// The trailing field is never read or written (sitesToBytes always emits a
// hardcoded 0 for it) — it exists only so the struct's size documents the
// WGSL side's padding, hence the blank identifier rather than a named,
// genuinely-dead field.
type gpuSite struct {
	Lat, Lon, TxHeightM float32
	_                   float32
}

// noCoverageSentinel is written by the shader in place of NaN (GPU/SPIR-V
// NaN handling is backend-dependent and not worth the risk) and translated
// back to a real NaN on readback, matching propagation.ComputeMarginsCPU's
// contract.
const noCoverageSentinel = -3.0e38

// Init probes for a compatible GPU/driver and initializes a Backend if one
// is found. Callers should always run Verify on the result before trusting
// it for real output — Init alone doesn't establish correctness, only that
// a device was created.
func Init() (*Backend, error) {
	instance := wgpu.CreateInstance(nil)
	if instance == nil {
		return nil, fmt.Errorf("wgpu.CreateInstance returned nil")
	}
	defer instance.Release()

	adapter, err := instance.RequestAdapter(&wgpu.RequestAdapterOptions{
		PowerPreference: wgpu.PowerPreference_HighPerformance,
	})
	if err != nil {
		return nil, fmt.Errorf("no adapter: %w", err)
	}
	defer adapter.Release()
	props := adapter.GetProperties()

	// Without a real device passed through, Mesa/wgpu can still hand back
	// a *software* Vulkan rasterizer (llvmpipe) — a perfectly valid
	// adapter from the API's point of view, but pointless here: it can
	// only ever be slower than the native CPU path, defeating the entire
	// point of this feature. Treat it exactly like "no GPU available"
	// rather than actually dispatching to it.
	if props.AdapterType == wgpu.AdapterType_CPU {
		return nil, fmt.Errorf("adapter %q is a software rasterizer, not real GPU hardware", props.Name)
	}

	// RequestDevice(nil) defaults to the conservative WebGPU-spec minimum
	// limits (256MB max buffer size), which the DEM grid buffer for a
	// realistically-sized coverage region — let alone a 6000px+ Precision
	// pass's output buffer — comfortably exceeds. Request whatever this
	// adapter actually supports instead.
	adapterLimits := adapter.GetLimits()
	device, err := adapter.RequestDevice(&wgpu.DeviceDescriptor{
		Label:          "hopreach",
		RequiredLimits: &wgpu.RequiredLimits{Limits: adapterLimits.Limits},
	})
	if err != nil {
		return nil, fmt.Errorf("request device: %w", err)
	}

	shader, err := device.CreateShaderModule(&wgpu.ShaderModuleDescriptor{
		Label:          "coverage-margins",
		WGSLDescriptor: &wgpu.ShaderModuleWGSLDescriptor{Code: marginsShaderWGSL},
	})
	if err != nil {
		device.Release()
		return nil, fmt.Errorf("shader compile: %w", err)
	}
	defer shader.Release()

	// Binding layout: 0 = params, 1..maxElevChunks = elevation grid chunks
	// (see the "Elevation grid, chunked" comment on ComputeMargins),
	// elevSitesBinding = sites, elevOutputBinding = output margins.
	bglEntries := make([]wgpu.BindGroupLayoutEntry, 0, maxElevChunks+3)
	bglEntries = append(bglEntries, wgpu.BindGroupLayoutEntry{Binding: 0, Visibility: wgpu.ShaderStage_Compute, Buffer: wgpu.BufferBindingLayout{Type: wgpu.BufferBindingType_ReadOnlyStorage}})
	for i := 0; i < maxElevChunks; i++ {
		bglEntries = append(bglEntries, wgpu.BindGroupLayoutEntry{Binding: uint32(1 + i), Visibility: wgpu.ShaderStage_Compute, Buffer: wgpu.BufferBindingLayout{Type: wgpu.BufferBindingType_ReadOnlyStorage}})
	}
	bglEntries = append(bglEntries,
		wgpu.BindGroupLayoutEntry{Binding: elevSitesBinding, Visibility: wgpu.ShaderStage_Compute, Buffer: wgpu.BufferBindingLayout{Type: wgpu.BufferBindingType_ReadOnlyStorage}},
		wgpu.BindGroupLayoutEntry{Binding: elevOutputBinding, Visibility: wgpu.ShaderStage_Compute, Buffer: wgpu.BufferBindingLayout{Type: wgpu.BufferBindingType_Storage}},
	)
	bgLayout, err := device.CreateBindGroupLayout(&wgpu.BindGroupLayoutDescriptor{
		Label:   "coverage-bgl",
		Entries: bglEntries,
	})
	if err != nil {
		device.Release()
		return nil, fmt.Errorf("bind group layout: %w", err)
	}

	pipelineLayout, err := device.CreatePipelineLayout(&wgpu.PipelineLayoutDescriptor{
		Label:            "coverage-pl",
		BindGroupLayouts: []*wgpu.BindGroupLayout{bgLayout},
	})
	if err != nil {
		bgLayout.Release()
		device.Release()
		return nil, fmt.Errorf("pipeline layout: %w", err)
	}
	defer pipelineLayout.Release()

	pipeline, err := device.CreateComputePipeline(&wgpu.ComputePipelineDescriptor{
		Label:   "coverage-pipeline",
		Layout:  pipelineLayout,
		Compute: wgpu.ProgrammableStageDescriptor{Module: shader, EntryPoint: "main"},
	})
	if err != nil {
		bgLayout.Release()
		device.Release()
		return nil, fmt.Errorf("compute pipeline: %w", err)
	}

	return &Backend{
		device:        device,
		queue:         device.GetQueue(),
		pipeline:      pipeline,
		bgLayout:      bgLayout,
		AdapterID:     fmt.Sprintf("%s (%s via %s)", props.Name, props.DriverDescription, props.BackendType),
		maxBufferSize: adapterLimits.Limits.MaxBufferSize,
	}, nil
}

// Verify runs a small synthetic grid/site fixture through both the CPU
// and GPU paths and requires them to agree within tolerance before the GPU
// path is ever used for real output — the nightly coverage data this whole
// project is built on must never silently depend on an unverified port.
func Verify(be *Backend) error {
	grid := &demgrid.Grid{
		Zoom: 11, MinTileX: 1000, MinTileY: 600,
		TilesWide: 2, TilesHigh: 2, Width: 512, Height: 512,
		Elev: make([]float32, 512*512),
	}
	for i := range grid.Elev {
		// A simple non-flat synthetic terrain so diffraction actually kicks
		// in for at least some paths, not just free-space loss.
		x, y := i%grid.Width, i/grid.Width
		grid.Elev[i] = float32(100 + 50*math.Sin(float64(x)/40) + 30*math.Cos(float64(y)/30))
	}

	p := propagation.Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, AntennaHeightM: 1.6, RxHeightM: 2,
		MaxRangeKm: 100, MarginGreenDB: 15,
	}
	bounds := propagation.Bounds{South: 56.0, North: 56.3, West: -4.3, East: -3.9}
	sites := []propagation.Site{
		{Lat: 56.05, Lon: -4.2, GroundM: 120, TxHeightM: 121.6},
		{Lat: 56.2, Lon: -4.0, GroundM: 200, TxHeightM: 201.6},
		{Lat: 56.15, Lon: -4.15, GroundM: 80, TxHeightM: 81.6},
	}
	const imageWidth, imageHeight = 40, 40
	rangeKm := propagation.LinkBudgetMaxRangeKm(p)

	cpu := propagation.ComputeMarginsCPU(grid, sites, bounds, imageWidth, imageHeight, rangeKm, p, nil)
	gpuOut, err := ComputeMargins(be, grid, sites, bounds, imageWidth, imageHeight, rangeKm, p, nil)
	if err != nil {
		return fmt.Errorf("GPU dispatch failed on verification fixture: %w", err)
	}

	// toleranceDB covers ordinary float32-vs-float64 rounding drift
	// accumulated over the ~8-300 transcendental-function-heavy samples
	// per pixel (measured in practice around 0.05-0.07dB) — this is not
	// noise to chase out, it's the inherent cost of doing this computation
	// in float32, and utterly imperceptible in a coverage heatmap.
	// nearZeroDB additionally excuses covered-vs-not-covered (NaN)
	// disagreements only when the CPU value itself is already within a
	// hair of the 0dB cutoff: right at that boundary, which side any two
	// differently-rounded implementations land on is inherently
	// unstable — not a sign either one is wrong. A real bug would show up
	// as either a mismatch on a *clearly* covered/uncovered pixel, or a
	// tolerance-exceeding divergence that isn't just boundary noise.
	const toleranceDB = 0.3
	const nearZeroDB = 0.1
	mismatches := 0
	for i := range cpu {
		cpuIsNaN := math.IsNaN(float64(cpu[i]))
		gpuIsNaN := math.IsNaN(float64(gpuOut[i]))
		if cpuIsNaN != gpuIsNaN {
			if !cpuIsNaN && math.Abs(float64(cpu[i])) < nearZeroDB {
				continue // right at the coverage boundary — expected to be unstable
			}
			if !gpuIsNaN && math.Abs(float64(gpuOut[i])) < nearZeroDB {
				continue
			}
			mismatches++
			continue
		}
		if cpuIsNaN {
			continue
		}
		if math.Abs(float64(cpu[i]-gpuOut[i])) > toleranceDB {
			mismatches++
		}
	}
	if mismatches > 0 {
		return fmt.Errorf("%d/%d pixels diverge by more than %.2fdB", mismatches, len(cpu), toleranceDB)
	}
	return nil
}

// MaxElevChunks/ElevChunkBudgetBytes exported so the root package's
// dispatcher (gpu.go) can pre-flight-check whether a grid is small enough
// for GPU chunking to cover at all, without duplicating the arithmetic.
const MaxElevChunks = maxElevChunks
const ElevChunkBudgetBytes = elevChunkBudgetBytes

// targetPixelsPerDispatch bounds how much work a single dispatch does.
// Without this, a large Precision-resolution raster (millions of pixels,
// each looping over every site and up to 300 terrain samples) can run long
// enough to trip the GPU driver's own hang-detection watchdog — observed
// in practice as the whole process being aborted by a Rust panic crossing
// the cgo boundary when a "device lost" event fires, which Go's recover()
// cannot catch. Splitting the raster into row-chunks, each a separate
// dispatch+submit+readback, keeps every individual dispatch comfortably
// short regardless of total image size.
//
// 750k pixels was safe when elev_at() was one flat array lookup; with the
// elevation grid chunked (elev_at branches across up to maxElevChunks
// buffers per lookup — a divergent branch, since different invocations in
// the same wavefront/workgroup can land in different chunks and serialize
// against each other), even 100k measurably ran long enough to trip the
// watchdog again against a real ~70-site dataset — but that finding
// predates discovering the real bug below (chunking silently not
// happening at all for wide images), so it's not clear 100k was actually
// unsafe on its own merits rather than secretly running unchunked too.
// 10k was the final conservative value from that debugging spiral. Now
// that chunking is provably correct regardless of width (see the bug fix
// below) *and* every dispatch is wrapped in waitForMap's timeout (a hang
// or driver abort now fails cleanly instead of crashing/hanging the whole
// process), raised back up for real throughput — 10k meant a 12000px-wide
// Precision raster floored to one GPU round-trip per single row, paying
// full submit/sync/readback overhead for almost no compute each time.
const targetPixelsPerDispatch = 200_000

// baselineSitesPerDispatch is the site count targetPixelsPerDispatch was
// implicitly tuned against — see dispatchPixelBudget.
const baselineSitesPerDispatch = 15

// dispatchSafetyFactor is extra headroom on top of the linear pixels÷sites
// scaling in dispatchPixelBudget. Without it, the fix would only just barely
// clear the specific failure it was measured against (45 sites dispatched
// fine, 48 didn't — a thin margin, and per-chunk GPU time isn't perfectly
// uniform: chunks covering rows with more sites actually in range of more
// pixels cost more than the average chunk). 1.5x means a dense tile's
// dispatches target roughly a third of the timeout instead of grazing it.
const dispatchSafetyFactor = 1.5

// dispatchPixelBudget scales targetPixelsPerDispatch down for a dense site
// list. The shader loops over every site for every pixel (params.num_sites
// — see the WGSL main() below), so a dispatch's total work is really
// pixels × sites, not just pixels: targetPixelsPerDispatch alone assumes
// something like baselineSitesPerDispatch sites, which holds for a
// low-resolution whole-region pass (many sites, but any given pixel is
// only in range of a few of them) but not for a Precision-tier tile sized
// around a dense repeater cluster, where most of the tile's sites can be
// in range of most of its pixels. Confirmed in production: a 923x1865
// tile with 45 sites in a dense cluster dispatched normally, but the same
// size tile with 48 sites reliably blew the 5-second dispatchWaitTimeout
// watchdog on its very first chunk and fell back to CPU — turning a
// sub-minute tile into roughly an hour. Dividing the pixel budget by
// sites/baselineSitesPerDispatch, times dispatchSafetyFactor (and never
// scaling *up* for a sparse list), keeps each dispatch's total work well
// under what tripped the watchdog instead of merely at its edge.
func dispatchPixelBudget(numSites int) int {
	if numSites <= baselineSitesPerDispatch {
		return targetPixelsPerDispatch
	}
	return int(float64(targetPixelsPerDispatch) * float64(baselineSitesPerDispatch) / (float64(numSites) * dispatchSafetyFactor))
}

// ComputeMargins renders one whole coverage pass on the GPU, dispatched in
// row-chunks (see targetPixelsPerDispatch) with the elevation grid uploaded
// across up to MaxElevChunks buffer bindings (see the Backend.maxBufferSize
// comment) — never trust its output without having first run Verify on be.
func ComputeMargins(be *Backend, grid *demgrid.Grid, sites []propagation.Site, bounds propagation.Bounds, imageWidth, imageHeight int, rangeKm float64, p propagation.Params, progress func(done, total int)) ([]float32, error) {
	baseParams := gpuParams{
		Zoom: float32(grid.Zoom), MinTileX: float32(grid.MinTileX), MinTileY: float32(grid.MinTileY),
		GridWidth: uint32(grid.Width), GridHeight: uint32(grid.Height),
		ImageWidth: uint32(imageWidth), ImageHeight: uint32(imageHeight), NumSites: uint32(len(sites)),
		BoundsSouth: float32(bounds.South), BoundsNorth: float32(bounds.North),
		BoundsWest: float32(bounds.West), BoundsEast: float32(bounds.East),
		RangeKm: float32(rangeKm), FrequencyMHz: float32(p.FrequencyMHz),
		TxPowerDBm: float32(p.TxPowerDBm), TxAntennaGainDB: float32(p.TxAntennaGainDB),
		RxAntennaGainDB: float32(p.RxAntennaGainDB), RxSensitivityDB: float32(p.RxSensitivityDB),
		FadeMarginDB: float32(p.FadeMarginDB), RxHeightM: float32(p.RxHeightM),
	}

	gpuSites := make([]gpuSite, len(sites))
	for i, s := range sites {
		gpuSites[i] = gpuSite{Lat: float32(s.Lat), Lon: float32(s.Lon), TxHeightM: float32(s.TxHeightM)}
	}
	if len(gpuSites) == 0 {
		// A zero-length storage buffer is invalid in WebGPU; a single inert
		// site far from the raster bounds is a harmless stand-in (haversine
		// distance check in the shader will just always skip it).
		gpuSites = []gpuSite{{Lat: 0, Lon: 0, TxHeightM: 0}}
	}

	paramsBufSize := uint64(len(structToBytes(baseParams)))
	paramsBuf, err := be.device.CreateBuffer(&wgpu.BufferDescriptor{Label: "params", Size: paramsBufSize, Usage: wgpu.BufferUsage_Storage | wgpu.BufferUsage_CopyDst})
	if err != nil {
		return nil, fmt.Errorf("params buffer: %w", err)
	}
	defer paramsBuf.Release()

	// Elevation grid, chunked: a whole-Scotland grid at higher DEM zooms
	// can exceed WebGPU's ~2GB per-buffer ceiling (see the maxBufferSize
	// comment on gpuBackend), so it's split by row into up to
	// maxElevChunks separate bindings instead of avoiding the GPU for
	// large grids entirely. Row r of the grid lives in chunk r/rowsPerChunk
	// at local row r%rowsPerChunk — mirrored in the WGSL elev_at() below.
	rowsPerChunk := elevChunkBudgetBytes / (grid.Width * 4)
	if rowsPerChunk < 1 {
		rowsPerChunk = 1
	}
	if rowsPerChunk > grid.Height {
		rowsPerChunk = grid.Height
	}
	numElevChunks := (grid.Height + rowsPerChunk - 1) / rowsPerChunk
	if numElevChunks > maxElevChunks {
		return nil, fmt.Errorf("elevation grid needs %d chunks of ~%dMB, only %d supported (grid %dx%d) — lower coverage.precision_dem_zoom", numElevChunks, elevChunkBudgetBytes/1_000_000, maxElevChunks, grid.Width, grid.Height)
	}

	elevBufs := make([]*wgpu.Buffer, maxElevChunks)
	elevBufSizes := make([]uint64, maxElevChunks)
	for i := 0; i < maxElevChunks; i++ {
		var contents []byte
		if i < numElevChunks {
			rowStart := i * rowsPerChunk
			rowEnd := rowStart + rowsPerChunk
			if rowEnd > grid.Height {
				rowEnd = grid.Height
			}
			contents = gpujob.Float32ToBytesLE(grid.Elev[rowStart*grid.Width : rowEnd*grid.Width])
		} else {
			// Unused chunk slot: the fixed bind group layout always
			// expects maxElevChunks bindings, so pad with a harmless tiny
			// buffer. The shader never indexes into it — row/rowsPerChunk
			// never reaches an unused chunk index for a valid grid row.
			contents = make([]byte, 4)
		}
		buf, err := be.device.CreateBufferInit(&wgpu.BufferInitDescriptor{
			Label: fmt.Sprintf("elev-chunk-%d", i), Contents: contents, Usage: wgpu.BufferUsage_Storage | wgpu.BufferUsage_CopyDst,
		})
		if err != nil {
			for j := 0; j < i; j++ {
				elevBufs[j].Release()
			}
			return nil, fmt.Errorf("elev chunk %d buffer: %w", i, err)
		}
		elevBufs[i] = buf
		elevBufSizes[i] = uint64(len(contents))
	}
	defer func() {
		for _, buf := range elevBufs {
			buf.Release()
		}
	}()
	baseParams.ElevRowsPerChunk = uint32(rowsPerChunk)

	sitesBuf, err := be.device.CreateBufferInit(&wgpu.BufferInitDescriptor{
		Label: "sites", Contents: sitesToBytes(gpuSites), Usage: wgpu.BufferUsage_Storage | wgpu.BufferUsage_CopyDst,
	})
	if err != nil {
		return nil, fmt.Errorf("sites buffer: %w", err)
	}
	defer sitesBuf.Release()

	// BUG THIS FIXED: integer division silently produces 0 whenever
	// imageWidth alone exceeds targetPixelsPerDispatch (a wide supersampled
	// Precision raster routinely does — e.g. 6000px served * 2x
	// supersample = 12000px wide), and the old "only update chunkRows if
	// r >= 1" guard then left chunkRows at its *initial* value of the full
	// imageHeight — meaning no chunking happened at all for exactly the
	// rasters most likely to need it, dispatching the entire image in one
	// submission. That's what actually caused the "device lost" GPU
	// driver-timeout crashes seen in earlier testing, at both a
	// smaller-than-real scale (where it happened to go unnoticed because
	// imageWidth was still under the target) and at full production
	// scale (where it crashed unmissably). Chunking by at least 1 row is
	// always correct, even if that single row alone exceeds the pixel
	// budget — a giant single-row dispatch is still far cheaper than the
	// entire raster in one go.
	chunkRows := dispatchPixelBudget(len(sites)) / imageWidth
	if chunkRows < 1 {
		chunkRows = 1
	}
	if chunkRows > imageHeight {
		chunkRows = imageHeight
	}
	chunkOutSize := uint64(chunkRows*imageWidth) * 4

	outBuf, err := be.device.CreateBuffer(&wgpu.BufferDescriptor{Label: "margins-out", Size: chunkOutSize, Usage: wgpu.BufferUsage_Storage | wgpu.BufferUsage_CopySrc})
	if err != nil {
		return nil, fmt.Errorf("output buffer: %w", err)
	}
	defer outBuf.Release()

	readBuf, err := be.device.CreateBuffer(&wgpu.BufferDescriptor{Label: "margins-read", Size: chunkOutSize, Usage: wgpu.BufferUsage_CopyDst | wgpu.BufferUsage_MapRead})
	if err != nil {
		return nil, fmt.Errorf("readback buffer: %w", err)
	}
	defer readBuf.Release()

	bgEntries := make([]wgpu.BindGroupEntry, 0, maxElevChunks+3)
	bgEntries = append(bgEntries, wgpu.BindGroupEntry{Binding: 0, Buffer: paramsBuf, Size: paramsBufSize})
	for i := 0; i < maxElevChunks; i++ {
		bgEntries = append(bgEntries, wgpu.BindGroupEntry{Binding: uint32(1 + i), Buffer: elevBufs[i], Size: elevBufSizes[i]})
	}
	bgEntries = append(bgEntries,
		wgpu.BindGroupEntry{Binding: elevSitesBinding, Buffer: sitesBuf, Size: uint64(len(gpuSites) * 16)},
		wgpu.BindGroupEntry{Binding: elevOutputBinding, Buffer: outBuf, Size: chunkOutSize},
	)
	bindGroup, err := be.device.CreateBindGroup(&wgpu.BindGroupDescriptor{
		Label:   "coverage-bg",
		Layout:  be.bgLayout,
		Entries: bgEntries,
	})
	if err != nil {
		return nil, fmt.Errorf("bind group: %w", err)
	}
	defer bindGroup.Release()

	out := make([]float32, imageWidth*imageHeight)
	const workgroupSizeX, workgroupSizeY = 8, 8
	countX := (uint32(imageWidth) + workgroupSizeX - 1) / workgroupSizeX

	for rowOffset := 0; rowOffset < imageHeight; rowOffset += chunkRows {
		rowsThisChunk := chunkRows
		if rowOffset+rowsThisChunk > imageHeight {
			rowsThisChunk = imageHeight - rowOffset
		}

		chunkParams := baseParams
		chunkParams.RowOffset = uint32(rowOffset)
		chunkParams.RowCount = uint32(rowsThisChunk)
		if err := be.queue.WriteBuffer(paramsBuf, 0, structToBytes(chunkParams)); err != nil {
			return nil, fmt.Errorf("write params (chunk at row %d): %w", rowOffset, err)
		}

		encoder, err := be.device.CreateCommandEncoder(nil)
		if err != nil {
			return nil, fmt.Errorf("command encoder (chunk at row %d): %w", rowOffset, err)
		}

		pass := encoder.BeginComputePass(nil)
		pass.SetPipeline(be.pipeline)
		pass.SetBindGroup(0, bindGroup, nil)
		countY := (uint32(rowsThisChunk) + workgroupSizeY - 1) / workgroupSizeY
		pass.DispatchWorkgroups(countX, countY, 1)
		if err := pass.End(); err != nil {
			pass.Release()
			encoder.Release()
			return nil, fmt.Errorf("end compute pass (chunk at row %d): %w", rowOffset, err)
		}
		pass.Release()

		chunkBytes := uint64(rowsThisChunk*imageWidth) * 4
		if err := encoder.CopyBufferToBuffer(outBuf, 0, readBuf, 0, chunkBytes); err != nil {
			encoder.Release()
			return nil, fmt.Errorf("copy to readback (chunk at row %d): %w", rowOffset, err)
		}

		cmd, err := encoder.Finish(nil)
		if err != nil {
			encoder.Release()
			return nil, fmt.Errorf("finish encoder (chunk at row %d): %w", rowOffset, err)
		}
		encoder.Release()

		be.queue.Submit(cmd)
		cmd.Release()

		if err := waitForMap(be, readBuf, chunkBytes, dispatchWaitTimeout); err != nil {
			return nil, fmt.Errorf("chunk at row %d: %w", rowOffset, err)
		}

		data := readBuf.GetMappedRange(0, uint(chunkBytes))
		chunkMargins := gpujob.BytesToFloat32LE(data)
		destOffset := rowOffset * imageWidth
		for i, m := range chunkMargins {
			if m <= noCoverageSentinel/2 { // comfortably below any real dB value
				out[destOffset+i] = float32(math.NaN())
			} else {
				out[destOffset+i] = m
			}
		}
		readBuf.Unmap()

		if progress != nil {
			progress(rowOffset+rowsThisChunk, imageHeight)
		}
	}

	return out, nil
}

// dispatchWaitTimeout bounds how long waitForMap will wait for a single
// chunk's GPU work to complete. Deliberately short: this exists to catch a
// genuine driver hang (Poll never returning), and a real AMDGPU TDR
// watchdog typically fires within a few seconds of a stalled dispatch —
// crossing the cgo boundary as an uncatchable panic that no Go-side
// timeout can intercept. Keeping this shorter than that window is the only
// way this timeout ever "wins the race" and returns a clean, catchable
// error instead of the driver's own more destructive intervention getting
// there first. A properly-sized dispatch (targetPixelsPerDispatch) should
// complete in a small fraction of this even under load, so false positives
// from legitimate-but-slow work (e.g. GPU contention from other desktop
// apps) should be rare.
const dispatchWaitTimeout = 5 * time.Second

// waitForMap blocks until readBuf's mapping completes or timeout elapses,
// whichever comes first. If it times out, it returns immediately without
// waiting for the background poll goroutine to ever finish — that
// goroutine (and whatever GPU state it's still touching) is deliberately
// abandoned rather than waited on, since the whole point is to not get
// stuck. This is safe here specifically because computeMargins's caller
// nils out gpuBE on any error from this call, so nothing else in this
// process ever touches be again; the process exits at the end of this
// batch run either way, which reclaims the abandoned goroutine/GPU state
// regardless of whether it ever actually finished.
func waitForMap(be *Backend, readBuf *wgpu.Buffer, chunkBytes uint64, timeout time.Duration) error {
	done := make(chan error, 1)
	if err := readBuf.MapAsync(wgpu.MapMode_Read, 0, chunkBytes, func(status wgpu.BufferMapAsyncStatus) {
		if status != wgpu.BufferMapAsyncStatus_Success {
			done <- fmt.Errorf("buffer map status %v", status)
			return
		}
		done <- nil
	}); err != nil {
		return fmt.Errorf("map async: %w", err)
	}

	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			be.device.Poll(true, nil)
		}
	}()

	select {
	case err := <-done:
		close(stop)
		return err
	case <-time.After(timeout):
		// Deliberately not closing stop / not waiting on the goroutine —
		// see the function comment above.
		return fmt.Errorf("timed out after %s waiting for GPU (driver may be hung)", timeout)
	}
}

func sitesToBytes(sites []gpuSite) []byte {
	b := make([]byte, len(sites)*16)
	for i, s := range sites {
		off := i * 16
		binary.LittleEndian.PutUint32(b[off:], math.Float32bits(s.Lat))
		binary.LittleEndian.PutUint32(b[off+4:], math.Float32bits(s.Lon))
		binary.LittleEndian.PutUint32(b[off+8:], math.Float32bits(s.TxHeightM))
		binary.LittleEndian.PutUint32(b[off+12:], 0)
	}
	return b
}

func structToBytes(p gpuParams) []byte {
	vals := []float32{
		p.Zoom, p.MinTileX, p.MinTileY,
	}
	b := make([]byte, 0, 96)
	for _, v := range vals {
		b = binary.LittleEndian.AppendUint32(b, math.Float32bits(v))
	}
	b = binary.LittleEndian.AppendUint32(b, p.GridWidth)
	b = binary.LittleEndian.AppendUint32(b, p.GridHeight)
	b = binary.LittleEndian.AppendUint32(b, p.ImageWidth)
	b = binary.LittleEndian.AppendUint32(b, p.ImageHeight)
	b = binary.LittleEndian.AppendUint32(b, p.NumSites)
	for _, v := range []float32{
		p.BoundsSouth, p.BoundsNorth, p.BoundsWest, p.BoundsEast,
		p.RangeKm, p.FrequencyMHz, p.TxPowerDBm, p.TxAntennaGainDB,
		p.RxAntennaGainDB, p.RxSensitivityDB, p.FadeMarginDB, p.RxHeightM,
	} {
		b = binary.LittleEndian.AppendUint32(b, math.Float32bits(v))
	}
	b = binary.LittleEndian.AppendUint32(b, p.RowOffset)
	b = binary.LittleEndian.AppendUint32(b, p.RowCount)
	b = binary.LittleEndian.AppendUint32(b, p.ElevRowsPerChunk)
	b = binary.LittleEndian.AppendUint32(b, p._pad0)
	return b
}

const marginsShaderWGSL = `
struct Params {
	zoom: f32,
	min_tile_x: f32,
	min_tile_y: f32,
	grid_width: u32,
	grid_height: u32,
	image_width: u32,
	image_height: u32,
	num_sites: u32,
	bounds_south: f32,
	bounds_north: f32,
	bounds_west: f32,
	bounds_east: f32,
	range_km: f32,
	frequency_mhz: f32,
	tx_power_dbm: f32,
	tx_antenna_gain_db: f32,
	rx_antenna_gain_db: f32,
	rx_sensitivity_db: f32,
	fade_margin_db: f32,
	rx_height_m: f32,
	row_offset: u32,
	row_count: u32,
	elev_rows_per_chunk: u32,
};

struct Site {
	lat: f32,
	lon: f32,
	tx_height_m: f32,
	_pad: f32,
};

@group(0) @binding(0) var<storage, read> params: Params;
// Elevation grid, chunked across up to 16 bindings — WebGPU caps any
// single buffer around 2GB, well under what a whole-Scotland grid needs
// at higher DEM zooms. Row r lives in chunk r/elev_rows_per_chunk, at
// local row r%elev_rows_per_chunk within that chunk — see elev_at below
// and the matching Go-side chunking in computeMarginsGPU.
@group(0) @binding(1) var<storage, read> elev0: array<f32>;
@group(0) @binding(2) var<storage, read> elev1: array<f32>;
@group(0) @binding(3) var<storage, read> elev2: array<f32>;
@group(0) @binding(4) var<storage, read> elev3: array<f32>;
@group(0) @binding(5) var<storage, read> elev4: array<f32>;
@group(0) @binding(6) var<storage, read> elev5: array<f32>;
@group(0) @binding(7) var<storage, read> elev6: array<f32>;
@group(0) @binding(8) var<storage, read> elev7: array<f32>;
@group(0) @binding(9) var<storage, read> elev8: array<f32>;
@group(0) @binding(10) var<storage, read> elev9: array<f32>;
@group(0) @binding(11) var<storage, read> elev10: array<f32>;
@group(0) @binding(12) var<storage, read> elev11: array<f32>;
@group(0) @binding(13) var<storage, read> elev12: array<f32>;
@group(0) @binding(14) var<storage, read> elev13: array<f32>;
@group(0) @binding(15) var<storage, read> elev14: array<f32>;
@group(0) @binding(16) var<storage, read> elev15: array<f32>;
@group(0) @binding(17) var<storage, read> sites: array<Site>;
@group(0) @binding(18) var<storage, read_write> margins: array<f32>;

fn elev_at(row: u32, col: u32) -> f32 {
	let chunk = row / params.elev_rows_per_chunk;
	let local_row = row % params.elev_rows_per_chunk;
	let idx = local_row * params.grid_width + col;
	if (chunk == 0u) { return elev0[idx]; }
	if (chunk == 1u) { return elev1[idx]; }
	if (chunk == 2u) { return elev2[idx]; }
	if (chunk == 3u) { return elev3[idx]; }
	if (chunk == 4u) { return elev4[idx]; }
	if (chunk == 5u) { return elev5[idx]; }
	if (chunk == 6u) { return elev6[idx]; }
	if (chunk == 7u) { return elev7[idx]; }
	if (chunk == 8u) { return elev8[idx]; }
	if (chunk == 9u) { return elev9[idx]; }
	if (chunk == 10u) { return elev10[idx]; }
	if (chunk == 11u) { return elev11[idx]; }
	if (chunk == 12u) { return elev12[idx]; }
	if (chunk == 13u) { return elev13[idx]; }
	if (chunk == 14u) { return elev14[idx]; }
	return elev15[idx];
}

const EARTH_RADIUS_M: f32 = 6371008.8;
const REFRACTION_K: f32 = 1.3333333333;
const SPEED_OF_LIGHT: f32 = 299792458.0;
const PI: f32 = 3.14159265358979323846;
const TILE_SIZE: f32 = 256.0;
const NO_COVERAGE: f32 = -3.0e38;

fn asinh_f32(x: f32) -> f32 {
	return log(x + sqrt(x * x + 1.0));
}

fn log10_f32(x: f32) -> f32 {
	return log(x) / log(10.0);
}

fn lon_to_tile_x(lon: f32) -> f32 {
	let n = exp2(params.zoom);
	return (lon + 180.0) / 360.0 * n;
}

fn lat_to_tile_y(lat: f32) -> f32 {
	let n = exp2(params.zoom);
	let lat_rad = lat * PI / 180.0;
	return (1.0 - asinh_f32(tan(lat_rad)) / PI) / 2.0 * n;
}

fn dem_at(lat: f32, lon: f32) -> f32 {
	let xf = lon_to_tile_x(lon) - params.min_tile_x;
	let yf = lat_to_tile_y(lat) - params.min_tile_y;
	let px_f = xf * TILE_SIZE;
	let py_f = yf * TILE_SIZE;

	let px = clamp(px_f, 0.0, f32(params.grid_width - 1u));
	let py = clamp(py_f, 0.0, f32(params.grid_height - 1u));

	let x0 = u32(px);
	let y0 = u32(py);
	let x1 = min(x0 + 1u, params.grid_width - 1u);
	let y1 = min(y0 + 1u, params.grid_height - 1u);
	let fx = px - f32(x0);
	let fy = py - f32(y0);

	let e00 = elev_at(y0, x0);
	let e10 = elev_at(y0, x1);
	let e01 = elev_at(y1, x0);
	let e11 = elev_at(y1, x1);

	let top = e00 + (e10 - e00) * fx;
	let bottom = e01 + (e11 - e01) * fx;
	return top + (bottom - top) * fy;
}

fn haversine_km(lat1: f32, lon1: f32, lat2: f32, lon2: f32) -> f32 {
	let rad = PI / 180.0;
	let d_lat = (lat2 - lat1) * rad;
	let d_lon = (lon2 - lon1) * rad;
	let a = sin(d_lat / 2.0) * sin(d_lat / 2.0) +
		cos(lat1 * rad) * cos(lat2 * rad) * sin(d_lon / 2.0) * sin(d_lon / 2.0);
	let c = 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
	return 6371.0088 * c;
}

fn fspl_db(distance_km_in: f32, freq_mhz: f32) -> f32 {
	var distance_km = distance_km_in;
	if (distance_km < 0.001) {
		distance_km = 0.001;
	}
	return 20.0 * log10_f32(distance_km) + 20.0 * log10_f32(freq_mhz) + 32.44;
}

fn knife_edge_diffraction_db(v: f32) -> f32 {
	if (v <= -0.78) {
		return 0.0;
	}
	return 6.9 + 20.0 * log10_f32(sqrt((v - 0.1) * (v - 0.1) + 1.0) + v - 0.1);
}

fn path_margin(tx_lat: f32, tx_lon: f32, tx_height_m: f32, rx_lat: f32, rx_lon: f32, distance_km: f32) -> f32 {
	let rx_ground_m = dem_at(rx_lat, rx_lon);
	let rx_height_asl = rx_ground_m + params.rx_height_m;

	let distance_m = distance_km * 1000.0;
	let wavelength_m = SPEED_OF_LIGHT / (params.frequency_mhz * 1e6);

	var samples = i32(distance_km / 0.05);
	if (samples < 8) {
		samples = 8;
	}
	if (samples > 300) {
		samples = 300;
	}

	var max_v: f32 = -3.0e38;
	for (var i: i32 = 1; i < samples; i = i + 1) {
		let frac = f32(i) / f32(samples);
		let lat = tx_lat + (rx_lat - tx_lat) * frac;
		let lon = tx_lon + (rx_lon - tx_lon) * frac;

		let d1m = distance_m * frac;
		let d2m = distance_m - d1m;

		let terrain_m = dem_at(lat, lon);
		let curvature_drop_m = (d1m * d2m) / (2.0 * REFRACTION_K * EARTH_RADIUS_M);
		let effective_terrain_m = terrain_m - curvature_drop_m;

		let direct_line_m = tx_height_m + (rx_height_asl - tx_height_m) * frac;
		let obstruction_m = effective_terrain_m - direct_line_m;

		let v = obstruction_m * sqrt((2.0 / wavelength_m) * (1.0 / d1m + 1.0 / d2m));
		if (v > max_v) {
			max_v = v;
		}
	}

	var loss = fspl_db(distance_km, params.frequency_mhz);
	if (max_v > -0.78) {
		loss = loss + knife_edge_diffraction_db(max_v);
	}

	let received = params.tx_power_dbm + params.tx_antenna_gain_db + params.rx_antenna_gain_db - loss;
	return received - params.rx_sensitivity_db - params.fade_margin_db;
}

// Each dispatch covers only params.row_count rows of the full raster,
// starting at params.row_offset — see the chunking comment on
// computeMarginsGPU in gpu.go. gid.y is local to the chunk (0..row_count);
// py is the row's position in the *full* raster, used for the lat/lon math,
// while the output buffer is only ever sized for one chunk at a time, so
// it's indexed by the local row.
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let px = gid.x;
	if (px >= params.image_width || gid.y >= params.row_count) {
		return;
	}
	let py = params.row_offset + gid.y;
	if (py >= params.image_height) {
		return;
	}
	let idx = gid.y * params.image_width + px;

	let lat = params.bounds_north - (f32(py) + 0.5) / f32(params.image_height) * (params.bounds_north - params.bounds_south);
	let lon = params.bounds_west + (f32(px) + 0.5) / f32(params.image_width) * (params.bounds_east - params.bounds_west);

	var best_margin: f32 = -3.0e38;
	for (var i: u32 = 0u; i < params.num_sites; i = i + 1u) {
		let s = sites[i];
		let d = haversine_km(lat, lon, s.lat, s.lon);
		if (d > params.range_km || d < 0.01) {
			continue;
		}
		let m = path_margin(s.lat, s.lon, s.tx_height_m, lat, lon, d);
		if (m > best_margin) {
			best_margin = m;
		}
	}

	if (best_margin < 0.0) {
		margins[idx] = NO_COVERAGE;
	} else {
		margins[idx] = best_margin;
	}
}
`
