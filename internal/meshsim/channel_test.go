package meshsim

import (
	"math"
	"math/rand/v2"
	"testing"
)

// newSeededRNG returns a deterministic RNG satisfying the package's own RNG
// interface — math/rand/v2's Rand already has IntN.
func newSeededRNG(seed uint64) RNG {
	return rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
}

// --- P1: probabilistic reception (ChannelParams.PERWidthDB) --------------

// TestDecodesHardThresholdWhenPERWidthZero proves the zero value is the
// exact legacy behaviour — a hard step at the SF threshold, no RNG draws.
func TestDecodesHardThresholdWhenPERWidthZero(t *testing.T) {
	ch := ChannelParams{} // PERWidthDB == 0
	sf := 8               // threshold -10 (snrThresholdDB[1])
	// A panicking RNG proves decodes() never draws in the legacy path.
	panicRNG := rngFunc(func(int) int { panic("decodes must not draw from rng when PERWidthDB == 0") })
	if !decodes(-9.9, sf, ch, panicRNG) {
		t.Error("expected decode just above the SF8 threshold")
	}
	if decodes(-10.1, sf, ch, panicRNG) {
		t.Error("expected no decode just below the SF8 threshold")
	}
}

// TestDecodesLogisticMatchesTheCurveNearThreshold checks the sampled decode
// rate tracks the intended logistic packet-error-rate curve: ~50% exactly
// at threshold, ~73% one width above, ~27% one width below.
func TestDecodesLogisticMatchesTheCurveNearThreshold(t *testing.T) {
	ch := ChannelParams{PERWidthDB: 2.0}
	sf := 8 // threshold -10
	threshold := -10.0
	rng := newSeededRNG(42)
	const trials = 20000

	for _, offset := range []float64{-2, 0, 2, 6} {
		hits := 0
		for i := 0; i < trials; i++ {
			if decodes(threshold+offset, sf, ch, rng) {
				hits++
			}
		}
		got := float64(hits) / trials
		want := 1.0 / (1.0 + math.Exp(-offset/ch.PERWidthDB))
		if math.Abs(got-want) > 0.02 {
			t.Errorf("offset %+.0f dB: decode rate %.3f, want ~%.3f (logistic)", offset, got, want)
		}
	}
}

