# Decomposition plan — breaking up the oversized files

Enforces Rule 1 of `CLAUDE.md` (< 400 lines per file, one responsibility) on
the files that currently violate it. Ordered by **risk, lowest first** — build
confidence on the moves with airtight nets before touching the ones without.

## Status — done

**No file in the repo exceeds 1000 lines.** The largest is
`internal/meshsim/optimize_test.go` at 985.

| File | Before | After | Split into |
|---|---:|---:|---|
| `public/simulator.js` | 7582 | **981** | 18 modules + `sim-state.js` + `sim-constants.js` |
| `public/planner.js` | 1930 | **925** | 5 modules + `plan-state.js` |
| `internal/meshsim/engine_test.go` | 1997 | **803** | 6 files, mirroring engine.go's own split |
| `tests/simulator.spec.js` | 1748 | **529** | 3 specs + `sim-helpers.js` |
| `internal/meshsim/optimize.go` | 1854 | **844** | score, spsa, moves, types |
| `internal/meshsim/engine.go` | 1439 | **853** | types, capture, airtime |
| `public/style.css` | 2248 | **590** | simulator, planner, sim-panel, leaflet, mobile |
| `public/app.js` | 1172 | **799** | `map-responsive.js` + `map-state.js` |

### What made it possible

Not line-counting — the blocker was that `simulator.js` held 64 mutable
variables in one closure, read and reassigned across 211 functions. Any
extraction meant threading a getter per piece of state. Lifting state into a
plain object first (`sim-state.js`, then `plan-state.js`, `map-state.js`)
turned every later split into a mechanical move.

### What caught the mistakes

Three static checks and one dynamic, all under `npm test`:

- `tools/check_module_refs.mjs` — identifiers that resolve to nothing.
- `tests/unit/module-contracts.test.mjs` — the init()/return handshake in both
  directions, plus "no module pins shared state into a load-time const".
- `tests/unit/simulator-boot.test.mjs` — evaluates every script `index.html`
  loads, in order, against a stub DOM.

The boot test is the one that mattered. Load-order faults are invisible to a
syntax check and to the static checks — the names exist, they just aren't
initialised yet — and they break the whole page rather than one feature. It
found five: two modules keeping top-level `map.on(...)` registrations, two
wiring blocks sitting below the code that depended on them, and a `<script>`
tag pointing at a module that was never created.

## The offenders

| Lines | File | Net protecting it |
|------:|---|---|
| 7527 | `public/simulator.js` | e2e only, and skippable (Rule 3) |
| 2248 | `public/style.css` | none — but CSS has no state |
| 1997 | `internal/meshsim/engine_test.go` | n/a (is a test) |
| 1930 | `public/planner.js` | partial e2e |
| 1854 | `internal/meshsim/optimize.go` | **985-line adjacent test** |
| 1728 | `tests/simulator.spec.js` | n/a (is a test) |
| 1439 | `internal/meshsim/engine.go` | **1997-line adjacent test** |
| 1172 | `public/app.js` | partial e2e |
| 944 | `internal/gpucompute/gpucompute.go` | **47 lines — effectively none** |
| 893 | `public/index.html` | e2e |
| 873 | `public/planner-worker.js` | none |

Excluded as vendored/generated: `public/wasm_exec.js` (Go toolchain),
`node_modules/`, `public/hopreach.wasm`.

---

## Stage 1 — Go splits (zero risk, do first)

Unexported identifiers stay package-visible, so these are **pure file moves:
no signature changes, no state relocation**. `go test ./internal/meshsim/...`
is an airtight before/after check.

**`internal/meshsim/optimize.go` (1854 → ~1230)**

| New file | Lines moved | Contents |
|---|---|---|
| `optimize_score.go` | 505–652 (~148) | `ContentionWeights`, `weightedContentionScore`, `nodeContentionScore`, `contentionComponents`, `nodeSpeedupScore`, `networkContentionScore`, `dominantContentionReason` |
| `optimize_spsa.go` | 845–1058 (~214) | `currentNodeStateFor`, `baselineNodeFor`, `escalatingStep`, `spsaWarmStart` |
| `optimize_moves.go` | 1237–1495 (~259) | `optimizeMoveCandidate`, `generateOptimizeCandidates`, tabu list |

Second pass: `optimize_eval.go` (653–844). Still leaves `OptimizeStep` at 336
lines — worth breaking into its phases, but that is a *code* change, not a
move, so it needs its own reviewed commit.

**`internal/meshsim/engine.go` (1439 → ~770)**

| New file | Lines moved | Contents |
|---|---|---|
| `engine_types.go` | 214–538 (~325) | `Scenario`, `ChannelParams`, `Message`, `Reception`, `Report`, `Transmission` |
| `engine_capture.go` | 1149–1357 (~209) | `overlaps`, `captureOutcome`, `loraCaptureOutcome`, `linkSNR`, `snrThresholdForSF`, `gaussian`, `decodes` — pure RF physics, already targeted by `channel_test.go` |
| → `airtime.go` | 1358–1439 (~82) | `txBudget` and friends join the existing file |

`RunWithAblation` remains 456 lines. Same note as `OptimizeStep`: splitting the
event loop is a behavioural change and needs its own commit with the ablation
tests watched closely.

## Stage 2 — CSS (zero risk, order matters)

