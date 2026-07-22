// Command hopreach fetches repeater nodes from a CoreScope instance, keeps
// only the ones that fall geographically within the configured region and
// are scoped to the configured MeshCore region, then computes a
// terrain-aware estimated RF coverage map (free-space path loss +
// single-knife-edge diffraction over real elevation data) and writes:
//   - repeaters.geojson: the filtered repeater points
//   - coverage.png + bounds in meta.json: the estimated coverage heatmap
//   - meta.json: summary stats for the frontend
//   - progress.json: updated throughout the run so the frontend can show a
//     progress bar during the (potentially multi-minute) terrain analysis
//
// Configuration is a single YAML file — see internal/config — resolved
// from -config, then $HOPREACH_CONFIG, then ./config.yaml. -prepare renders
// the frontend's config.js, nginx's site config, and the cron file from
// that same config instead of running the fetch/compute pipeline; the
// Docker entrypoint calls it once at container startup.
package main

import (
	"flag"
	"log"

	yconfig "hopreach/internal/config"
)

func main() {
	configFlag := flag.String("config", "", "path to config.yaml (default: $HOPREACH_CONFIG, then ./config.yaml)")
	force := flag.Bool("force", false, "recompute even if within coverage.min_recompute_interval_hours")
	prepare := flag.Bool("prepare", false, "render config.js, nginx's site config, and the cron file from config.yaml, then exit")
	flag.Parse()

	yc, path, err := yconfig.Load(*configFlag)
	if err != nil {
		log.Fatalf("hopreach: %v", err)
	}

	if *prepare {
		if err := runPrepare(yc, path); err != nil {
			log.Fatalf("hopreach: -prepare: %v", err)
		}
		return
	}

	// Excludes concurrent runs from whichever combination of the container's
	// initial background run, the daily cron job, and an on-demand
	// /admin/recompute trigger happens to overlap — see lock.go.
	lock, err := acquireLock()
	if err != nil {
		log.Printf("hopreach: %v, skipping this run", err)
		return
	}
	defer lock.Close()

	cfg := toAppConfig(yc)
	cfg.forceRecompute = *force
	if err := run(cfg); err != nil {
		log.Fatalf("hopreach: %v", err)
	}
}
