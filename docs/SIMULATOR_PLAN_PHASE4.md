# Simulator plan, phase 4 — per-repeater tuning, community methods, and an adaptive optimizer

Status: **work items 1, 2, 3, 4, 5, 6, 8 done and verified** (Go tests +
`docker compose up --build` + full Playwright suite, all green). Work item
7 (retire the JS rule-engine mirror) deliberately deferred — recommended,
not required, not started.

Work item 8's own real, measured result: HopReach does **not** reproduce
the "zero delays win" claim from discussion #2053 — see "What was
actually found" under work item 8 below for the full write-up, including
a genuinely unresolved finding (none of the five ablated mechanisms
individually explain the effect).

## What's actually built (read this before re-deriving anything below)

- **Item 1 — `RuleScale`** (`rules.go`): continuous proportional rules.
  `degree-proportional`/`coverage-proportional`/`altitude-proportional`
  (+ inverses) added to `stage2NamedModelPolicies` (`policytune.go`).
  `refinePolicy` nudges `Scale.ValueAtMin/ValueAtMax` together. JS mirror
  (`applyRule` in `simulator.js`) updated to match.
- **Item 2 — `ConditionNodeIndexIn`** (`rules.go`): per-node targeting,
  `MatchesNode`/`matchesNode`. Empty `Nodes` matches nothing (dangerous
  default, tested explicitly).
- **Item 3 — `Report.PerNodeStats`** (`report.go`): Go port of
  `computeRankings`. Found and fixed a real bounds-safety bug in
  `reachableFrom` along the way (out-of-range node index panicked;
  now treated as an unreachable leaf).
- **Item 4 — the adaptive optimizer** (`optimize.go`, the main event):
  `OptimizeStep`/`OptimizeState`/`OptimizeValidate`. Chunked, one bounded
  round per call, driven round-by-round from `simulator.js` (not looped
  inside the worker) so cancellation actually works — see
  `meshsim-worker.js`'s `"optimize-step"` kind and `runOptimizeAdaptive`.
  Wired through WASM (`wasm/meshsim.go`: `jsSimOptimizeStep`/
  `jsSimOptimizeValidate`) and the bridge (`meshsim-bridge.js`:
  `optimizeStep`/`optimizeValidate`). UI: "🎯🔁 Optimize adaptively" button
  in `#sim-predictions-modal`, graceful-then-forced cancel
  (`cancelOptimizeAdaptive`, an 8s force-terminate backstop), hold-out
  validation shown alongside the search figure, deviations list with CSV
  export. **Three real bugs found and fixed empirically** (not just by
  writing tests that happened to pass — by tracing actual behaviour on the
  `lockstepCollisionScenario` fixture until the numbers made sense):
  1. `networkContentionScore` summed raw counts across trials; comparing a
     `Trials`-run screening score against a `ConfirmTrials`-run
     confirmation score directly made a genuinely better candidate look
     worse purely because it summed over more trials. Fixed with
     `normalizedContentionScore` (divides by trial count) — every scalar
     contention comparison goes through it now, never the raw sum.
  2. `currentTxDelayFor` read `DefaultNodePrefs()` instead of the
     scenario's own actual base `NodePrefs` — reported a fabricated "old"
     value with no relationship to what a node was actually running (the
     mechanics still worked; only the displayed number was wrong).
  3. A pure multiplicative bump (`oldTxDelay * 1.5`) is a permanent no-op
     starting from `TxDelayFactor: 0` — a real, legitimate starting value.
     Fixed with an escalating additive step
     (`optimizeMinBackoffStep * (1 + staleRounds)`).

  All three have dedicated regression tests
  (`TestNormalizedContentionScoreIsComparableAcrossDifferentTrialCounts`,
  `TestOptimizeStepEscalatesStepWhenStartingFromZero`), not just the
  higher-level tests that originally caught them.
- **Item 5 — community methods** (`methods.go`): `BuiltinMeshMethods()` —
  MeshSydney, WNY, TennMesh, W6HS, upstream-proposed-minimums, every
  `Source` mandatory and test-enforced. Wired into `SuggestPolicy`'s own
  candidate set (`communityMethodCandidates`, prefixed `"community: "`),
  altitude-gated methods excluded when no altitude data was supplied.
- **Item 6 — tier assignment** (`rules.go`: `AssignPolicy`/
  `PolicyAssignment`): exposed over WASM (`jsSimAssignPolicy`), not
  reimplemented in JS. UI: profile summary + drill-down in
  `#sim-policy-section`, word labels only (no colour — see the CSS's own
  comment), "No profile" is a first-class drillable row, profile counts
  sum-checked against the loaded repeater count.

## Test status

`go test ./...` — all packages pass, including 11 new `optimize_test.go`
tests, method-catalogue tests (`methods_test.go`), and the `RuleScale`/
`ConditionNodeIndexIn`/`PerNodeStats`/`AssignPolicy` suites in
`policytune_test.go`/`report_test.go`. Full Playwright suite (36 tests) —
3 new adaptive-optimizer end-to-end tests (require-a-search-first,
runs-and-shows-holdout, cancel-mid-run), plus the extended
search-policies test now also checks the profile drill-down. All green,
confirmed stable across repeated runs (the cancel test in particular was
iterated until it wasn't racy).

## Why this exists

Three requests, from the user, verbatim in intent:

1. A policy-search model that **fine-tunes individual repeaters** — "a lot
   of these are set this thing to the exact same a lot so its not so
   smart."
2. **Named models from other real-world meshes** — "the X method (e.g.
   Sydney method)."
3. A **long-running optimizer** that "slowly adjusts from seeing collisions
   etc and contention on specific repeaters etc until it disappear[s]."

(1) and (3) are the same missing capability seen from two angles, and (3)
is the interesting one: it's a closed feedback loop, which nothing in the
current search does.

## The diagnosis — the user is right, and the code already admits it

Every model in `stage2NamedModelPolicies` (`internal/meshsim/policytune.go:115`)
is **class-based**: a `RuleCondition` selects a set of nodes and assigns
them all one identical value. There is no mechanism to target an individual
repeater at all.

