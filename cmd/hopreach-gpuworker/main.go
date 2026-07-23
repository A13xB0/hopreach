// Command gpuworker is the remote-GPU counterpart to the VPS-side broker
// (cmd/hopreach-shareapi's gpubroker routes): it runs on a machine that actually has
// a GPU (this project's own dev/test box, for instance), connects *out* to
// the broker over WebSocket (the worker is expected to be behind NAT with
// no public IP — outbound-initiated is the only practical option), and
// executes whatever coverage-pass jobs the VPS hands it.
//
// Deliberately never trusts the local GPU without verifying it first —
// same discipline as the main binary's compute.Engine.Setup: init, verify against the
// CPU reference on a synthetic fixture, and refuse to even start (let alone
// connect and accept real jobs) if that fails.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpucompute"
	"hopreach/internal/gpujob"
	"hopreach/internal/propagation"
	"hopreach/internal/sysinfo"
)

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvFloat(key string, fallback float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		log.Printf("invalid %s=%q, using default %v", key, v, fallback)
		return fallback
	}
	return f
}

// progressSendInterval throttles how often a Progress frame goes out over
// the WebSocket while ComputeMargins' own dispatch loop reports rows done —
// that loop can report far more often than is useful to relay over the
// network, and every dropped frame here just costs one fewer UI update,
// never correctness (the final Result always arrives regardless). Same
// rationale/value as internal/progress.Writer's own minSampleInterval.
const progressSendInterval = 500 * time.Millisecond

// helloInterval is how often runConnection re-sends its Hello heartbeat
// after the initial one — frequent enough that the analytics memory graph
// (internal/analytics.MemorySample) gets a reasonably continuous picture of
// this box over a long-lived connection, infrequent enough that it's noise
// on the wire compared to an actual job's traffic.
const helloInterval = 2 * time.Minute

// buildHello reads this box's current available memory plus its (static,
// rarely-changing) total memory/CPU/GPU description, for both the initial
// Hello and each heartbeat resend. Best-effort throughout: any field that
// can't be determined (non-Linux, etc.) is just left at its zero value —
// callers already treat 0/"" as "unknown" rather than a real value.
func buildHello(be *gpucompute.Backend) gpujob.Hello {
	h := gpujob.Hello{Kind: gpujob.KindHello, GPUAdapter: be.AdapterID}
	if v, err := sysinfo.AvailableMemoryBytes(); err == nil {
		h.AvailableBytes = v
	} else {
		log.Printf("gpuworker: could not determine available memory (%v), reporting unknown", err)
	}
	if v, err := sysinfo.TotalMemoryBytes(); err == nil {
		h.TotalBytes = v
	}
	if v, err := sysinfo.CPUModel(); err == nil {
		h.CPUModel = v
	}
	return h
}

// writeMessage serializes writes to conn: gorilla/websocket connections
// aren't safe for concurrent writers, but this worker now has two
// (runConnection's own result/error writes and the Hello heartbeat ticker
// started alongside it), so every write anywhere in this file goes through
// here rather than calling conn.WriteMessage directly.
func writeMessage(conn *websocket.Conn, mu *sync.Mutex, msgType int, data []byte) error {
	mu.Lock()
	defer mu.Unlock()
	return conn.WriteMessage(msgType, data)
}

func processJob(be *gpucompute.Backend, mu *sync.Mutex, cacheDir string, httpClient *http.Client, job gpujob.Job, conn *websocket.Conn) (margins []byte, err error) {
	// DemBounds (padded by the job's range so a site/path near the edge of
	// Bounds still sees real terrain beyond it) is what this worker should
	// actually fetch — see the field comment on gpujob.Job. Falls back to
	// the exact output Bounds for any submitter that predates the field.
	demBounds := job.DemBounds
	if demBounds == (propagation.Bounds{}) {
		demBounds = job.Bounds
	}
	bounds := demgrid.Bounds{South: demBounds.South, North: demBounds.North, West: demBounds.West, East: demBounds.East}
	grid, err := demgrid.Load(bounds, job.DemZoom, cacheDir, job.DemTileURLBase, httpClient, func(done, total int) {
		if done == total {
			log.Printf("gpuworker: job %s: terrain loaded (%d tiles)", job.ID, total)
		}
	})
	if err != nil {
		return nil, err
	}
	defer grid.Close()

	var lastSent time.Time
	out, err := gpucompute.ComputeMargins(be, grid, job.Sites, job.Bounds, job.ImageWidth, job.ImageHeight, job.RangeKm, job.Propagation, func(done, total int) {
		now := time.Now()
		if done < total && now.Sub(lastSent) < progressSendInterval {
			return
		}
		lastSent = now
		body, merr := json.Marshal(gpujob.Progress{Kind: gpujob.KindProgress, ID: job.ID, Done: done, Total: total})
		if merr != nil {
			return
		}
		// Best-effort: a failed write here just means one missed progress
		// update, not a failed job — the caller's own conn.ReadMessage loop
		// is what actually detects a genuinely dead connection.
		_ = writeMessage(conn, mu, websocket.TextMessage, body)
	})
	if err != nil {
		return nil, err
	}
	return gpujob.Float32ToBytesLE(out), nil
}

