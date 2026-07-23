package meshsim

import "testing"

// TestAirtimeMsMatchesHandComputedExample checks one full hand-computed
// case against the standard Semtech AN1200.13 formula, using
// DefaultLoRaParams (SF11, BW250kHz, CR5, preamble 8, explicit header, CRC
// on) and a 20-byte payload:
//
//	symbolDurationMs = 2^11/250 = 8.192ms
//	low data rate optimize: 8.192 < 16 -> DE=0
//	preamble = (8+4.25) * 8.192 = 100.352ms
//	numerator = 8*20 - 4*11 + 28 + 16*1 - 20*0 = 160-44+28+16 = 160
//	denominator = 4*(11-0) = 44
//	ceil(160/44) = ceil(3.636) = 4
//	crSemtech = 5-4 = 1
//	nPayloadSymbols = 8 + 4*(1+4) = 28
//	total = 100.352 + 28*8.192 = 100.352 + 229.376 = 329.728ms -> truncates to 329
func TestAirtimeMsMatchesHandComputedExample(t *testing.T) {
	got := AirtimeMs(DefaultLoRaParams(), 20)
	if got != 329 {
		t.Errorf("AirtimeMs(default params, 20 bytes) = %d, want 329", got)
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
