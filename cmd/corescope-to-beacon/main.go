// Command corescope-to-beacon copies a CoreScope instance's observations into
// a MeshCore Beacon database, so the two backends can be compared against the
// same mesh.
//
// This exists to test backend parity honestly. Pointing HopReach at CoreScope
// and at some unrelated Beacon proves nothing — the maps would differ because
// the networks differ. Loading ScotMesh into a local Beacon means any
// remaining difference is HopReach's, which is the whole question.
//
// It reads exclusively through meshsource.Source. That is deliberate: if the
// canonical shape were missing something a backend needs, this tool could not
// be written, and the interface would not really be an interface.
//
// Output is SQL on stdout rather than direct inserts, which keeps HopReach
// free of a PostgreSQL driver dependency it otherwise has no use for, and
// makes the migration inspectable before it is applied:
//
//	go run ./cmd/corescope-to-beacon -corescope URL | \
//	  docker exec -i beacon-postgres psql -U beacon -d beacon
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	"hopreach/internal/config"
	"hopreach/internal/meshsource"
	"hopreach/internal/sources"
)

func main() {
	log.SetFlags(0)
	log.SetOutput(os.Stderr) // stdout is the SQL stream

	var (
		apiURL      = flag.String("corescope", "", "CoreScope API base URL (required)")
		packetHours = flag.Float64("packet-hours", 6, "how much packet history to copy")
		packetLimit = flag.Int("packet-limit", 2000, "cap on packets copied")
		reachDays   = flag.Int("reach-days", 7, "observed-reach window per node")
		maxNodes    = flag.Int("max-reach-nodes", 0, "cap nodes fetched reach for (0 = all)")
	)
	flag.Parse()
	if *apiURL == "" {
		log.Fatal("-corescope is required")
	}

	ctx := context.Background()
	src, err := sources.FromConfig(config.Config{
		Source:    config.SourceConfig{Type: config.SourceCoreScope},
		CoreScope: config.CoreScopeConfig{APIURL: *apiURL, RequestTimeoutSeconds: 60},
	})
	if err != nil {
		log.Fatalf("building source: %v", err)
	}

	w := newWriter(os.Stdout)
	m := &migration{src: src, w: w, http: &http.Client{Timeout: 60 * time.Second}}

	if err := m.run(ctx, runOpts{
		apiURL:      *apiURL,
		packetSince: time.Now().Add(-time.Duration(*packetHours * float64(time.Hour))),
		packetLimit: *packetLimit,
		reachDays:   *reachDays,
		maxReach:    *maxNodes,
	}); err != nil {
		log.Fatalf("migration: %v", err)
	}
	if err := w.flush(); err != nil {
		log.Fatalf("writing SQL: %v", err)
	}
	log.Printf("done: %s", m.stats)
}

type runOpts struct {
	apiURL      string
	packetSince time.Time
	packetLimit int
	reachDays   int
	maxReach    int
}

type migration struct {
	src   meshsource.Source
	w     *writer
	http  *http.Client
	stats stats
}

type stats struct {
	scopes, nodes, neighbours, packets, observations int
}

func (s stats) String() string {
	return fmt.Sprintf("%d scopes, %d nodes, %d neighbour edges, %d packets, %d observations",
		s.scopes, s.nodes, s.neighbours, s.packets, s.observations)
}

func (m *migration) run(ctx context.Context, o runOpts) error {
	m.w.header()

	scopeRefs, err := m.writeScopes(ctx)
	if err != nil {
		return fmt.Errorf("scopes: %w", err)
	}

	nodes, err := m.src.FetchAllNodes(ctx)
	if err != nil {
		return fmt.Errorf("nodes: %w", err)
	}
	byKey := m.writeNodes(nodes, scopeRefs)

	if err := m.writeNeighbours(ctx, nodes, byKey, o); err != nil {
		return fmt.Errorf("neighbours: %w", err)
	}
	if err := m.writePackets(ctx, byKey, scopeRefs, o); err != nil {
		return fmt.Errorf("packets: %w", err)
	}

	m.w.footer()
	return nil
}
