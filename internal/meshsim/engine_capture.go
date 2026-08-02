package meshsim

import (
	"math"
)

// LoRa channel physics: whether two overlapping transmissions
// collide, which one survives capture, and whether what is left
// actually decodes.

func overlaps(aStart, aEnd, bStart, bEnd uint32) bool {
	return aStart < bEnd && bStart < aEnd
}

// captureMarginDB is how much stronger (in dB SNR at the listener) a wanted
// signal must be than a co-channel interferer for real LoRa's capture
// effect to let it be decoded anyway, rather than both being destroyed —
// unlike narrowband FM/ASK capture (which can be as low as ~1dB), LoRa's
// chirp spread spectrum needs a real margin to reject an interferer;
// ~6dB is a commonly cited same-SF LoRa co-channel rejection figure. A
// named, tunable constant rather than folded into the comparison inline,
// since this specific number is a literature figure (not verified against
// our own measured hardware behavior) and may need adjusting.
const captureMarginDB = 6.0

// preambleCaptureMarginDB is the acquisition-stage counterpart of
// captureMarginDB: how much stronger the wanted signal must be than a
// co-channel interferer arriving during its own preamble/sync window for
// the receiver to still lock onto the wanted (rather than the interferer
// preventing acquisition). Real LoRa preamble detection is a correlation
// against a known chirp sequence, so a much weaker concurrent signal does
// not stop a strong wanted packet from being acquired — the receiver locks
// onto whichever preamble dominates. Kept EQUAL to captureMarginDB absent
// evidence to differentiate the two stages; a separate named constant so it
// can diverge if measured behavior ever warrants it (correlation processing
// gain could make acquisition somewhat more forgiving than payload
// rejection). Previously this stage had no strength test at all — any
// preamble-window overlap was treated as fatal regardless of level.
const preambleCaptureMarginDB = captureMarginDB

// captureOutcome is the result of one wanted-transmission-vs-one-interferer
// comparison — see loraCaptureOutcome. Three-valued rather than a bool
// because a caller (the interferer loop in eventRxComplete) needs to know
// not just whether the wanted signal survived, but *how* it failed when it
// didn't, to populate Reception.CollisionKind.
type captureOutcome int

const (
	outcomeCaptured  captureOutcome = iota // the wanted signal survived this specific interferer
	outcomeNoLock                          // this interferer arrived during preamble/sync acquisition AND was strong enough to block lock
	outcomeCorrupted                       // lock was achieved, but this interferer wasn't beaten by captureMarginDB
)

// loraCaptureOutcome reports whether tx (the wanted transmission, arriving
// with wantedSNR at the listener) survives other's overlapping, audible
// transmission (arriving with interfererSNR) via the capture effect, and if
// not, which of the two physically distinct ways it failed. This is the
// single-interferer reference primitive; the Run loop applies the same two
// stages but aggregates the payload stage across all interferers at once
// (which a single-pair function can't express).
//
// Two stages, both real LoRa demodulator behavior, and BOTH now
// strength-aware:
//
//  1. Acquisition (timing + strength): if other starts before tx's own
//     preamble+sync window has elapsed (preambleDurationMs), it contends
//     for lock. The receiver still locks onto tx if tx dominates other by
//     preambleCaptureMarginDB (LoRa preamble correlation rejects a
//     sufficiently weaker concurrent signal); otherwise lock never
//     establishes (outcomeNoLock). This mirrors real firmware's own
//     isReceivingPacket()/isChannelActive() distinction
//     (src/helpers/radiolib/RadioLibWrappers.cpp) between merely detecting
//     channel activity and having actually locked onto a specific packet's
//     preamble. When tx wins acquisition over a weaker preamble interferer,
//     that interferer then contends at the payload stage instead (in the
//     Run loop; this single-pair function reports outcomeCaptured for it,
//     since with only that one interferer present tx also wins the payload
//     stage by the same margin).
//  2. Payload (strength): once locked (interference arrives during payload
//     symbols, after tx's own preamble window), the receiver can reject a
//     weaker co-channel interferer — captured if wantedSNR beats
//     interfererSNR by at least captureMarginDB; otherwise the payload is
//     corrupted.
func loraCaptureOutcome(wantedSNR, interfererSNR float64, tx, other transmission) captureOutcome {
	if startsBeforeLock(tx, other) {
		if wantedSNR-interfererSNR >= preambleCaptureMarginDB {
			return outcomeCaptured
		}
		return outcomeNoLock
	}
	if wantedSNR-interfererSNR >= captureMarginDB {
		return outcomeCaptured
	}
	return outcomeCorrupted
}

