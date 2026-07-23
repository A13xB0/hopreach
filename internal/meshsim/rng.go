package meshsim

import "math/rand/v2"

// NewSeededRNG returns a deterministic RNG driven by seed — the same seed
// always produces the same sequence of draws, which is what makes two Run
// calls (e.g. comparing NodePrefs before/after a config change) fairly
// comparable. math/rand/v2.Rand already satisfies RNG (IntN(n int) int)
// directly, so this is just a convenience constructor for callers (the WASM
// bridge, tests) that only have a plain seed value to work with.
func NewSeededRNG(seed uint64) RNG {
	return rand.New(rand.NewPCG(seed, seed))
}