The bottleneck is `RuleCondition` (`rules.go:46`), which is `Kind` +
a single `Threshold` float. `matches()` (`rules.go:51`) is a pure function
of `NodeAttrs` — it cannot express "this specific node," and it cannot
express a continuous function either, only a step.

`policytune.go:100-114` already documents exactly this, having hit it:

> - `degree-proportional`: needs continuous (non-threshold) scaling of
>   txdelay by neighbour count — RuleCondition's Kind+Threshold shape has
>   no way to express a continuous function, only a step.
> - `redundancy-suppress` / `airtime-aware`: these are measurement-driven —
>   they target SPECIFIC nodes identified from a prior run's own
>   scoreboard… Nothing in RuleCondition can match "this specific set of
>   node indices".

So three of the fifteen models from the phase-2 catalogue
(`SIMULATOR_PLAN_PHASE2.md:148-150`) were never built, all for this one
reason. This phase builds the missing infrastructure and then the models.

There is a real design tension to keep in view. `ConfigRule`'s own doc
comment (`rules.go:73-76`) says:

> Rules exist so a suggestion is expressible as something a human can read
> and apply ("repeaters above 600m: txdelay 1.0, rxdelay 5"), not just an
> opaque per-node table.

A per-node optimizer produces precisely that opaque table. **The mitigation
is architectural, not cosmetic**: the optimizer must start from the best
class-based policy and only deviate per-node where measurement justifies
it, so the output is "this base policy, plus 4 named exceptions with a
measured reason each" — not 70 unexplained rows. This is also just better
for the user: fewer settings to actually change on real hardware. Work
item 4 is built around this.

---

## Work item 1 — proportional (continuous) rules

The cheap win, and it addresses "set this thing to the exact same a lot"
without any per-node machinery at all: a rule whose value is a *function*
of a node attribute, so every node gets a different number from one
compact, human-readable rule.

Add to `ConfigRule` (`rules.go:77`):

```go
// Scale, when non-nil, makes this rule's TxDelayFactor a continuous
// function of a node attribute rather than a constant — the
// `degree-proportional` model policytune.go's own comment flags as
// needing "a new proportional rule kind". Reads as e.g. "txdelay 0.25
// at 1 neighbour rising to 1.0 at 12+", which is still one legible
// sentence, unlike a per-node table.
type RuleScale struct {
    Attr    RuleScaleAttr `json:"attr"`    // "neighbor_count" | "altitude_m" | "marginal_coverage"
    AtMin   float64       `json:"atMin"`   // attribute value mapping to ValueAtMin
    AtMax   float64       `json:"atMax"`   // attribute value mapping to ValueAtMax
    ValueAtMin float64    `json:"valueAtMin"`
    ValueAtMax float64    `json:"valueAtMax"`
}
```

Linear interpolation, clamped outside `[AtMin, AtMax]`. Applied in
`ConfigRule.Apply` — but note `Apply(base NodePrefs)` currently has no
access to `NodeAttrs`, so it needs a second method rather than a signature
change (`Apply` is used by the untouched legacy `Suggest` path — see the
"things not to do" list):

```go
func (r ConfigRule) ApplyWithAttrs(base NodePrefs, attrs NodeAttrs) NodePrefs
```

`applyPolicyToScenario` (`rules.go:148`) switches to `ApplyWithAttrs`;
`applyRuleToScenario` (the legacy path, `rules.go:118`) keeps calling
`Apply` unchanged.

New models this unlocks in `stage2NamedModelPolicies`:
- `degree-proportional` — txdelay scaled by neighbour count, plus inverse.
- `coverage-proportional` — txdelay scaled inversely by marginal coverage.
- `altitude-proportional` — gated on `hasAltitude`, plus inverse.

**JS mirror required**: `ruleMatchesAttrs`/`applyRule`
(`simulator.js:2858`, `:2881`) are hand-written mirrors of the Go rule
engine, used by the per-repeater action list. `applyRule` must gain the
same scaling logic or the action list will silently show wrong values for
any scaled rule. See work item 7 for retiring this duplication properly.

---

## Work item 2 — per-node targeted overrides

Needed by both the measurement-driven models and the optimizer.

Add a condition kind that matches an explicit node set. `RuleCondition`
gains a `Nodes []int`:

```go
ConditionNodeIndexIn RuleConditionKind = "node_index_in"
```

`matches(a NodeAttrs)` can't implement this — it takes attrs, not an index.
Change the internal call sites to a new `matchesNode(index int, a NodeAttrs) bool`
that handles `ConditionNodeIndexIn` by index and delegates everything else
to the existing `matches`. Keep `matches` exported-behaviour-identical for
the legacy `Suggest` path.

Node indices are only meaningful against the exact `Scenario` they were
searched on. A policy carrying `Nodes: [3, 17]` applied to a different node
list is silently wrong, not obviously wrong. **Guard this**: the action
list and CSV export must resolve indices to repeater *labels/addresses* at
generation time, and a saved policy that's reloaded against a different
node set must refuse to apply rather than mis-apply. Worth a test.

New models unlocked:
- `redundancy-suppress` — from a baseline run, the top-K nodes by
  `redundantRelays` get raised txdelay.
