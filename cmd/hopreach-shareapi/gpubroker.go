// Remote GPU broker: relays coverage-compute jobs between the batch job
// (/app/hopreach, same container, calling POST /gpu/submit over
// localhost) and a remote GPU worker (cmd/hopreach-gpuworker, a separate container
// on a different machine, connected over WebSocket at GET /gpu-worker,
// proxied by nginx since it's the one part of this that needs to be
// reachable from outside).
//
// Deliberately simple: exactly one worker connection at a time (a new one
// replaces whatever was there, logged) and exactly one job in flight at a
// time (the batch job submits passes sequentially, never concurrently) —
// matches the actual usage pattern rather than building out a queue this
// project doesn't need yet.
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"hopreach/internal/gpujob"
)

var gpuUpgrader = websocket.Upgrader{
	// No origin check: this isn't a browser client, it's a purpose-built
	// worker binary presenting a bearer token — CheckOrigin's browser-CSRF
	// threat model doesn't apply here.
	CheckOrigin: func(r *http.Request) bool { return true },
}

type gpuJobResult struct {
	margins []byte
	err     string
}

type jobProgress struct{ done, total int }

type gpuBroker struct {
	mu             sync.Mutex
	conn           *websocket.Conn
	writeMu        sync.Mutex // serializes writes to conn, separate from mu so a slow write doesn't block status/pending bookkeeping
	pending        map[string]chan gpuJobResult
	progress       map[string]jobProgress // updated as Progress frames arrive, read by /gpu/progress; cleared once a job is delivered
	availableBytes uint64                 // 0 = unknown, either never reported or the current worker predates Hello — see setAvailableBytes
}

var broker = &gpuBroker{
	pending:  make(map[string]chan gpuJobResult),
	progress: make(map[string]jobProgress),
}

// Default is generous (30 min), not a few seconds' safety margin: a large
// Precision-tier job on a worker with a cold DEM tile cache can spend
// several minutes just fetching tiles from the upstream source before GPU
// compute even starts (observed in practice: ~7 minutes for a whole-
// Scotland zoom-13 grid on a fresh cache) — a short timeout here would
// silently discard an otherwise-successful remote result and fall back to
// CPU for no good reason, defeating the point of having a worker at all.
func gpuJobTimeout() time.Duration {
	f := cfg.RemoteWorker.JobTimeoutSeconds
	if f <= 0 {
		f = 1800
	}
	return time.Duration(f * float64(time.Second))
}

func (b *gpuBroker) connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.conn != nil
}

func (b *gpuBroker) setConn(c *websocket.Conn) (old *websocket.Conn) {
	b.mu.Lock()
	defer b.mu.Unlock()
	old = b.conn
	b.conn = c
	// A new (or no) connection means whatever was previously reported is no
	// longer trustworthy — a replacement worker could be a different box
	// entirely, and no connection at all means no worker to size tiles
	// against. The new connection's own Hello (if any) will set this again.
	b.availableBytes = 0
	return old
}

// setAvailableBytes records the worker's self-reported available memory
// (see gpujob.Hello) — read by handleGPUStatus, and from there by
// compute.Engine's chunk-budget auto-sizing.
func (b *gpuBroker) setAvailableBytes(n uint64) {
	b.mu.Lock()
	b.availableBytes = n
	b.mu.Unlock()
}

func (b *gpuBroker) getAvailableBytes() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.availableBytes
}

// failAllPending is called when the worker connection is lost — any job
// still awaiting a result from it needs to fail now rather than have
// /gpu/submit hang until its own timeout, since there's no longer any
// chance of an answer arriving.
func (b *gpuBroker) failAllPending(reason string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, ch := range b.pending {
		ch <- gpuJobResult{err: reason}
		delete(b.pending, id)
		delete(b.progress, id)
	}
}

func (b *gpuBroker) deliver(id string, margins []byte, errMsg string) {
	b.mu.Lock()
	ch, ok := b.pending[id]
	if ok {
		delete(b.pending, id)
	}
	delete(b.progress, id)
	b.mu.Unlock()
	if ok {
		ch <- gpuJobResult{margins: margins, err: errMsg}
	}
}

// setProgress records the latest (done, total) reported for an in-flight
// job — see handleGPUProgress, polled by internal/compute's remote-dispatch
// path while it waits on /gpu/submit.
func (b *gpuBroker) setProgress(id string, done, total int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	// Only meaningful for a job this broker actually still considers
	// in-flight — a stray/late Progress frame for an already-delivered (or
	// never-submitted) job ID shouldn't resurrect a map entry nothing will
	// ever clean up.
	if _, ok := b.pending[id]; ok {
		b.progress[id] = jobProgress{done: done, total: total}
	}
}

func (b *gpuBroker) getProgress(id string) (done, total int, ok bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, ok := b.progress[id]
	return p.done, p.total, ok
}

// submit sends job to the connected worker and blocks until a result
// arrives or timeout elapses. Returns an error (never blocks forever) if
// no worker is connected, the send fails, or nothing comes back in time.
func (b *gpuBroker) submit(job gpujob.Job, timeout time.Duration) ([]byte, error) {
	b.mu.Lock()
	conn := b.conn
	if conn == nil {
		b.mu.Unlock()
		return nil, fmt.Errorf("no GPU worker connected")
	}
	resultCh := make(chan gpuJobResult, 1)
	b.pending[job.ID] = resultCh
	b.mu.Unlock()

	body, err := json.Marshal(job)
	if err != nil {
		b.mu.Lock()
		delete(b.pending, job.ID)
		b.mu.Unlock()
		return nil, fmt.Errorf("encoding job: %w", err)
	}

	b.writeMu.Lock()
	writeErr := conn.WriteMessage(websocket.TextMessage, body)
	b.writeMu.Unlock()
	if writeErr != nil {
		b.mu.Lock()
		delete(b.pending, job.ID)
		b.mu.Unlock()
		return nil, fmt.Errorf("sending job to worker: %w", writeErr)
	}

	select {
	case res := <-resultCh:
		if res.err != "" {
			return nil, fmt.Errorf("worker reported: %s", res.err)
		}
		return res.margins, nil
	case <-time.After(timeout):
		b.mu.Lock()
		delete(b.pending, job.ID)
		b.mu.Unlock()
		return nil, fmt.Errorf("timed out after %s waiting for worker", timeout)
	}
}

