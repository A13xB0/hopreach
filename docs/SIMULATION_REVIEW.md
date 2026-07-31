# Full simulation-subsystem review — 2026-07-31

> **Status update (same day):** everything below marked 🔴/🟠 plus the
> cheap 🟡 items has been FIXED (see the fix commit); A6–A8 remain as
> disclosed model limitations (now in simulator-model.md's divergence
> table), L6 (saved replay setups can't re-run their comparison) remains
> open and disclosed. Cross-project preamble fix (C7) applied to MeshCIM
> and HopLink separately.

Scope: `internal/meshsim/*` (engine, airtime, delays, links, rules, topology,
rng, report, scoring, optimizer, policy tuner), `wasm/meshsim.go`, the JS
bridge/scenario/worker layer, the whole replay + observer-evidence pipeline
in `public/simulator.js` + `public/evidence.js`, and the docs' claims versus
the code. Engine findings were verified line-by-line against the real
MeshCore firmware checkout (`~/Documents/projects/meshcore`, dev branch).
Four independent review passes; every HIGH/CRITICAL claim below was
re-verified against source before inclusion.

Legend: 🔴 wrongness that can flip conclusions · 🟠 systematic bias /
silent drift · 🟡 edge cases, honesty gaps · ✅ verified-solid areas.

---

## A. Engine physics vs real MeshCore firmware

🔴 **A1. One radio can transmit two packets at once — and its impossible
overlaps don't interfere with each other.** `eventSend` has no
"already transmitting" gate; `channelBusy` skips the sender's own
transmissions and the interferer loop skips `other.sender == tx.sender`
(engine.go:793–827, 928, 1240). Real firmware strictly serializes TX
(Dispatcher queue + `STATE_TX_WAIT`). Understates contention and queueing
at busy relays — the exact regime the failure-inference feature studies.

🔴 **A2. Firmware's `MAX_PATH_SIZE` (64 bytes) relay gate is missing.**
`Mesh.cpp:331` refuses relays past `(n+1)·hashSize ≤ 64` → real floods die
at 21 hops with 3-byte hashes; the sim floods to its 64-hop default.
Deep-chain what-ifs over-propagate and over-count airtime.

🟠 **A3. Weak-signal RX-delay score uses the actual SF; firmware hardcodes
SF10** (`RadioLibWrappers.h:64`, verified verbatim). Sign of the bias flips
around SF10; hidden today because `RxDelayBase` defaults to 0 — but the
optimizer's `rx_delay_backoff` moves explore exactly the corrupted range.

🟠 **A4. CAD retry is a fixed 200 ms; the `Mesh` override every repeater
runs is randomized 120/240/360 ms** (`Mesh.cpp:29–31`). Sim contenders
retry in lockstep and re-collide; firmware randomizes precisely to avoid
that → overstated post-CAD collisions.

🟠 **A5. Relay-delay window sized on the pre-append path length** —
firmware appends its own hash *before* computing the delay window. Every
hop's window is one hash of airtime too narrow (~1–3% systematic).

🟡 **A6. Independent fading draws** can let one demodulator decode two
overlapping packets (each "wins" its own draw). Physically impossible;
inflates delivery in dense fading runs.

🟡 **A7. Preamble-only interferers corrupt payloads they never overlapped**
(interference evaluated over the whole frame window, no per-portion
accounting; aggregate also sums interferers that never overlapped each
other).

🟡 **A8. CAD + interference gated on the decode-level link graph** — real
radios carrier-sense below decode threshold, and sub-decode signals still
add interference power. A CoreScope-decoded link graph misses both.

🟡 **A9. SF5/6 silently undeliverable** (`snrThresholdForSF` → 999, no
error; UI accepts 5–12; JS link building clamps and shows healthy links).
Mixed-radio scenarios likewise neither modeled nor rejected.

🟡 **A10. `WasRelayed` can be true with no matching Transmission** at the
sim-window edge; the `relayed` map is written but never read.

✅ Airtime formula (incl. SF-dependent 32/16 preamble, LDRO, CR mapping),
frame accounting incl. per-hop path growth, retransmit/rx-delay ports,
loop-detect thresholds + hasSeen ordering, flood limits, duty budget, RNG
determinism, report integrity (mod A10) — all verified byte-for-byte
against firmware or internally consistent.

## B. Scenario translation, UI state, scoring

🔴 **B1. `removeNode` doesn't remap generator indices** (simulator.js:489):
removing a mid-list node shifts all later nodes; senders silently move to
the wrong node, and `lastEpisode.target.nodeIndex` goes stale the same way
(the stale pair *match each other*, so the episode analysis proceeds
confidently wrong). `lastReport` isn't cleared either → mislabeled
per-repeater rows after any removal. Verified.

🔴 **B2. Per-repeater rankings count background messages in the reachable
denominator** (simulator.js:2884) — the Go original skips them
(report.go:283). Reconstructed episodes create background generators in
bulk → the "Received x/y (%)" column collapses toward 0%. Verified.

🟠 **B3. "Predict settings" grid search ranks by CollisionRate with no
delivery guard** (tune.go:160) — the objective the project's own docs call
degenerate; README claims both search modes rank by delivery ratio. Users
can be led to low-collision/low-delivery configs.

🟠 **B4. `ruleMatchesAttrs` JS mirror lacks `node_index_in`** — latent
drift trap: optimizer policies rendered through it would silently show "no
change".

🟡 **B5. Superseded worker searches aren't cancelled** — a stale search's
result can pop modals/re-enable buttons mid-newer-search.

🟡 **B6. Rankings duty-cycle uses the *current* duration input,** not the
run's. `applyRuleToScenario` can panic the whole WASM instance on
malformed attrs (worker dead until reload). Big runs + the 10× ensemble
run on the main thread despite the worker existing.

✅ JS↔Go field/unit translation, defaultPrefs/SF-thresholds/
isCanonicalDelivery/reachableFrom mirrors, link SNR directionality, seed
plumbing (distinct trials, no collisions), WASM marshalling/cancel/memory,
optimizer acceptance internals — verified solid.

## C. Replay + observer-evidence pipeline

🔴 **C1. The 🎲 probability analysis is broken for the "🔗 Replay" flow it
claims to support** — it consumes `simMessageGenerators`, which
`replayFromHash` never sets. Fresh workspace → refuses; stale generators
from an *earlier* reconstruction → all 10 runs silently skip the target
and it renders a confident verdict ("probability 100% — inconclusive")
computed from **zero valid runs**. Same staleness nulls
`computeEpisodeStats` after ▶ Run following a replay. Verified (my code).

🔴 **C2. `P(all silent | model)` uses an independence product over
per-observer marginals when the joint samples are in hand.** Silent
observers share relay chains, so their deliveries are strongly correlated;
the product overstates the "died near sender" verdict (worked example: true
0.5 → product 0.06, flipping the verdict). The correct estimator — the
fraction of runs where *every* silent observer got no clean delivery — is
directly countable from data already collected. Also: 10 runs cannot
support "<0.01%" precision. Verified (my code — the bias runs in the
direction I expected, which is exactly why it slipped through).

🟠 **C3. The two flows compute different "reality":** the reconstruct flow
builds its contradicted set from window-observers only (evidence outside
±window never contradicts — SCO-ANG at −73 s in the case study is lost);
the replay flow merges evidence properly. Headline counts use all
evidence while pruning uses fewer — same packet, two different constrained
reaches depending on the button.

🟠 **C4. Row-multiplicity assumption conflict:** one comment says the
packet list is one-row-per-observation ("dedupe or the same flood gets
sent several times"), the other says one-representative-row-per-packet.
The reconstruct generator loop has **no hash dedupe** — if the API is
per-observation, a 3-observer flood becomes 3 same-second flood senders
(the target duplicated against itself manufactures the "died locally in a
collision" outcome as an artifact). Needs a live-API check + one enforced
assumption.

🟠 **C5. Case-sensitive `refId` lookups** in `computeEpisodeStats` /
`runEpisodeProbability` — planner-cased nodes silently drop out of recall
AND the contradicted set (worst case "0 of 0 (100% recall)");
`replayFromHash`'s own code comments warn about exactly this casing.

🟠 **C6. A proven target relay can be classified silent-active and
pruned** — evidence skips target-hash events, so a relay that provably
carried the packet but uploaded no observation gets contradicted by its
*other* activity while simultaneously listed as a proven transmitter.
`targetPaths` members must be excluded from the contradicted set.

🟠 **C7. `evidence.js` airtime hardcodes a 16-symbol preamble; engine +
firmware use 32 for SF ≤ 8** — at the default SF8 preset every busy/deaf
window is ~130 ms short. Verified. **Cross-project:** the same 16-symbol
assumption shipped today in MeshCIM's `ChannelActivityMonitor` and
HopLink's `airtime.go` — all three need the SF-dependent preamble.

🟡 **C8.** Trailing-null `resolved_path` fabricates a proven observer edge
in the replay flow (the reconstruct flow correctly drops it). Malformed
observation timestamp anchors the whole replay at 1970 (`|| 0`). Empty
observed timeline collapses pre-target traffic to t=0 (fabricated pileup).
`escapedRuns === 0` prints "timing luck decides it" about a coin toss that
never existed. Frontier "competing costs" double-count core-adjacent
silent observers on both sides of the comparison. "N REFUTED" hops are
counted but rendered nowhere. Contradicted collided-only nodes get no
✕-ring though the timeline excludes them. Saved replay-flow setups restore
an episode that can never re-run. Binary-search backoff of −2 can skip
same-second ties at the window edge.

✅ `loraAirtimeMs` formula itself (mod preamble count), `constrainDeliveries`,
`frontierAnalysis` classification, timeline constraint semantics, the
binary-search core, `filterRepeatersAliveAt`, interior-null path handling —
verified sound with meaningful tests.

## D. Docs vs code

🔴 **D1. Default deployments silently disable relaying on every real
repeater** in the Simulate tab: `denyUnscoped: !r.observedUnscoped`, and
`observed_unscoped` is only emitted when `corescope.scope_observation` is
enabled — which is **off by default**. The model doc frames DenyUnscoped
as a user-set what-if knob; in a stock install every real repeater loads
deny-all-unscoped with whatever scopes CoreScope guessed. (Scoped traffic
still flows where region keys match — which is why the ScotMesh replays
worked — but unscoped floods die everywhere, undocumented.)

🟠 **D2.** Model doc's §Timing says txdelay is driven by packet score (it's
uniform random; the score only drives the off-by-default rx hold-back);
event table lists a nonexistent `eventRelay` and mislabels `already_seen`
as loop detection; hop-limit gates unmentioned; direct-traffic-floods
simplification undisclosed in user docs; link-SNR provenance (observed =
log-count heuristic where one observation always clears decode threshold)
documented nowhere user-facing; validation numbers (100%/96.6%) are
unreproducible in-repo and sit alongside a newer 80% figure and a known
over-prediction case the validation section doesn't mention.

🟡 **D3. Test-coverage hole is the scenario-translation layer** — zero
unit tests for link-SNR heuristics, denyUnscoped/regions defaulting,
radiosCompatible, blend dedup, and no drift-pinning tests for any
manually-mirrored JS↔Go constant (this class has now produced two live
bugs: the phase-7 SF11 anchor and C7). The Go engine's own suites are
genuinely strong.

---

## Suggested fix order

1. **C1 + C2** — the verdict feature can currently fabricate output and
   its estimator is biased toward the expected conclusion. (Small: run the
   ensemble off the episode's own messages; count joint all-silent runs.)
2. **B1/C3-staleness** — index remap on node removal (corrupts everything
   downstream of an edit, silently).
3. **C3/C4/C5/C6** — one source of truth for evidence/contradicted set,
   verified row multiplicity, case-normalized refIds, proven-relay
   exclusion.
4. **C7** — SF-dependent preamble in evidence.js + MeshCIM + HopLink, with
   a JS↔Go parity test.
5. **B2, D1** — rankings denominator; scope-observation default disclosure
   (or enable it in the shipped configs).
6. **A1/A2** — TX serialization + MAX_PATH_SIZE gate (highest-fidelity
   engine gaps; both small, well-localized).
7. **B3** — give the grid search a delivery guard or retire it in favour
   of the policy search.
8. Docs sweep (D2) + drift-pinning tests (D3); remaining A/B/C 🟡 items
   opportunistically.
