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
	FreqMHz float64 `json:"freqMhz"` // e.g. 869.525
	BWkHz   float64 `json:"bwKhz"`   // e.g. 250
	SF      int     `json:"sf"`      // spreading factor, 5-12
	CR      int     `json:"cr"`      // coding rate denominator, 5-8 (i.e. 4/5 .. 4/8) — MeshCore's CLI convention

	// ExplicitHeader: true for MeshCore's normal packet framing (variable
	// payload length needs an explicit header); implicit header (false) is
	// a fixed-length-payload LoRa mode MeshCore doesn't appear to use.
	ExplicitHeader bool `json:"explicitHeader"`
	// CRCEnabled: true for MeshCore's normal payload CRC.
	CRCEnabled bool `json:"crcEnabled"`
}

// DefaultLoRaParams mirrors the EU/UK (Narrow) preset (sourced from
// api.meshcore.nz/api/v1/config) — the current MeshCore-recommended default
// for this region. The project's previous default, 869.525/SF11/BW250/CR5,
// is now labelled "EU/UK (Deprecated)" in that same upstream list.
func DefaultLoRaParams() LoRaParams {
	return LoRaParams{
		FreqMHz: 869.618, BWkHz: 62.5, SF: 8, CR: 8,
		ExplicitHeader: true, CRCEnabled: true,
	}
}

// lowDataRateOptimize mirrors the standard LoRa rule (and RadioLib's own
// auto-detection, which MeshCore relies on rather than setting explicitly):
// enabled whenever a symbol takes at least 16ms, since the radio's frequency
// drift over that long a symbol needs the extra coding margin.
func lowDataRateOptimize(symbolDurationMs float64) bool {
	return symbolDurationMs >= 16.0
}

// preambleSymbolsForSF mirrors RadioLibWrapper::preambleLengthForSF exactly
// (src/helpers/radiolib/RadioLibWrappers.h) — real MeshCore firmware derives
// preamble length from spreading factor automatically; there is no user-
// facing setting for it (unlike freq/BW/SF/CR, which the CLI's `set radio`
// does expose), so it is deliberately NOT a LoRaParams field a caller can
// set independently of SF — that would just reopen the drift this function
// exists to prevent (a previous version stored a fixed PreambleSymbols: 8
// for every SF, which undercounted airtime 4x at SF8 and below).
func preambleSymbolsForSF(sf int) int {
	if sf <= 8 {
		return 32
	}
	return 16
}

// symbolDurationMs returns one LoRa symbol's duration under p — 2^SF/BW,
// with BW in kHz so the result is already in ms.
func symbolDurationMs(p LoRaParams) float64 {
	return math.Exp2(float64(p.SF)) / p.BWkHz
}

// preambleDurationMs is the (preambleSymbolsForSF(p.SF) + 4.25) symbols a
// receiver needs to hear and lock onto before it can even start
// demodulating a packet's header/payload — shared by AirtimeMs (the
// preamble is part of total time-on-air) and the capture-effect logic in
// engine.go (an interferer arriving before this window elapses prevents
// lock from ever happening, regardless of relative signal strength).
func preambleDurationMs(p LoRaParams) float64 {
	return (float64(preambleSymbolsForSF(p.SF)) + 4.25) * symbolDurationMs(p)
}

// Airtime returns how long transmitting a payloadLen-byte LoRa packet takes
// under p, using the standard Semtech AN1200.13 time-on-air formula — the
// same formula RadioLib (which MeshCore's own RadioLibWrapper.getEstAirtimeFor
// delegates to) implements for real hardware. Returned in milliseconds,
// truncated the same way RadioLibWrapper::getEstAirtimeFor's
// microseconds/1000 integer division is (matching real firmware's own
// rounding behavior, not just mathematical convenience).
func AirtimeMs(p LoRaParams, payloadLen int) uint32 {
	symDurMs := symbolDurationMs(p)
	de := 0.0
	if lowDataRateOptimize(symDurMs) {
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

	numerator := 8*float64(payloadLen) - 4*float64(p.SF) + 28 + 16*crc - 20*ih
	denominator := 4 * (float64(p.SF) - 2*de)
	nPayloadSymbols := 8.0
	if numerator > 0 {
		nPayloadSymbols += math.Ceil(numerator/denominator) * (crSemtech + 4)
	}

	totalMs := preambleDurationMs(p) + nPayloadSymbols*symDurMs
	return uint32(totalMs) // truncating int conversion, matching getEstAirtimeFor's own microseconds/1000 integer division
}

// onAirLen returns the byte count actually transmitted for a packet — a
// direct port of Packet::getRawLength (src/Packet.cpp):
//
//	2 + getPathByteLen() + payload_len + (hasTransportCodes() ? 4 : 0)
//
// i.e. 2 framing bytes (the 1-byte header + the 1-byte path_len field),
// plus hashCount*hashSize accumulated path bytes, plus the application
// payload, plus 4 bytes of transport codes when the packet carries them.
// A packet carries transport codes exactly when it is region-scoped /
// transport-routed (ROUTE_TYPE_TRANSPORT_FLOOD / _DIRECT — see engine.go's
// own mapping of a non-empty Message.Region to this); an ordinary unscoped
// flood (ROUTE_TYPE_FLOOD) does not. Dispatcher::checkRecv's own
// packetScore/getEstAirtimeFor calls (src/Dispatcher.cpp) both use this
// same raw-received length, so a longer accumulated path — and a
// transport-coded packet — genuinely cost more airtime and are genuinely
// harder to receive cleanly.
//
// (Previously this counted only 1 framing byte and never the transport
// codes, undercounting airtime by 1 byte on every packet and by 5 on every
// region-scoped one — small, but a systematic bias in every collision
// window and duty-cycle figure.)
func onAirLen(payloadLen, hashCount, hashSize int, hasTransportCodes bool) int {
	n := payloadLen + 2 + hashCount*hashSize
	if hasTransportCodes {
		n += 4
	}
	return n
}
