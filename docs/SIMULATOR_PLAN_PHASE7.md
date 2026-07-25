# Simulator plan, phase 7 — RF/physical-layer accuracy

Status: **done and verified**. This phase came out of an accuracy review of
the whole reception path, not a feature request. The protocol/timing layer
(airtime, relay delays, half-duplex, CAD, duty cycle, dedup, loop.detect,
flood.max, regions) was found faithful — a line-for-line port of real
firmware. Every accuracy problem was on the **RF/physical-layer** side, and
one was a concrete regression. All three are now fixed.

## P0 — SF-anchor regression (the one real bug)

**Symptom.** Link SNRs were being anchored to SF11's reception threshold
while nodes actually run SF8 (the current EU/UK (Narrow) default), because
`buildLinksFromModel` and `fetchCorescopeLinksFor` both hardcoded
`const sf = 11` — a value that used to match the old default preset (SF11)
and was never updated when the default changed. The engine checks each
reception against the *listener's own* SF (`snrThresholdForSF(listener SF)`),
so the mismatch silently rejected genuinely-decodable links as
`weak_signal`.

**Evidence (the numbers).**
- Model links: `approxSnrFromMargin(margin, 11) = -17.5 + margin`. Engine
  keeps a reception only if `snr >= -10` (SF8). So a link survived only at
  `margin >= 7.5 dB` — every modeled link with `0 <= margin < 7.5 dB` was
  created and then silently dropped.
- CoreScope links: `snrFromObservationCount(count, 11) = -17.5 +
  min(15, log2(1+count)*3)`. Solving `>= -10` gives `count >= 5`, so links
  observed 1–4 times were all discarded — directly contradicting that
  function's own comment ("even a single observation clears every SF's
  threshold").

Latent because it was consistent back when the default was SF11, and the
2-node e2e fixture sits well above 7.5 dB margin so tests stayed green.
Worse, the optimizer built in phase 6 was tuning against a graph missing
exactly its weakest, most contention-relevant edges.

**Fix.**
- Anchor each directed link's SNR to the **receiver's** own SF (`receiverSf`
  = `effectivePrefsFor(receiverNode).radio.sf`), for both connectivity
  sources. `margin 0` / `1 observation` now map onto the receiver's real
  threshold, consistent by construction with the engine's own check.
- `applyNodesModalTable` now calls `invalidateLinks()` when a radio setting
  changes — the baked-in SNR is receiver-SF-specific, so changing SF must
  force a rebuild (previously it didn't, compounding the mismatch).

## P1 — hard SNR threshold + fixed per-link SNR (biggest physical gap)

**Problem.** Reception was an all-or-nothing step (`snr < threshold -> 0%`,
`>= -> 100%`), and each link's SNR was a single fixed value reused for every
packet and every trial. Real reception is a smooth packet-error-rate curve
over a few dB, and real links fade packet-to-packet. So marginal links were
deterministically all-or-nothing, and Monte-Carlo trials varied only relay
*timing*, never the channel — making delivery-ratio variance artificially
low, which directly undercuts the confidence machinery in the phase-6
optimizer (racing / hold-out assume trial variance reflects real
uncertainty).

**Fix — `ChannelParams` on `Scenario` (zero value = legacy behaviour).**
- `PERWidthDB`: replaces the hard cutoff with a logistic PER curve centred
  on each SF's threshold (~50% at threshold, ~73% one width above). 0 keeps
  the hard step.
- `FadingSigmaDB`: a per-reception zero-mean Gaussian on the wanted signal's
  SNR (applied consistently to both the capture comparison and the decode
  check), so a marginal link genuinely flickers between trials. Interferer
  SNRs stay at their mean — a documented scoping choice (one draw per
  reception, and the wanted signal's own fade dominates whether a marginal
  packet decodes).

Both default off in Go (so all existing Go tests get identical legacy
behaviour), and are turned on in the browser via `scenarioFromState`
(`perWidthDb: 2.0`, `fadingSigmaDb: 2.0` — modest LoRa-appropriate values;
`TestChannelSigmoidLeavesStrongLinksReliable` proves comfortably-strong
links stay ~100%). RNG draws only happen when a feature is enabled, so
paired-seed determinism is preserved exactly for the legacy path.

## P2 — pairwise capture over-optimism

**Problem.** The capture effect was evaluated **pairwise**: a wanted signal
survived if it beat *each* interferer individually by the 6 dB margin. Two
interferers each 6 dB down were each individually "survived," though their
*combined* power (+3 dB) would corrupt the packet in reality — so dense
collisions were under-modelled.

**Fix.** Post-lock interferers are now aggregated in the linear power domain
(`aggregateInterfererSNRdB`) and the wanted signal must beat their *combined*
level by the capture margin. Single-interferer behaviour is unchanged
(aggregate of one = itself), so every existing capture test still passes;
the new behaviour only appears with multiple simultaneous post-lock
interferers. Preamble-window interferers are handled first and separately
(any one prevents lock → `no_lock`, which still dominates `corrupted`).

## What is deliberately still approximate (documented, not fixed here)

- **The margin→SNR and observation-count→SNR mappings are proxies**, not
  calibrated dB-above-noise. Good for relative comparison; the 6 dB capture
  margin therefore operates on a synthetic SNR scale. Calibrating against
  real measured SNR would need hardware data the tool doesn't have.
- **Fading is applied to the wanted signal only**, not per-interferer.
- **`set tx` power** still doesn't feed link SNR (links come from the
  propagation model / observation counts, not per-node tx power), so a
  suggested tx-power change can't yet be evaluated.
- **The upstream terrain propagation model** (`internal/propagation`,
  FSPL + knife-edge) is a separate accuracy axis feeding `margin`.

## Verification

`go build/vet/staticcheck/test ./...` (all green, legacy behaviour
byte-identical since Channel defaults to zero), new Go tests
(`channel_test.go`) for the logistic PER curve, fading flicker, power
aggregation, and the multi-interferer corruption that pairwise would have
survived; `make wasm`; fresh Docker rebuild; full Playwright suite (36
passing); and a live browser check confirming model links now decode at the
default SF8.