// readLoop owns one worker connection for its lifetime. Two kinds of JSON
// text frame arrive: zero or more Progress frames while a job is still
// computing, then exactly one terminal Result frame, immediately followed
// (only if Result.Error is empty) by one binary frame of raw little-endian
// float32 margins. Strict ordering is safe here specifically because only
// one job is ever in flight at a time (see the package comment).
func (b *gpuBroker) readLoop(conn *websocket.Conn) {
	defer conn.Close()
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			if old := b.setConn(nil); old == conn {
				log.Printf("gpubroker: worker disconnected: %v", err)
			}
			b.failAllPending(fmt.Sprintf("worker disconnected: %v", err))
			return
		}
		if msgType != websocket.TextMessage {
			continue
		}

		var head struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(data, &head); err != nil {
			log.Printf("gpubroker: malformed message from worker: %v", err)
			continue
		}

		if head.Kind == gpujob.KindHello {
			var h gpujob.Hello
			if err := json.Unmarshal(data, &h); err != nil {
				log.Printf("gpubroker: malformed hello frame from worker: %v", err)
				continue
			}
			b.setAvailableBytes(h.AvailableBytes)
			log.Printf("gpubroker: worker reports %.1fGB available memory", float64(h.AvailableBytes)/1e9)
			continue
		}

		if head.Kind == gpujob.KindProgress {
			var p gpujob.Progress
			if err := json.Unmarshal(data, &p); err != nil {
				log.Printf("gpubroker: malformed progress frame from worker: %v", err)
				continue
			}
			b.setProgress(p.ID, p.Done, p.Total)
			continue
		}

		var result gpujob.Result
		if err := json.Unmarshal(data, &result); err != nil {
			log.Printf("gpubroker: malformed result from worker: %v", err)
			continue
		}
		if result.Error != "" {
			b.deliver(result.ID, nil, result.Error)
			continue
		}
		_, margins, err := conn.ReadMessage()
		if err != nil {
			if old := b.setConn(nil); old == conn {
				log.Printf("gpubroker: worker disconnected mid-result: %v", err)
			}
			b.failAllPending(fmt.Sprintf("worker disconnected mid-result: %v", err))
			return
		}
		b.deliver(result.ID, margins, "")
	}
}

// handleGPUWorkerConnect upgrades a WebSocket connection from a remote GPU
// worker. Requires GPU_WORKER_TOKEN to match — this endpoint is reachable
// from the public internet (nginx proxies it), so it's a real trust
// boundary: whoever holds the token can feed data into the live public
// coverage map. Never registered at all if the token isn't configured (see
// main.go) rather than defaulting to an open endpoint.
func handleGPUWorkerConnect(requiredToken string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("Authorization")
		if got != "Bearer "+requiredToken {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		conn, err := gpuUpgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("gpubroker: websocket upgrade failed: %v", err)
			return
		}
		if old := broker.setConn(conn); old != nil {
			log.Printf("gpubroker: new worker connection replacing a previous one")
			old.Close()
		} else {
			log.Printf("gpubroker: GPU worker connected")
		}
		go broker.readLoop(conn)
	}
}

// handleGPUSubmit is local-only in practice (never proxied by nginx — only
// /app/hopreach, in the same container, ever calls it) — takes one whole
// coverage pass's job description and blocks until the worker's result
// arrives, returning the margins as raw octet-stream bytes.
func handleGPUSubmit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var job gpujob.Job
	if err := json.NewDecoder(r.Body).Decode(&job); err != nil {
		http.Error(w, "invalid job JSON", http.StatusBadRequest)
		return
	}
	margins, err := broker.submit(job, gpuJobTimeout())
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		if err.Error() == "no GPU worker connected" {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusInternalServerError)
		}
		json.NewEncoder(w).Encode(gpujob.Result{ID: job.ID, Error: err.Error()})
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Write(margins)
}

// handleGPUProgress reports the latest (done, total) reported for an
// in-flight job — local-only in practice, same as handleGPUSubmit, polled
// by internal/compute's remote-dispatch path while its one blocking
// /gpu/submit call for the same job ID is still outstanding. Not an error
// if nothing's tracked yet (a job that hasn't reported any progress frames
// yet, or one that already finished) — just reports zeros, same as the
// "haven't started" state every other compute path already reports before
// its first real sample.
func handleGPUProgress(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	done, total, _ := broker.getProgress(id)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"done": done, "total": total})
}

// handleGPUStatus reports whether a worker is currently connected — used
// both by the remote-dispatch path (skip the doomed /gpu/submit call
// entirely if nothing's connected) and the per-tier GPU-gating check in
// main.go (decide whether to attempt a gated tier at all). available_bytes
// is the connected worker's self-reported available memory (see
// gpujob.Hello), 0 if unknown (no worker connected, or a worker that
// predates Hello) — read by compute.Engine's chunk-budget auto-sizing.
func handleGPUStatus(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"worker_connected": broker.connected(),
		"available_bytes":  broker.getAvailableBytes(),
	})
}
