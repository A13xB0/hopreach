package meshsim

import (
	"math/rand/v2"
	"testing"
)

// TestZeroDelayExperiment is an
// independent sweep of the same question github.com/meshcore-dev/MeshCore
// discussion #2053 investigated (does backing off before relaying help or
// hurt delivery), NOT a replication — stachuman's own topologies, metric
// and parameter ranges aren't stated in that thread, so this uses its own.
// See the plan document's own pre-registered prediction, written before
// this test was run, and "What was actually found" below it, written
// after.
//
// Sweeps TxDelayFactor/DirectTxDelayFactor together (RxDelayBase stays at
// its real firmware default of 0/"off" throughout — see the plan's own
// note on why this keeps the experiment focused on the same core question
// stachuman/KPrivitt were actually debating: does waiting before relaying
// help).
func TestZeroDelayExperiment(t *testing.T) {
	const trials = 25
	delayLevels := []float64{0.0, 0.25, 0.5, 1.0}

	topologies := []struct {
		name          string
		buildScenario func() Scenario
		buildMessages func() []Message
	}{
		{"sparse (6-node chain)", sparseChainScenario, sparseChainMessages},
		{"medium (4-way fan-in)", mediumFanInScenario, mediumFanInMessages},
		{"dense (7-way lockstep fan-in)", denseFanInScenario, denseFanInMessages},
	}

	for _, topo := range topologies {
		t.Logf("=== %s ===", topo.name)
		var zeroDelivery, fullDelayDelivery float64
		for _, level := range delayLevels {
			scenario := withDelayLevel(topo.buildScenario(), level)
			messages := topo.buildMessages()
			avgDelivery, avgCollision := averageOverTrials(scenario, messages, trials, 1000)
			t.Logf("  delay=%.2f: delivery=%.3f collision=%.3f", level, avgDelivery, avgCollision)
			if level == 0.0 {
				zeroDelivery = avgDelivery
			}
			if level == delayLevels[len(delayLevels)-1] {
				fullDelayDelivery = avgDelivery
			}
		}
		// The actual regression guard this experiment exists to provide:
		// if the optimizer trends toward zero/minimal delays that is a red
		// flag, not a discovery, so it gets an explicit sanity check. Zero delays
		// outright BEATING a real backoff on a contention-heavy topology
		// would reproduce the exact result field-tested as wrong
		// (discussion #2053) — a future engine change that reintroduces
		// that must fail this test, not slip by silently. Not asserted
		// for the sparse topology, which never has a real gap either way.
		if topo.name != "sparse (6-node chain)" && zeroDelivery > fullDelayDelivery {
			t.Errorf("%s: zero-delay delivery (%.3f) exceeded full-delay delivery (%.3f) — this reproduces the exact 'zero delays win' result field-tested as wrong in github.com/meshcore-dev/MeshCore discussion #2053; see this file's own doc comment before dismissing this failure",
				topo.name, zeroDelivery, fullDelayDelivery)
		}
	}
}

// TestZeroDelayExperimentAblation is step 2 — for the dense topology
// (where the previous test's own results show the largest effect),
// re-sweep zero-vs-nonzero delay with each mechanism disabled in turn, to
// find out which one accounts for the difference.
func TestZeroDelayExperimentAblation(t *testing.T) {
	const trials = 25
	variants := []struct {
		name string
		ab   AblationFlags
	}{
		{"full model (nothing disabled)", AblationFlags{}},
		{"DisableTxBusy", AblationFlags{DisableTxBusy: true}},
		{"DisableCAD", AblationFlags{DisableCAD: true}},
		{"DisableDutyCycle", AblationFlags{DisableDutyCycle: true}},
		{"DisableCapture", AblationFlags{DisableCapture: true}},
		{"DisablePathByteAirtime", AblationFlags{DisablePathByteAirtime: true}},
	}

	for _, v := range variants {
		zeroScenario := withDelayLevel(denseFanInScenario(), 0.0)
		nonzeroScenario := withDelayLevel(denseFanInScenario(), 1.0)
		messages := denseFanInMessages()

		zeroDelivery, zeroCollision := averageOverTrialsAblated(zeroScenario, messages, trials, 2000, v.ab)
		nonzeroDelivery, nonzeroCollision := averageOverTrialsAblated(nonzeroScenario, messages, trials, 2000, v.ab)

		verdict := "zero delays LOSE"
		if zeroDelivery > nonzeroDelivery {
			verdict = "zero delays WIN"
		} else if zeroDelivery == nonzeroDelivery {
			verdict = "TIE"
		}
		t.Logf("%s: zero-delay delivery=%.3f collision=%.3f | non-zero delivery=%.3f collision=%.3f -> %s",
			v.name, zeroDelivery, zeroCollision, nonzeroDelivery, nonzeroCollision, verdict)
	}
}

