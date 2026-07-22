// Package calibration searches for a repeater position that better
// explains its actually-observed reach data than the reported position
// does, within a bounded search radius.
package calibration

import (
	"math"

	"hopreach/internal/corescope"
	"hopreach/internal/demgrid"
	"hopreach/internal/propagation"
)

// scorePosition sums, over every observed link with known coordinates, a
// confidence-weighted penalty for links the terrain model predicts as
// worse than a "comfortable" margin (p.MarginGreenDB — the same threshold
// already used for the map's own orange→green colouring) from this
// position. An unobserved-but-model-predicts-reachable pair is never
// penalized: mesh traffic doesn't necessarily exercise every viable route
// within the observation window, so absence of a recorded link is weak
// evidence at best. Only a link CoreScope actually recorded counts as
// evidence either way. Lower is better; 0 means every observed link is
// comfortably explained from this position.
//
// Deliberately NOT a hard 0/1 cutoff at margin<0 (broken vs not): a
// position with excellent, e.g. +40dB, margin to every neighbour and one
// with only just-positive, +1dB, margin to every neighbour would score
// identically under a broken/not-broken test, since nothing has crossed
// zero — which let the search trade a repeater's genuinely excellent
// siting (e.g. a hilltop with 360° visibility) for a merely-still-working
// one elsewhere, as long as no single link actually flipped negative. A
// smooth deficit-below-comfortable penalty means degrading a link's
// margin costs something even while it's still positive, so the search
// can no longer "hide" that kind of real quality loss.
func scorePosition(grid *demgrid.Grid, p propagation.Params, lat, lon, groundM float64, links []corescope.ReachLink) float64 {
	txHeightM := groundM + p.AntennaHeightM
	score := 0.0
	for _, l := range links {
		if l.Lat == nil || l.Lon == nil {
			continue
		}
		weight := math.Log(1 + float64(l.Bottleneck))
		if weight <= 0 {
			continue
		}
		d := propagation.HaversineKm(lat, lon, *l.Lat, *l.Lon)
		if d < 0.01 {
			continue
		}
		margin := propagation.PathMargin(grid, p, lat, lon, txHeightM, *l.Lat, *l.Lon, d)
		if deficit := p.MarginGreenDB - margin; deficit > 0 {
			score += weight * deficit
		}
	}
	return score
}

// Config controls how aggressively Position searches for a better fit.
type Config struct {
	MinLinks          int     // skip calibration entirely below this many observed links — not enough evidence to act on
	NeedsScore        float64 // only search if the reported position's score exceeds this
	MaxOffsetM        float64 // candidates never stray further than this from the reported position
	MinImprovementPct float64 // only adopt a candidate if it improves the score by at least this percentage
	ReachDays         int     // lookback window for the reach-data fetch (broader than the frontend's default, for more evidence)
}

// Result is the outcome of a Position search: the (possibly unchanged)
// position and the scores before/after.
type Result struct {
	Lat, Lon    float64
	GroundM     float64
	OffsetM     float64
	ScoreBefore float64
	ScoreAfter  float64
	Calibrated  bool
}

const kmPerDegLat = 110.574

// Position searches for a position within cal.MaxOffsetM of the reported
// one that better explains links (real observed reach data), only
// bothering for repeaters with enough evidence and a reported-position
// score bad enough to be worth it — "individual coverage for the ones
// scored really inaccurate," everyone else keeps their reported position
// untouched. Candidates are sampled in rings (50m steps) out to the max
// offset, at 16 angles each, each ring rotated a bit from the last so the
// sampled points don't all line up on the same handful of compass
// directions ring after ring.
func Position(grid *demgrid.Grid, p propagation.Params, cal Config, origLat, origLon float64, links []corescope.ReachLink) Result {
	origGroundM := grid.At(origLat, origLon)
	scoreBefore := scorePosition(grid, p, origLat, origLon, origGroundM, links)

	result := Result{Lat: origLat, Lon: origLon, GroundM: origGroundM, ScoreBefore: scoreBefore, ScoreAfter: scoreBefore}

	if len(links) < cal.MinLinks || scoreBefore <= 0 || scoreBefore < cal.NeedsScore {
		return result
	}

	kmPerDegLon := 111.320 * math.Cos(origLat*math.Pi/180)
	if kmPerDegLon < 1 {
		kmPerDegLon = 1
	}

	bestLat, bestLon, bestGroundM, bestScore := origLat, origLon, origGroundM, scoreBefore
	const angleSteps = 16
	ringIndex := 0
	for radiusM := 50.0; radiusM <= cal.MaxOffsetM; radiusM += 50.0 {
		radiusKm := radiusM / 1000
		ringOffset := float64(ringIndex) * (math.Pi / angleSteps / 2) // stagger each ring so candidates don't all fall on the same compass points
		ringIndex++
		for a := 0; a < angleSteps; a++ {
			angle := ringOffset + float64(a)/angleSteps*2*math.Pi
			candLat := origLat + (radiusKm*math.Cos(angle))/kmPerDegLat
			candLon := origLon + (radiusKm*math.Sin(angle))/kmPerDegLon
			candGroundM := grid.At(candLat, candLon)
			candScore := scorePosition(grid, p, candLat, candLon, candGroundM, links)
			if candScore < bestScore {
				bestScore = candScore
				bestLat, bestLon, bestGroundM = candLat, candLon, candGroundM
			}
		}
	}

	improvement := (scoreBefore - bestScore) / scoreBefore
	if improvement >= cal.MinImprovementPct/100 {
		result.Lat, result.Lon, result.GroundM = bestLat, bestLon, bestGroundM
		result.ScoreAfter = bestScore
		result.OffsetM = propagation.HaversineKm(origLat, origLon, bestLat, bestLon) * 1000
		result.Calibrated = true
	}
	return result
}
