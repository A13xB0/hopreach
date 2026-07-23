package meshsim

// CollisionRate is the fraction of Receptions marked Collided — the primary
// metric Suggest optimizes against. 0 if there were no receptions at all
// (an empty scenario isn't "perfect," it's undefined, but 0 is the useful
// default for a search that otherwise ranks candidates by this number).
func (r Report) CollisionRate() float64 {
	if len(r.Receptions) == 0 {
		return 0
	}
	collided := 0
	for _, rec := range r.Receptions {
		if rec.Collided {
			collided++
		}
	}
	return float64(collided) / float64(len(r.Receptions))
}
