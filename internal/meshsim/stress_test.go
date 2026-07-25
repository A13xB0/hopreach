package meshsim

import "testing"

func stressScenario(n int) Scenario {
	nodes := make([]SimNode, n)
	var links []Link
	for i := 0; i < n; i++ {
		nodes[i] = testNode(true)
		for j := 0; j < n; j++ {
			if i != j {
				links = append(links, Link{From: i, To: j, SNRdB: 5})
			}
		}
	}
	return Scenario{Nodes: nodes, Links: links}
}

func TestStressTestDeterministicForFixedSeed(t *testing.T) {
	req := StressRequest{
		Scenario:     stressScenario(20),
		MaxSimTimeMs: 10_000,
		Trials:       3,
		Seed:         42,
		MinPayload:   10,
		MaxPayload:   50,
		LoadLevels:   []float64{5, 20, 60},
	}
	a := StressTest(req, nil)
	b := StressTest(req, nil)
	if len(a.Levels) != len(b.Levels) {
		t.Fatalf("level count differs between identical runs: %d vs %d", len(a.Levels), len(b.Levels))
	}
	for i := range a.Levels {
		if a.Levels[i] != b.Levels[i] {
			t.Errorf("level %d differs between identical-seed runs: %+v vs %+v", i, a.Levels[i], b.Levels[i])
		}
	}
	if a.KneeMessagesPerMinute != b.KneeMessagesPerMinute {
		t.Errorf("knee differs between identical-seed runs: %v vs %v", a.KneeMessagesPerMinute, b.KneeMessagesPerMinute)
	}
}

// TestStressTestKneeMovesDownOnOverload proves the knee reflects a real
// saturation point rather than always just reporting the top of the swept
// range: on a small, easily-saturated dense network, a load series that
// climbs far past what the network can actually carry must produce a knee
// BELOW the highest swept level, not at it.
func TestStressTestKneeMovesDownOnOverload(t *testing.T) {
	req := StressRequest{
		Scenario:     stressScenario(10),
		MaxSimTimeMs: 20_000,
		Trials:       2,
		Seed:         7,
		MinPayload:   10,
		MaxPayload:   50,
		LoadLevels:   []float64{2, 10, 50, 200, 500},
	}
	result := StressTest(req, nil)
	highest := req.LoadLevels[len(req.LoadLevels)-1]
	if result.KneeMessagesPerMinute >= highest {
		t.Errorf("expected the knee (%v) to fall below the highest swept load (%v) on a deliberately overloaded sweep", result.KneeMessagesPerMinute, highest)
	}
	if result.KneeMessagesPerMinute <= 0 {
		t.Errorf("expected a positive knee (the lowest level should always clear its own threshold), got %v", result.KneeMessagesPerMinute)
	}
	// Delivery should generally trend downward as offered load climbs on an
	// already near-saturated network — not asserting strict monotonicity
	// (a single seed can have noise), just that the top level is
	// meaningfully worse than the bottom one.
	first := result.Levels[0].DeliveryRatio
	last := result.Levels[len(result.Levels)-1].DeliveryRatio
	if last >= first {
		t.Errorf("expected delivery ratio to degrade from the lowest load (%v) to the highest (%v)", first, last)
	}
}

func TestGenerateStressMessagesRespectsPayloadBounds(t *testing.T) {
	scenario := stressScenario(5)
	rng := NewSeededRNG(1)
	messages := generateStressMessages(scenario, rng, 120, 10, 20, 60_000)
	if len(messages) == 0 {
		t.Fatal("expected at least one generated message")
	}
	for _, m := range messages {
		if m.PayloadLen < 10 || m.PayloadLen > 20 {
			t.Errorf("message payload %d out of bounds [10,20]", m.PayloadLen)
		}
		if m.Origin < 0 || m.Origin >= len(scenario.Nodes) {
			t.Errorf("message origin %d out of range", m.Origin)
		}
		if m.SendAtMs >= 60_000 {
			t.Errorf("message SendAtMs %d out of the sim window", m.SendAtMs)
		}
	}
}

func TestGenerateStressMessagesZeroLoadProducesNone(t *testing.T) {
	scenario := stressScenario(5)
	if got := generateStressMessages(scenario, NewSeededRNG(1), 0, 10, 20, 60_000); got != nil {
		t.Errorf("expected no messages at zero offered load, got %d", len(got))
	}
}
