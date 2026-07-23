// Package compute is the single entry point every coverage pass goes
// through to turn a DEM grid + site list into a margins array: local GPU via
// internal/gpucompute (WebGPU/wgpu-native on Vulkan), then a network-
// connected remote GPU worker (see remote.go), then CPU
// (propagation.ComputeMarginsCPU) as the always-correct fallback. GPU is
// only ever trusted after producing output that matches CPU within
// tolerance (see gpucompute.Verify).
//
// Engine holds the state that used to live as package-level globals in the
// original gpu.go/gpuworker.go (gpuBE, gpuForced, gpuBrokerAddr,
// activeProgress, ...) — an explicit struct instead lets a future caller
// (e.g. a test, or a process handling more than one concurrent run) have
// more than one, and avoids hidden shared state between them.
package compute

import (
	"log"
	"sync"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpucompute"
	"hopreach/internal/progress"
	"hopreach/internal/propagation"
)

// Engine dispatches coverage passes across local GPU, remote GPU, and CPU.
// Not safe for concurrent Setup/SetRemote calls, but Margins itself may be
// called concurrently once setup is complete (mirrors the original
// package-global design, which only ever had one setup call at startup).
type Engine struct {
	localOnce sync.Once
	localBE   *gpucompute.Backend
	forced    bool // mode "gpu": failures are hard errors, not silent fallback

	gpuLogOnce     sync.Once
	gpuSizeLogOnce sync.Once
	remoteLogOnce  sync.Once

	brokerAddr     string // e.g. "127.0.0.1:8081"; empty disables the remote-GPU path
	demTileURLBase string // upstream DEM tile source, passed to the remote worker verbatim
	jobSeq         int64
	jobMu          sync.Mutex

	// progress, if set, lets Margins report which backend is serving the
	// current pass without needing the progress callback's own signature to
	// carry that.
	progress *progress.Writer

	// chunkBudgetBytes overrides defaultChunkGridBudgetBytes for
	// MarginsChunked — see SetChunkBudgetBytes. Zero (the default) means
	// "use the built-in default".
	chunkBudgetBytes float64
}

// New returns an unconfigured Engine. Call Setup (and optionally SetRemote,
// SetProgress) before using it.
func New() *Engine {
	return &Engine{}
}

// SetProgress attaches a progress.Writer that Margins reports the active
// backend to. Optional — a nil/unset progress writer just means no backend
// label is reported.
func (e *Engine) SetProgress(w *progress.Writer) {
	e.progress = w
}

// SetRemote configures the remote-GPU-worker broker address (host:port) and
// the DEM tile URL base the remote worker should fetch its own elevation
// data from. An empty brokerAddr disables the remote path entirely.
func (e *Engine) SetRemote(brokerAddr, demTileURLBase string) {
	e.brokerAddr = brokerAddr
	e.demTileURLBase = demTileURLBase
}

// SetChunkBudgetBytes overrides MarginsChunked's automatic per-tile memory
// budget sizing (see Engine.effectiveChunkBudgetBytes) with an explicit
// value. Optional — bytes <= 0 (the zero value, i.e. never called) leaves
// auto-sizing in effect, which is the right default for most deployments;
// this exists for a deployment that needs to force a specific value (e.g.
// a box whose real headroom isn't accurately reflected by available
// memory alone), not as something every config needs to set.
func (e *Engine) SetChunkBudgetBytes(bytes float64) {
	e.chunkBudgetBytes = bytes
}

func (e *Engine) reportBackend(label string) {
	if e.progress != nil {
		e.progress.SetBackend(label)
	}
}

// Setup initializes the local WebGPU backend according to mode
// ("auto"|"cpu"|"gpu") and, for "auto"/"gpu", verifies its output against
// the CPU path on a small fixture before it's ever trusted for real output.
// Safe to call once at startup; failures are logged (never panics) and
// simply leave the local backend unset, so Margins falls back to remote/CPU
// for every pass. Errors are only fatal when mode is "gpu" (forced).
func (e *Engine) Setup(mode string) {
	e.localOnce.Do(func() {
		if mode == "cpu" {
			log.Printf("coverage: gpu.mode=cpu, skipping GPU probe")
			return
		}
		e.forced = mode == "gpu"

		be, err := gpucompute.Init()
		if err != nil {
			if e.forced {
				log.Fatalf("coverage: gpu.mode=gpu but GPU init failed: %v", err)
			}
			log.Printf("coverage: GPU unavailable, using CPU (%v)", err)
			return
		}

		if err := gpucompute.Verify(be); err != nil {
			if e.forced {
				log.Fatalf("coverage: gpu.mode=gpu but GPU/CPU outputs diverge, refusing to trust it: %v", err)
			}
			log.Printf("coverage: GPU output didn't match CPU on a verification fixture, using CPU instead (%v)", err)
			return
		}

		log.Printf("coverage: GPU compute enabled (%s)", be.AdapterID)
		e.localBE = be
	})
}

