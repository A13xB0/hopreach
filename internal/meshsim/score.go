package meshsim

// snrThresholdDB is the approximate per-SF minimum SNR for successful
// reception — ported directly from
// RadioLibWrapper::packetScoreInt's own snr_threshold table
// (src/helpers/radiolib/RadioLibWrappers.cpp), indexed by SF-7 there and
// here alike (SF7 at index 0).
var snrThresholdDB = [6]float64{
	-7.5,  // SF7
	-10,   // SF8
	-12.5, // SF9
	-15,   // SF10
	-17.5, // SF11
	-20,   // SF12
}

// PacketScore is a direct port of RadioLibWrapper::packetScoreInt: a rough
// 0..1 estimate of how likely a packet was to be received cleanly, given
// its SNR, the spreading factor it was sent at, and its own length (longer
// packets are treated as more collision-prone — MeshCore's own stated
// assumption, "Assuming max packet of 256 bytes", not a real collision
// simulation, which is exactly why this project's own discrete-event
// engine models collisions directly instead of relying on this heuristic
// alone). Used by MeshCore's real firmware only to decide the *weak-signal
// RX holdback* delay (see RxDelayMs) — kept here under the same name and
// behavior so that specific formula stays faithful to the real firmware,
// not because this project treats it as its own collision model.
func PacketScore(snrDB float64, sf int, packetLenBytes int) float64 {
	if sf < 7 {
		return 0
	}
	threshold := snrThresholdDB[sf-7]
	if snrDB < threshold {
		return 0
	}
	successRateFromSNR := (snrDB - threshold) / 10.0
	collisionPenalty := 1 - (float64(packetLenBytes) / 256.0)
	score := successRateFromSNR * collisionPenalty
	if score < 0 {
		return 0
	}
	if score > 1 {
		return 1
	}
	return score
}