- `airtime-aware` — top-K by duty cycle back off most.
- `contention-suppress` — top-K by `contentionCaused` back off (this is
  the one closest to the user's "contention on specific repeaters").

---

## Work item 3 — per-node diagnostics in Go

Both work item 2's models and the optimizer need per-node measurements that
currently exist **only in JavaScript**: `computeRankings`
(`simulator.js:2306`) computes `collisionCount`, `contentionCaused`,
`txBusyCount`, `dutyAirtimeMs`, `relayedCount`, `uniqueDeliveries`,
`redundantRelays`, `deliveredCount`, `reachableCount`, `deferrals`.

Add to `report.go`:

```go
type NodeStats struct {
    Node int
    SuccessCount, CollisionCount, ContentionCaused, TxBusyCount int
    DutyAirtimeMs uint32
    RelayedCount, RedundantRelays, UniqueDeliveries int
    DeliveredCount, ReachableCount int
}

func (r Report) PerNodeStats(scenario Scenario, messages []Message) []NodeStats
```

Port `computeRankings`' logic exactly, including the `deliveringPairs`
`"packetId:fromNode"` set that `redundantRelays` depends on
(`simulator.js:2338-2363`) and the `isCanonicalDelivery` filter — a
reception that was collided/weak_signal/tx_busy/already_seen is not a
delivery. Reuse `reachableFrom` (`report.go:89`) for `ReachableCount`
rather than re-deriving it.

**This creates a second copy of that logic**, which is exactly the drift
risk `README.md`'s "WASM shared core" section says this project eliminated
for the propagation model. See work item 7.

---

## Work item 4 — the adaptive optimizer (the main event)

`OptimizeAdaptive` — a closed feedback loop: measure → find the worst
offenders → adjust just those → re-measure → keep or revert → repeat.

### Loop shape

1. Evaluate the **base policy** (default: the winner of a normal
   `SuggestPolicy` run, so this starts from a good class-based policy
   rather than from nothing). Record delivery, collision, per-node stats.
2. Rank offenders by a **contention score** combining
   `ContentionCaused`, `CollisionCount`, `RedundantRelays` and duty cycle.
   Exact weighting is a tuning decision — start simple and document it.
3. Propose a **targeted adjustment** for the worst offender(s): a
   `ConditionNodeIndexIn` rule nudging that node's txdelay (up for a
   high-contention/high-redundancy node; down for a starving articulation
   point whose subtree is missing deliveries).
4. Evaluate. **Accept or revert** per the criteria below.
5. Repeat until a stopping condition.

### Acceptance criteria — delivery-first, non-negotiable

Phase 2's hardest-won finding (`SIMULATOR_PLAN_PHASE2.md:94-101`) is that
collision rate is the *wrong* objective: two scenarios at 43.1% vs 43.9%
collisions delivered 33.3% vs 64.3%. "Adjust until contention disappears"
taken literally is satisfied perfectly by making every node silent.

So: **accept only if delivery does not regress**, and among
delivery-neutral moves prefer the one that cuts contention most.
Concretely — accept iff
`delivery >= bestDelivery - deliveryTolerance` **and**
`contentionScore < bestContentionScore`. Never accept a contention
improvement that costs real delivery.

### Guarding against chasing noise

Each evaluation is an average over `Trials` stochastic runs. A delta
smaller than the run-to-run spread is noise, and a greedy loop will
happily chase it for hours and report a meaningless "improvement."

- Require improvement to exceed a `minImprovement` epsilon, not just be
  positive.
- Re-evaluate the incumbent periodically with fresh seeds rather than
  trusting a cached score indefinitely.
- Consider raising `Trials` for the accept/reject decision specifically —
  a cheap screening pass followed by a more-trials confirmation before
  committing.

### Guarding against overfitting

A long greedy search *will* overfit to the specific seed and generated
message set. The output is CLI commands users paste into real radios, so
this matters.

**Hold-out validation**: reserve a set of seeds never used during the
search, and re-evaluate the final policy against them. Report both
numbers. If the held-out delivery is materially worse than the search
delivery, say so in the UI rather than presenting the search number as the
result.

### Cancellation — a real technical constraint, read this before designing

The optimizer is long-running by definition, so Cancel must work. It
currently cannot, for two independent reasons:

1. **`self.onmessage` cannot fire while a synchronous WASM call is
   running.** `MeshSim.suggestPolicy(...)` (`meshsim-worker.js:49`) blocks
   the worker's event loop for the whole search. Progress `postMessage`
   calls *out* work fine; a cancel message *in* is queued and not seen
   until the call returns — i.e. never, in time to matter.
2. **The worker is never terminated.** `ensurePredictWorker`
   (`simulator.js:92`) creates one lazily and nothing calls `terminate()`.
   `predictGeneration` only causes stale *results* to be ignored
   (`simulator.js:3222`) — the abandoned search keeps burning CPU to
   completion.

Two viable designs:

- **Resumable chunks (recommended).** Go exposes
  `OptimizeStep(state OptimizeState) OptimizeState` doing a bounded amount
  of work and returning serializable state. JS drives the loop, so it
  regains control between chunks and can check for cancel, update the UI,
  and stop cleanly. Also gives honest incremental progress and lets a
  partial result be shown.
- **Terminate the worker.** Simpler, and worth adding regardless as a
  backstop, but it throws away all progress and forces a fresh WASM
  instantiation on the next run.

Do both: chunked for clean cancellation, `terminate()` as the hard stop.

### Stopping conditions

All user-visible, none infinite: no accepted move in N consecutive rounds;
a wall-clock/iteration budget; contention score reaching zero; explicit
cancel. Always return the best policy found so far, never nothing.

### Output

Reuse the existing per-repeater action list — it already renders
copy-pasteable `set txdelay …` lines with a CSV export. Additions worth
making: which repeaters deviate from the base policy and **why** (the
measured reason that triggered each deviation), and the search-vs-held-out
delivery figures side by side.

---

## Work item 5 — community "method" presets (RESEARCHED — unblocked)

The user asked for models "from other meshes online," e.g. a "Sydney
method." These turn out to be real, published, and citable. Every value
below was read from the primary source, not from a search summary — see
the accuracy warning at the end of this section, which matters.

### The catalogue

**5a. MeshSydney / NSW method** — role + elevation profiles.
Source: <https://meshsydney.com/wiki>

| Profile | Role | Elevation | Neighbours | txdelay |
|---|---|---|---|---|
| BACKBONE | point-to-point link | variable | 1-2 | 0.25 |
| CRITICAL | hilltop/tower | highest | 20+ | 0.3 |
| LINK | mid-elevation bridge | mid | 15-20 | 0.6 |
| STANDARD | suburban coverage | average | 5-10 | 1.0 |
| LOCAL | ground-level/indoor | low | 1-3 | 1.4 |
| MOBILE | vehicle/portable | variable | variable | 2.0 |
| BRIDGE | ESP-NOW bridge | variable | variable | 0.25 |

