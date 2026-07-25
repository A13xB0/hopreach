package meshsim

import (
	"math/rand/v2"
	"sort"
)

// kneeThresholdFraction is how much of the LOWEST-load level's own delivery
// ratio a higher level must still clear to count as "the network is still
// coping" — 95%, not 100%, so the threshold adapts to a network that's
// already slightly imperfect even at minimal load (see StressResult's own
// doc comment).
const kneeThresholdFraction = 0.95

// StressRequest configures an offered-load sweep — see StressTest.
type StressRequest struct {
	Scenario     Scenario `json:"scenario"`
	MaxSimTimeMs uint32   `json:"maxSimTimeMs"`
	// Trials is how many times each load level is simulated, averaging out
	// the randomized message generation and retransmit-delay draws — same
	// idea as TuneRequest.Trials. Trials < 1 is treated as 1.
	Trials int    `json:"trials"`
	Seed   uint64 `json:"seed"`

	// MinPayload/MaxPayload bound each synthetically generated message's
	// randomly drawn payload length. MaxPayload <= 0 falls back to a 10-50
	// byte default range.
	MinPayload int `json:"minPayload"`
	MaxPayload int `json:"maxPayload"`

	// LoadLevels is the increasing series of offered load (messages per
	// simulated minute) to sweep across — caller-provided so a coarse
	// initial sweep and a refined follow-up around the knee are just two
	// calls with different LoadLevels slices, not two different code paths.
	LoadLevels []float64 `json:"loadLevels"`
}

// StressLevel is one swept load level's own averaged result.
type StressLevel struct {
	MessagesPerMinute float64 `json:"messagesPerMinute"`
	DeliveryRatio     float64 `json:"deliveryRatio"`
	CollisionRate     float64 `json:"collisionRate"`
}

// StressResult is StressTest's output: the full measured capacity curve,
// plus the knee — the practical, single-number answer to "how many
// messages can this network handle."
type StressResult struct {
	Levels []StressLevel `json:"levels"`
	// KneeMessagesPerMinute is the highest swept load level whose own
	// DeliveryRatio still clears kneeThresholdFraction of the delivery
	// measured at the LOWEST swept level — 0 if even the lowest level
	// fails to clear its own threshold (a contradiction, since it's being
	// compared to itself, so this only happens with zero levels swept) or
	// if delivery never recovers above threshold at all after an early
	// dip; a caller sweeping a wider or finer LoadLevels range can narrow
	// in on the true knee from here.
	KneeMessagesPerMinute float64 `json:"kneeMessagesPerMinute"`
}

// StressTest sweeps req.LoadLevels, generating synthetic offered load at
// each one (see generateStressMessages) and measuring the same
// Report.DeliveryRatio/CollisionRate every other part of this package
// already reports — this is deliberately NOT a new metric, just Run
// exercised at increasing load so the existing ones can be plotted as a
// capacity curve.
//
// This is a genuinely different traffic source from Suggest's own
// evaluate(): predict-settings measures candidate CONFIGS against a FIXED,
// user-authored message set; StressTest measures a FIXED config against an
// increasing, synthetically generated message set. Same engine underneath
// (Run), different independent variable.
//
// progress, if non-nil, is called after each swept level finishes — same
// (done, total) shape and same reason Suggest's own progress callback
// exists: each level is itself Trials full simulation runs, so a caller
// driving this from a Web Worker (see wasm/meshsim.go's jsSimStress and
// public/meshsim-worker.js) can show real progress instead of a plain
// "please wait" for however long the whole sweep takes.
func StressTest(req StressRequest, progress func(done, total int)) StressResult {
	trials := req.Trials
	if trials < 1 {
		trials = 1
	}
	minPayload, maxPayload := req.MinPayload, req.MaxPayload
	if maxPayload <= 0 {
		minPayload, maxPayload = 10, 50
	}
	if minPayload > maxPayload {
		minPayload, maxPayload = maxPayload, minPayload
	}

	levels := make([]StressLevel, 0, len(req.LoadLevels))
	for i, mpm := range req.LoadLevels {
		var totalDelivery, totalCollision float64
		for trial := 0; trial < trials; trial++ {
			rng := rand.New(rand.NewPCG(req.Seed, uint64(trial)))
			messages := generateStressMessages(req.Scenario, rng, mpm, minPayload, maxPayload, req.MaxSimTimeMs)
			report := Run(req.Scenario, messages, rng, req.MaxSimTimeMs)
			totalDelivery += report.DeliveryRatio(req.Scenario, messages)
			totalCollision += report.CollisionRate()
		}
		levels = append(levels, StressLevel{
			MessagesPerMinute: mpm,
			DeliveryRatio:     totalDelivery / float64(trials),
			CollisionRate:     totalCollision / float64(trials),
		})
		if progress != nil {
			progress(i+1, len(req.LoadLevels))
		}
	}

	return StressResult{Levels: levels, KneeMessagesPerMinute: computeKnee(levels)}
}

// computeKnee finds the highest-MessagesPerMinute level (assuming levels is
// given in ascending offered-load order, as StressRequest.LoadLevels is
// documented to be) whose own DeliveryRatio still clears
// kneeThresholdFraction of levels[0]'s — see StressResult.KneeMessagesPerMinute.
func computeKnee(levels []StressLevel) float64 {
	if len(levels) == 0 {
		return 0
	}
	threshold := levels[0].DeliveryRatio * kneeThresholdFraction
	knee := 0.0
	for _, l := range levels {
		if l.DeliveryRatio >= threshold {
			knee = l.MessagesPerMinute
		}
	}
	return knee
}

// generateStressMessages synthesizes offered load for one StressTest level:
// count messages (derived from messagesPerMinute and the sim window),
// randomly chosen origins, random payload lengths within
// [minPayload,maxPayload], and send times drawn uniformly across
// [0, maxSimTimeMs) — a Poisson-process arrival model would be more
// realistic still, but uniform random arrival already gives a genuinely
// irregular, non-metronomic stream, which is what actually matters for
// stressing collision/contention behaviour; unlike messagesFromState's own
// deliberately-authored message generators (public/simulator.js), nothing
// here is meant to be hand-tuned by a user, so the simpler model is an
// intentional choice, not a shortcut. HashSize is left unset (falls back to
// defaultMessageHashSize — see Message.HashSize) rather than plumbed
// through StressRequest: a stress sweep measures capacity under a chosen
// topology/config, not a specific hash-size choice, and every synthetic
// message sharing one size keeps that variable out of the sweep.
func generateStressMessages(scenario Scenario, rng RNG, messagesPerMinute float64, minPayload, maxPayload int, maxSimTimeMs uint32) []Message {
	if len(scenario.Nodes) == 0 || messagesPerMinute <= 0 || maxSimTimeMs == 0 {
		return nil
	}
	count := int(messagesPerMinute * float64(maxSimTimeMs) / 60_000.0)
	if count < 1 {
		count = 1
	}
	messages := make([]Message, count)
	for i := 0; i < count; i++ {
		origin := rng.IntN(len(scenario.Nodes))
		payloadLen := minPayload
		if maxPayload > minPayload {
			payloadLen += rng.IntN(maxPayload - minPayload + 1)
		}
		messages[i] = Message{
			Origin:     origin,
			SendAtMs:   uint32(rng.IntN(int(maxSimTimeMs))),
			PayloadLen: payloadLen,
		}
	}
	sort.Slice(messages, func(a, b int) bool { return messages[a].SendAtMs < messages[b].SendAtMs })
	return messages
}
