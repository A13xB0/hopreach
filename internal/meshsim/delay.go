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
	delay := int((math.Pow(rxDelayBase, 0.85-score) - 1.0) * float64(airtimeMs))
	// Mirror Dispatcher::checkRecv's own `if (_delay < 50) { process
	// immediately }` gate (Dispatcher.cpp:243): a computed hold-back below
	// rxDelayMinThresholdMs is NOT queued as a delayed relay at all — the
	// packet is processed straight away, i.e. an effective delay of 0. This
	// crucially covers the NEGATIVE values pow(rxDelayBase, 0.85-score)
	// produces whenever score > 0.85 (a strong, cleanly-decoded reception)
	// and rxDelayBase > 1: pow(base, negative) < 1, so (…-1)*airtime < 0.
	// Without this clamp a negative delay flows into the engine's
	// relayAt := atMs + uint32(rxDelay) + txDelay, where uint32(negative)
	// is an enormous value that schedules the relay in the past / beyond
	// the sim window — silently breaking every relay from a node with
	// rxDelayBase > 1. That's not a hypothetical: the adaptive optimizer's
	// own rx_delay_backoff move raises rxDelayBase into exactly that range.
	if delay < rxDelayMinThresholdMs {
		return 0
	}
	if delay > MaxRxDelayMs {
		return MaxRxDelayMs
	}
	return delay
}

// rxDelayMinThresholdMs mirrors the literal 50 in Dispatcher::checkRecv's
// own "process immediately" branch — any hold-back shorter than this
// (including negatives) is treated as no delay at all. See RxDelayMs.
const rxDelayMinThresholdMs = 50

// MaxRxDelayMs mirrors Dispatcher.cpp's own MAX_RX_DELAY_MILLIS clamp — real
// firmware never holds a weak-signal reception back longer than this,
// regardless of how low its score is:
//
//	if (_delay > MAX_RX_DELAY_MILLIS) { _delay = MAX_RX_DELAY_MILLIS; }
//
// (Dispatcher.cpp:248-250). Previously declared here but never actually
// applied by RxDelayMs — a real bug that would have biased any tuning
// search over rxDelayBase:
// without the clamp, a high rxDelayBase combined with a long airtime (SF12,
// a large payload) produces delays real hardware would never actually
// apply, making that candidate score worse than reality.
const MaxRxDelayMs = 32000
