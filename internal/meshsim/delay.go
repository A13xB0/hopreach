package meshsim

import "math"

// RNG is the random source RetransmitDelayMs/DirectRetransmitDelayMs draw
// from — an interface (not a concrete *rand.Rand) so the simulation engine
// can seed a deterministic source per run, letting two rule-sets be
// compared fairly against the *same* random draws rather than confounding
// "did the new settings help" with "did we just get luckier random delays
// this time."
type RNG interface {
	// IntN returns a pseudo-random int in [0, n) — same contract as
	// math/rand/v2's Rand.IntN, which any *rand.Rand satisfies.
	IntN(n int) int
}

// RetransmitDelayMs is a direct port of MyMesh::getRetransmitDelay — the
// random delay a node waits before relaying a *flood* packet, sized against
// that packet's own airtime and TxDelayFactor. This is the primary
// collision-avoidance mechanism MeshCore relies on: multiple repeaters that
// all just heard the same flood packet independently draw a random delay
// from the same window, spreading their retransmissions out instead of all
// firing at once.
func RetransmitDelayMs(rng RNG, airtimeMs uint32, txDelayFactor float64) uint32 {
	t := uint32(float64(airtimeMs) * txDelayFactor)
	return uint32(rng.IntN(int(5*t + 1)))
}

// DirectRetransmitDelayMs is a direct port of
// MyMesh::getDirectRetransmitDelay — the same mechanism as
// RetransmitDelayMs, applied to direct (routed, non-flood) traffic via
// DirectTxDelayFactor instead. Real firmware's default factor is lower
// (0.3 vs 0.5) since far fewer nodes compete to relay a packet addressed to
// one specific next hop.
func DirectRetransmitDelayMs(rng RNG, airtimeMs uint32, directTxDelayFactor float64) uint32 {
	t := uint32(float64(airtimeMs) * directTxDelayFactor)
	return uint32(rng.IntN(int(5*t + 1)))
}

// RxDelayMs is a direct port of MyMesh::calcRxDelay — a deterministic (not
// randomized) hold-back applied to a *weak-signal* flood reception before
// it's processed, so a repeater that only just barely heard a packet
// doesn't immediately compete to relay it ahead of repeaters that received
// it cleanly. score is PacketScore's own 0..1 output for this reception;
// rxDelayBase<=0 (the current real firmware default) disables this
// mechanism entirely, matching MyMesh::calcRxDelay's own early return.
func RxDelayMs(rxDelayBase float64, score float64, airtimeMs uint32) int {
	if rxDelayBase <= 0 {
		return 0
	}
	return int((math.Pow(rxDelayBase, 0.85-score) - 1.0) * float64(airtimeMs))
}

// MaxRxDelayMs mirrors Dispatcher.cpp's own MAX_RX_DELAY_MILLIS clamp — real
// firmware never holds a weak-signal reception back longer than this,
// regardless of how low its score is.
const MaxRxDelayMs = 32000
