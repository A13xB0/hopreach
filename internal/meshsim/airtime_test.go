package meshsim

import "testing"

// TestAirtimeMsMatchesHandComputedExample checks one full hand-computed
// case against the standard Semtech AN1200.13 formula, using
// DefaultLoRaParams (the EU/UK (Narrow) preset: SF8, BW62.5kHz, CR8,
// explicit header, CRC on — preamble derived from SF via
// preambleSymbolsForSF, 32 symbols at SF8) and a 20-byte payload:
//
//	symbolDurationMs = 2^8/62.5 = 4.096ms
//	low data rate optimize: 4.096 < 16 -> DE=0
//	preamble = (32+4.25) * 4.096 = 148.48ms
//	numerator = 8*20 - 4*8 + 28 + 16*1 - 20*0 = 160-32+28+16 = 172
//	denominator = 4*(8-0) = 32
//	ceil(172/32) = ceil(5.375) = 6
//	crSemtech = 8-4 = 4
//	nPayloadSymbols = 8 + 6*(4+4) = 56
//	total = 148.48 + 56*4.096 = 148.48 + 229.376 = 377.856ms -> truncates to 377
func TestAirtimeMsMatchesHandComputedExample(t *testing.T) {
	got := AirtimeMs(DefaultLoRaParams(), 20)
	if got != 377 {
		t.Errorf("AirtimeMs(default params, 20 bytes) = %d, want 377", got)
	}
}

// TestPreambleSymbolsForSF locks in the exact firmware boundary
// (RadioLibWrapper::preambleLengthForSF, src/helpers/radiolib/
// RadioLibWrappers.h): 32 symbols for SF<=8, 16 for SF>8. Getting this
// backwards previously undercounted airtime 4x at SF8, which cascades into
// every collision window, CAD check, and relay delay in the engine.
func TestPreambleSymbolsForSF(t *testing.T) {
	tests := []struct {
		sf   int
		want int
	}{
		{5, 32}, {6, 32}, {7, 32}, {8, 32}, // <= 8
		{9, 16}, {10, 16}, {11, 16}, {12, 16}, // > 8
	}
	for _, tt := range tests {
		if got := preambleSymbolsForSF(tt.sf); got != tt.want {
			t.Errorf("preambleSymbolsForSF(%d) = %d, want %d", tt.sf, got, tt.want)
		}
	}
}

// TestAirtimeMsMonotonicity locks in the formula's expected directional
// behavior — robust even against a small arithmetic slip in the
// hand-computed exact case above, since these hold regardless of the
// precise constants.
func TestAirtimeMsMonotonicity(t *testing.T) {
	base := DefaultLoRaParams()

	t.Run("higher SF means longer airtime", func(t *testing.T) {
		low := base
		low.SF = 7
		high := base
		high.SF = 12
		if AirtimeMs(high, 20) <= AirtimeMs(low, 20) {
			t.Errorf("SF12 airtime (%d) should exceed SF7 airtime (%d)", AirtimeMs(high, 20), AirtimeMs(low, 20))
		}
	})

	t.Run("wider bandwidth means shorter airtime", func(t *testing.T) {
		narrow := base
		narrow.BWkHz = 125
		wide := base
		wide.BWkHz = 500
		if AirtimeMs(wide, 20) >= AirtimeMs(narrow, 20) {
			t.Errorf("500kHz airtime (%d) should be less than 125kHz airtime (%d)", AirtimeMs(wide, 20), AirtimeMs(narrow, 20))
		}
	})

	t.Run("longer payload means longer or equal airtime", func(t *testing.T) {
		if AirtimeMs(base, 200) < AirtimeMs(base, 10) {
			t.Errorf("a 200-byte payload's airtime (%d) should be at least a 10-byte payload's (%d)", AirtimeMs(base, 200), AirtimeMs(base, 10))
		}
	})

	t.Run("higher coding rate denominator means longer or equal airtime", func(t *testing.T) {
		// MeshCore's CR is the denominator of 4/CR (5=4/5 .. 8=4/8) — a
		// higher denominator means *more* redundancy bits, so airtime
		// should never decrease.
		cr5 := base
		cr5.CR = 5
		cr8 := base
		cr8.CR = 8
		if AirtimeMs(cr8, 20) < AirtimeMs(cr5, 20) {
			t.Errorf("CR8 airtime (%d) should be at least CR5 airtime (%d)", AirtimeMs(cr8, 20), AirtimeMs(cr5, 20))
		}
	})
}