`public/style.css` (2248 → ~1360). Cut at existing banners, **preserving load
order** — the file's own comment at line 1802 explains that the Leaflet
overrides must match Leaflet's `0,2,0` specificity and cannot rely on load
order alone, and the mobile block must stay last.

| New file | Lines | Why it's safe |
|---|---|---|
| `style-simulator.css` | 1365–1801 (~437) | simulator panel, rankings, modals, nodes table |
| `style-leaflet.css` | 1802–1914 (~113) | self-contained themed control overrides |
| `style-mobile.css` | 1915–2248 (~334) | the banner-marked phone-layout block, zero inbound coupling — **stays last** |

The earlier scattered `@media (max-width: 700px)` blocks (lines 103, 165, 215,
427, 1011, 1050) belong to the components they sit beside and **stay where they
are**. Only the banner-marked block at 1915 moves.

## Stage 3 — frontend, pure modules first

These are the safe JS cuts because the extracted code touches no shared state
and no DOM. **Each ships with `tests/unit/<name>.test.mjs` in the same
commit** (Rule 2) — which also closes the biggest hole in current coverage.

**3a. `public/mesh-frame.js` (~230 lines: simulator.js 4941–4979 + 5109–5248)**
`parseMeshFrame`, `extractPacketHash`, `sha256Bytes`, `hmacSha256`,
`decodeRegionOfPacket`, `regionKeyCache`. Shared state to move: **none** — the
only outward reference in the whole block is `MeshApi.scopes()`. Already
exercised indirectly via `__hopreachSimulatorDebug.decodeRegion`
(`tests/simulator.spec.js:1499`), but that test *skips* when scope-stats are
unavailable, so the unit test is a genuine gain, not a duplicate.

**3b. `public/sim-topology.js` (~235 lines: 3708–3942)**
`computeNeighborSets`, `findArticulationPointsJs`, `marginalCoverageForJs`,
`computeTopologyAttrsJs`, plus the rule engine (`ruleMatchesAttrs`,
`ruleScaleValueAt`, `applyRule`, `applyPolicyToNodeState`). Currently reads
`simNodes`/`simLinks` from closure; pass them explicitly — `attrsFromState`
(3691) already takes them as parameters, so the pattern exists. **Zero direct
assertions today**; the unit test can be cross-checked against the Go
`topology_test.go` it mirrors.

**3c. `public/sim-rankings.js` (~342 lines: 2785–3126)**
Split the pure part from the DOM part: `computeRankings(report, nodes,
messages)` (2854–2987) becomes a tested module function; the render helpers
stay behind or move with the container element injected. `lastRankings`,
`rankingsSortKey`, `rankingsSortDir` become module-private. Protected by e2e
test 294 and the `getLastReport` debug hook.

After 3a–3c: simulator.js ≈ 6720. Still far too big — but every remaining line
is now either DOM wiring or genuinely entangled state, and the pure logic has
tests.

## Stage 4 — the real prize (only after Stage 3)

**`public/sim-episode.js` (~830 lines: 5249–6078)** — `reconstructEpisodeFromWindow`
(301 lines), `computeEpisodeStats`, `renderEpisodeAnalysis`, `runEpisodeProbability`.
Depends on Stage 3a, and owns `lastEpisode`, `lastEpisodeMessages`,
`lastEpisodeTargetPid`, `episodeBaseline` as module state with `simNodes`
passed in.

⚠️ **Precondition, not a suggestion:** this region's *only* coverage is e2e
tests that skip on a quiet mesh (`simulator.spec.js` 1323, 1345, 1634). Record
fixtures and pin `getEpisode`/`getScenario` **before** moving anything. Without
that, a green suite proves nothing about this code.

The packet inspector (2091–2784, 694 lines) is a hub with six inbound call
sites; funnel those through one entry point before attempting it.

## Stage 5 — planner.js (1930 → ~1350)

| New file | Lines | Shared state to pass |
|---|---|---|
| `plan-kml.js` | 1719–1873 (~155) | `plan` by argument — cleanest cut in the file |
| `plan-connect.js` | 1054–1337 (~284) | owns its own state cluster; needs `{getPlan, setMode, requestRoute}` injected. Has real e2e coverage (`planning.spec.js:80`) |
| `plan-area.js` | 1338–1476 (~139) | same shape as connect |

Leave neighbours (374–757) alone until `showNeighborHighlight`'s nine call
sites are funnelled through one entry point.

## Stage 6 — the untested Go file

`internal/gpucompute/gpucompute.go` is 944 lines against a **47-line** test,
because it needs a GPU. Splitting it is safe (same package), but the honest
first move is coverage for the parts that don't need hardware —
`sitesToBytes`, `structToBytes`, the chunk-planning arithmetic — before any
restructuring.

---

## Sequencing summary

1. **Stage 1** (Go) — airtight tests, pure moves. Build confidence here.
2. **Stage 2** (CSS) — no state, just keep the order.
3. **Stage 3** (pure JS + new unit tests) — closes real coverage gaps.
4. **Stage 4** (episode) — *only* after fixtures exist.
5. **Stage 5** (planner) — independent of 3/4, can run in parallel.
6. **Stage 6** (gpucompute) — coverage before restructuring.

One stage per PR. Never mix a split with a behavioural change: if a diff
contains both a move and an edit, the move stops being reviewable.
