// Command shareapi is a small standalone HTTP server for sharing planning
// tool plans via a short link. It stores only plan structure (repeater
// positions, labels, hop chains, notes) — never a rendered coverage raster,
// since that's cheap to recompute client-side and would only go stale.
//
// Two modes:
//   - default: serve POST/GET /api/plans (proxied by nginx at the same
//     path, so this only needs to listen on localhost)
//   - -prune: one-shot cleanup of anything older than the TTL, meant to be
//     run daily by cron alongside the main coverage fetch job
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"hopreach/internal/analytics"
	yconfig "hopreach/internal/config"
)

const maxPlanBytes = 256 * 1024 // plans are just repeater lists + labels; this is generous

type storedPlan struct {
	CreatedAt string          `json:"created_at"`
	Plan      json.RawMessage `json:"plan"`
}

// cfg is set once at startup in main() — this binary, like the original
// getEnv-based version, only ever has one configuration for its lifetime.
var cfg yconfig.Config

func storeDir() string {
	return cfg.Share.StoreDir
}

func ttlDays() float64 {
	return cfg.Share.TTLDays
}

func randomID() (string, error) {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func planPath(dir, id string) (string, bool) {
	// id comes straight from the URL path; reject anything that isn't a
	// plain hex token before it ever touches the filesystem.
	if len(id) == 0 || len(id) > 32 {
		return "", false
	}
	for _, c := range id {
		if !strings.ContainsRune("0123456789abcdef", c) {
			return "", false
		}
	}
	return filepath.Join(dir, id+".json"), true
}

func handleCreate(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPlanBytes+1))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	if len(body) > maxPlanBytes {
		http.Error(w, "plan too large", http.StatusRequestEntityTooLarge)
		return
	}
	var probe map[string]any
	if err := json.Unmarshal(body, &probe); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	dir := storeDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	var id string
	for attempt := 0; attempt < 5; attempt++ {
		candidate, err := randomID()
		if err != nil {
			http.Error(w, "id generation failed", http.StatusInternalServerError)
			return
		}
		path, ok := planPath(dir, candidate)
		if !ok {
			continue
		}
		if _, err := os.Stat(path); os.IsNotExist(err) {
			id = candidate
			break
		}
	}
	if id == "" {
		http.Error(w, "could not allocate id", http.StatusInternalServerError)
		return
	}

	stored := storedPlan{CreatedAt: time.Now().UTC().Format(time.RFC3339), Plan: json.RawMessage(body)}
	path, _ := planPath(dir, id)
	f, err := os.Create(path)
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	defer f.Close()
	if err := json.NewEncoder(f).Encode(stored); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}

	// Anonymous count only — just a timestamp, nothing about the plan's
	// contents or who created it (see internal/analytics's package doc).
	// Best-effort: a failure to record this never fails the actual share.
	sharePath := filepath.Join(analyticsDir(), "plan_shares.jsonl")
	if err := analytics.Append(sharePath, analytics.PlanShareEvent{Time: time.Now()}, analytics.MaxLinesDefault); err != nil {
		log.Printf("analytics: could not record plan share event: %v", err)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": id, "url": "/?plan=" + id})
}

func handleGet(w http.ResponseWriter, r *http.Request, id string) {
	path, ok := planPath(storeDir(), id)
	if !ok {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var stored storedPlan
	if err := json.Unmarshal(data, &stored); err != nil {
		http.Error(w, "corrupt plan", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(stored.Plan)
}

func handlePlans(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/api/plans":
		handleCreate(w, r)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/plans/"):
		id := strings.TrimPrefix(r.URL.Path, "/api/plans/")
		handleGet(w, r, id)
	default:
		http.NotFound(w, r)
	}
}

func prune() error {
	dir := storeDir()
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-time.Duration(ttlDays() * 24 * float64(time.Hour)))
	removed := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var stored storedPlan
		if err := json.Unmarshal(data, &stored); err != nil {
			continue
		}
		createdAt, err := time.Parse(time.RFC3339, stored.CreatedAt)
		if err != nil {
			continue
		}
		if createdAt.Before(cutoff) {
			if err := os.Remove(path); err == nil {
				removed++
			}
		}
	}
	log.Printf("shareapi -prune: removed %d expired plan(s) from %s (ttl=%.1f days)", removed, dir, ttlDays())
	return nil
}

func main() {
	configFlag := flag.String("config", "", "path to config.yaml (default: $HOPREACH_CONFIG, then ./config.yaml)")
	pruneMode := flag.Bool("prune", false, "delete plans older than share.ttl_days and exit")
	flag.Parse()

	yc, _, err := yconfig.Load(*configFlag)
	if err != nil {
		log.Fatalf("shareapi: %v", err)
	}
	cfg = yc

	if *pruneMode {
		if err := prune(); err != nil {
			log.Fatalf("shareapi: prune failed: %v", err)
		}
		return
	}

	addr := cfg.Share.ListenAddr
	http.HandleFunc("/api/plans", handlePlans)
	http.HandleFunc("/api/plans/", handlePlans)
	http.HandleFunc("/api/analytics", handleAnalytics)
	http.HandleFunc("/admin/recompute", handleRecompute)

	go startMemorySampling()

	// Remote GPU worker support is entirely opt-in: refuse to expose
	// /gpu-worker at all unless a real token is configured, rather than
	// defaulting to an open endpoint that would accept a connection (and
	// therefore compute results) from anyone on the internet.
	if cfg.RemoteWorker.Token != "" {
		http.HandleFunc("/gpu-worker", handleGPUWorkerConnect(cfg.RemoteWorker.Token))
		http.HandleFunc("/gpu/submit", handleGPUSubmit)
		http.HandleFunc("/gpu/status", handleGPUStatus)
		http.HandleFunc("/gpu/progress", handleGPUProgress)
		log.Printf("shareapi: remote GPU worker support enabled")
	} else {
		log.Printf("shareapi: remote_worker.token not set, remote GPU worker support disabled")
	}

	log.Printf("shareapi: listening on %s, storing plans in %s", addr, storeDir())
	log.Fatal(http.ListenAndServe(addr, nil))
}
