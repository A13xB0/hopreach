// Analytics: serves the aggregated operational-history data behind the
// frontend's /analytics page — run history, memory-over-time for both
// boxes, plan-share counts over time, and each box's hardware specs. All of
// it is either about this deployment's own infrastructure or an anonymous
// count; see internal/analytics's package doc for the no-PII design this
// builds on.
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"path/filepath"
	"time"

	"hopreach/internal/analytics"
	"hopreach/internal/buildinfo"
	"hopreach/internal/gpujob"
	"hopreach/internal/sysinfo"
)

// analyticsDir mirrors cmd/hopreach/run.go's own convention: a sibling
// "analytics" directory next to output_dir, so both binaries agree on where
// this data lives without needing a new config field just for a path.
func analyticsDir() string {
	return filepath.Join(cfg.OutputDir, "..", "analytics")
}

// memorySampleInterval bounds how often this box (and, if connected, the
// remote GPU worker) gets a fresh memory-usage data point on the analytics
// graph — frequent enough to show real trends over a day, infrequent enough
// that months of samples stay a small file (see analytics.MaxLinesDefault).
const memorySampleInterval = 5 * time.Minute

// recordWebsiteHardwareOnce records this box's static specs (CPU model,
// total RAM) once at shareapi startup — this process is always-on for the
// lifetime of the deployment, unlike cmd/hopreach's own recordLocalHardwareInfo
// (cmd/hopreach/run.go), which only runs as part of a full coverage pass and
// so leaves the analytics page's hardware panel showing nothing for this box
// until the first recompute after a fresh deploy. Doesn't know about a local
// GPU (only cmd/hopreach's own compute.Engine does), so a run's own record —
// which does include GPUAdapter when relevant — still wins on write order
// once one actually happens, since both write to the same maxLines=1 file.
func recordWebsiteHardwareOnce() {
	info := analytics.HardwareInfo{Box: "website"}
	if v, err := sysinfo.CPUModel(); err == nil {
		info.CPUModel = v
	}
	if v, err := sysinfo.TotalMemoryBytes(); err == nil {
		info.TotalBytes = v
	}
	path := filepath.Join(analyticsDir(), "hardware_website.jsonl")
	if err := analytics.Append(path, info, 1); err != nil {
		log.Printf("analytics: could not record website hardware info: %v", err)
	}
}

// startMemorySampling runs for the lifetime of the process, appending one
// MemorySample for this box (and, if a worker is connected, one more for it)
// every memorySampleInterval. Called once from main(); never returns.
func startMemorySampling() {
	sampleOnce()
	ticker := time.NewTicker(memorySampleInterval)
	defer ticker.Stop()
	for range ticker.C {
		sampleOnce()
	}
}

func sampleOnce() {
	now := time.Now()
	path := filepath.Join(analyticsDir(), "memory_samples.jsonl")

	if avail, err := sysinfo.AvailableMemoryBytes(); err == nil {
		total, _ := sysinfo.TotalMemoryBytes() // best-effort; 0 if unknown
		sample := analytics.MemorySample{Time: now, Box: "website", AvailableBytes: avail, TotalBytes: total}
		if err := analytics.Append(path, sample, analytics.MaxLinesDefault); err != nil {
			log.Printf("analytics: could not record website memory sample: %v", err)
		}
	}

	if h := broker.getHello(); broker.connected() && h.AvailableBytes > 0 {
		sample := analytics.MemorySample{Time: now, Box: "gpu_worker", AvailableBytes: h.AvailableBytes, TotalBytes: h.TotalBytes}
		if err := analytics.Append(path, sample, analytics.MaxLinesDefault); err != nil {
			log.Printf("analytics: could not record gpu_worker memory sample: %v", err)
		}
	}
}

// recordGPUWorkerHardware persists a connected worker's hardware description
// so the analytics page still has something to show for it even when
// viewed while no worker happens to be connected — mirrors
// cmd/hopreach's recordLocalHardwareInfo for the website box. Only called
// with a real Hello (non-empty CPUModel); the zero-value reset on
// disconnect (see gpuBroker.setConn) is deliberately not persisted, so the
// last real reading survives a brief disconnect/reconnect cycle.
func recordGPUWorkerHardware(h gpujob.Hello) {
	if h.CPUModel == "" && h.GPUAdapter == "" {
		return
	}
	info := analytics.HardwareInfo{Box: "gpu_worker", CPUModel: h.CPUModel, TotalBytes: h.TotalBytes, GPUAdapter: h.GPUAdapter}
	path := filepath.Join(analyticsDir(), "hardware_gpu_worker.jsonl")
	if err := analytics.Append(path, info, 1); err != nil {
		log.Printf("analytics: could not record gpu_worker hardware info: %v", err)
	}
}

// analyticsResponse is the whole payload the frontend's /analytics page
// consumes in one request — deliberately pre-aggregated server-side (rather
// than several smaller endpoints) since every piece is small and the page
// needs all of it to render its first frame anyway.
type analyticsResponse struct {
	Version            string                     `json:"version"`
	Runs               []analytics.RunRecord      `json:"runs"`
	MemorySamples      []analytics.MemorySample   `json:"memory_samples"`
	PlanShares         []analytics.PlanShareEvent `json:"plan_shares"`
	Hardware           []analytics.HardwareInfo   `json:"hardware"`
	GPUWorkerConnected bool                       `json:"gpu_worker_connected"`
}

func handleAnalytics(w http.ResponseWriter, r *http.Request) {
	dir := analyticsDir()

	runs, err := analytics.ReadAll[analytics.RunRecord](filepath.Join(dir, "runs.jsonl"))
	if err != nil {
		http.Error(w, "reading run history", http.StatusInternalServerError)
		return
	}
	samples, err := analytics.ReadAll[analytics.MemorySample](filepath.Join(dir, "memory_samples.jsonl"))
	if err != nil {
		http.Error(w, "reading memory samples", http.StatusInternalServerError)
		return
	}
	shares, err := analytics.ReadAll[analytics.PlanShareEvent](filepath.Join(dir, "plan_shares.jsonl"))
	if err != nil {
		http.Error(w, "reading plan shares", http.StatusInternalServerError)
		return
	}

	var hw []analytics.HardwareInfo
	if websiteHW, err := analytics.ReadAll[analytics.HardwareInfo](filepath.Join(dir, "hardware_website.jsonl")); err == nil {
		hw = append(hw, websiteHW...)
	}
	if gpuHW, err := analytics.ReadAll[analytics.HardwareInfo](filepath.Join(dir, "hardware_gpu_worker.jsonl")); err == nil {
		hw = append(hw, gpuHW...)
	}

	resp := analyticsResponse{
		Version:            buildinfo.Version,
		Runs:               runs,
		MemorySamples:      samples,
		PlanShares:         shares,
		Hardware:           hw,
		GPUWorkerConnected: broker.connected(),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
