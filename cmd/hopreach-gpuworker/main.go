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
	"time"

	"github.com/gorilla/websocket"

	"hopreach/internal/demgrid"
	"hopreach/internal/gpucompute"
	"hopreach/internal/gpujob"
	"hopreach/internal/propagation"
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

func processJob(be *gpucompute.Backend, cacheDir string, httpClient *http.Client, job gpujob.Job, conn *websocket.Conn) (margins []byte, err error) {
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
		// Best-effort: this connection is only ever used by this one
		// goroutine (one job at a time, no concurrent writer), but a
		// failed write here just means one missed progress update, not a
		// failed job — the caller's own conn.ReadMessage loop is what
		// actually detects a genuinely dead connection.
		_ = conn.WriteMessage(websocket.TextMessage, body)
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

		margins, jobErr := processJob(be, cacheDir, httpClient, job, conn)
		if jobErr != nil {
			log.Printf("gpuworker: job %s failed: %v", job.ID, jobErr)
			resultBody, _ := json.Marshal(gpujob.Result{Kind: gpujob.KindResult, ID: job.ID, Error: jobErr.Error()})
			if err := conn.WriteMessage(websocket.TextMessage, resultBody); err != nil {
				return err
			}
			continue
		}

		resultBody, _ := json.Marshal(gpujob.Result{Kind: gpujob.KindResult, ID: job.ID})
		if err := conn.WriteMessage(websocket.TextMessage, resultBody); err != nil {
			return err
		}
		if err := conn.WriteMessage(websocket.BinaryMessage, margins); err != nil {
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
