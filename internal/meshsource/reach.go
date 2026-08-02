package meshsource

import (
	"context"
	"log"
	"sync"
)

// reachWorkers bounds the fan-out. Reach is one request per node and a real
// mesh has hundreds, so this is the difference between a pipeline run taking
// seconds and taking minutes — but it is someone else's server, so the number
// stays modest.
const reachWorkers = 12

// FetchAllReach fetches observed links for every node, concurrently.
//
// Backend-agnostic on purpose: it used to be corescope.FetchAllReach, taking
// a *corescope.Client, which is what tied the render pipeline to one backend.
// Nothing about "ask for each node's reach in parallel" is CoreScope-specific.
//
// A node whose fetch fails is logged and omitted rather than failing the run:
// reach feeds calibration, which is an enrichment, and one unreachable node
// should not cost the whole render.
func FetchAllReach(
	ctx context.Context, src Source, nodes []Node, days int, progress func(done, total int),
) map[string][]ReachLink {
	results := make(map[string][]ReachLink, len(nodes))
	var mu sync.Mutex

	jobs := make(chan string, len(nodes))
	for _, n := range nodes {
		jobs <- n.PublicKey
	}
	close(jobs)

	var wg sync.WaitGroup
	done := 0
	total := len(nodes)
	for w := 0; w < reachWorkers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for pubkey := range jobs {
				links, err := src.FetchReach(ctx, pubkey, days)
				mu.Lock()
				if err != nil {
					log.Printf("%s: reach fetch failed for %s: %v", src.Name(), pubkey, err)
				} else {
					results[pubkey] = links
				}
				done++
				if progress != nil {
					progress(done, total)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return results
}