// loraCaptured is loraCaptureOutcome collapsed to a bool, for the one call
// site (the interferer loop) that only needs pass/fail plus its own
// captureOutcome switch for the kind, and for tests that only care whether
// capture happened at all.
func loraCaptured(wantedSNR, interfererSNR float64, tx, other transmission) bool {
	return loraCaptureOutcome(wantedSNR, interfererSNR, tx, other) == outcomeCaptured
}

// startsBeforeLock reports whether other begins before tx's own
// preamble+sync acquisition window has elapsed — i.e. whether other
// prevents the receiver from ever locking onto tx at all (condition 1 of
// loraCaptureOutcome, factored out so the aggregated interferer loop in
// Run can partition preamble-window interferers from payload-window ones).
func startsBeforeLock(tx, other transmission) bool {
	return other.startMs < tx.startMs+uint32(preambleDurationMs(tx.radio))
}

// aggregateInterfererSNRdB combines several co-channel interferers'
// individual SNRs into the single effective interferer level their COMBINED
// power presents, by summing in the linear domain and converting back to
// dB. This is the fix for pairwise capture over-optimism (docs/SIMULATOR_
// PLAN_PHASE7.md): evaluating each interferer separately lets a wanted
// signal "win" against several interferers it individually beats by the
// capture margin, even though their summed energy would corrupt it. Two
// equal interferers sum to +3 dB, three to ~+4.8 dB, and so on — so the
// effective margin the wanted signal must clear shrinks as interferers
// pile up, which is the real physical behaviour. For a single interferer
// this returns exactly that interferer's own SNR, so nothing changes in
// the (common, and only previously-tested) one-interferer case.
func aggregateInterfererSNRdB(snrs []float64) float64 {
	var linear float64
	for _, s := range snrs {
		linear += math.Pow(10, s/10)
	}
	if linear <= 0 {
		return math.Inf(-1)
	}
	return 10 * math.Log10(linear)
}

// channelBusy reports whether sender would currently detect the radio
// channel as occupied — i.e. some other node's transmission, audible to
// sender, has an airtime window that contains atMs right now — mirroring
// real firmware's _radio->isReceiving() check in Dispatcher::checkSend().
// A node never CAD-detects its own prior transmission.
func channelBusy(transmissions []transmission, adj adjacency, sender int, atMs uint32) bool {
	for _, tx := range transmissions {
		if tx.sender == sender {
			continue
		}
		if atMs < tx.startMs || atMs >= tx.endMs {
			continue
		}
		if audibleTo(adj, tx.sender, sender) {
			return true
		}
	}
	return false
}

func audibleTo(adj adjacency, sender, listener int) bool {
	for _, l := range adj[sender] {
		if l.To == listener {
			return true
		}
	}
	return false
}

func linkSNR(adj adjacency, sender, listener int) float64 {
	for _, l := range adj[sender] {
		if l.To == listener {
			return l.SNRdB
		}
	}
	return -999 // unreachable in practice — only called after audibleTo confirms a link exists
}

func snrThresholdForSF(sf int) float64 {
	if sf < 7 || sf > 12 {
		return 999 // out of the modeled range — never passes
	}
	return snrThresholdDB[sf-7]
}

// uniformFloat draws a uniform in [0,1) from the RNG interface's only
// method (IntN) — 24 bits of resolution, far finer than any dB-scale
// perturbation here needs. Kept off the hot path: only ever called when a
// ChannelParams feature is actually enabled, so a zero-value (legacy)
// Channel consumes no RNG draws and reproduces prior behaviour exactly.
func uniformFloat(rng RNG) float64 {
	const bits = 1 << 24
	return float64(rng.IntN(bits)) / float64(bits)
}

// gaussian draws a standard-normal sample (mean 0, stddev 1) via
// Box-Muller from two uniforms — deterministic for a deterministic RNG,
// so paired-seed comparisons (the optimizer's whole confidence model)
// stay valid.
func gaussian(rng RNG) float64 {
	u1 := uniformFloat(rng)
	if u1 < 1e-12 {
		u1 = 1e-12 // guard the log; the drawn value is otherwise unbiased
	}
	u2 := uniformFloat(rng)
	return math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
}

// decodes reports whether a wanted signal arriving at effSnr (its mean SNR
// plus any fading already applied by the caller) is successfully decoded
// at spreading factor sf, under channel. With ch.PERWidthDB <= 0 this is
// the legacy hard step (effSnr >= threshold); otherwise it's a logistic
// packet-error-rate curve centred on that SF's own threshold, sampled with
// rng. Only draws from rng when the probabilistic model is active.
func decodes(effSnr float64, sf int, ch ChannelParams, rng RNG) bool {
	threshold := snrThresholdForSF(sf)
	if ch.PERWidthDB <= 0 {
		return effSnr >= threshold
	}
	p := 1.0 / (1.0 + math.Exp(-(effSnr-threshold)/ch.PERWidthDB))
	return uniformFloat(rng) < p
}