func withDelayLevel(scenario Scenario, level float64) Scenario {
	out := Scenario{Links: scenario.Links, Nodes: make([]SimNode, len(scenario.Nodes))}
	copy(out.Nodes, scenario.Nodes)
	for i := range out.Nodes {
		out.Nodes[i].Prefs.TxDelayFactor = level
		out.Nodes[i].Prefs.DirectTxDelayFactor = level
	}
	return out
}

func averageOverTrials(scenario Scenario, messages []Message, trials int, seedBase uint64) (delivery, collision float64) {
	return averageOverTrialsAblated(scenario, messages, trials, seedBase, AblationFlags{})
}

func averageOverTrialsAblated(scenario Scenario, messages []Message, trials int, seedBase uint64, ab AblationFlags) (delivery, collision float64) {
	var totalD, totalC float64
	for trial := 0; trial < trials; trial++ {
		rng := rand.New(rand.NewPCG(seedBase, uint64(trial)))
		report := RunWithAblation(scenario, messages, rng, 60_000, ab)
		totalD += report.DeliveryRatio(scenario, messages)
		totalC += report.CollisionRate()
	}
	return totalD / float64(trials), totalC / float64(trials)
}

// sparseChainScenario: a 6-node single-path chain, 0 -> 1 -> 2 -> 3 -> 4 ->
// 5 — at most one relay ever contends for the channel at a time, since
// each node's only neighbours are the one before and after it. Minimal
// contention by construction.
func sparseChainScenario() Scenario {
	const n = 6
	nodes := make([]SimNode, n)
	var links []Link
	for i := 0; i < n; i++ {
		nodes[i] = testNode(true)
		if i > 0 {
			links = append(links, Link{From: i - 1, To: i, SNRdB: 15})
		}
	}
	return Scenario{Nodes: nodes, Links: links}
}

func sparseChainMessages() []Message {
	return []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 30, HashSize: 3}}
}

// mediumFanInScenario: an origin broadcasts to 4 relays, each of which
// relays onward to a SECOND shared listener — moderate contention (4-way
// fan-in), between sparse's none and dense's heavy.
func mediumFanInScenario() Scenario {
	const fanIn = 4
	total := fanIn + 2 // origin + fanIn relays + listener
	origin, listener := 0, total-1
	nodes := make([]SimNode, total)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	var links []Link
	for r := 1; r <= fanIn; r++ {
		links = append(links, Link{From: origin, To: r, SNRdB: 12})
		links = append(links, Link{From: r, To: listener, SNRdB: 12})
	}
	return Scenario{Nodes: nodes, Links: links}
}

func mediumFanInMessages() []Message {
	return []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 30, HashSize: 3}}
}

// denseFanInScenario: an origin broadcasts to 7 relays which ALL relay
// onward to the same shared listener — heavy contention by construction,
// the same "many relays racing to the same audience" shape as
// lockstepCollisionScenario (tune_test.go), just larger.
func denseFanInScenario() Scenario {
	const fanIn = 7
	total := fanIn + 2
	origin, listener := 0, total-1
	nodes := make([]SimNode, total)
	for i := range nodes {
		nodes[i] = testNode(true)
	}
	var links []Link
	for r := 1; r <= fanIn; r++ {
		links = append(links, Link{From: origin, To: r, SNRdB: 10})
		links = append(links, Link{From: r, To: listener, SNRdB: 10})
	}
	return Scenario{Nodes: nodes, Links: links}
}

func denseFanInMessages() []Message {
	return []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 30, HashSize: 3}}
}