Direction: **hilltop-first / dense-fast.** Stated reasoning, quoted:
> "Highest-reach nodes fire first, covering the most area in a single
> transmission before the channel fills with retransmissions from lower
> nodes."

Specifies `txdelay` only — no per-profile `rxdelay`/`direct.txdelay`.

**5b. WNY MeshCore method** — five tiers, explicitly "adapted from the
Australian model."
Source: <https://wnymeshcore.org/blog/repeater-setup-naming-guides>
(republished verbatim by Colorado MeshCore and Denver MeshCore)

| Tier | Description | txdelay |
|---|---|---|
| HILLTOP | mountain peaks, towers, the backbone | 2.0 |
| FOOTHILLS | mid-elevation, bridges hilltops to suburbs | 1.5 |
| SUBURBAN | typical rooftop install | 0.8 |
| LOCAL | indoor, ground-level, few neighbours | 0.3 |
| MOBILE | vehicles, hiking, always defers to fixed nodes | 3.0 |

Plus `rxdelay 3` and `agc.reset.interval 500` network-wide.
Direction: **hilltop-last.** Stated reasoning: "make higher nodes wait
longer before retransmitting."

**5c. TennMesh method** — neighbour-count keyed.
Source: <https://tennmesh.com/settings/>

`rxdelay 3`, `agc.reset.interval 4`, `multi.acks 1` for all repeaters, then:

| Neighbours | txdelay | direct.txdelay |
|---|---|---|
| 0-1 | 0.3 | 0.1 |
| 2-4 | 0.5 | 0.3 |
| 5-9 | 1.0 | 0.5 |
| 10-14 | 1.5 | 1.0 |
| 15+ | 2.0 | 2.0 |

Direction: **dense-slow** — "repeaters that hear more neighbors should wait
longer before transmitting."

**5d. W6HS three-tier** — Eric Hendrickson, Nov 2025 (updated Jan 2026).
Source: <https://w6hs.net/meshcore-repeater-deployment-timing-considerations-for-wide-area-networks/>
txdelay 0.5 personal/residential/mobile, 1.0 high-rise urban, 2.0
mountaintop/backbone. Keep `flood.max` at default. Direction:
**hilltop-last.**

**5e. Upstream proposed minimums** — not a community method, but the same
shape and worth searching as a candidate.
Source: <https://github.com/meshcore-dev/MeshCore/issues/2123> (KPrivitt,
March 2026). Proposes `rxdelay >= 3`, `txdelay >= 1.6` (8 backoff slots),
`direct.txdelay >= 1` (5 slots), against current firmware defaults of
0 / 0.5 / 0.3. **Status: not endorsed by maintainers** — label it as a
proposal, not a recommendation.

### The finding that actually matters: they contradict each other

**MeshSydney puts hilltops FIRST (txdelay 0.3). WNY, Colorado, Denver and
W6HS put them LAST (2.0). TennMesh's dense-slow rule points the same way as
WNY.** These are opposite strategies, both in production, both reasoned.

And the WNY guide, which credits the Australian model as its origin,
states:
> "The txdelay values are nearly identical because the physics doesn't
> change between hemispheres, the strategy of making higher nodes wait
> longer works everywhere."

That claim does not survive checking against the source it cites:
MeshSydney's top tier is 0.3 and its bottom tier is 1.4 — WNY's are 2.0 and
0.3. The two tables are close to mirror images. Present this neutrally: we
have no basis to say which performs better in its own network, and both may
be right for their own topology. But do not repeat the "nearly identical"
framing, because it is checkably untrue.

**This is a strong validation of phase 2's own design choice.**
`policytune.go:96-99` says each model is searched alongside its inverse
because "which way round is right… is a property of the specific topology
being searched, which is why it's measured rather than reasoned about."
Two real communities landing on opposite answers is exactly that, and it's
the clearest use case this tool has: load your own repeaters, run both
directions, get a measured answer instead of inheriting someone else's
hemisphere.

### Implementation

The mechanism is unchanged from the original proposal — a named
`ConfigPolicy` with mandatory provenance:

```go
type MeshMethod struct {
    Name      string       // "MeshSydney (NSW)"
    Policy    ConfigPolicy
    Source    string       // REQUIRED — URL
    AsOf      string       // when observed
    Direction string       // "hilltop-first" | "hilltop-last" | "dense-slow"
    Note      string       // caveats and what it does NOT specify
}
```

`Source` mandatory, enforced by a test, surfaced in the UI beside the
result — a community convention must never render with the same authority
as a firmware-verified fact.

Expressing these needs work items 1 and 2:
- 5a/5b/5d are **elevation-tiered**, needing altitude thresholds
  (`ConditionAltitudeAtLeast` already exists) — but note 5a is keyed on
  elevation *and* neighbour count, which `RuleCondition` still can't AND
  together (the same gap `policytune.go:184-191` documents for
  `hub-and-spoke`). Approximate as phase 2 did, and name the approximation
  visibly.
- 5c is a **five-band step function on neighbour count** — expressible today
  as five ordered `ConditionNeighborsAtMost` rules, or more cleanly by work
  item 1's `RuleScale`.
- MOBILE/BRIDGE/BACKBONE profiles have no topological proxy at all (they're
  deployment facts, not measurable from the graph). Either skip them or
  drive them from the existing per-node source field
  (`companion` vs `real` vs `planned`). Do not fabricate a mapping.

### ⚠️ Accuracy warning for whoever implements this

Search-engine summaries got this **wrong twice**, in the same direction
both times — both attributed WNY's hilltop-last values to MeshSydney,
producing a confident, fluent, entirely inverted description of Sydney's
method. Only fetching `meshsydney.com/wiki` directly and asking for the
reasoning revealed the true direction.

