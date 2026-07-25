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

## Second review pass — per-node siting and both-sided fading

A follow-up review found the model link builder was throwing away
per-node siting the user explicitly configures, which then fed the whole
flood graph:

- **Per-node antenna (mast) height was ignored.** `buildLinksFromModel`
  used the single global `cfg.propagation.antennaHeightM` for the
  transmitter of every link and the global `RxHeightM` for every receiver —
  even though the planner lets each repeater set its own mast height (and
  the coverage map respects it). Worse, `simNodes` didn't even carry
  `antennaHeightM` from the plan, so it was dropped before the sim saw it.
  Every repeater-to-repeater link — the entire subject of the flood sim —
  was computed at handheld height on both ends, badly understating range
  and SNR. Fixed: thread `antennaHeightM` into `simNodes`, and use each
  node's own height on BOTH ends of a link (`nodeAntennaHeightM`; a
  companion is treated as a handheld client at the receiver height, not a
  mast). The receiver height is threaded via a per-height params variant
  (`propagationForRxHeight`, cached so a same-height mesh shares one Wasm
  handle) — no propagation-model signature change needed.
- **Per-node tx power was ignored** (`set tx` couldn't be evaluated).
  Received power scales 1:1 with transmit power and margin is received
  power minus a fixed sensitivity, so a node's own tx-power deviation from
  the model baseline shifts the margin by exactly that difference — applied
  directly in `buildLinksFromModel`. Verified live: dropping a node from 22
  to 1 dBm lowered its link SNR by exactly 21 dB.
- **Fading is now applied to interferers too**, not just the wanted signal
  (phase 7's first pass was wanted-only) — so the aggregated capture margin
  sees genuine both-sided channel variance. Still gated on the same
  `FadingSigmaDB` knob, so legacy (zero) behaviour is unchanged.

## Third review pass — strength-aware preamble acquisition

The first pass left preamble-window interference as "any overlap prevents
lock, regardless of strength" — a conservative approximation. That treated
a 30 dB-weaker stray transmission as fatal to a strong wanted packet, which
real LoRa preamble correlation does not: the receiver locks onto whichever
preamble dominates.

Now the acquisition stage is strength-aware, symmetric with the payload
stage. A preamble-window interferer blocks lock only when the wanted signal
does NOT beat it by `preambleCaptureMarginDB` (kept equal to the payload
`captureMarginDB` absent evidence to differentiate the stages; a separate
named constant so it can diverge later). A preamble interferer the wanted
dominates is demoted to a payload interferer — it's still on the air during
the payload, so it still counts toward the aggregate corruption check.

Because each reception is evaluated independently, this single symmetric
rule also models the **first-arrival/strength interplay** correctly with no
extra machinery: a much-stronger packet arriving late still captures via its
OWN reception's preamble check, while the earlier weaker packet it
overpowers is corrupted via that packet's own aggregate check. Comparable-
strength overlaps still collide as `no_lock` on both sides. Covered by
`TestRunStrongSignalWinsLockOverWeakPreambleInterferer` and
`TestRunComparablePreambleInterferersStillCollide`, plus updated
single-interferer unit tests.

## Fourth review pass — radio compatibility gating

The per-node radio override lets a user set one repeater to a different
spreading factor / frequency, but `buildLinksFromModel` created a link
purely from geometry, ignoring whether the two radios could actually
communicate. A LoRa receiver must match the transmitter's centre
frequency, bandwidth, and spreading factor to demodulate at all — so a link
between a SF8 node and a SF12 node, or between two nodes on different
frequencies, is physically impossible, yet the sim rendered it as real
connectivity.

Fixed: `buildLinksFromModel` now requires `radiosCompatible` (same freq,
bandwidth, SF — CR rides in the explicit header and needn't match) before
forming a link. Every node defaults to the same preset, so a normal
uniform-config mesh — the only kind real MeshCore runs — is entirely
unchanged (verified: the default fixture still forms both links; switching
one node to SF12 correctly drops the links to zero). Because interference
audibility also flows through links (`engine.go` `audibleTo` needs a Link),
this single gate keeps decoding AND interference consistent — mismatched
radios neither hear nor jam each other. Observed CoreScope links are never
gated: if two real repeaters actually heard each other, they were
compatible in reality.

## Fifth review pass — firmware timing formulas (checked against source)

Re-read the actual MeshCore firmware (`/tmp/mc-src`, github.com/meshcore-
dev/MeshCore) line-by-line for the timing formulas. `packetScoreInt` and
`getRetransmitDelay`/`getDirectRetransmitDelay` matched ours exactly. Three
things did not:

- **Negative RX hold-back bug (real, high-impact).** `MyMesh::calcRxDelay`
  is `(pow(rx_delay_base, 0.85 - score) - 1) * air_time`. For a strong,
  cleanly-decoded packet (`score > 0.85`) with `rx_delay_base > 1`, the
  exponent is negative, `pow(...) < 1`, and the whole thing is NEGATIVE.
  Firmware's `Dispatcher::checkRecv` guards this with `if (_delay < 50) {
  process immediately }` — which covers negatives. Our `RxDelayMs` didn't:
  a negative int flowed into the engine's `relayAt := atMs +
  uint32(rxDelay) + txDelay`, where `uint32(negative)` is ~4 billion,
  scheduling the relay in the past / beyond the sim window so it never
  fired. Every relay from a node with `rx_delay_base > 1` silently broke —
  and the adaptive optimizer's own `rx_delay_backoff` move raises
  `rx_delay_base` into exactly that range, so it could actively steer into
  the bug. Fixed by mirroring the `< 50 → 0` gate (which also correctly
  models "a sub-50ms hold-back is processed immediately").
- **Airtime under-counted the frame by 1–5 bytes.** Real `Packet::
  getRawLength()` is `2 + pathBytes + payload + (transportCodes ? 4 : 0)`:
  two framing bytes (header + path_len), and 4 transport-code bytes on a
  region-scoped / transport-routed packet. Our `onAirLen` used `+1` and
  never modelled transport codes — a systematic 1-byte airtime undercount
  on every packet, and 5 on every scoped one, biasing every collision
  window and duty-cycle figure. Now a direct port of `getRawLength`, with a
  non-empty `Message.Region` as the marker for transport codes.
- **Retransmit-delay length excludes transport codes.** Firmware sizes the
  flood/direct relay delay on `getEstAirtimeFor(getPathByteLen() +
  payload_len + 2)` — `getRawLength` MINUS the 4 transport bytes — while the
  RX hold-back and the actual transmission airtime use the full frame. Now
  matched: scoped traffic sizes its relay delay on the transport-excluded
  length, everything else on the full frame (identical for unscoped, the
  common case).

## What is deliberately still approximate (and why it's the right call)

- **The margin→SNR and observation-count→SNR mappings are proxies**, not
  calibrated dB-above-noise. This is intentional, not a gap to close: the
  two connectivity sources (terrain model vs. CoreScope observation count)
  have no common physical SNR scale, and both are re-anchored to the same
  per-SF reception threshold so they stay comparable when blended and when
  they interact via the capture effect. Switching model links to a true
  noise-floor SNR while observation links stayed a count-proxy would put the
  two on different scales — worse, not better. Absolute-power calibration
  would also need hardware/foliage data the terrain model structurally
  lacks.
- **Same-frequency, different-SF interference** is treated as no
  interference (the two nodes get no link, so they don't jam each other),
  whereas in reality co-frequency signals on different SFs are only
  *quasi*-orthogonal and interfere weakly. This only arises under a
  deliberately mixed-SF config (a misconfiguration for real MeshCore, which
  is uniform-SF), and the link gate errs toward "these nodes are on
  effectively separate channels," which is the closer of the two available
  approximations.
- **Sub-threshold interferers raise the noise floor but are ignored.** Only
  decodable-strength interferers (those with a link) are considered as
  interference; a swarm of individually-undecodable weak signals that would
  collectively lift the noise floor isn't modelled. Second-order, and
  modelling it would require carrying sub-threshold links the rest of the
  engine has no use for.
- **Channel fades are drawn sequentially, not per-(link, packet).** This
  means two candidate policies in the optimizer don't see perfectly common
  random channel draws (they already didn't, for relay-delay draws) — a
  minor variance-reduction loss the racing/confirmation machinery already
  absorbs, not a correctness issue.
- **The upstream terrain propagation model** (`internal/propagation`,
  FSPL + single knife-edge, no foliage/buildings) is a separate accuracy
  axis feeding `margin`. The planner's own LOS check shares the same
  per-node-height limitation the sim just fixed — worth aligning later.

## Verification

`go build/vet/staticcheck/test ./...` (all green, legacy behaviour
byte-identical since Channel defaults to zero), new Go tests
(`channel_test.go`) for the logistic PER curve, fading flicker, power
aggregation, and the multi-interferer corruption that pairwise would have
survived; `make wasm`; fresh Docker rebuild; full Playwright suite (36
passing); and a live browser check confirming model links now decode at the
default SF8.
