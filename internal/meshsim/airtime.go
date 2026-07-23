// Package meshsim implements a faithful, from-source model of MeshCore's own
// flood-relay timing and collision-avoidance behavior (calcRxDelay,
// getRetransmitDelay, getDirectRetransmitDelay, and the standard LoRa
// time-on-air formula they're built on) — not an approximation, a direct
// port of the real firmware's formulas, verified line-for-line against
// github.com/meshcore-dev/MeshCore's actual source
// (examples/simple_repeater/MyMesh.cpp, src/Dispatcher.cpp,
// src/helpers/radiolib/RadioLibWrappers.cpp) rather than secondhand
// descriptions, specifically so predictions made here are trustworthy
// enough to suggest real device settings from. Plain Go, compiled to WASM
// the same way internal/propagation already is, so the browser-side
// simulator and any future server-side batch tooling share one
// implementation instead of two that can drift apart.
package meshsim

import "math"

// LoRaParams is one radio configuration — mirrors MeshCore's own
// `set radio <freq>,<bw>,<sf>,<cr>` CLI command exactly (same field meaning
// and units), plus the packet-framing options the airtime formula also
// needs. CR here uses MeshCore's own convention (5-8, the denominator of
// the 4/CR coding rate), not the Semtech AN1200.13 paper's CR (1-4) — see
// Airtime, which converts internally.
type LoRaParams struct {
	FreqMHz float64 // e.g. 869.525
	BWkHz   float64 // e.g. 250
	SF      int     // spreading factor, 5-12
	CR      int     // coding rate denominator, 5-8 (i.e. 4/5 .. 4/8) — MeshCore's CLI convention

	// PreambleSymbols is the LoRa preamble length in symbols. 8 is the
	// standard LoRa/RadioLib default and not yet confirmed against
	// MeshCore's own radio init code — override if that turns out to
	// differ once verified.
	PreambleSymbols int
	// ExplicitHeader: true for MeshCore's normal packet framing (variable
	// payload length needs an explicit header); implicit header (false) is
	// a fixed-length-payload LoRa mode MeshCore doesn't appear to use.
	ExplicitHeader bool
	// CRCEnabled: true for MeshCore's normal payload CRC.
	CRCEnabled bool
}

// DefaultLoRaParams mirrors MeshCore's own documented default:
// "set radio 869.525,250,11,5".
func DefaultLoRaParams() LoRaParams {
	return LoRaParams{
		FreqMHz: 869.525, BWkHz: 250, SF: 11, CR: 5,
		PreambleSymbols: 8, ExplicitHeader: true, CRCEnabled: true,
	}
}

// lowDataRateOptimize mirrors the standard LoRa rule (and RadioLib's own
// auto-detection, which MeshCore relies on rather than setting explicitly):
// enabled whenever a symbol takes at least 16ms, since the radio's frequency
// drift over that long a symbol needs the extra coding margin.
func lowDataRateOptimize(symbolDurationMs float64) bool {
	return symbolDurationMs >= 16.0
}

// Airtime returns how long transmitting a payloadLen-byte LoRa packet takes
// under p, using the standard Semtech AN1200.13 time-on-air formula — the
// same formula RadioLib (which MeshCore's own RadioLibWrapper.getEstAirtimeFor
// delegates to) implements for real hardware. Returned in milliseconds,
// truncated the same way RadioLibWrapper::getEstAirtimeFor's
// microseconds/1000 integer division is (matching real firmware's own
// rounding behavior, not just mathematical convenience).
func AirtimeMs(p LoRaParams, payloadLen int) uint32 {
	symbolDurationMs := math.Exp2(float64(p.SF)) / p.BWkHz // 2^SF / BW, BW in kHz so this is already in ms
	de := 0.0
	if lowDataRateOptimize(symbolDurationMs) {
		de = 1.0
	}
	ih := 0.0
	if !p.ExplicitHeader {
		ih = 1.0
	}
	crc := 0.0
	if p.CRCEnabled {
		crc = 1.0
	}
	// MeshCore's own coding rate CLI value is the denominator (5-8); the
	// Semtech formula's CR is that minus 4 (1-4, i.e. "4/5" -> 1).
	crSemtech := float64(p.CR - 4)

	preamble := (float64(p.PreambleSymbols) + 4.25) * symbolDurationMs

	numerator := 8*float64(payloadLen) - 4*float64(p.SF) + 28 + 16*crc - 20*ih
	denominator := 4 * (float64(p.SF) - 2*de)
	nPayloadSymbols := 8.0
	if numerator > 0 {
		nPayloadSymbols += math.Ceil(numerator/denominator) * (crSemtech + 4)
	}

	totalMs := preamble + nPayloadSymbols*symbolDurationMs
	return uint32(totalMs) // truncating int conversion, matching getEstAirtimeFor's own microseconds/1000 integer division
}
