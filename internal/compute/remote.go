package compute

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpujob"
	"hopreach/internal/propagation"
)

// remoteConfigured reports whether a broker address was configured at all —
// if not, Margins skips the remote branch entirely rather than making a
// doomed HTTP call to nothing on every single pass.
func (e *Engine) remoteConfigured() bool {
	return e.brokerAddr != ""
}

// remoteAvailable additionally confirms a worker is actually connected right
// now — used by Available (and hence the per-tier GPU-gating check), which
// needs to know before committing to a whole pass, not just after a submit
// attempt already failed.
func (e *Engine) remoteAvailable() bool {
	if !e.remoteConfigured() {
		return false
	}
	resp, err := http.Get(fmt.Sprintf("http://%s/gpu/status", e.brokerAddr))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var status struct {
		WorkerConnected bool `json:"worker_connected"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&status); err != nil {
		return false
	}
	return status.WorkerConnected
}

func (e *Engine) nextJobID() string {
	e.jobMu.Lock()
	defer e.jobMu.Unlock()
	e.jobSeq++
	return fmt.Sprintf("job-%d-%d", time.Now().UnixNano(), e.jobSeq)
}

// marginsRemote submits one whole coverage pass to the broker and blocks
// until the result arrives (or the broker's own job timeout fires and it
// responds with an error) — same "whole pass, one round trip" granularity as
// a local GPU pass, just over a network hop instead of a function call. The
// elevation grid itself is never sent — only bounds, sites, and propagation
// parameters; the worker fetches/caches its own DEM tiles from
// e.demTileURLBase, since a low-powered VPS likely also means a modest-
// bandwidth link not worth spending on shipping a multi-GB grid.
func (e *Engine) marginsRemote(grid *demgrid.Grid, sites []propagation.Site, bounds propagation.Bounds, imageWidth, imageHeight int, rangeKm float64, p propagation.Params, progressFn func(done, total int)) ([]float32, error) {
	job := gpujob.Job{
		ID:             e.nextJobID(),
		Sites:          sites,
		Bounds:         bounds,
		ImageWidth:     imageWidth,
		ImageHeight:    imageHeight,
		RangeKm:        rangeKm,
		Propagation:    p,
		DemZoom:        grid.Zoom,
		DemTileURLBase: e.demTileURLBase,
	}
	body, err := json.Marshal(job)
	if err != nil {
		return nil, fmt.Errorf("remote GPU: encoding job: %w", err)
	}

	if progressFn != nil {
		progressFn(0, imageHeight)
	}
	resp, err := http.Post(fmt.Sprintf("http://%s/gpu/submit", e.brokerAddr), "application/json", bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("remote GPU: submitting job: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var errResp gpujob.Result
		_ = json.NewDecoder(resp.Body).Decode(&errResp)
		if errResp.Error != "" {
			return nil, fmt.Errorf("remote GPU: %s", errResp.Error)
		}
		return nil, fmt.Errorf("remote GPU: broker returned status %d", resp.StatusCode)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("remote GPU: reading result: %w", err)
	}
	if len(data) != imageWidth*imageHeight*4 {
		return nil, fmt.Errorf("remote GPU: result size %d doesn't match expected %d", len(data), imageWidth*imageHeight*4)
	}
	margins := gpujob.BytesToFloat32LE(data)
	if progressFn != nil {
		progressFn(imageHeight, imageHeight)
	}
	return margins, nil
}