Read each primary source before encoding its numbers. Getting a direction
backwards here means shipping a preset that tells someone to invert their
whole network's timing, attributed to a community that recommends the
opposite.

### Settings we don't model

`agc.reset.interval` (WNY 500, TennMesh 4) and `multi.acks` (TennMesh 1)
appear in real community configs and have no counterpart in
`internal/meshsim`. A method preset can't reproduce them. Either model them
or state plainly in the UI that a preset covers only its delay settings —
don't let a partial preset imply full fidelity.

### Related upstream work worth reading first

<https://github.com/meshcore-dev/MeshCore/discussions/2053> — KPrivitt's
proposal to auto-tune repeater parameters from local density, which is
approximately work item 4 done in firmware. Contains a concrete
neighbour-count → delay lookup table (0 neighbours → tx 0.050 / direct
0.050 / rx 0.500; 5 → 1.500 / 1.500 / 2.000; 12 → 3.600 / 3.600 / 4.100)
and the delay formula `random(0, 5*t + 1)` where `t = airtime * delay_factor`.

**Read the thread before building work item 4.** A developer (stachuman)
built a simulator, swept 42,768 parameter combinations across sparse,
medium and dense topologies, and concluded *zero delays performed best*.
KPrivitt then field-tested zero delays on a real repeater at Pacific Beach
and error rates got **worse** — 45.7% → 50%. Maintainers declined to merge
an auto-tuning PR without "convincing test results." The discussion is
unresolved.

That is a documented case of a MeshCore delay simulator confidently
producing a recommendation that reality contradicted. HopReach is a
MeshCore delay simulator that produces recommendations. Treat it as a
live warning, not trivia:

- **If our optimizer trends toward zero/minimal delays, that is a red
  flag**, not a discovery — it reproduces a known-wrong result. Add it as
  an explicit sanity check on the output.
- It's a specific argument for the hold-out validation above, and for the
  UI being honest that these are simulated predictions needing field
  confirmation.
- Worth checking whether the discrepancy is explained by something we now
  model and that simulator didn't — half-duplex `tx_busy`, CAD deferral,
  the duty-cycle budget, capture effect (all phase-1/2 findings), or
  per-hop path-byte airtime (phase 3). If HopReach *doesn't* reproduce
  "zero delays best," that's a meaningful signal about which of those
  mechanisms matters.

---

## Work item 6 — show which tier each repeater was assigned

The tiered methods (5a/5b/5c/5d) classify every repeater into a named
profile — HILLTOP, CRITICAL, LOCAL, MOBILE, or a neighbour band. That
classification *is* the interesting output: "which of my repeaters does
Sydney's method call a hilltop?" is a more useful question than "what
number did it produce," and it's the thing you'd sanity-check before
trusting a preset at all. Right now nothing surfaces it — the action list
only shows resulting settings.

### Go: report the assignment

`ConfigRule` already has a `Name` field (`rules.go:78`) that's currently
only used for display, so tier names need no new storage — a tiered
method is just a policy whose rules are named `"HILLTOP"`, `"FOOTHILLS"`,
and so on.

What's missing is which rule actually *won* for each node.
`applyPolicyToScenario` (`rules.go:148`) applies every matching rule in
order and throws that information away.

```go
// PolicyAssignment records which of a policy's rules matched a node, in
// application order — the last one that set a given field is the one
// that actually determined it (see ConfigPolicy's later-overrides-earlier
// contract).
type PolicyAssignment struct {
    Node         int
    MatchedRules []int // indices into the ConfigPolicy
}

func AssignPolicy(scenario Scenario, attrs []NodeAttrs, policy ConfigPolicy) []PolicyAssignment
```

Return matched rule *indices*, not a single "tier" string. Picking one
label out of several matching rules is a presentation decision with real
ambiguity in it (a node can legitimately match a global `rxdelay` rule
*and* a tier rule), and baking a guess into the engine would hide that.
Let the UI decide, and document the convention it uses.

Implement `AssignPolicy` by factoring the existing match loop rather than
duplicating it, so the two can't disagree about what matched.

### UI: a profile breakdown you can drill into

**Word labels only — no colour coding.** The community guides do assign a
colour per profile (MeshSydney uses ⚫🔴🟠🟡🟢🔵🟣), but do not carry that
over: a colour needs a legend to decode, doesn't survive being read out or
pasted into a message, and this project already spends colour on
propagation margin and on clean/collided/dropped receptions. Spell the
profile out — `HILLTOP`, `CRITICAL`, `LOCAL` — everywhere it appears.

Primary surface is a **profile summary list** in `#sim-policy-section`,
one row per profile in the applied method's own rule order:

```
CRITICAL   txdelay 0.3    4 repeaters   ›
LINK       txdelay 0.6    7 repeaters   ›
STANDARD   txdelay 1.0   22 repeaters   ›
LOCAL      txdelay 1.4   11 repeaters   ›
No profile      —         3 repeaters   ›
```

**Clicking a profile drills into the list of repeaters it labelled**, by
name, with each one's own matched criteria (altitude / neighbour count)
alongside — so you can immediately see *why* a given repeater landed in
that tier and spot a wrong one.

Reuse the existing drill-down machinery rather than inventing a second
one: `enterPacketModalView`/`packetModalHistory`/`goBackPacketModal`
(`simulator.js:2104-2120`) already implement push/pop navigation with a
back button (`#sim-packet-modal-back`), and the packet inspector already
drills node → packet → node through it. A profile → repeater-list drill is
the same shape and should get the same back-button behaviour, so
navigation is consistent across the tool.

Secondary surfaces, both plain text labels:
- **Policy action list** — a Tier column per repeater. Convention: show
  the last matching rule with a non-empty `Name`; if several matched, the
  others go in a tooltip rather than being hidden.
- **⚙ Repeaters & settings table** — the same label, so the classification
  is visible while editing.

### Two cases that must be visible, not silent