// TestChannelSigmoidLeavesStrongLinksReliable is the "don't break good
// links" guard: a comfortably-strong link decodes essentially always even
// with the probabilistic model on, so enabling it doesn't quietly degrade
// healthy meshes.
func TestChannelSigmoidLeavesStrongLinksReliable(t *testing.T) {
	scenario := Scenario{
		Nodes:   []SimNode{testNode(true), testNode(false)},
		Links:   []Link{{From: 0, To: 1, SNRdB: 10}}, // 20 dB above the SF8 threshold
		Channel: ChannelParams{PERWidthDB: 2.0, FadingSigmaDB: 2.0},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	decoded := 0
	const runs = 500
	for s := 0; s < runs; s++ {
		report := Run(scenario, messages, newSeededRNG(uint64(s)), 60_000)
		for _, r := range report.Receptions {
			if r.Node == 1 && r.DropReason != "weak_signal" {
				decoded++
			}
		}
	}
	if decoded < runs {
		t.Errorf("a 20 dB-margin link should decode on every run, got %d/%d", decoded, runs)
	}
}

// TestChannelFadingMakesAMarginalLinkFlicker is the direct evidence for the
// channel-variance fix: a link sitting near its threshold must sometimes
// decode and sometimes not across trials once fading is on — the fixed-SNR
// model produced an identical outcome every time, understating real
// delivery variance.
func TestChannelFadingMakesAMarginalLinkFlicker(t *testing.T) {
	scenario := Scenario{
		Nodes: []SimNode{testNode(true), testNode(false)},
		// Right at the SF8 threshold (-10): with the hard model this is a
		// coin-flip-free "always decodes" (>=), but with the sigmoid+fading
		// it must genuinely vary run to run.
		Links:   []Link{{From: 0, To: 1, SNRdB: -10}},
		Channel: ChannelParams{PERWidthDB: 2.0, FadingSigmaDB: 2.0},
	}
	messages := []Message{{Origin: 0, SendAtMs: 0, PayloadLen: 20}}

	decoded := 0
	const runs = 500
	for s := 0; s < runs; s++ {
		report := Run(scenario, messages, newSeededRNG(uint64(s)), 60_000)
		for _, r := range report.Receptions {
			if r.Node == 1 && r.DropReason != "weak_signal" {
				decoded++
			}
		}
	}
	if decoded == 0 || decoded == runs {
		t.Errorf("expected a marginal link to flicker (0 < decoded < %d), got %d — fading/sigmoid isn't introducing channel variance", runs, decoded)
	}
}

// --- P2: aggregated capture (aggregateInterfererSNRdB) -------------------

// TestAggregateInterfererSNRdBSumsPower is the unit check: one interferer
// aggregates to itself; two equal interferers sum to +3 dB (double power).
func TestAggregateInterfererSNRdBSumsPower(t *testing.T) {
	if got := aggregateInterfererSNRdB([]float64{8}); math.Abs(got-8) > 1e-9 {
		t.Errorf("single interferer should aggregate to itself, got %v", got)
	}
	got := aggregateInterfererSNRdB([]float64{8, 8})
	if math.Abs(got-(8+10*math.Log10(2))) > 1e-9 {
		t.Errorf("two equal 8 dB interferers should sum to +3 dB (%.3f), got %v", 8+10*math.Log10(2), got)
	}
}

// TestCaptureAggregationCorruptsWherePairwiseWouldSurvive is the headline
// P2 test: two interferers each individually beaten by the wanted signal
// (so the old pairwise model let it survive both), whose COMBINED power
// nonetheless corrupts it. wanted 15 dB; two interferers at 8 dB each are
// each 7 dB down (> the 6 dB capture margin, so individually captured),
// but together present ~11 dB, leaving only a 4 dB margin — corrupted.
func TestCaptureAggregationCorruptsWherePairwiseWouldSurvive(t *testing.T) {
	const wanted, int1, int2, listener = 0, 1, 2, 3
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: wanted, To: listener, SNRdB: 15},
			{From: int1, To: listener, SNRdB: 8},
			{From: int2, To: listener, SNRdB: 8},
		},
	}
	// Both interferers start after the wanted packet's lock deadline (so
	// this is a payload-corruption question, not a lock question) but still
	// overlap its airtime window.
	preambleMs := uint32(preambleDurationMs(DefaultLoRaParams()))
	messages := []Message{
		{Origin: wanted, SendAtMs: 0, PayloadLen: 20},
		{Origin: int1, SendAtMs: preambleMs + 10, PayloadLen: 20},
		{Origin: int2, SendAtMs: preambleMs + 20, PayloadLen: 20},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atListener *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node == listener && r.FromNode == wanted {
			atListener = r
		}
	}
	if atListener == nil {
		t.Fatal("expected a reception at the listener from the wanted sender")
	}
	if !atListener.Collided {
		t.Errorf("expected combined interference to corrupt the wanted signal, got Collided=false: %+v", atListener)
	}
	if atListener.CollisionKind != "corrupted" {
		t.Errorf("expected CollisionKind %q, got %q", "corrupted", atListener.CollisionKind)
	}
	// Sanity: a SINGLE one of those interferers must NOT corrupt it (7 dB
	// margin > 6 dB) — proving the corruption above is genuinely the
	// aggregation, not either interferer alone.
	single := Scenario{
		Nodes: scenario.Nodes,
		Links: []Link{{From: wanted, To: listener, SNRdB: 15}, {From: int1, To: listener, SNRdB: 8}},
	}
	singleReport := Run(single, []Message{
		{Origin: wanted, SendAtMs: 0, PayloadLen: 20},
		{Origin: int1, SendAtMs: preambleMs + 10, PayloadLen: 20},
	}, zeroRNG{}, 60_000)
	for i := range singleReport.Receptions {
		r := &singleReport.Receptions[i]
		if r.Node == listener && r.FromNode == wanted && r.Collided {
			t.Errorf("a single 7 dB-down interferer should be captured over, not collide: %+v", r)
		}
	}
}

// --- strength-aware preamble acquisition ---------------------------------

