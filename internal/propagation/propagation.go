// Package propagation implements the RF coverage model shared by every
// compute path in this project (CPU, local GPU, and remote GPU workers):
// free-space path loss plus single-knife-edge diffraction loss from the
// worst obstruction found by sampling real terrain along the repeater->point
// path (earth curvature included via the standard k=4/3 refracted-earth
// correction). This is the same class of model used by common ham-radio
// coverage tools (ITU-R P.526's single-knife-edge method), not a full
// multi-edge (Bullington) or statistical (Longley-Rice) model — a single
// dominant obstruction is assumed per path. It does not model foliage or
// buildings.
//
// Extracted into its own package (rather than living in the root binary's
// package main, where it originated) so cmd/gpuworker — a separate binary
// that runs on a remote machine — can import the exact same physics and CPU
// reference implementation the root binary trusts, instead of risking a
// second, drifting copy.
package propagation

import (
	"math"
	"runtime"
	"sync"
)

const (
	EarthRadiusKm = 6371.0088
	earthRadiusM  = EarthRadiusKm * 1000
	refractionK   = 4.0 / 3.0
	speedOfLight  = 299792458.0 // m/s
)

// Params holds the configurable radio link assumptions used to turn terrain
// + siting into an estimated coverage margin.
type Params struct {
	FrequencyMHz    float64
	TxPowerDBm      float64
	TxAntennaGainDB float64
	RxAntennaGainDB float64
	RxSensitivityDB float64
	FadeMarginDB    float64
	AntennaHeightM  float64 // repeater mast height above ground level
	RxHeightM       float64 // assumed receiver antenna height above ground level
	MaxRangeKm      float64 // hard cap on search radius, independent of link budget
	MarginGreenDB   float64 // signal margin (dB above sensitivity+fade) at which colour reaches full green
}

// Site is a transmitter position and effective height for margin
// calculations.
type Site struct {
	Lat, Lon  float64
	GroundM   float64
	TxHeightM float64
}

// Bounds is a lat/lon bounding box.
type Bounds struct {
	South, North, West, East float64
}

// Grid is anything that can answer a bilinear elevation lookup — satisfied
// by demgrid.Grid, kept as an interface here so this package doesn't need
// to depend on demgrid (avoids a needless import cycle risk and keeps this
// package's own dependency list to the standard library only).
type Grid interface {
	At(lat, lon float64) float64
}

// HaversineKm returns the great-circle distance between two lat/lon points
// in km.
func HaversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	rad := math.Pi / 180
	dLat := (lat2 - lat1) * rad
	dLon := (lon2 - lon1) * rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return EarthRadiusKm * c
}

// LinkBudgetMaxRangeKm returns the free-space-path-loss range implied by the
// link budget: the true physical upper bound, since diffraction only adds
// loss relative to free space.
func LinkBudgetMaxRangeKm(p Params) float64 {
	linkBudgetDB := p.TxPowerDBm + p.TxAntennaGainDB + p.RxAntennaGainDB - p.RxSensitivityDB - p.FadeMarginDB
	fsplRangeKm := math.Pow(10, (linkBudgetDB-20*math.Log10(p.FrequencyMHz)-32.44)/20)
	if p.MaxRangeKm > 0 && fsplRangeKm > p.MaxRangeKm {
		return p.MaxRangeKm
	}
	return fsplRangeKm
}

// FsplDB returns the free-space path loss in dB at distanceKm and freqMHz.
func FsplDB(distanceKm, freqMHz float64) float64 {
	if distanceKm < 0.001 {
		distanceKm = 0.001
	}
	return 20*math.Log10(distanceKm) + 20*math.Log10(freqMHz) + 32.44
}

// KnifeEdgeDiffractionDB implements the ITU-R P.526 single-knife-edge
// approximation from the Fresnel-Kirchhoff diffraction parameter v.
func KnifeEdgeDiffractionDB(v float64) float64 {
	if v <= -0.78 {
		return 0
	}
	return 6.9 + 20*math.Log10(math.Sqrt((v-0.1)*(v-0.1)+1)+v-0.1)
}