1. **Unmatched repeaters.** A node matching no rule keeps its current
   settings. The existing action list only lists repeaters whose settings
   *change*, so an unmatched node is currently indistinguishable from an
   absent one. The profile summary must therefore carry an explicit
   **"No profile"** row, drillable like any other, and the per-repeater
   views must account for **every** loaded repeater. The profile counts
   summing to the loaded repeater count is the check that nothing was
   quietly dropped — worth asserting in a test.
2. **Approximated tiers.** MeshSydney keys on elevation *and* neighbour
   count, which `RuleCondition` still can't AND together (same gap
   `policytune.go:184-191` documents for `hub-and-spoke`). Where a tier is
   matched on only half its real criteria, label it as approximate in the
   UI — e.g. `CRITICAL (approx: altitude only)` — following the naming
   precedent phase 2 already set. Do not let an approximated classification
   read as the real method's own verdict.

### Tests

- `AssignPolicy` returns matching indices in application order.
- A node matching no rule returns an empty `MatchedRules`.
- A node matching both a global rule and a tier rule reports both.
- Playwright: running a tiered method shows a profile summary whose
  per-profile counts **sum to the loaded repeater count** (the
  nothing-silently-dropped check), including the "No profile" row.
- Playwright: clicking a profile drills into a named repeater list, and
  the back button returns to the summary — same navigation contract as the
  packet inspector's own drill-down.
- Assert profile labels render as words; no test should depend on a colour
  class for identifying a tier.

---

## Work item 7 — retire the JS rule-engine mirror (recommended, not required)

Work items 1, 2, 3 and 6 each add a *second* place the same logic lives:
`ruleMatchesAttrs`/`applyRule`/`applyPolicyToNodeState`
(`simulator.js:2858-2983`) mirror `rules.go`, `computeRankings`
(`simulator.js:2306`) would mirror the new `PerNodeStats`, and work item
6's tier column needs the same matching logic a third time unless
`AssignPolicy` is exposed directly. Every one is a drift risk, and phase 3
was caused by exactly this class of problem (a frontend model that didn't
match the real one).

`README.md`'s "WASM shared core" section states the project's own rule:
domain logic goes through the shared Go/WASM module; only I/O stays JS.
The rule engine is domain logic.

Expose `applyPolicyToScenario`, `PerNodeStats` and `AssignPolicy` over the
existing WASM bridge and delete the JS copies. Do this **before** work
items 1-3 and 6 if scheduling allows — it's cheaper than porting the new
scaling, per-node and assignment logic into JS and then deleting it.

Note work item 6 makes this materially more attractive: a Tier column
computed by a JS reimplementation of the match loop could disagree with
the Go engine about which tier a repeater is in, which is exactly the kind
of quietly-wrong output this phase is otherwise trying to avoid.

---

## Test plan

**Go**
- `RuleScale` interpolation: at/below min, at/above max, midpoint, and
  `AtMin == AtMax` (no divide-by-zero).
- `ConditionNodeIndexIn` matches only listed indices; empty list matches
  nothing (not everything — assert this explicitly, it's the dangerous
  default).
