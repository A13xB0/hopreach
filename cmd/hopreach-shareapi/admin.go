// Local-only admin route to trigger an immediate coverage recompute without
// restarting this process. Restarting would drop any live remote GPU
// worker WebSocket connection (see gpubroker.go), forcing a reconnect that
// races whatever coverage pass happens to start first — a pass already
// past its "which backend am I using" decision keeps running on whatever
// it already picked, so a restart-triggered recompute can easily still end
// up on CPU even though a GPU worker is genuinely available moments later.
// Spawning a fresh hopreach process instead leaves this process (and its
// broker connection) completely untouched.
//
// Deliberately unauthenticated: the safety boundary is that this is never
// reachable except via `docker exec` on the host already running this
// container (see docker/default.conf.template — nginx never proxies
// /admin/*, and share.listen_addr is loopback-only), not a bearer token.
// Anyone who already has shell access to the host has full control anyway.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sync"
)

// hopreachBinary matches the path the Docker image's entrypoint/cron jobs
// already invoke (see docker/entrypoint.sh) — this is Docker-deployment
// specific, same as this whole file's premise.
const hopreachBinary = "/app/hopreach"

var (
	recomputeMu      sync.Mutex
	recomputeRunning bool
)

func handleRecompute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	recomputeMu.Lock()
	if recomputeRunning {
		recomputeMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]string{"status": "already running"})
		return
	}
	recomputeRunning = true
	recomputeMu.Unlock()

	go runRecompute()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	json.NewEncoder(w).Encode(map[string]string{"status": "started"})
}

func runRecompute() {
	defer func() {
		recomputeMu.Lock()
		recomputeRunning = false
		recomputeMu.Unlock()
	}()

	// -force guarantees a run happens now (bypassing
	// coverage.min_recompute_interval_hours) — it does NOT force every
	// tier to recompute from scratch: a tier that already finished earlier
	// today is left as-is (see cmd/hopreach/output.go's tierFreshToday).
	// That's the intended behaviour here too — this endpoint exists to
	// pick up fresh repeater data / a config change on demand, not to
	// redo an expensive Precision pass that just ran a few hours ago.
	cmd := exec.Command(hopreachBinary, "-force")
	// Same log file the cron-triggered run writes to (see
	// docker/entrypoint.sh) — one place to look regardless of what
	// triggered a given run. hopreach's own lock file (cmd/hopreach/lock.go)
	// is what actually prevents this from overlapping a concurrent cron or
	// startup run, not anything here.
	if out, err := os.OpenFile("/var/log/fetch.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		defer out.Close()
		cmd.Stdout = out
		cmd.Stderr = out
	}
	log.Printf("shareapi: recompute: starting %s -force", hopreachBinary)
	if err := cmd.Run(); err != nil {
		log.Printf("shareapi: recompute: %v", err)
		return
	}
	log.Printf("shareapi: recompute: finished")
}
