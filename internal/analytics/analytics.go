// Package analytics records operational history — coverage-run timing and
// outcomes, periodic memory samples from both boxes, and shared-plan
// creation events — as small append-only JSONL files, read back by
// cmd/hopreach-shareapi's analytics endpoint for the frontend's analytics
// page. No database: this project's own scale (a handful of runs a day, a
// memory sample every few minutes, occasional plan shares) doesn't warrant
// one, and JSONL keeps every entry human-readable and trivially greppable
// on the box itself.
//
// Deliberately excludes anything that could identify a visitor — no IP
// addresses, no user agents, no request-level data of any kind. Every
// record here is either about this deployment's own infrastructure (boxes,
// builds) or an anonymous count (a plan was shared; no reference to who,
// from where, or what was in it).
package analytics

import (
	"bufio"
	"encoding/json"
	"os"
	"time"
)

// RunRecord is one whole coverage-generation run (cmd/hopreach's run()) —
// success or failure, start to finish, with a per-tier breakdown of which
// backend served each one and how long it took.
type RunRecord struct {
	StartedAt  time.Time    `json:"started_at"`
	FinishedAt time.Time    `json:"finished_at"`
	DurationS  float64      `json:"duration_seconds"`
	Success    bool         `json:"success"`
	Error      string       `json:"error,omitempty"`
	Version    string       `json:"version"`
	Tiers      []TierRecord `json:"tiers,omitempty"`
}

// TierRecord is one of the (up to four) coverage tiers within a run:
// Standard, Calibrated, Precision, Calibrated Precision.
type TierRecord struct {
	Name      string  `json:"name"`
	Backend   string  `json:"backend"` // "cpu" | "gpu" | "remote_gpu"
	DurationS float64 `json:"duration_seconds"`
}

// MemorySample is one point-in-time reading of a box's available/total
// memory (see internal/sysinfo) — "website" for the box running
// cmd/hopreach and cmd/hopreach-shareapi, "gpu_worker" for a connected
// remote GPU worker, if any.
type MemorySample struct {
	Time           time.Time `json:"time"`
	Box            string    `json:"box"`
	AvailableBytes uint64    `json:"available_bytes"`
	TotalBytes     uint64    `json:"total_bytes"`
}

// PlanShareEvent is one POST /api/plans call — just a timestamp, nothing
// about the plan's contents or who created it.
type PlanShareEvent struct {
	Time time.Time `json:"time"`
}

// HardwareInfo is a box's static specs — fetched once (or refreshed
// occasionally; hardware essentially never changes underneath a running
// deployment) rather than repeated on every sample.
type HardwareInfo struct {
	Box        string `json:"box"`
	CPUModel   string `json:"cpu_model,omitempty"`
	TotalBytes uint64 `json:"total_bytes,omitempty"`
	GPUAdapter string `json:"gpu_adapter,omitempty"`
}

// MaxLinesDefault is the suggested maxLines for most Append callers — old
// entries beyond this are dropped, oldest first, so none of these logs
// grow unbounded over a long-running deployment (exactly the kind of
// silent disk growth that filled this project's own website box once
// already, from an unrelated cause — see the demgrid scratch-file cleanup
// fix). 20,000 entries comfortably covers months of even frequent (every
// few minutes) memory sampling; callers with a much lower natural event
// rate (e.g. one entry per coverage run, a few a day at most) can pass
// their own smaller cap instead.
const MaxLinesDefault = 20_000

// Append adds v as one JSON line to path, creating it if needed, then
// trims the file to at most maxLines entries (oldest first discarded) if
// it now exceeds that. Every call is a full read-modify-write — fine at
// this project's scale (at most tens of thousands of small JSON lines,
// appended at most every few minutes, never in a request hot path), and
// keeps the trimming logic simple and obviously correct rather than
// optimizing for a write volume this was never going to see.
func Append(path string, v any, maxLines int) error {
	existing, err := readLines(path)
	if err != nil {
		return err
	}
	body, err := json.Marshal(v)
	if err != nil {
		return err
	}
	existing = append(existing, string(body))
	if maxLines > 0 && len(existing) > maxLines {
		existing = existing[len(existing)-maxLines:]
	}

	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	for _, line := range existing {
		if _, err := w.WriteString(line); err != nil {
			f.Close()
			os.Remove(tmp)
			return err
		}
		if err := w.WriteByte('\n'); err != nil {
			f.Close()
			os.Remove(tmp)
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

func readLines(path string) ([]string, error) {
	f, err := os.Open(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var lines []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines, scanner.Err()
}

// ReadAll reads every entry in path, decoded as T — missing file is a
// clean empty result (a fresh deployment with no history yet), not an
// error, and any single unparseable line (a partially-written entry from a
// crash mid-write — Append's tmp-then-rename makes this rare, but not
// impossible if the process died between the two) is skipped rather than
// failing the whole read.
func ReadAll[T any](path string) ([]T, error) {
	lines, err := readLines(path)
	if err != nil {
		return nil, err
	}
	out := make([]T, 0, len(lines))
	for _, line := range lines {
		var v T
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			continue
		}
		out = append(out, v)
	}
	return out, nil
}
