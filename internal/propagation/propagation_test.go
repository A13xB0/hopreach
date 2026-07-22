package propagation

import (
	"math"
	"testing"
)

func approxEqual(a, b, tol float64) bool {
	return math.Abs(a-b) <= tol
}

func TestHaversineKm(t *testing.T) {
	// London to Paris is a well-known reference distance (~344km great-circle).
	d := HaversineKm(51.5072, -0.1276, 48.8566, 2.3522)
	if !approxEqual(d, 344, 5) {
		t.Errorf("HaversineKm(London, Paris) = %v, want ~344km", d)
	}
	if d := HaversineKm(10, 20, 10, 20); d != 0 {
		t.Errorf("HaversineKm(same point) = %v, want 0", d)
	}
}

func TestFsplDB(t *testing.T) {
	// FSPL at 1km, 868MHz: 20*log10(1) + 20*log10(868) + 32.44 = 0 + 58.77 + 32.44 = 91.21dB
	got := FsplDB(1, 868)
	want := 91.21
	if !approxEqual(got, want, 0.05) {
		t.Errorf("FsplDB(1km, 868MHz) = %v, want ~%v", got, want)
	}

	// Doubling distance adds ~6.02dB (20*log10(2)), the standard free-space
	// path loss inverse-square relationship.
	d1 := FsplDB(10, 868)
	d2 := FsplDB(20, 868)
	if !approxEqual(d2-d1, 20*math.Log10(2), 1e-9) {
		t.Errorf("FsplDB doubling distance: delta = %v, want %v", d2-d1, 20*math.Log10(2))
	}

	// Sub-metre distances clamp to 1m rather than going to -Inf.
	if math.IsInf(FsplDB(0, 868), 0) || math.IsNaN(FsplDB(0, 868)) {
		t.Errorf("FsplDB(0, 868) should clamp to a finite value, got %v", FsplDB(0, 868))
	}
}

func TestKnifeEdgeDiffractionDB(t *testing.T) {
	// v <= -0.78 is the "no obstruction" regime — zero additional loss.
	if got := KnifeEdgeDiffractionDB(-1); got != 0 {
		t.Errorf("KnifeEdgeDiffractionDB(-1) = %v, want 0", got)
	}
	if got := KnifeEdgeDiffractionDB(-0.78); got != 0 {
		t.Errorf("KnifeEdgeDiffractionDB(-0.78) = %v, want 0", got)
	}

	// v=0 (the obstruction exactly grazes the direct line) is a well-known
	// reference point of the ITU-R P.526 single-knife-edge curve: ~6dB.
	if got := KnifeEdgeDiffractionDB(0); !approxEqual(got, 6.03, 0.05) {
		t.Errorf("KnifeEdgeDiffractionDB(0) = %v, want ~6.03", got)
	}

	// Loss increases monotonically with a worsening (more positive)
	// obstruction — more blockage should never read as less loss.
	prev := KnifeEdgeDiffractionDB(0)
	for _, v := range []float64{0.5, 1, 2, 5} {
		got := KnifeEdgeDiffractionDB(v)
		if got <= prev {
			t.Errorf("KnifeEdgeDiffractionDB(%v) = %v, expected > previous %v", v, got, prev)
		}
		prev = got
	}
}

func TestLinkBudgetMaxRangeKm(t *testing.T) {
	p := Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, MaxRangeKm: 100,
	}
	got := LinkBudgetMaxRangeKm(p)
	if got <= 0 || got > p.MaxRangeKm {
		t.Errorf("LinkBudgetMaxRangeKm = %v, want in (0, %v]", got, p.MaxRangeKm)
	}

	// MaxRangeKm caps a link budget that would otherwise imply a longer range.
	p.MaxRangeKm = 10
	if got := LinkBudgetMaxRangeKm(p); got != 10 {
		t.Errorf("LinkBudgetMaxRangeKm with a tight cap = %v, want 10 (the cap)", got)
	}

	// A weaker link budget (lower TX power) implies a shorter range than a
	// stronger one, all else equal.
	weak := p
	weak.MaxRangeKm = 0 // uncapped, so the comparison reflects the link budget alone
	weak.TxPowerDBm = 5
	strong := p
	strong.MaxRangeKm = 0
	strong.TxPowerDBm = 30
	if !(LinkBudgetMaxRangeKm(weak) < LinkBudgetMaxRangeKm(strong)) {
		t.Errorf("expected lower TX power to imply a shorter range: weak=%v strong=%v",
			LinkBudgetMaxRangeKm(weak), LinkBudgetMaxRangeKm(strong))
	}
}