func runConnection(wsURL, token, cacheDir string, be *gpucompute.Backend, httpClient *http.Client) error {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	header := http.Header{"Authorization": {"Bearer " + token}}
	conn, _, err := dialer.Dial(wsURL, header)
	if err != nil {
		return err
	}
	defer conn.Close()
	log.Printf("gpuworker: connected to broker at %s", wsURL)

	var writeMu sync.Mutex
	sendHello := func() {
		body, err := json.Marshal(buildHello(be))
		if err != nil {
			return
		}
		if err := writeMessage(conn, &writeMu, websocket.TextMessage, body); err != nil {
			log.Printf("gpuworker: sending hello failed: %v", err)
		}
	}

	// Report memory/hardware info once up front so the batch job can size
	// MarginsChunked's per-tile budget against this box's actual RAM
	// instead of a fixed guess (see gpujob.Hello), then keep re-sending it
	// every helloInterval for as long as the connection stays up so the
	// analytics memory graph and hardware panel don't go stale on a
	// long-lived connection. Stopped via done when this connection ends.
	sendHello()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(helloInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sendHello()
			case <-done:
				return
			}
		}
	}()

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if msgType != websocket.TextMessage {
			continue
		}
		var job gpujob.Job
		if err := json.Unmarshal(data, &job); err != nil {
			log.Printf("gpuworker: malformed job from broker: %v", err)
			continue
		}
		log.Printf("gpuworker: job %s: %dx%d, %d sites, DEM zoom %d", job.ID, job.ImageWidth, job.ImageHeight, len(job.Sites), job.DemZoom)

		margins, jobErr := processJob(be, &writeMu, cacheDir, httpClient, job, conn)
		if jobErr != nil {
			log.Printf("gpuworker: job %s failed: %v", job.ID, jobErr)
			resultBody, _ := json.Marshal(gpujob.Result{Kind: gpujob.KindResult, ID: job.ID, Error: jobErr.Error()})
			if err := writeMessage(conn, &writeMu, websocket.TextMessage, resultBody); err != nil {
				return err
			}
			continue
		}

		resultBody, _ := json.Marshal(gpujob.Result{Kind: gpujob.KindResult, ID: job.ID})
		if err := writeMessage(conn, &writeMu, websocket.TextMessage, resultBody); err != nil {
			return err
		}
		if err := writeMessage(conn, &writeMu, websocket.BinaryMessage, margins); err != nil {
			return err
		}
		log.Printf("gpuworker: job %s done", job.ID)
	}
}

func main() {
	wsURL := getEnv("GPU_BROKER_WS_URL", "")
	token := getEnv("GPU_WORKER_TOKEN", "")
	cacheDir := getEnv("DEM_CACHE_DIR", "dem-cache")
	reconnectSeconds := getEnvFloat("GPU_WORKER_RECONNECT_SECONDS", 10)

	if wsURL == "" || token == "" {
		log.Fatal("gpuworker: GPU_BROKER_WS_URL and GPU_WORKER_TOKEN must both be set")
	}

	be, err := gpucompute.Init()
	if err != nil {
		log.Fatalf("gpuworker: GPU init failed, refusing to start: %v", err)
	}
	if err := gpucompute.Verify(be); err != nil {
		log.Fatalf("gpuworker: GPU output didn't match the CPU reference on a verification fixture, refusing to trust it: %v", err)
	}
	log.Printf("gpuworker: GPU ready (%s)", be.AdapterID)

	httpClient := &http.Client{Timeout: 30 * time.Second}

	for {
		if err := runConnection(wsURL, token, cacheDir, be, httpClient); err != nil {
			log.Printf("gpuworker: connection lost: %v — reconnecting in %.0fs", err, reconnectSeconds)
		}
		time.Sleep(time.Duration(reconnectSeconds * float64(time.Second)))
	}
}
