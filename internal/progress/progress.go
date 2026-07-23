// Package progress writes progress.json for the frontend's progress bar,
// tracking per-stage completion, an ETA, and which compute backend
// (CPU/GPU/remote GPU) is serving the current stage.
package progress

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type state struct {
	Stage      string   `json:"stage"` // fetching_repeaters | loading_terrain | computing_coverage | fetching_reach_data | computing_coverage_calibrated | loading_precision_terrain | computing_coverage_precision | computing_coverage_calibrated_precision | done | error
	Done       int      `json:"done"`
	Total      int      `json:"total"`
	Percent    float64  `json:"percent"`
	Message    string   `json:"message"`
	UpdatedAt  string   `json:"updated_at"`
	EtaSeconds *float64 `json:"eta_seconds,omitempty"`
	// Backend: "cpu" | "gpu" | "remote_gpu" — which compute path is
	// actually serving the *current* computing_coverage* stage, set by
	// compute.Engine right before it commits to trying one. Empty outside
	// a computing_coverage* stage (nothing to report yet).
	Backend string `json:"backend,omitempty"`
}

// minSampleInterval bounds how often the rate is recomputed and the file
// rewritten. With many parallel workers, Update can be called dozens of
// times a second on tiny row-to-row windows — far too noisy to estimate a
// rate from. Aggregating over a larger interval gives each sample enough
// completed work to be statistically meaningful.
const minSampleInterval = 500 * time.Millisecond

// Writer writes progress.json for one coverage-generation run. Not safe
// for concurrent use by multiple runs (there's only ever one per process).
type Writer struct {
	path string

	mu             sync.Mutex
	currentStage   string
	currentBackend string
	lastSampleTime time.Time
	lastSampleDone int
	smoothedRate   float64 // units/sec, recency-weighted; 0 = not established yet
}

// New returns a Writer that writes progress.json under outputDir.
func New(outputDir string) *Writer {
	return &Writer{path: filepath.Join(outputDir, "progress.json")}
}

// SetBackend records which compute path is serving the current
// computing_coverage* stage — read by the next Update call. Cheap to call
// speculatively right before attempting a backend: if an attempt fails,
// the very next call here before the fallback attempt corrects it, and
// that fallback's own Update(0, total, ...) call restarts the visible
// progress from zero anyway, so there's no meaningful window where the
// label is wrong but progress is still moving.
func (w *Writer) SetBackend(b string) {
	w.mu.Lock()
	w.currentBackend = b
	w.mu.Unlock()
}

// LastBackend returns whichever backend was last reported via SetBackend —
// read by cmd/hopreach right after a tier's raster finishes, to record
// which backend served it in the analytics run history. For a chunked tier
// (Precision/Calibrated Precision) individual tiles can fall back between
// backends, so this reports whichever was reported *last*, a reasonable
// "what actually served most of this tier" approximation rather than a
// precise per-tile breakdown — the same simplification the live progress
// bar itself already makes.
func (w *Writer) LastBackend() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.currentBackend
}

// Update writes the current progress, including an ETA for the current
// stage. The ETA uses an exponentially-weighted recent rate sampled at
// most every minSampleInterval, rather than a cumulative since-stage-start
// average or a per-call instantaneous rate: work isn't uniform (e.g. a
// raster row over a city with a dozen nearby repeaters costs far more than
// one over empty terrain), and with many parallel workers individual
// Update calls arrive too close together to measure a meaningful rate
// from. Sampling over a larger, regular interval and then weighting
// recent samples more heavily converges to "how fast are we going right
// now" without the per-call noise.
func (w *Writer) Update(stage string, done, total int, message string) {
	w.mu.Lock()
	now := time.Now()
	forceWrite := false
	if stage != w.currentStage {
		w.currentStage = stage
		w.currentBackend = "" // a new stage hasn't picked a backend yet — don't carry over the previous stage's label
		w.lastSampleTime = now
		w.lastSampleDone = done
		w.smoothedRate = 0
		forceWrite = true
	} else if dt := now.Sub(w.lastSampleTime); dt >= minSampleInterval {
		if dDone := done - w.lastSampleDone; dDone > 0 {
			instantRate := float64(dDone) / dt.Seconds()
			const alpha = 0.4 // higher = trusts recent samples more, less smoothing
			if w.smoothedRate == 0 {
				w.smoothedRate = instantRate
			} else {
				w.smoothedRate = alpha*instantRate + (1-alpha)*w.smoothedRate
			}
		}
		w.lastSampleTime = now
		w.lastSampleDone = done
		forceWrite = true
	}
	rate := w.smoothedRate
	backend := w.currentBackend
	w.mu.Unlock()

	// Skip the file write entirely between samples (except stage transitions
	// and the final done/error call) — nothing meaningful changed anyway.
	if !forceWrite && done < total {
		return
	}

	pct := 0.0
	if total > 0 {
		pct = float64(done) / float64(total) * 100
	}

	var eta *float64
	if rate > 0 && total > done {
		remaining := float64(total-done) / rate
		eta = &remaining
	}

	s := state{
		Stage:      stage,
		Done:       done,
		Total:      total,
		Percent:    pct,
		Message:    message,
		UpdatedAt:  time.Now().UTC().Format(time.RFC3339),
		EtaSeconds: eta,
		Backend:    backend,
	}
	// Best-effort, non-atomic: this file is polled frequently during a long
	// run, so skip the write-tmp-then-rename dance and just overwrite it.
	if f, err := os.Create(w.path); err == nil {
		json.NewEncoder(f).Encode(s)
		f.Close()
	}
}