// flatGrid is a constant-elevation propagation.Grid.
type flatGrid struct{ elevM float64 }

func (g flatGrid) At(lat, lon float64) float64 { return g.elevM }

// ridgeGrid is flat except for a raised band across the path's midpoint —
// a deliberate obstruction to compare against flatGrid's clear path.
type ridgeGrid struct{ baseM, ridgeM, ridgeAtLon float64 }

func (g ridgeGrid) At(lat, lon float64) float64 {
	if math.Abs(lon-g.ridgeAtLon) < 0.01 {
		return g.ridgeM
	}
	return g.baseM
}

func TestPathMarginObstructionReducesMargin(t *testing.T) {
	p := Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, RxHeightM: 2,
	}
	txLat, txLon := 0.0, 0.0
	rxLat, rxLon := 0.0, 0.1 // ~11.1km east at the equator
	d := HaversineKm(txLat, txLon, rxLat, rxLon)
	txHeightM := 50.0

	clear := PathMargin(flatGrid{elevM: 0}, p, txLat, txLon, txHeightM, rxLat, rxLon, d)
	blocked := PathMargin(ridgeGrid{baseM: 0, ridgeM: 200, ridgeAtLon: 0.05}, p, txLat, txLon, txHeightM, rxLat, rxLon, d)

	if !(blocked < clear) {
		t.Errorf("expected a 200m ridge across the path to reduce the margin: clear=%v blocked=%v", clear, blocked)
	}

	// A taller ridge should block more than a shorter one, not less.
	lightlyBlocked := PathMargin(ridgeGrid{baseM: 0, ridgeM: 60, ridgeAtLon: 0.05}, p, txLat, txLon, txHeightM, rxLat, rxLon, d)
	if !(blocked < lightlyBlocked) {
		t.Errorf("expected a taller ridge to reduce the margin further: 60m=%v 200m=%v", lightlyBlocked, blocked)
	}
}

func TestPathMarginMonotonicWithDistance(t *testing.T) {
	p := Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, RxHeightM: 2,
	}
	grid := flatGrid{elevM: 0}
	txLat, txLon := 0.0, 0.0
	txHeightM := 50.0

	near := PathMargin(grid, p, txLat, txLon, txHeightM, 0.0, 0.02, HaversineKm(txLat, txLon, 0.0, 0.02))
	far := PathMargin(grid, p, txLat, txLon, txHeightM, 0.0, 0.2, HaversineKm(txLat, txLon, 0.0, 0.2))
	if !(far < near) {
		t.Errorf("expected margin to fall with distance over flat terrain: near=%v far=%v", near, far)
	}
}

func TestComputeMarginsCPUShape(t *testing.T) {
	p := Params{
		FrequencyMHz: 868, TxPowerDBm: 22, TxAntennaGainDB: 3, RxAntennaGainDB: 0,
		RxSensitivityDB: -124, FadeMarginDB: 20, RxHeightM: 2, MaxRangeKm: 50,
	}
	grid := flatGrid{elevM: 0}
	sites := []Site{{Lat: 0, Lon: 0, GroundM: 0, TxHeightM: 50}}
	bounds := Bounds{South: -0.1, North: 0.1, West: -0.1, East: 0.1}

	const w, h = 8, 8
	margins := ComputeMarginsCPU(grid, sites, bounds, w, h, LinkBudgetMaxRangeKm(p), p, nil)
	if len(margins) != w*h {
		t.Fatalf("len(margins) = %d, want %d", len(margins), w*h)
	}

	// The pixel nearest the site (image center-ish) should have a real
	// (non-NaN) margin — it's well within range of the only site.
	center := margins[(h/2)*w+(w/2)]
	if math.IsNaN(float64(center)) {
		t.Errorf("expected a non-NaN margin near the transmitter, got NaN")
	}
}