// Available reports whether GPU compute is usable right now, local or
// remote — used by the per-tier COVERAGE_*_REQUIRES_GPU gate to decide
// whether to attempt a gated tier at all, before committing to a whole pass.
func (e *Engine) Available() bool {
	return e.localBE != nil || e.remoteAvailable()
}

// LocalAdapterID returns the local GPU's adapter description (as reported by
// gpucompute.Init), or "" if this box has no usable local GPU — read once by
// cmd/hopreach after Setup to record this box's hardware for the analytics
// page, the same adapter string cmd/hopreach-gpuworker reports for a remote
// box via gpujob.Hello.
func (e *Engine) LocalAdapterID() string {
	if e.localBE == nil {
		return ""
	}
	return e.localBE.AdapterID
}

// Margins is the single entry point coverage.Raster*() uses instead of
// calling propagation.ComputeMarginsCPU directly. Tried in order: local GPU,
// then a connected remote GPU worker (if configured), then CPU. Each
// failure falls through to the next exactly like the original local-GPU-
// only fallback did — no change to that trust model, just one more rung
// before giving up on GPU entirely. Errors are only fatal when mode "gpu"
// was forced via Setup (local GPU only; a forced-GPU config doesn't apply
// to the optional remote path).
func (e *Engine) Margins(grid *demgrid.Grid, sites []propagation.Site, bounds propagation.Bounds, imageWidth, imageHeight int, rangeKm float64, p propagation.Params, progressFn func(done, total int)) []float32 {
	if e.localBE != nil {
		// The elevation grid is uploaded in row-chunks, so WebGPU's ~2GB
		// single-buffer ceiling isn't a reason to avoid the GPU by itself —
		// only a genuinely enormous grid, beyond what MaxElevChunks chunks
		// can cover, falls back here.
		elevBytes := uint64(len(grid.Elev)) * 4
		limit := uint64(gpucompute.MaxElevChunks * gpucompute.ElevChunkBudgetBytes)
		if elevBytes > limit {
			if e.forced {
				log.Fatalf("coverage: gpu.mode=gpu but this grid (%d bytes) exceeds what chunking supports (%d bytes across %d chunks) — lower coverage.precision_dem_zoom or use gpu.mode: auto/cpu", elevBytes, limit, gpucompute.MaxElevChunks)
			}
			e.gpuSizeLogOnce.Do(func() {
				log.Printf("coverage: grid (%d bytes) exceeds what GPU chunking supports (%d bytes), using CPU for passes at this resolution", elevBytes, limit)
			})
		} else {
			e.reportBackend("gpu")
			if progressFn != nil {
				progressFn(0, imageHeight)
			}
			margins, err := gpucompute.ComputeMargins(e.localBE, grid, sites, bounds, imageWidth, imageHeight, rangeKm, p, progressFn)
			if err == nil {
				if progressFn != nil {
					progressFn(imageHeight, imageHeight)
				}
				return margins
			}
			if e.forced {
				log.Fatalf("coverage: GPU dispatch failed (gpu.mode=gpu, not falling back): %v", err)
			}
			e.gpuLogOnce.Do(func() {
				log.Printf("coverage: GPU dispatch failed, falling back to CPU for this and future passes: %v", err)
			})
			e.localBE = nil // don't keep retrying a backend that just failed
		}
	}

	if e.remoteConfigured() {
		e.reportBackend("remote_gpu")
		margins, err := e.marginsRemote(grid, sites, bounds, imageWidth, imageHeight, rangeKm, p, progressFn)
		if err == nil {
			return margins
		}
		e.remoteLogOnce.Do(func() {
			log.Printf("coverage: remote GPU worker dispatch failed, falling back to CPU for this pass: %v", err)
		})
	}

	e.reportBackend("cpu")
	return propagation.ComputeMarginsCPU(grid, sites, bounds, imageWidth, imageHeight, rangeKm, p, progressFn)
}
