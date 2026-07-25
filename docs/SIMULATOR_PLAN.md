# MeshCore flood simulator — correctness fixes and feature plan

Working document. Everything here was verified against the real MeshCore
firmware source (`github.com/meshcore-dev/MeshCore`, cloned to `/tmp/mc-src`
during planning — re-clone if it's gone) and against measured runs of our own
engine. File/line references to the firmware are from that clone.

**Ground rules for this work**

- Everything stays **local and uncommitted** unless the user explicitly says
  otherwise. Do not commit, push, tag or deploy without being told.
- Go verification sweep after every Go change:
  `gofmt -l . && go build ./... && go vet ./... && ~/go/bin/staticcheck ./... && go test ./...`
  plus `GOOS=js GOARCH=wasm go build -o /tmp/hopreach_check.wasm ./wasm`
- Frontend verification after every JS/HTML/CSS change: rebuild the image
  (`public/*` is baked in, **not** volume-mounted) then run the suite:
  `docker compose build hopreach && docker compose up -d hopreach && timeout 280 npx playwright test --workers=1`
- **This codebase has no generic `.hidden { display: none }` rule.** Every
  hidden element needs its own scoped rule in `style.css`. Silently-broken
  toggles have shipped twice from forgetting this.
- Leaflet swallows the first click on a freshly shown/resized map. Use the
  existing `clickUntilVisible` / `clickMapUntilNodeCount` helpers in
  `tests/simulator.spec.js` for any marker interaction, or CI will flake.

---

## Measured baseline (before any fix)

Reproduced with throwaway tests against the current engine. Reproduce these
numbers first so you can prove the fixes moved them.

| Scenario | Receptions | Collided | Last activity |
|---|---|---|---|
| 73 nodes fully-connected, 3 msgs | 5,256 | 4,823 (91.8%) | 6.7 s |
| 9×8 grid (72 nodes), 3 msgs | 989 | 533 (53.9%) | 16.8 s |
| 9×8 grid, **single** packet | 444 | — | 14.9 s (last relay 13.1 s) |

In the grid run, packet #0 reached only **42 of 72** nodes cleanly, there were
**556** CAD deferrals, and the nominal hop-limited flood time is ~11 s — so the
tail runs ~35% past what the hop limit alone explains.

---

## 1. Packet dedup — the root cause

**Symptom the user reported:** a reception shows "Dropped by loop detection",
and then the packet propagates onward from that same repeater anyway. Loop
detect appears not to work.

**Firmware truth.** `SimpleMeshTables::hasSeen()`
(`src/helpers/SimpleMeshTables.h:34`) is *mark-and-test*: it hashes the packet,
scans a 160-entry cyclic table, and if absent **inserts it and returns false**.
First sight → false (may relay). Every later copy → true (dropped). It's called
on receipt throughout `Mesh.cpp` (lines 92, 99, 120, 137, 196, 223, 254, 281,
356) and after sending (636, 665, 698, 708, 721 — "mark this packet as already
sent in case it is rebroadcast back to us").

`Packet::calculatePacketHash()` (`src/Packet.cpp:41`) hashes **payload type +
payload only — deliberately not the path** (TRACE packets are the sole
exception, explicitly commented as a caveat). So every copy of a flood packet
hashes identically regardless of the route it arrived by.

**Our bug.** `engine.go` tracks only `relayed[packetID][node]`, set *exclusively
when a node actually relays* (`engine.go` ~line 478, plus ~406 for the origin).
A node that received a packet but didn't relay — loop_detect, collided,
hop_limit, region_mismatch — is never marked. When another copy arrives via a
different path, the loop-detect check passes (that path doesn't contain its
hash) and **it relays anyway**. Loop detection is effectively defeated, and the
late re-relays keep resurrecting the flood, which is most of the long tail.

**Fix.**

- Add `seen := make(map[int]map[int]bool)` alongside `relayed`.
- Mark `seen[packetID][node]` on the first **successfully decoded** reception,
  regardless of what happens afterwards.
- Check it in the relay-eligibility switch *before* the loop-detect / hop-limit
  / region checks.
- Keep `relayed` purely for reporting (`Reception.WasRelayed`).
- Rename drop reason `already_relayed` → `already_seen` (update
  `DROP_REASON_LABELS` and `DROP_REASON_DETAILS` in `simulator.js`, and the
  outcome filter in `matchesOutcomeFilter`).

**Ordering matters — what counts as "decoded":**

- `collided` → **not** decoded → must **not** mark seen.
- `weak_signal` (below `snrThresholdForSF`) → **not** decoded → must **not**
  mark seen.
- Everything else (including `cannot_relay`, `region_mismatch`, `loop_detect`,
  `hop_limit`) → decoded → **marks seen**.

So the switch becomes: `weak_signal` → *(mark seen)* → `cannot_relay` →
`already_seen` → hop limits → `region_mismatch` → `loop_detect` → relay.

**Tests** (`internal/meshsim/engine_test.go`):
- A node that drops a packet for `loop_detect` never relays a later copy of the
  same packet arriving by a different path. This is the direct regression test
  for the reported bug.
- Same for a node that dropped on `hop_limit` and on `region_mismatch`.
- A node whose only earlier copy **collided** *does* still relay a later clean
  copy (collided was never decoded, so it isn't "seen").
- Existing `TestRunRelaysOnlyOnce` should still pass with the reason renamed.

---

## 2. Airtime — preamble length

**Firmware truth.** `RadioLibWrapper::preambleLengthForSF()`
(`src/helpers/radiolib/RadioLibWrappers.h:47`):

```cpp
static uint16_t preambleLengthForSF(uint8_t sf) { return sf <= 8 ? 32 : 16; }
```

**Our bug.** `DefaultLoRaParams()` in `internal/meshsim/airtime.go` hardcodes
`PreambleSymbols: 8` for every SF. Under the new SF8 default (item 4) the real
value is **32** — a 4× error. Airtime feeds collision windows, CAD, and every
relay delay, so this skews everything downstream.

**Fix.** Derive the preamble from SF rather than storing a fixed 8: 32 symbols
for SF≤8, 16 for SF>8. Keep the field so a caller can still override it
explicitly, but default it from SF. Update `TestAirtimeMsMatchesHandComputedExample`
— recompute the expected value by hand rather than pasting whatever the code
now returns, or the test stops being independent evidence.

**Re-measure the baseline table after items 1+2 and report before/after.**

---

## 3. LoRa capture effect

**Our bug.** `engine.go` treats *any* time-overlap of two audible transmissions
as mutual destruction (the `collidedWith` loop, ~line 419). Real LoRa has a
strong capture effect: CSS modulation rejects a weaker co-channel interferer, so
the stronger signal decodes fine.

**Fix.** Compare signal strengths instead of assuming mutual loss:

- If the wanted signal exceeds the strongest interferer by the co-channel
  rejection margin (**~6 dB** for same-SF LoRa), it is **captured** — decoded
  successfully, not collided.
- Otherwise both are lost, as today.
- Additionally distinguish an interferer that arrives during preamble/sync
  acquisition (fatal — the receiver never locks) from one arriving mid-payload
  after lock (survivable given adequate margin). Use the preamble length from
  item 2 for that window.
- Different SFs are quasi-orthogonal; if we ever simulate mixed SFs, non-equal
  SF should not collide at all. Currently all nodes share one radio config, so
  this is a guard for item 4 rather than a live case.

Make the margin a named constant with a comment citing the ~6 dB figure so it's
tunable and its provenance is clear.

**Reporting.** Add a distinct outcome so the inspector can show "captured
(survived interference)" separately from "collided" — new value in
`receptionOutcome()` in `simulator.js` plus its own `.sim-reason-*` colour.

**Re-measure and report.** Expect the 91.8% dense-mesh collision rate to drop
substantially. If it doesn't, stop and investigate before proceeding.

---

## 10. Modal redesign (do this before items 4/5/6)

Sequenced here deliberately: items 4–6 add many columns and controls to these
same modals. Build the structure first, don't retrofit twice.

**Current problems.** Widths are ad-hoc per ID (560 default, `#sim-nodes-modal`
900, `#sim-packet-modal` 920). Summaries are run-on sentences
(`0 sent · 30 received · 1 relayed onward · 27 collided · 2 dropped.`) where the
number that matters has no more weight than the rest. Rows are visually uniform
and repeat a redundant prefix on every line. Header, toolbar and footer scroll
away with the content. Empty state is a bare "Nothing to show." **There is no
keyboard or screen-reader support anywhere** — no Escape handler, no
`role="dialog"`, no focus management. The reception log renders unbounded (5,256
rows measured), each a multi-span node.

**A. Shared shell.** Replace per-ID widths with a size scale
(`--modal-sm: 560px`, `--modal-md: 760px`, `--modal-lg: 1040px`) applied via a
class (`.sim-modal--lg`). `.sim-modal` is already flex-column: make the header,
toolbar/filter row and footer `position: sticky`, and confine `overflow-y: auto`
to the body so only the list scrolls.

**B. Accessibility.** `role="dialog"`, `aria-modal="true"`, `aria-labelledby`
pointing at the title. Escape pops `packetModalHistory` if non-empty, else
closes (document the choice in a comment). Trap focus; move focus in on open,
restore to the triggering element on close.

**C. Stat strip.** Replace the run-on summary with discrete labelled figures plus
a proportion bar, so "27 of 30 collided" reads instantly. Tint the problem stat
past a threshold. Reuse the existing `.sim-reason-*` colour tokens.

**D. Row scannability.** Drop the repeated prefix; lead with what differs.
Right-align a monospace time column. Group consecutive rows under a subtle
sticky sub-header (by packet, or by second). Single line at wide widths, second
line only when a path is present. Hover/zebra tracking.

**E. Long lists.** Cap initial render (~200 rows) with a "Show all N" control, or
window it. Applies to `renderNodeActivityRows`, `renderReceptionLogInto`, and
the bottleneck lists.

**F. Empty/loading states.** One shared component: what's empty, why, and the
action that would populate it.

**G. Per-modal.**
- `#sim-nodes-modal` — sticky header row **and** sticky first column (node
  label); group the new radio columns under a collapsible "Radio" group.
- `#sim-packet-modal` — stat strip + grouped rows; TX/RX badge stays leading.
- `#sim-results-modal` — "Sent messages" / "Reception log" become tabs.
- `#sim-bottleneck-modal` — tabs for the two comparison lists; replay controls
  in the sticky toolbar.
- `#sim-predictions-modal` — per-node results as a table matching the nodes
  modal, not a plain list.

**Where things live.** Markup: `public/index.html`, inside
`#sim-modal-backdrop`. Rendering: `public/simulator.js` —
`renderNodeActivityRows`, `renderPacketChecklist`, `renderReceptionLogInto`,
`renderNodesModalTable`, `renderBottleneckAnalysis`. Styles:
`public/style.css` from ~line 1122.

---

## 4. Radio presets, with manual override

**Source of truth:** `https://api.meshcore.nz/api/v1/config` →
`config.suggested_radio_settings.entries` — the live list the official MeshCore
app uses (20 entries as of this writing). Also documented at
`https://forum.letsmesh.net/t/meshcore-radio-setting-presets/67`.

**Bake the list in** rather than fetching at runtime — no CORS/proxy dependency,
works offline. Put the source URL in a comment so it can be refreshed.

Key entries:

| Preset | Freq MHz | SF | BW kHz | CR |
|---|---|---|---|---|
| **EU/UK (Narrow)** ← **new default** | 869.618 | 8 | 62.5 | 8 |
| EU/UK (Deprecated) ← *our current default* | 869.525 | 11 | 250 | 5 |
| USA/Canada (Recommended) | 910.525 | 7 | 62.5 | 5 |
| Australia | 915.800 | 10 | 250 | 5 |
| New Zealand | 917.375 | 11 | 250 | 5 |
| EU 433MHz (Long Range) | 433.650 | 11 | 250 | 5 |

(Full 20 available from the API; include them all.)

**Note:** our current default is the one the upstream list now labels
*Deprecated*. Switching the default to EU/UK (Narrow) halves the symbol time
(SF8/BW62.5 = 4.096 ms vs SF11/BW250 = 8.192 ms), which materially shortens
airtime and reduces collisions on its own. Expect the baseline numbers to move
again — measure and report.

**UI.** Preset dropdown in `#sim-nodes-modal` (and the bulk-apply row).
Selecting a preset fills frequency / bandwidth / SF / coding rate. Each field
stays individually editable; editing any of them flips the dropdown to
"Custom". Thread through `LoRaParams` (already has `FreqMHz`, `BWkHz`, `SF`,
`CR`) → `scenarioFromState()` → engine.

---

## 5. Three hop limits, per node

**Firmware truth** (`examples/simple_repeater/MyMesh.cpp:432-434`):

```cpp
if (packet->getPathHashCount() >= _prefs.flood_max) return false;
if (packet->getRouteType() == ROUTE_TYPE_FLOOD && packet->getPathHashCount() >= _prefs.flood_max_unscoped) return false;
if (packet->getPayloadType() == PAYLOAD_TYPE_ADVERT && packet->getPathHashCount() >= _prefs.flood_max_advert) return false;
```

Defaults (`MyMesh.cpp:892-894`): **`flood_max = 64`, `flood_max_unscoped = 64`,
`flood_max_advert = 8`**. CLI settings are `flood.max`, `flood.max.unscoped`,
`flood.max.advert`. They are checked **cumulatively** — the effective limit is
the minimum of whichever apply.

**Our bug.** A single package const `MaxHopCount = 8` (`engine.go:234`) collapses
all three, and 8 is only the *advert* default — so we're 8× too strict for
ordinary traffic.

**Fix.** Per-node `FloodMax` / `FloodMaxUnscoped` / `FloodMaxAdvert` on
`SimNode`, defaulting to **64 / 64 / 8** (user has approved taking the firmware
values). Zero/unset falls back to those defaults. Apply cumulatively. Expose all
three in the settings table + bulk-apply. Keep the `hop_limit` drop reason but
make the inspector say *which* limit was hit.

**This changes results** — floods will propagate further than today. That's the
point (we were wrong before), but call it out when reporting numbers, and update
`TestRunRespectsHopLimit` (it currently assumes a ring hits the limit at 8).

---

## 6. Observed scopes and observed-unscoped

**The concept.** Scopes are *observed*, not inferred — every entry comes from an
HMAC transport-code verification, which is either right or it isn't (see
`ObservedScopes`' doc comment in `internal/corescope/scope.go:318`). These
observations tell us **what each repeater actually allows**, and the simulator
should use them so that sending e.g. a `#fif` message shows where it really
reaches — then let the user vary it (add a region to one repeater, remove
`#sco` from another, enable unscoped) to model changes.

**Already wired, end to end** — verify, don't rebuild:
`repeaters.geojson:inferred_scopes` → `planner.js:639` (unions with
`default_scope`) → `simulator.js:261` (`regions:` on the sim node) →
`simulator.js:1071` (into the scenario) → `engine.go:448`
(`acceptsRegion(tx.region)` gates the relay). Same source
`repeaterInScope()` uses for scope coverage.

**6a. Extend observation to unscoped traffic.** `decodePacketRegion` only handles
route types 0 (`routeTypeTransportFlood`) and 3 (`routeTypeTransportDirect`) —
see `scope.go:47`, which notes every other route type "carries no per-packet
region information at all." Plain floods are walked past and discarded, so we
currently **cannot tell whether a repeater relays unscoped traffic**.

Extend the same `/api/packets` walk in `FetchRegionParticipation` (`scope.go:212`)
to also tally repeaters appearing in the relay path of **plain (non-transport)
flood** packets. Emit a per-repeater `observed_unscoped` boolean alongside the
scopes, through `output.go` into `repeaters.geojson`, then into the sim node.

**6b. Derive the allow-unscoped default.** If a repeater has never been observed
relaying unscoped traffic in the window, default it to **unscoped disabled** —
the user's rule, and a sound default. **Label it in the UI as derived by
absence**, not asserted like the scopes are: a scoped-only repeater and a merely
quiet one look identical over a short window. Widening
`scope_observation.window_hours` tightens the inference.

**6c. Engine.** `acceptsRegion("")` currently hardcodes `true`. Add a per-node
`AllowUnscoped` (default true — matching firmware, where regions are *additive*:
holding region keys lets a repeater relay *extra* scoped traffic, it doesn't stop
it relaying ordinary unscoped floods). The toggle is a simulator what-if knob,
not a claim about firmware defaults.

**6d. UI.** Scopes column in `#sim-nodes-modal` as a comma-delimited list
**without the `#`** (`sco, ioi, edi`), editable. Allow-unscoped toggle.

**6e. Predict-settings** consumes observed scopes and observed-unscoped as
inputs, and its per-node recommendation covers region/unscoped config alongside
delay tuning — a complete "set this on this repeater" answer.

**Real bug to fix here.** `loadPlannedRepeaters` and `addCompanionAt` in
`simulator.js` never set `regions` (only the `"real"` branch at line 261 does).
So a **planned** repeater gets `regions: []`, and `acceptsRegion("#sco")` returns
false — planned repeaters **silently drop every scoped message**. Anyone testing
a planned site against `#sco` traffic gets a dead node with no explanation.
Companions are unaffected in practice because `cannot_relay` short-circuits
first. Fix: planned repeaters default to accepting all scopes; ensure the drop is
visible as `region_mismatch` in the inspector either way.

---

## 11. Rename "inferred" → "observed"

The data is cryptographically confirmed, not inferred. `ObservedScopes` in
`internal/corescope` is already named correctly; the misnomer leaked outward into
11 files (`cmd/hopreach/run.go` ×16, `public/app.js` ×9,
`cmd/hopreach/output.go` ×7, `cmd/hopreach/config.go` ×5, `README.md` ×4,
`tests/basic.spec.js` ×3, `public/planner.js` ×2,
`internal/config/config{,_test}.go` ×4, `config.example.yaml` ×2,
`internal/meshsim/engine.go` ×1).

**Rename freely** (internal, no external consumer): `inferRepeaterScopes` →
`observeRepeaterScopes`, the `inferredScopes` locals, the `scopeInference*`
`appConfig` fields, and the `inferring_scopes` progress stage — verified that
stage string is **not** matched anywhere in `public/` or `tests/`.

**Needs a compatibility window — do not rename blind:**

- **GeoJSON `inferred_scopes`** is a published property read by `app.js:223`,
  `app.js:416` and `planner.js:639`, and there is **live data on disk in
  production** carrying that key. Dual-write `observed_scopes` alongside
  `inferred_scopes` for one release; frontend reads `observed_scopes ??
  inferred_scopes`. Drop the alias a release later.
- **Config key `corescope.scope_inference`** is in the **deployed**
  `/etc/hopreach/config.yaml`. Renaming it blind makes production fall back to
  the `enabled: false` zero value and silently lose scope coverage — the exact
  bug just fixed. Accept both `scope_observation` (new) and `scope_inference`
  (deprecated alias) in `internal/config`, prefer the new, log a deprecation
  notice for the old. Update production's config **as part of** that deploy,
  never before it.

---

## 7. Direct (routed) messages

`DirectRetransmitDelayMs` and `NodePrefs.DirectTxDelayFactor` are already ported
and tested but **unused** — nothing calls them. Model `isRouteDirect()`: a packet
addressed to a specific next hop rather than flooded, using the direct delay path
(firmware default factor 0.3 vs flood's 0.5, since far fewer nodes contend).

Add a route type to `Message` and a selector per message generator in
`#sim-messages-modal`. Note `flood_max_unscoped` only gates `ROUTE_TYPE_FLOOD`,
so direct traffic bypasses that particular limit (item 5).

---

## 8. CoreScope replay window

`replayFromHash` in `simulator.js` hardcodes `REAL_TIMELINE_WINDOW_MS = 30_000`.
Make it a control in the replay section accepting **up to ±120 s**. Note
`fetchPacketsAroundTime` grows its page size until it covers the window, capped
by `REAL_TIMELINE_MAX_LIMIT = 4800`; a 120 s window on a busy mesh may hit that
cap, so surface partial coverage in the status line rather than silently
truncating.

---

## 9. Airtime duty-cycle budget (last, isolated)

**Firmware truth.** `Dispatcher::updateTxBudget()` (`src/Dispatcher.cpp`) with
`getAirtimeBudgetFactor()` returning 1.0 → `duty_cycle = 1/(1+1) = 0.5`, i.e. a
**50% duty cycle** per node. `checkSend` refuses to transmit while
`tx_budget_ms < est_airtime / MIN_TX_BUDGET_AIRTIME_DIV` (divisor 2) and defers
until the budget refills. Unmodeled by us entirely.

Do this **last and on its own** so it can't confound the measurements from items
1–3. It will lengthen floods under load, which is correct but will move the
numbers again.

---

## Also noted, not scheduled

- `calcRxDelay` in firmware is `pow(10, 0.85 - score)` — base 10 hardcoded. Our
  `RxDelayMs` takes `rxDelayBase` as a parameter and disables on `<= 0`, which
  matches the firmware's own early return, so this is consistent today. Revisit
  only if a non-zero base is ever exposed in the UI.
- `MAX_PATH_SIZE` is 64 bytes, so with 1-byte hashes the path buffer itself caps
  hops at 64 — consistent with `flood_max = 64` being effectively "no limit
  beyond the buffer".
- CAD is already modeled correctly (`Dispatcher.cpp:288`, 200 ms retry / 4000 ms
  max — our `cadFailRetryDelayMs` / `cadFailMaxDurationMs` match).

---

## Suggested order

1. **1 + 2** (dedup, preamble) → re-measure the baseline table, report before/after
2. **3** (capture effect) → re-measure, report
3. **10** (modal shell) — before the config work lands new columns
4. **4, 5, 6, 11** (presets, hop limits, scopes/unscoped, rename)
5. **7, 8** (direct messages, replay window)
6. **9** (duty cycle) — isolated

Report measured numbers at each of the first two checkpoints before moving on.
If the capture-effect change doesn't move the collision rate materially, stop and
investigate rather than continuing.