// PathMargin walks the great-circle path from (txLat,txLon) at height
// txHeightM (metres above sea level) to (rxLat,rxLon) at ground+rxHeightM,
// finds the worst obstruction against the direct line (after earth-curvature
// correction), and returns the received signal margin in dB (positive means
// covered). distanceKm is passed in since callers already compute it for
// the range cutoff.
func PathMargin(grid Grid, p Params, txLat, txLon, txHeightM, rxLat, rxLon, distanceKm float64) float64 {
	rxGroundM := grid.At(rxLat, rxLon)
	rxHeightASL := rxGroundM + p.RxHeightM

	distanceM := distanceKm * 1000
	wavelengthM := speedOfLight / (p.FrequencyMHz * 1e6)

	samples := int(distanceKm / 0.05) // ~50m spacing, matches DEM resolution at zoom 11
	if samples < 8 {
		samples = 8
	}
	if samples > 300 {
		samples = 300
	}

	maxV := math.Inf(-1)
	for i := 1; i < samples; i++ {
		frac := float64(i) / float64(samples)
		lat := txLat + (rxLat-txLat)*frac
		lon := txLon + (rxLon-txLon)*frac

		d1M := distanceM * frac
		d2M := distanceM - d1M

		terrainM := grid.At(lat, lon)
		curvatureDropM := (d1M * d2M) / (2 * refractionK * earthRadiusM)
		effectiveTerrainM := terrainM - curvatureDropM

		directLineM := txHeightM + (rxHeightASL-txHeightM)*frac
		obstructionM := effectiveTerrainM - directLineM

		v := obstructionM * math.Sqrt((2/wavelengthM)*(1/d1M+1/d2M))
		if v > maxV {
			maxV = v
		}
	}

	loss := FsplDB(distanceKm, p.FrequencyMHz)
	if maxV > -0.78 {
		loss += KnifeEdgeDiffractionDB(maxV)
	}

	received := p.TxPowerDBm + p.TxAntennaGainDB + p.RxAntennaGainDB - loss
	return received - p.RxSensitivityDB - p.FadeMarginDB
}

func marginsRow(margins []float32, py, imageWidth, imageHeight int, bounds Bounds, grid Grid, sites []Site, rangeKm float64, p Params) {
	lat := bounds.North - (float64(py)+0.5)/float64(imageHeight)*(bounds.North-bounds.South)
	rowOffset := py * imageWidth
	for px := 0; px < imageWidth; px++ {
		lon := bounds.West + (float64(px)+0.5)/float64(imageWidth)*(bounds.East-bounds.West)

		bestMargin := math.Inf(-1)
		for _, s := range sites {
			d := HaversineKm(lat, lon, s.Lat, s.Lon)
			if d > rangeKm || d < 0.01 {
				continue
			}
			m := PathMargin(grid, p, s.Lat, s.Lon, s.TxHeightM, lat, lon, d)
			if m > bestMargin {
				bestMargin = m
			}
		}

		if bestMargin < 0 {
			margins[rowOffset+px] = float32(math.NaN()) // no repeater reaches this point with positive margin
			continue
		}
		margins[rowOffset+px] = float32(bestMargin)
	}
}

// ComputeMarginsCPU is the trusted reference implementation every other
// compute path (local GPU, remote GPU workers) is verified against — always
// correct, parallelized across CPU cores since it's also the real fallback
// whenever no GPU is available at all.
func ComputeMarginsCPU(grid Grid, sites []Site, bounds Bounds, imageWidth, imageHeight int, rangeKm float64, p Params, progress func(done, total int)) []float32 {
	margins := make([]float32, imageWidth*imageHeight)

	rows := make(chan int, imageHeight)
	for py := 0; py < imageHeight; py++ {
		rows <- py
	}
	close(rows)

	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	var mu sync.Mutex
	done := 0
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for py := range rows {
				marginsRow(margins, py, imageWidth, imageHeight, bounds, grid, sites, rangeKm, p)
				mu.Lock()
				done++
				if progress != nil {
					progress(done, imageHeight)
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	return margins
}
