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

// TestRxDelayMsClampsAtMaxRxDelayMs is a direct regression test: real
// firmware never
// holds a reception back longer than MAX_RX_DELAY_MILLIS (32s), regardless
// of how extreme rxDelayBase or airtime are — this was declared but never
// actually applied.
func TestRxDelayMsClampsAtMaxRxDelayMs(t *testing.T) {
	// A deliberately extreme combination — high rxDelayBase, worst-case
	// score, long airtime — that without the clamp would compute a delay
	// far past 32s.
	got := RxDelayMs(1000, 0.0, 30_000)
	if got != MaxRxDelayMs {
		t.Errorf("RxDelayMs with an extreme rxDelayBase/airtime = %dms, want clamped to MaxRxDelayMs (%dms)", got, MaxRxDelayMs)
	}
}

// TestRxDelayMsNeverNegativeForStrongSignal is the direct regression test
// for the negative-delay bug: at score > 0.85 with rxDelayBase > 1,
// pow(base, 0.85-score) < 1, so the raw formula is NEGATIVE. Real firmware's
// `if (_delay < 50)` branch treats that as "process immediately" (delay 0);
// RxDelayMs must too. Without it a negative here became a huge uint32 in
// the engine's relayAt arithmetic, silently breaking every relay from a
// node with rxDelayBase > 1 — the range the optimizer's rx_delay_backoff
// move raises it to.
func TestRxDelayMsNeverNegativeForStrongSignal(t *testing.T) {
	for _, base := range []float64{1.5, 3, 10, 20} {
		for _, score := range []float64{0.9, 0.95, 1.0} {
			for _, airtime := range []uint32{100, 1000, 30_000} {
				if got := RxDelayMs(base, score, airtime); got < 0 {
					t.Errorf("RxDelayMs(%v, %v, %d) = %d, want >= 0 (a strong-signal reception must never produce a negative hold-back)", base, score, airtime, got)
				}
			}
		}
	}
}

// TestRxDelayMsBelowThresholdIsZero pins the firmware `if (_delay < 50)`
// gate: a small-but-positive computed hold-back (below rxDelayMinThresholdMs)
// is processed immediately, not applied.
func TestRxDelayMsBelowThresholdIsZero(t *testing.T) {
	// base 1.1, score 0.5 -> pow(1.1, 0.35)-1 ~= 0.0335; * a short airtime
	// stays well under 50ms.
	if got := RxDelayMs(1.1, 0.5, 500); got != 0 {
		t.Errorf("RxDelayMs(1.1, 0.5, 500) = %d, want 0 (a sub-50ms hold-back is processed immediately)", got)
	}
}