- A single-rule `ConfigPolicy` still behaves identically to
  `applyRuleToScenario` — the existing guarantee
  (`policytune_test.go`'s `TestApplyPolicyToScenarioSingleRuleMatchesApplyRuleToScenario`)
  must survive `ApplyWithAttrs`.
- `PerNodeStats` against a hand-built scenario with known
  collision/redundant-relay outcomes; specifically assert a relay whose
  every listener already had the packet counts as redundant.
- Optimizer: deterministic for a fixed seed; never returns a policy worse
  than its own baseline; respects the iteration budget; `OptimizeStep`
  round-trips its state without changing the trajectory (chunked and
  unchunked runs converge identically).
- Optimizer rejects a contention improvement that costs delivery — the
  direct regression test for the phase-2 wrong-objective finding.
- Every built-in `MeshMethod` has a non-empty `Source`.

**Playwright**
- The optimizer runs, reports incremental progress, and Cancel actually
  stops it (assert progress *stops advancing* after cancel, not just that
  the button flips).
- A per-node deviation appears in the action list with its repeater's real
  label, not a bare index.
- Held-out validation figures render alongside the search figures.

---

## Work item 8 — reproduce the #2053 "zero delays win" result, and explain the gap

Standalone investigation, independent of the features above. Worth doing
**early** — if HopReach reproduces a known-wrong result, that's a finding
about HopReach, and better learned before an optimizer is built on top of
it. (In practice this ran after work item 4 shipped, not before — the
optimizer was requested first. Recorded as a known ordering deviation
from the plan's own advice, not silently glossed over. The optimizer's own
delivery-first acceptance gate is a partial mitigation either way: even if
this experiment below had come out the "wrong" way, the optimizer can
never be TRICKED into recommending zero delays by a false collision-rate
improvement, because it never optimizes for collision rate at all.)

### Pre-registered prediction (written 2026-07-25, before running anything below)

HopReach models five mechanisms that all penalise transmitting SOONER —
half-duplex `tx_busy`, CAD deferral, the duty-cycle budget, the capture
effect's own margin requirement, and path-byte airtime. Prediction: as
`txDelayFactor`/`rxDelayBase`/`directTxDelayFactor` sweep toward zero,
`DeliveryRatio` should **plateau or decline** relative to a moderate
non-zero baseline in **dense** topologies (multiple relays racing to zero
delay collide with each other more — the same "thundering herd" dynamic
already exploited to find the three optimizer bugs above, on
`lockstepCollisionScenario`). In **sparse** topologies with little
contention to begin with, the effect should be much smaller or absent —
nothing to collide with, so backing off buys little.

So: **zero delays should lose or tie in dense/medium topologies**, ideally
matching the field result's direction (worse, not better) — that is the
"consistent with reality" outcome. If zero delays win outright, uniformly
across topologies, that reproduces stachuman's own result and is a defect
signal about this simulator requiring investigation before trusting the
optimizer's own recommendations (see the acceptance-gate mitigation note
above — it limits, but doesn't eliminate, the consequences of that).

### The claim under test

In [discussion #2053](https://github.com/meshcore-dev/MeshCore/discussions/2053),
stachuman swept 42,768 delay-parameter combinations across sparse, medium
and dense topologies and concluded **zero delays performed best**.
KPrivitt then field-tested zero delays on a real repeater at Pacific Beach
and error rates got **worse**: 45.7% → 50%. Maintainers declined an
auto-tuning PR pending better evidence. Unresolved.

HopReach models at least five mechanisms a simpler collision model
plausibly omits, each added because firmware source said so:

| Mechanism | Where | Phase |
|---|---|---|
| Half-duplex `tx_busy` | `engine.go:703` | 2 (item 13) |
| CAD / channel-busy deferral | `engine.go:634` | 1 |
| Duty-cycle budget | `engine.go:625` | 1 |
| LoRa capture effect | `engine.go:739` | 1 |
| Path bytes in airtime | `engine.go:652`, `:807` | 3 |

Every one of these *penalises transmitting sooner*, so it's a plausible
hypothesis that a model lacking them would find zero delays optimal. That's
a hypothesis, not a conclusion — the point of this work item is to test it,
including the possibility that it's wrong.

### Step 1 — reproduce

Sweep `txDelayFactor`/`rxDelayBase`/`directTxDelayFactor` down to zero
across sparse, medium and dense topologies, ranking by `DeliveryRatio`.
The existing stress-test harness already generates load and sweeps; this
is close to `StressTest` with delay as the swept axis instead of offered
load.

Two honesty constraints:

- **We cannot exactly replicate stachuman's method.** Their topologies,
  metric and parameter ranges aren't stated in the thread. Report this as
  "an independent sweep of the same question," never "a replication."
- **Pre-register the prediction.** Write down, before running, what each
  outcome would mean. Otherwise whatever comes out gets rationalised as
  confirming whichever model we already prefer.
  - Zero delays lose in HopReach → consistent with the field result;
    proceed to step 2 to find out which mechanism is responsible.
  - Zero delays win in HopReach too → we reproduce a result reality
    contradicted. That's a **defect signal about this simulator**, and
    work item 4's optimizer must not ship until it's understood.

### Step 2 — ablation

If zero delays lose, find out why: disable each mechanism in turn and
re-run. Whichever one flips the result is the explanation.

This needs ablation toggles, which don't exist. Add them additively — `Run`
has four non-test callers (`policytune.go:307`, `tune.go:184`,
`stress.go:99`, `wasm/meshsim.go:41`) and 39 test call sites, so do **not**
change its signature:

```go
// All fields default false = mechanism ENABLED, so the zero value is
// current behaviour and every existing caller is unaffected.
type AblationFlags struct {
    DisableTxBusy        bool
    DisableCAD           bool
    DisableDutyCycle     bool
    DisableCapture       bool
    DisablePathByteAirtime bool
}

func RunWithAblation(scenario Scenario, messages []Message, rng RNG, maxSimTimeMs uint32, ab AblationFlags) Report
func Run(...) Report // unchanged wrapper: RunWithAblation(..., AblationFlags{})
```

Same additive discipline as `applyPolicyToScenario`. A test must assert
`Run` and `RunWithAblation` with a zero-value `AblationFlags` produce
byte-identical reports for a fixed seed.

These flags are a **research instrument, not a user setting** — don't
expose them in the main UI, or someone will disable half-duplex and get
confidently wrong answers. A debug-only surface at most.

### Step 3 — compare to the field data, carefully

KPrivitt's Pacific Beach observation is the only real-world anchor here,
and it is weak evidence: one repeater, one before/after comparison, 45.7%
→ 50%, no stated sample size, duration, or error bars. A 4.3-point
difference at one site could easily be noise or a confounder.

Also, **the metrics don't line up.** "Error rate" at a repeater is not
`DeliveryRatio` or `CollisionRate`. Either establish a defensible mapping
or state plainly that we're comparing directions of change, not magnitudes.

So: treat it as a directional sanity check — does delivery get worse with
zero delays, yes or no — and don't claim to have quantitatively matched a
field measurement. Overclaiming here would be the same failure mode as the
thing we're investigating.

### Step 4 — write it up

Record the result in this document either way, including if it's
unflattering. If the findings are solid they're worth contributing back to
#2053 — the thread is unresolved and a mechanism-level explanation would
be genuinely useful to the community. Contribute with the caveats intact
(simulated, our own topologies, not a replication); don't present it as
settling the question.

A useful side effect regardless of outcome: this is the first end-to-end
check of whether phases 1-3's correctness work actually changes conclusions
in practice, rather than just being more faithful in principle.

### What was actually found (run 2026-07-25)

`AblationFlags`/`RunWithAblation` (`internal/meshsim/engine.go`) and the
sweep itself (`internal/meshsim/zerodelay_experiment_test.go`,
`TestZeroDelayExperiment`/`TestZeroDelayExperimentAblation`) are real, not
sketched — run them yourself with
`go test ./internal/meshsim/ -run TestZeroDelayExperiment -v`. Three
topologies (sparse: a 6-node chain; medium: 4-way fan-in through two
listeners; dense: 7-way fan-in, the same "many relays race the same
audience" shape as `lockstepCollisionScenario`, just bigger), delay swept
0/0.25/0.5/1.0 across `TxDelayFactor`/`DirectTxDelayFactor` together
(`RxDelayBase` left at firmware's own 0/off throughout), 25 trials per
point, checked stable across two different seed bases before being
recorded here.

**Sweep (Step 1) — DeliveryRatio at each delay level:**

| Topology | delay=0 | delay=0.25 | delay=0.5 | delay=1.0 |
|---|---|---|---|---|
| Sparse (6-chain) | 1.000 | 1.000 | 1.000 | 1.000 |
| Medium (4-way fan-in) | 0.800 | 0.800 | 0.848–0.872 | 0.960 |
| Dense (7-way fan-in) | 0.875 | 0.875 | 0.880 | 0.915–0.940 |

**Result: the pre-registered prediction held.** Zero delays never win in
this sweep — they tie or lose in every topology with real contention, and
delivery rises monotonically as delay increases toward 1.0. Sparse shows
no effect at all (predicted: nothing to collide with, so backing off buys
nothing) — a ceiling effect, not evidence either way. **HopReach does
NOT reproduce stachuman's "zero delays win" result**, and the direction
(zero delays worse) is consistent with KPrivitt's own field observation,
for whatever that weak a data point is worth (see Step 3's own caveats,
unchanged — this is a directional match, not a magnitude match, and
45.7%→50% "error rate" was never mapped onto `DeliveryRatio`/
`CollisionRate` in any principled way).

One honest surprise worth recording rather than smoothing over: the
**medium** topology showed a LARGER zero-vs-full-delay gap (0.800→0.960,
16 points) than the **dense** one (0.875→0.915–0.940, 4–7 points) — the
opposite of what "more contention should show a bigger effect" would
predict going in. Not investigated further here; a plausible-but-unverified
guess is that dense's 7-way fan-in is contention-saturated even at
delay=1.0 (still leaves real collisions on the table, per the table above),
so there's less headroom left for a zero-vs-nonzero comparison to show —
but this is speculation, not a finding, and is flagged as such.

**Result (Step 2, ablation) — genuinely the most interesting finding, and
not the one predicted.** On the dense topology, "zero delays lose" held
**identically under every single ablation variant** — disabling
`TxBusy`, `CAD`, `DutyCycle`, `Capture`, or `PathByteAirtime` INDIVIDUALLY
never flipped the result, and barely moved the delivery numbers at all
(only `CollisionRate` shifted noticeably, and only for `DisableCAD`):

| Variant | delay=0 delivery | delay=1.0 delivery |
|---|---|---|
| Full model | 0.875 | 0.920–0.940 |
| DisableTxBusy | 0.875 | 0.920–0.940 |
| DisableCAD | 0.875 | 0.920–0.940 |
| DisableDutyCycle | 0.875 | 0.920–0.940 |
| DisableCapture | 0.875 | 0.920–0.940 |
| DisablePathByteAirtime | 0.875 | 0.920–0.940 |

**None of the five phase-1/2/3 mechanisms individually explain the
effect in this topology.** The pre-registered hypothesis — "one of these
five is why zero delays lose here" — is **not supported** by single-flag
ablation. The most likely explanation, not tested further here: the
effect comes from `RetransmitDelayMs`'s own randomized backoff
(`delay.go`) spreading relay transmissions out in time as `txDelayFactor`
rises — a mechanism that predates phases 1–3 entirely (it's the most
basic form of collision avoidance a flood simulator could have, and was
already present when this project started) and that none of these five
ablation flags touch or disable. That would mean the field-consistent
result observed here isn't actually attributable to this project's own
correctness work — it may have been present in whatever simpler model
stachuman used too, if theirs modeled randomized backoff at all (unknown
— their own methodology isn't public).

**What this changes about the optimizer (work item 4):** nothing
structurally — its delivery-first acceptance gate was never contingent on
which mechanism explains collision behaviour, only on measuring delivery
directly. But it does mean "the optimizer's recommendations are more
trustworthy because of phases 1–3's modeling work" is NOT a claim this
experiment can back up; the honest claim is narrower: HopReach's
directional answer (delay helps) agrees with the one real field
observation available, for reasons not fully pinned down here.

**Scope limits, stated plainly:** only single-flag ablation was tested,
never combinations (a pairwise or full 2^5 sweep might surface an
interaction effect no individual flag shows) — a real limitation of this
pass, not a finding that combinations don't matter. Only one dense
topology shape was tested for ablation (the sweep's own three topologies
weren't each re-run under every ablation variant). Three trial-generating
topologies is a small sample of "sparse/medium/dense" as a concept, built
to be illustrative, not to span the space MeshCore's own real deployments
actually occupy.

**Worth contributing back to #2053**, with every caveat above intact —
an independent simulator, built with different assumptions and a
different (undisclosed-vs-theirs) topology set, reaches the opposite
directional conclusion from stachuman's own sweep and agrees directionally
with KPrivitt's field result, but cannot attribute why via the five
mechanisms this project happens to model. That's a genuinely useful data
point for that unresolved thread — not a settled answer, and should not
be presented as one.

---

## Risks and things not to do

- **Don't rank by contention.** Delivery-first, always. This is phase 2's
  most expensive lesson; `SIMULATOR_PLAN_PHASE2.md:94-101` has the numbers.
- **Don't expose ablation flags as a user setting.** Research instrument
  only — see work item 8.
- **Don't encode profile identity as a colour.** Word labels, always —
  colour is already spent on propagation margin and reception outcome, and
  a tier you can't read out or paste isn't a usable answer.
- **Don't call work item 8 a replication.** stachuman's topologies, metric
  and ranges aren't documented; it's an independent sweep of the same
  question.
- **Don't touch `Suggest`/`applyRuleToScenario`/`ConfigRule.Apply`.** The
  legacy "Predict settings" path and its tests depend on them being exactly
  as they are — the same additive discipline phase 2 used for
  `applyPolicyToScenario`. Add new methods; don't change old signatures.
- **Don't let `ConditionNodeIndexIn` policies escape their scenario.**
  Indices are meaningless against a different node list. Resolve to labels
  for display; refuse to apply on mismatch.
- **Don't encode a community method from a search summary.** Fetch the
  primary source. Search summaries described MeshSydney's method backwards
  twice — see work item 5's accuracy warning.
- **Don't add a `MeshMethod` without a `Source`.** Enforced by test.
- **Don't treat "zero/minimal delays win" as a discovery.** Another
  MeshCore simulator reached that conclusion and field testing contradicted
  it (discussion #2053). If our optimizer trends there, investigate before
  believing it.
- **Don't ship an optimizer that can't be stopped.** Cancellation is a
  correctness requirement here, not polish — see the `self.onmessage`
  constraint above.
- **Don't report search-set delivery as if it were validated.** Hold-out
  numbers, shown honestly, or the tool is confidently wrong.
