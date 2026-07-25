package meshsim

import "testing"

// TestFindArticulationPointsOnALineGraph proves the classic case: in a
// straight chain 0-1-2-3-4, every internal node is a cut vertex and both
// endpoints are not.
func TestFindArticulationPointsOnALineGraph(t *testing.T) {
	neighbors := make([]map[int]bool, 5)
	for i := range neighbors {
		neighbors[i] = make(map[int]bool)
	}
	for i := 0; i < 4; i++ {
		neighbors[i][i+1] = true
		neighbors[i+1][i] = true
	}
	got := findArticulationPoints(5, neighbors)
	want := []bool{false, true, true, true, false}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("node %d: articulation = %v, want %v (full: %v)", i, got[i], want[i], got)
		}
	}
}

// TestFindArticulationPointsOnACycle proves the other classic case: a
// cycle has NO cut vertices at all — removing any one node still leaves
// the rest connected via the remaining arc.
func TestFindArticulationPointsOnACycle(t *testing.T) {
	const n = 6
	neighbors := make([]map[int]bool, n)
	for i := range neighbors {
		neighbors[i] = make(map[int]bool)
	}
	for i := 0; i < n; i++ {
		next := (i + 1) % n
		neighbors[i][next] = true
		neighbors[next][i] = true
	}
	got := findArticulationPoints(n, neighbors)
	for i, isArt := range got {
		if isArt {
			t.Errorf("node %d on a pure cycle should never be an articulation point: %v", i, got)
		}
	}
}

// TestMarginalCoverageForStarTopology proves the OLSR MPR intuition
// directly: in a star (one hub, several spokes each only connected to the
// hub), the hub's own marginal coverage equals its degree (every spoke is
// reachable ONLY via the hub — none of them are also each other's
// neighbour). A spoke's own marginal coverage is 1, not 0 — by this
// metric's own definition (how many of THIS node's neighbours aren't also
// reachable via one of THIS SAME node's other neighbours), a degree-1 node
// trivially "uniquely covers" its one neighbour: there are no other
// neighbours of its own to have covered it instead. This is a real,
// documented property of the local, per-node proxy this package
// implements, not the literal (sender-relative) OLSR MPR selection
// algorithm — see marginalCoverageFor's own doc comment.
func TestMarginalCoverageForStarTopology(t *testing.T) {
	const spokes = 4
	n := spokes + 1
	hub := 0
	neighbors := make([]map[int]bool, n)
	for i := range neighbors {
		neighbors[i] = make(map[int]bool)
	}
	for s := 1; s <= spokes; s++ {
		neighbors[hub][s] = true
		neighbors[s][hub] = true
	}
	if got := marginalCoverageFor(hub, neighbors); got != spokes {
		t.Errorf("hub's marginal coverage = %d, want %d (every spoke, none covered by another spoke)", got, spokes)
	}
	if got := marginalCoverageFor(1, neighbors); got != 1 {
		t.Errorf("a spoke's marginal coverage = %d, want 1 (trivially unique — it has no OTHER neighbour of its own to have covered the hub instead)", got)
	}
}

func TestComputeTopologyAttrsOnLineGraph(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(true), testNode(true), testNode(true), testNode(true)},
		Links: []Link{
			{From: 0, To: 1, SNRdB: 0}, {From: 1, To: 0, SNRdB: 0},
			{From: 1, To: 2, SNRdB: 0}, {From: 2, To: 1, SNRdB: 0},
			{From: 2, To: 3, SNRdB: 0}, {From: 3, To: 2, SNRdB: 0},
			{From: 3, To: 4, SNRdB: 0}, {From: 4, To: 3, SNRdB: 0},
		},
	}
	attrs := computeTopologyAttrs(scenario)
	if len(attrs) != 5 {
		t.Fatalf("expected 5 attrs, got %d", len(attrs))
	}
	if attrs[0].NeighborCount != 1 || attrs[2].NeighborCount != 2 {
		t.Errorf("unexpected neighbour counts: endpoint=%d, middle=%d", attrs[0].NeighborCount, attrs[2].NeighborCount)
	}
	if attrs[0].IsArticulation {
		t.Error("an endpoint of a line graph should not be an articulation point")
	}
	if !attrs[2].IsArticulation {
		t.Error("an internal node of a line graph should be an articulation point")
	}
}
