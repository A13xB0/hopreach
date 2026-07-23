package meshsim

import "testing"

// fixedRNG always returns a fixed value from IntN, clamped to n-1 — lets
// tests pin down the exact boundary of a random window (e.g. "the maximum
// possible delay") without depending on any particular RNG implementation.
type fixedRNG struct{ pickMax bool }

func (r fixedRNG) IntN(n int) int {
	if n <= 0 {
		return 0
	}
	if r.pickMax {
		return n - 1
	}
	return 0
}

func TestRetransmitDelayMs(t *testing.T) {
	const airtimeMs = 300
	const txDelayFactor = 0.5
	// t = 300*0.5 = 150; window = [0, 5*150+1) = [0, 751)
	if got := RetransmitDelayMs(fixedRNG{pickMax: false}, airtimeMs, txDelayFactor); got != 0 {
		t.Errorf("RetransmitDelayMs with RNG always picking 0 = %d, want 0", got)
	}
	if got := RetransmitDelayMs(fixedRNG{pickMax: true}, airtimeMs, txDelayFactor); got != 750 {
		t.Errorf("RetransmitDelayMs with RNG always picking the max = %d, want 750 (5*150)", got)
	}
}

func TestDirectRetransmitDelayMs(t *testing.T) {
	const airtimeMs = 300
	const directTxDelayFactor = 0.3
	// t = 300*0.3 = 90; window = [0, 5*90+1) = [0, 451)
	if got := DirectRetransmitDelayMs(fixedRNG{pickMax: true}, airtimeMs, directTxDelayFactor); got != 450 {
		t.Errorf("DirectRetransmitDelayMs with RNG always picking the max = %d, want 450 (5*90)", got)
	}
}

func TestRetransmitDelayWindowScalesWithTxDelayFactor(t *testing.T) {
	const airtimeMs = 1000
	low := RetransmitDelayMs(fixedRNG{pickMax: true}, airtimeMs, 0.1)
	high := RetransmitDelayMs(fixedRNG{pickMax: true}, airtimeMs, 1.5)
	if high <= low {
		t.Errorf("a higher TxDelayFactor (1.5) should widen the max possible delay (%d) beyond a lower factor's (0.1, %d)", high, low)
	}
}

func TestRxDelayMsDisabledWhenBaseIsZeroOrLess(t *testing.T) {
	for _, base := range []float64{0, -1, -10} {
		if got := RxDelayMs(base, 0.0, 5000); got != 0 {
			t.Errorf("RxDelayMs(%v, ...) = %d, want 0 (disabled — matches real firmware's current default)", base, got)
		}
	}
}

// TestRxDelayMsZeroAtScore0Point85 is a formula-independent check: at
// score == 0.85, the exponent (0.85 - score) is exactly 0, so
// pow(base, 0) - 1 == 0 for *any* positive base — the delay must be exactly
// 0 regardless of rxDelayBase's value or airtime, without needing to trust
// a from-formula-derived expected value.
func TestRxDelayMsZeroAtScore0Point85(t *testing.T) {
	for _, base := range []float64{0.5, 1, 2, 10, 20} {
		for _, airtime := range []uint32{100, 1000, 30000} {
			if got := RxDelayMs(base, 0.85, airtime); got != 0 {
				t.Errorf("RxDelayMs(%v, 0.85, %d) = %d, want 0 (pow(base,0)-1 == 0 for any base)", base, airtime, got)
			}
		}
	}
}

func TestRxDelayMsLowerScoreMeansLongerDelay(t *testing.T) {
	const base = 10.0
	const airtime = 1000
	weakSignal := RxDelayMs(base, 0.0, airtime)    // low score, weak signal
	strongSignal := RxDelayMs(base, 0.85, airtime) // high score, strong signal
	if weakSignal <= strongSignal {
		t.Errorf("a weak-signal reception's delay (%d) should exceed a strong-signal one's (%d)", weakSignal, strongSignal)
	}
}