// TestRunStrongSignalWinsLockOverWeakPreambleInterferer is the end-to-end
// proof of the strength-aware acquisition model: a much weaker transmission
// overlapping a strong wanted packet's preamble window no longer prevents
// lock (the old model treated ANY preamble overlap as fatal regardless of
// level). The strong wanted packet is decoded; the weak interferer is
// demoted to a payload interferer it also dominates, so the reception
// survives via capture rather than colliding.
func TestRunStrongSignalWinsLockOverWeakPreambleInterferer(t *testing.T) {
	const strong, weak, listener = 0, 1, 2
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: strong, To: listener, SNRdB: 15},
			{From: weak, To: listener, SNRdB: 0}, // 15 dB down — well beyond the preamble capture margin
		},
	}
	// The weak interferer starts DURING the strong packet's preamble window
	// (both at t=0) — the exact case the old model called an unconditional
	// no_lock.
	messages := []Message{
		{Origin: strong, SendAtMs: 0, PayloadLen: 20},
		{Origin: weak, SendAtMs: 0, PayloadLen: 20},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	var atListenerFromStrong *Reception
	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node == listener && r.FromNode == strong {
			atListenerFromStrong = r
		}
	}
	if atListenerFromStrong == nil {
		t.Fatal("expected a reception at the listener from the strong sender")
	}
	if atListenerFromStrong.Collided {
		t.Errorf("expected the strong signal to win lock over a 15 dB-weaker preamble interferer, got Collided=true (%s): %+v", atListenerFromStrong.CollisionKind, atListenerFromStrong)
	}
	if !atListenerFromStrong.SurvivedCapture {
		t.Errorf("expected SurvivedCapture=true (a weaker interferer was present but lost), got: %+v", atListenerFromStrong)
	}
}

// TestRunComparablePreambleInterferersStillCollide is the complementary
// guard: two comparable-strength transmissions whose preambles overlap must
// STILL collide (neither dominates acquisition) — strength-awareness must
// not turn a genuine collision into a spurious capture.
func TestRunComparablePreambleInterferersStillCollide(t *testing.T) {
	const a, b, listener = 0, 1, 2
	scenario := Scenario{
		Nodes: []SimNode{testNode(false), testNode(false), testNode(false)},
		Links: []Link{
			{From: a, To: listener, SNRdB: 3},
			{From: b, To: listener, SNRdB: 0}, // only 3 dB apart — below the capture margin either way
		},
	}
	messages := []Message{
		{Origin: a, SendAtMs: 0, PayloadLen: 20},
		{Origin: b, SendAtMs: 0, PayloadLen: 20},
	}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	for i := range report.Receptions {
		r := &report.Receptions[i]
		if r.Node != listener {
			continue
		}
		if !r.Collided || r.CollisionKind != "no_lock" {
			t.Errorf("expected both comparable-strength preamble-overlapping receptions to collide as no_lock, got: %+v", r)
		}
	}
}

// TestRunRelaysWithHighRxDelayBaseAndStrongSignal is the end-to-end guard
// for the negative-RX-delay bug (see TestRxDelayMsNeverNegativeForStrongSignal):
// a repeater configured with rxDelayBase > 1, receiving a strong (high
// PacketScore) packet, must still relay it. The old code produced a
// negative RX delay here that became a huge uint32 in relayAt, scheduling
// the relay in the past / beyond the sim window so it never went out.
func TestRunRelaysWithHighRxDelayBaseAndStrongSignal(t *testing.T) {
	// A -> B -> C, strong links (high SNR -> high PacketScore -> the
	// score>0.85 regime where the raw RX-delay formula goes negative).
	a, b, c := 0, 1, 2
	nodes := []SimNode{testNode(true), testNode(true), testNode(false)}
	nodes[b].Prefs.RxDelayBase = 3 // a common community value, > 1 — the trigger
	scenario := Scenario{
		Nodes: nodes,
		Links: []Link{
			{From: a, To: b, SNRdB: 20}, {From: b, To: a, SNRdB: 20},
			{From: b, To: c, SNRdB: 20}, {From: c, To: b, SNRdB: 20},
		},
	}
	messages := []Message{{Origin: a, SendAtMs: 0, PayloadLen: 20}}

	report := Run(scenario, messages, zeroRNG{}, 60_000)

	// B must relay, and C must receive B's relay within the sim window.
	var bRelayed, cGotIt bool
	for _, tx := range report.Transmissions {
		if tx.Node == b && tx.IsRelay {
			bRelayed = true
		}
	}
	for _, r := range report.Receptions {
		if r.Node == c && r.FromNode == b && isCanonicalDelivery(r) {
			cGotIt = true
		}
	}
	if !bRelayed {
		t.Error("node B (rxDelayBase=3) failed to relay a strong-signal packet — the negative-RX-delay bug")
	}
	if !cGotIt {
		t.Error("node C never received B's relay — B's relay was scheduled outside the sim window (negative-RX-delay bug)")
	}
}

// rngFunc adapts a plain func to the RNG interface for tests.
type rngFunc func(int) int

func (f rngFunc) IntN(n int) int { return f(n) }
