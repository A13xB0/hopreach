package meshsim

// Link is one directed "A's transmission is audible at B" edge — asymmetric
// on purpose, since real terrain/antenna differences can make a link
// audible in only one direction. SNRdB is what B would measure when A
// transmits; the caller (not this package) decides where that number comes
// from — CoreScope-observed reach data, the propagation model's predicted
// margin converted to an approximate SNR, or a blend of both, per the
// simulator's own connectivity-source setting. This package only ever
// consumes the resulting graph, so it stays independent of both data
// sources.
type Link struct {
	From, To int
	SNRdB    float64
}

// adjacency indexes Links by sender for fast "who can hear node N" lookups
// during simulation.
type adjacency map[int][]Link

func buildAdjacency(links []Link) adjacency {
	adj := make(adjacency, len(links))
	for _, l := range links {
		adj[l.From] = append(adj[l.From], l)
	}
	return adj
}
