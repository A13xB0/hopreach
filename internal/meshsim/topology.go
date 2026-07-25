package meshsim

// computeTopologyAttrs derives NodeAttrs fields that need nothing but the
// scenario's own link graph — NeighborCount, IsArticulation and
// MarginalCoverage — used by SuggestPolicy's topology-keyed models (item
// 15c). Unlike AltitudeM (which genuinely needs external elevation data
// and so must come from the caller), these are always recomputed here
// rather than trusted from any caller-supplied NodeAttrs, so they're
// always accurate for the scenario actually being searched.
func computeTopologyAttrs(scenario Scenario) []NodeAttrs {
	n := len(scenario.Nodes)
	neighbors := make([]map[int]bool, n)
	for i := range neighbors {
		neighbors[i] = make(map[int]bool)
	}
	for _, l := range scenario.Links {
		if l.From < 0 || l.From >= n || l.To < 0 || l.To >= n {
			continue
		}
		// Undirected projection — a link either direction makes the two
		// nodes neighbours for topology purposes, same convention
		// public/simulator.js's own attrsFromState uses for NeighborCount.
		neighbors[l.From][l.To] = true
		neighbors[l.To][l.From] = true
	}

	articulation := findArticulationPoints(n, neighbors)

	attrs := make([]NodeAttrs, n)
	for i := 0; i < n; i++ {
		attrs[i].NeighborCount = len(neighbors[i])
		attrs[i].IsArticulation = articulation[i]
		attrs[i].MarginalCoverage = marginalCoverageFor(i, neighbors)
	}
	return attrs
}

// findArticulationPoints runs the standard low-link DFS algorithm over an
// undirected graph (Tarjan) to find every cut vertex — a node whose
// removal would disconnect the graph into more components. Isolated nodes
// and ordinary leaves are never articulation points, matching the
// graph-theoretic definition — see the articulation-first model, whose
// whole premise is that such a node's relay is never redundant.
func findArticulationPoints(n int, neighbors []map[int]bool) []bool {
	disc := make([]int, n)
	low := make([]int, n)
	visited := make([]bool, n)
	isArt := make([]bool, n)
	timer := 0

	var dfs func(u, parent int)
	dfs = func(u, parent int) {
		visited[u] = true
		timer++
		disc[u] = timer
		low[u] = timer
		children := 0
		for v := range neighbors[u] {
			if v == parent {
				continue
			}
			if visited[v] {
				if disc[v] < low[u] {
					low[u] = disc[v]
				}
				continue
			}
			children++
			dfs(v, u)
			if low[v] < low[u] {
				low[u] = low[v]
			}
			if parent != -1 && low[v] >= disc[u] {
				isArt[u] = true
			}
		}
		if parent == -1 && children > 1 {
			isArt[u] = true
		}
	}

	for i := 0; i < n; i++ {
		if !visited[i] {
			dfs(i, -1)
		}
	}
	return isArt
}

// marginalCoverageFor is a local, per-node proxy for the classic OLSR
// MultiPoint-Relay heuristic — NOT the literal (sender-relative) MPR
// selection algorithm, which asks "which of MY neighbours should I use to
// reach my 2-hop neighbourhood," a question with no single per-node
// answer independent of who's asking. This is the question "how many of
// u's own neighbours are not ALSO reachable via one of u's OTHER
// neighbours" — a genuinely useful static NodeAttrs figure (no per-message
// "sender" context needed) that captures the same underlying intuition:
// a HIGH figure means u sits in a spot its neighbours can't easily cover
// for each other (a real hub, or a low-degree node with nothing else
// nearby); a LOW figure on a well-connected node means its neighbours
// substantially overlap, so any one of them relaying is likely redundant
// with the others (see the mpr/coverage-gain model). Note a degree-1 node
// always scores 1 by this definition — it trivially has no OTHER
// neighbour of its own to have covered its one neighbour instead.
func marginalCoverageFor(u int, neighbors []map[int]bool) int {
	unique := 0
	for v := range neighbors[u] {
		coveredByOther := false
		for w := range neighbors[u] {
			if w == v {
				continue
			}
			if neighbors[w][v] {
				coveredByOther = true
				break
			}
		}
		if !coveredByOther {
			unique++
		}
	}
	return unique
}
