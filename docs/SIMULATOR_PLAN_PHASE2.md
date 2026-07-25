# MeshCore flood simulator — phase 2: relay visibility and collision causes

Follow-on to `docs/SIMULATOR_PLAN.md` (items 1–11, all now built and
verified). Three new items:

- **12.** Show a repeater's own **relay transmission** as a first-class event,
  linked to the reception that caused it, so you can see *when* it sent.
- **13.** Break the single `collided` flag into its **distinct physical
  causes**, so each can be diagnosed and fixed separately.
- **14.** **Declutter the map GUI** — nine floating controls, six stacked in
  one corner, three of which can never be collapsed.
- **15.** **Stress-test-driven tuning** — push load until the network
  saturates, search config policies that maximise *successful delivery*, and
  output per-repeater settings someone can actually apply.
- **16.** **Per-repeater run scoreboard** — duty cycle used, packets received
  x/y, and the "is this repeater earning its airtime" metrics that feed
  item 15's measurement-driven models.

Everything below was verified against the real MeshCore firmware source
(`github.com/meshcore-dev/MeshCore`, cloned to `/tmp/mc-src` — re-clone if
it's gone) and against measured runs of our own engine. Line references to
our own code are current as of this document being written; re-grep if they
have drifted.

**Ground rules (unchanged from phase 1)**

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
- Two tests in `tests/simulator.spec.js` are known-flaky for that Leaflet
  reason (`places a virtual companion location…`, `companion labels never
  repeat…`). If one fails, re-run it in isolation before assuming a
  regression.

---

## Measured baseline (current `main`, after items 1–11)

Reproduce these first so you can prove your own changes moved them. Seeded
`NewSeededRNG(1)`, `maxSimTimeMs=60_000`, 20-byte payloads, SNR 5 dB on
every link, default node prefs.

| Scenario | Receptions | Collided | Relayed | Last activity |
|---|---|---|---|---|
| 73 nodes fully connected, 3 msgs | 5,400 | 4,679 (86.6%) | 72 | 5,692 ms |
| 9×8 grid (72 nodes), 3 msgs | 494 | 217 (43.9%) | 137 | 12,100 ms |
| 9×8 grid, **single** packet | 246 | 96 (39.0%) | 69 | 13,888 ms |

For reference, the pre-phase-1 numbers were 5,256/91.8%/6.7 s, 989/53.9%/16.8 s
and 444/–/14.9 s respectively — the grid's reception count roughly halved
because the dedup fix stopped packets resurrecting on later paths.

**Item 13 will move these substantially** (see its own warning). Re-measure
and report before/after.

**Measured after item 13, part A (half-duplex `tx_busy`), seed 1:**

| Scenario | Receptions | Collided | tx_busy | Relayed | Last activity |
|---|---|---|---|---|---|
| 73 nodes fully connected, 3 msgs | 5,400 | 2,326 (43.1%) | 2,354 (43.6%) | 72 | 5,692 ms |
| 9×8 grid (72 nodes), 3 msgs | 494 | 217 (43.9%) | 0 (0%) | 137 | 12,100 ms |
| 9×8 grid, single packet | 246 | 96 (39.0%) | 0 (0%) | 69 | 13,888 ms |

Exactly as predicted: in the dense scenario the collision rate roughly
halved (86.6% → 43.1%) while `tx_busy` picked up almost exactly the
difference — the failures moved buckets, they didn't vanish. The sparse
grid shows 0% `tx_busy` in both cases, which makes physical sense: a node
only collides with itself when it's *both* transmitting *and* would
otherwise have received something at the same instant, and grid contention
is far lower than the fully-connected case's. Reception/relay counts are
unchanged in every scenario, as expected — this only reclassifies drop
reasons, it doesn't change which events get scheduled.

**Measured after item 15a (`DeliveryRatio`), seed 1 — collision rate vs
actual delivery, side by side:**

| Scenario | Collision rate | Delivery ratio |
|---|---|---|
| 73 nodes fully connected, 3 msgs | 43.1% | **33.3%** |
| 9×8 grid (72 nodes), 3 msgs | 43.9% | **64.3%** |
| 9×8 grid, single packet | 39.0% | **97.2%** |

This is the concrete case for why item 15 exists: the two dense/grid
scenarios have almost identical collision rates (43.1% vs 43.9%) but wildly
different delivery (33.3% vs 64.3%). A tuner optimising collision rate alone
would treat them as equally bad; they aren't even close. The dense
fully-connected topology is a much harder environment — every node
contends with every other node on every send — so its lower delivery
despite a similar collision rate is exactly the signal item 15c's search
needs to be driven by delivery, not collisions, to find real improvements.

---

## 12. Relay transmissions as first-class events

**What the user asked for:** "the repeaters show as RX only and show if it
was relayed… I want to see when it was relayed, so I want to see RX and TX
and show some way of linking them as relayed so I can see specifically when
it sent the packet."

### Why it's missing today

`Report` (`internal/meshsim/engine.go:324`) contains only `Receptions`. The
engine builds a complete `transmission` record for every send
(`engine.go:351` — sender, packetID, `startMs`/`endMs`, payload, region,
direct, CAD/budget deferral flags) but uses it only for collision scanning
and then discards it.

On the JS side `buildTxEvent` (`public/simulator.js:1627`) builds TX rows
only from `lastMessages`, i.e. **origin sends**. A repeater's own
re-transmission has never been a renderable event. `Reception.WasRelayed` is
its only trace — hence "RX only, with a Relayed flag".

### Three findings that shape the design

1. **Scheduled ≠ actual send time.** The relay is scheduled at `relayAt`
   (`engine.go`, in the `default:` branch of the relay-eligibility switch),
   but CAD backoff (200 ms retries) and the duty-cycle budget can both push
   the real airing later. "When it sent the packet" must therefore come from
   the transmission's actual `startMs`, recorded at `eventSend` processing
   time — **not** from `relayAt`. The gap between the two is itself worth
   showing.

2. **`WasRelayed: true` currently over-reports.** It is set when the relay is
   *scheduled*. If `relayAt` lands past `maxSimTimeMs`, the event is dropped
   by the sim-window guard (`if e.atMs > maxSimTimeMs { continue }`) and the
   packet never airs — but the reception still claims it relayed. Exporting
   transmissions makes this visible.

3. **Linking is unambiguous.** `hasSeen` dedup guarantees a node transmits
   any given packet at most once (`markSeen` fires on send; relaying requires
   `!alreadySeen`). So **`(packetId, node)` is a unique key** for
   transmissions — no heuristics needed to pair an RX with its TX.

### Go changes (`internal/meshsim`)

Add to `engine.go`:

```go
// Transmission is one node's own over-the-air send of one packet — the
// origin's first send, or any repeater's relay of it. AtMs is when the
// packet ACTUALLY started airing, after any CAD or duty-cycle deferral,
// not when it was originally scheduled.
type Transmission struct {
    PacketID       int    `json:"packetId"`
    Node           int    `json:"node"`
    AtMs           uint32 `json:"atMs"`
    AirtimeMs      uint32 `json:"airtimeMs"`
    HopCount       int    `json:"hopCount"`
    PayloadLen     int    `json:"payloadLen"`
    Region         string `json:"region,omitempty"`
    Direct         bool   `json:"direct,omitempty"`
    IsRelay        bool   `json:"isRelay,omitempty"`        // false for the origin's own first send
    CADDeferred    bool   `json:"cadDeferred,omitempty"`
    BudgetDeferred bool   `json:"budgetDeferred,omitempty"`
}
```

- Add `Transmissions []Transmission` to `Report`. Initialise it non-nil, for
  the same JSON reason `Receptions` is (`[]` not `null`).
- Add `hopCount int` to the internal `transmission` struct — currently only
  derivable as `len(pathNodes)-1`, which is fragile.
- Populate `report.Transmissions` in the `eventSend` case, right where the
  internal record is appended, so the recorded time is the true airing time.
  `IsRelay` is `e.hopCount > 0` (equivalently `len(e.pathNodes) > 1`).
- **Do not** carry `path`/`pathNodes` on the exported type — the paired
  reception already carries `Path`, and duplicating it doubles the payload
  for nothing.
- Size is a non-issue: transmissions are bounded by nodes × packets (~219 for
  the dense 73-node/3-message case, versus 5,400 receptions).
- `CollisionRate()` (`internal/meshsim/report.go`) and `Suggest`
  (`tune.go:185`) read only `Receptions`, so this is purely additive — no
  tuning behaviour changes.

**Go tests** (`engine_test.go`):
- A relay forced into CAD deferral reports its **actual** air time, not the
  scheduled one (build a scenario where the relayer can hear an ongoing
  transmission at its scheduled relay instant; assert
  `Transmission.AtMs > scheduledRelayAt` and `CADDeferred` is true).
- `(PacketID, Node)` never appears twice in `Transmissions`.
- The origin's own send has `IsRelay: false` and `HopCount: 0`; a
  first-hop relay has `IsRelay: true` and `HopCount: 1`.
- A reception with `WasRelayed: true` whose relay was scheduled past
  `maxSimTimeMs` produces **no** matching `Transmission` (locks in the
  finding-2 behaviour so the UI can rely on it).

### JS changes (`public/simulator.js`)

- Build TX events from `lastReport.transmissions` instead of `lastMessages`,
  so origin sends *and* relays both become rows. Keep the existing `tx` event
  shape (`{kind, atMs, packetId, node, …}`) and add `transmission` alongside
  `message` so `renderNodeActivityRows` can render either. Anchors:
  `buildTxEvent:1627`, `buildNodeActivityEvents:1638`,
  `buildPacketActivityEvents:1656`.
  - Keep reading `lastMessages` for the origin row's own region/payload
    metadata where convenient, but **time must come from the transmission**.
- Badges: keep `TX` for an origin send; add a new `RELAY` badge for
  `isRelay` sends (`.sim-txrx-relay`, alongside `.sim-txrx-tx` /
  `.sim-txrx-rx` at `public/style.css:1030`).
- **On the RX row**, when the reception has a paired transmission, the
  `Relayed` badge becomes `Relayed ⤵ +412ms` — the relay delay
  (`transmission.atMs − reception.atMs`). This is the single most useful
  number that row could carry: it is exactly what `txdelay`/`rxdelay` tuning
  moves, and what predict-settings optimises.
- **On the relay TX row**, show `⤴ relaying what arrived at 1,240ms` plus its
  own airtime.
- **Linking:** give both rows `data-link-key="<packetId>:<node>"`. Hovering
  either highlights both; clicking either scrolls to and briefly flashes its
  partner (reuse the `sim-row-highlight` flash pattern from
  `openNodesModal`).
- **Edge case from finding 2:** a reception with `wasRelayed` but no matching
  transmission must render as `Relayed (scheduled past the end of the sim
  window)` rather than silently implying it aired. Do not drop the row.

### Filters and summary

- `#sim-packet-filter-outcome` (`public/index.html:402`) — split
  `Sent (TX) only` into `Sent — original` and `Sent — relayed`, keeping a
  combined `Sent (any TX)`. Update `matchesOutcomeFilter`
  (`simulator.js:1668`), which currently hard-codes "TX rows only show under
  All outcomes".
- Make the `relayed` filter surface **both** halves of a pair, not just the
  RX row.
- Stat strip (`renderStatStrip:1450`, used by
  `openPacketInspectorForNode:1848`) gains a relay-TX count, and flags any
  scheduled-but-never-aired discrepancy.

---

## 13. Break `collided` into its real causes

**What the user asked for:** "break up collided… there's different types of
collision (such as corruption, was transmitting at the time, etc)… we want
to break these up so we can solve those."

Today every failure mode collapses into one boolean, `Reception.Collided`,
set by `len(collidedWith) > 0` (`engine.go:572-590`). That makes a
collision-heavy run undiagnosable: you cannot tell a fixable timing problem
from a fundamental range/contention problem.

### The taxonomy

Four physically distinct causes. **A is currently unmodelled entirely; B and
C are already computed and then thrown away; D is deferred (see below).**

#### A. `tx_busy` — the listener was transmitting at the time (half-duplex)

**Firmware truth.** The radio wrapper holds a single mutually exclusive
state (`src/helpers/radiolib/RadioLibWrappers.cpp:1-13`):

```c
#define STATE_IDLE       0
#define STATE_RX         1
#define STATE_TX_WAIT    3
#define STATE_TX_DONE    4
static volatile uint8_t state = STATE_IDLE;
```

`startSendRaw()` sets `state = STATE_TX_WAIT` (line 157); `isInRecvMode()`
returns true only when the state is `STATE_RX` (line 115). A node that is
transmitting is **not receiving** — full stop. LoRa transceivers (SX126x /
SX127x) are half-duplex parts; this is physics, not a firmware policy.

**Our bug — verified, not assumed.** The interferer loop
(`engine.go:574-589`) skips `other.sender == tx.sender` and requires
`audibleTo(adj, other.sender, e.listener)`. A listener's *own* transmission
is never considered, because `audibleTo(adj, X, X)` needs a self-link that
never exists. A scratch probe confirmed the consequence:

> Node 0 begins a 200-byte transmission at t=0. Node 1 sends a 20-byte packet
> at t=0. At t=377 ms — while node 0's own transmitter is still keyed —
> node 0 reports `collided=false, dropReason="", wasRelayed=true`. It
> received *and relayed* a packet while transmitting.

This inflates both delivery success and relay counts, most in exactly the
dense, chatty scenarios the tool exists to diagnose.

**Fix.** Before any interferer evaluation, check whether `e.listener` had a
transmission of its own whose `[startMs, endMs)` window overlaps the wanted
packet's `[tx.startMs, tx.endMs)`. If so the packet was never heard at all:

- `DropReason = "tx_busy"`, `Collided = false`, **does not mark seen** (it
  was never decoded, so a later clean copy must still be relayable — same
  rule as `weak_signal`; see `docs/SIMULATOR_PLAN.md` item 1's ordering
  notes).
- Skip collision evaluation entirely — if the radio is in TX, nothing else
  about the channel matters.
- Any overlap counts, not just overlap-at-start: a radio that keys up
  mid-reception aborts that reception, and one already transmitting never
  locks.

Note this is physically a *missed* packet, not a corrupted one — it belongs
in the taxonomy because the user named it, but it should read as "never
heard", not as a collision.

#### B. `no_lock` — interference during preamble/sync acquisition

The demodulator never achieved lock, so nothing was received at all: no
partial packet, no CRC error. Already computed in `loraCaptured`
(`engine.go:721-727`) as the `other.startMs < lockDeadline` branch, using the
SF-derived preamble length from phase-1 item 2 — and then discarded by the
caller, which treats it identically to C.

#### C. `corrupted` — payload collision, CRC failure

Lock *was* achieved, but an interferer overlapping the payload was not beaten
by `captureMarginDB` (6 dB, `engine.go:699`), so symbols were corrupted and
the CRC failed. This is the `wantedSNR-interfererSNR >= captureMarginDB`
branch of `loraCaptured`, also currently discarded.

Firmware counterpart: `RadioLibWrapper::recvRaw()`'s `readData` error path
incrementing `n_recv_errors` (`RadioLibWrappers.cpp:119-135`).

#### D. `rx_busy` — receiver already locked onto an earlier packet — **deferred**

A receiver that locked onto an earlier, still-in-flight packet is not
listening for this one. In practice B already covers almost all of this: if
an earlier packet is still airing when the wanted one starts, that earlier
packet *is* an interferer inside the wanted packet's preamble window, so the
reception already fails as `no_lock`. D would only add the nuance that a
locked receiver may refuse to re-lock onto a much stronger later signal.

Implementing it properly requires per-receiver lock-state tracking across the
whole run — a materially larger change than A–C for a small marginal gain.
**Do not build it as part of this item.** Leave this section as the record of
why.

### Reporting model

Keep `Collided bool` exactly as-is — `CollisionRate()` and `Suggest` depend
on it, and changing its meaning would silently invalidate every tuning
result. Add alongside it:

```go
// CollisionKind explains WHY Collided is true — "" when it is false.
// "no_lock": an interferer was on the air during this packet's preamble /
// sync-word acquisition window, so the demodulator never locked on and
// nothing at all was received. "corrupted": lock was achieved, but an
// interferer overlapping the payload was not beaten by captureMarginDB, so
// symbols were corrupted and the CRC failed.
CollisionKind string `json:"collisionKind,omitempty"`
```

- `no_lock` **dominates** `corrupted`: if any interferer caused a lock
  failure, the kind is `no_lock` regardless of what the others did (without
  lock, payload-level interference is moot).
- `tx_busy` is **not** a `CollisionKind` — it is a `DropReason`, since
  `Collided` stays false.
- Fold the existing `SurvivedCapture` (phase-1 item 3) into the same
  vocabulary in the UI: it is the positive counterpart to `corrupted`.

### ⚠ This will move the numbers

Half-duplex will **reduce** successful receptions and relays, most sharply in
dense meshes. It will likely also *lower* the headline collision percentage
while raising a new "missed" count — the failures do not disappear, they
move out of the collision bucket into `tx_busy`. Re-measure the baseline
table and report before/after, and say plainly which direction each moved and
why.

Related, worth flagging to the user but **out of scope here**: `Suggest`
optimises `CollisionRate` alone. Once `tx_busy` exists, a rule could reduce
collisions while increasing missed packets and look like an improvement. If
that shows up in measurements, raise it rather than silently changing the
objective function.

### Go tests (`engine_test.go`)

- A node transmitting a long packet does **not** receive one that arrives
  during its own airtime: expect `DropReason == "tx_busy"`, `Collided ==
  false`, `WasRelayed == false`. This is the direct regression test for the
  probe above.
- `tx_busy` does not mark seen: after a `tx_busy` miss, a later clean copy of
  the same packet is still relayed normally.
- A collision whose interferer starts inside the preamble window reports
  `CollisionKind == "no_lock"`; one starting after lock with insufficient
  margin reports `"corrupted"`.
- `no_lock` dominance: with one of each kind of interferer present, the kind
  is `no_lock`.
- `CollisionKind` is empty whenever `Collided` is false.

### Frontend (`public/simulator.js`, `index.html`, `style.css`)

- `DROP_REASON_LABELS` / `DROP_REASON_DETAILS` (`simulator.js:1525` / `1537`)
  gain `tx_busy`. Suggested copy — label: `Missed (was transmitting)`;
  detail: *"This node's own transmitter was keyed while this packet was on
  the air. LoRa radios are half-duplex — they cannot receive while
  transmitting — so the packet was never heard at all, rather than being
  heard and corrupted."*
- `receptionOutcome` (`simulator.js:1553`) returns kind-specific labels:
  `Collided (no lock)` and `Collided (corrupted)`, with distinct colours
  beside the existing `.sim-reason-collided` / `.sim-reason-captured`
  (`style.css:1019-1020`). Give `tx_busy` its own class too — it is a miss,
  not a collision, and should not read red like one.
- `#sim-packet-filter-outcome` gains entries for the collision kinds and for
  `Missed (transmitting)`. Update `matchesOutcomeFilter` (`simulator.js:1668`)
  — note its existing `dropped` branch excludes `cannot_relay` deliberately;
  decide explicitly whether `tx_busy` belongs under `dropped` (it should:
  it is a genuine delivery failure, unlike `cannot_relay`).
- Stat strip: break the single collided figure into its kinds so the
  dominant cause is obvious at a glance. The `tone: "bad"` threshold logic
  already exists in `renderStatStrip` (`simulator.js:1450`).
- The bottleneck analysis ("predicted but never confirmed") becomes far more
  useful once a predicted-but-unconfirmed hop can be attributed to a specific
  cause — worth a follow-up mention to the user, not required here.

### Playwright

- After a run, a relaying repeater's inspector shows **both** an RX row and a
  RELAY row for the same packet, and the link control moves between them
  (item 12).
- Filtering by a specific collision kind shows only rows whose reason badge
  matches (item 13). Follow the existing pattern at
  `tests/simulator.spec.js` around the `collided` filter assertions.

---

## 14. Declutter the map GUI

**What the user asked for:** "clean up the GUI around the map… it's got too
busy so we need to be able to manage it better."

### Verified inventory — nine floating controls, six of them stacked top-right

| # | Control | Built at | Position | Collapsible? | Present when |
|---|---|---|---|---|---|
| 1 | Basemap radios + overlay checkboxes | `app.js:74` | topright | ❌ `collapsed: false` | always |
| 2 | Filter by region scope | `app.js:313` | topright | ✅ shared helper | always |
| 3 | Map display | `app.js:357` | topright | ✅ (starts collapsed) | always |
| 4 | Map detail | `app.js:625` | topright | ✅ shared helper | always |
| 5 | Neighbours observed in the last | `planner.js:596` | topright | ❌ plain div | always |
| 6 | Simulator view options | `simulator.js:3015` | topright | ✅ shared helper | Simulate open |
| 7 | Coverage legend + opacity + note | `app.js:468` | bottomright | ❌ plain div | always |
| 8 | Sim playback + reception log | `simulator.js:3082` | bottomright | partial — log only | after a run |
| 9 | Bottleneck map key | `simulator.js:2646` | bottomleft | ❌ static header | bottleneck analysis |

Three controls (1, 5, 7) can never be collapsed at all, and #1 is the largest
single block on screen. But the deeper issue is that **there is no organising
principle**: nine independent boxes each decide their own position, size and
default state, so the top-right stack grows without any height budget.

**It is worse than the screenshot suggests.** The overlay list in control #1
is *dynamic*: `app.js:281` adds a `Scope coverage: <name>` overlay per region
as scope coverage becomes available, and `planner.js:876` adds "Planned
coverage (preview)". Ticking several region scopes grows a permanently
expanded control unboundedly.

Good news: the shared collapsible infrastructure already exists —
`window.HopReachMapControls.collapsibleHtml(title, bodyHtml, storageKey)` and
`wireCollapsible(div)` (`app.js:19-45`), with per-control collapsed state
persisted in `localStorage` under `hopreach.mapControlCollapsed.<key>`.
Controls 2, 3, 4 and 6 already use it. This item is mostly about *applying it
consistently* and giving the result a single home.

### Design

**One consolidated "⚙ Map" panel** in the top-right, replacing controls 1–5
(and hosting 6 when Simulate is open) as collapsible **sections** inside a
single box:

- Basemap · Overlays · Map detail · Region scope · Display · Neighbours
  window · (Simulator view)
- **Accordion**: at most one section expanded at a time, so the panel's height
  is bounded by its tallest single section rather than the sum of all of them.
- The panel itself collapses to a single **⚙ button**, so the map can be seen
  unobstructed. Persist that state under the existing
  `hopreach.mapControlCollapsed.*` scheme.
- `max-height: calc(100% - 2rem)` with `overflow-y: auto` on the panel body —
  it must never be able to grow past the viewport, which is the failure mode
  the dynamic overlay list can currently cause.

**Control #1 needs a compatibility shim.** `layersControl` is exported on
`window.MCCoverageMap` (`app.js:743`) and called from **planner.js** as well
as app.js — `addOverlay(layer, name)` at `app.js:281`, `app.js:599`,
`planner.js:876`, and `removeLayer(layer)` at `app.js:256`, `app.js:570`,
`planner.js:790`, `planner.js:836`. Replacing Leaflet's built-in control means
providing an object exposing **those same two methods**, backed by our own DOM
inside the panel, so no call site changes. Preserve the basemap persistence at
`app.js:69-75` (`BASEMAP_STORAGE_KEY`, `baselayerchange`) — if you drive layer
switching manually, write that key yourself.

**Quick win, if the full consolidation is deferred:** changing `collapsed:
false` → `collapsed: true` at `app.js:74` is a one-line change that removes
the single biggest block on screen. Worth doing first regardless.

**Control #7 (legend).** Make it collapsible with the shared helper. Keep the
title and gradient bar visible by default; move the two-line "Terrain-aware
estimate…" note behind the disclosure. That takes it from roughly six lines to
three without losing anything.

**Control #9 (bottleneck key).** Swap its `map-control-header-static`
(`simulator.js:2650`) for a real collapsible header.

**"Manage it better" — a global declutter toggle.** Add one small button that
collapses *every* map control at once (and restores them), for when the user
just wants to look at the map. This is the part of the request that
consolidation alone does not answer.

### ⚠ Test-selector landmine — read before restructuring

Several Playwright tests assert these elements are **visible with no prior
interaction**. Hiding them inside a collapsed panel *will* fail the suite:

| Selector | Used at | Requirement |
|---|---|---|
| `.scope-filter-control` | `basic.spec.js:63,97` | `toBeVisible()` |
| `.scope-filter-control input[data-scope="…"]` | `basic.spec.js:99,105` | `.check()` / `.uncheck()` |
| `#position-mode-select` | `basic.spec.js:119-144` | `waitForSelector` (visible) + `selectOption` |
| `.sim-playback-control` | `simulator.spec.js:161` | `toBeVisible()` |
| `#sim-map-results-log .plan-list-item` | `simulator.spec.js:162` | `toBeVisible()` — **so the reception log must stay expanded by default** |
| `#sim-map-replay-status`, `#sim-map-skip-to-end` | `simulator.spec.js:729-732` | visible + clickable |
| `.sim-bottleneck-legend` | `simulator.spec.js:852-853` | `toBeVisible()` + text |

Two acceptable resolutions, but **pick one deliberately and say which**:

1. **Preserve the class/ID names** on the inner elements when re-hosting them
   inside the consolidated panel, and keep their sections expanded by
   default. Least churn, keeps the tests as genuine regression cover.
2. **Update the tests** to open the panel/section first — but then add an
   explicit assertion that the control is reachable, so the test still proves
   something.

Do **not** simply relax the assertions to `toBeAttached()` to make them pass:
that would silently stop verifying the controls are usable at all.

### localStorage migration

Collapsed state keys are `hopreach.mapControlCollapsed.<storageKey>` with
existing keys `region-scope-filter`, `map-display`, `map-detail`,
`sim-reception-log`. Reusing a key means inheriting whatever the user last
set. If a section's meaning changes materially, use a new key rather than
silently reinterpreting the old one — and note that returning users will have
`map-display` already collapsed (`app.js:347`).

### Verification

- Playwright suite green (see the landmine table above — expect to touch
  `basic.spec.js` and possibly `simulator.spec.js`).
- Manually confirm at a short viewport (e.g. 900×600) that the top-right stack
  cannot overflow off-screen with every region scope ticked — that is the
  specific unbounded-growth case control #1 has today.
- Confirm basemap choice and coverage-overlay toggles still persist across a
  reload, and that "Planned coverage (preview)" still appears/disappears
  correctly from planner.js's own `addOverlay`/`removeLayer` calls.

---

## 15. Stress-test-driven network tuning

**What the user asked for:** "stress test the existing network and we adjust
settings until it improves, where it can handle as many messages as possible
being received successfully as possible across the network… then give the
settings to adjust the repeaters too… try different models such as lower
delays on hill repeaters, higher in lower or dense areas. Or higher delays or
lower delays with more neighbours."

We already have a tuner (`internal/meshsim/tune.go`, the "🎯 Predict
settings" button). It is the right skeleton but is wrong on four counts for
this request.

### What the current tuner does, and the four gaps

`Suggest` (`tune.go:76`) grid-searches 144 candidates — 9 global
(`txDelayCandidates` × 5, `rxDelayCandidates` × 4) plus 90 altitude-threshold
and 45 neighbour-threshold variants — evaluating each over `Trials` seeded
runs and ranking by `report.CollisionRate()`.

1. **Wrong objective.** It minimises *collision rate*, not delivery. Those are
   not the same goal: a policy that makes everyone back off enormously
   collides less and delivers less. (Item 13 already flags this;
   this item is where it gets resolved.) `report.go` currently exposes
   `CollisionRate()` and nothing else.
2. **One rule at a time.** `applyRuleToScenario` (`rules.go:91`) takes a
   single `ConfigRule`. The user's headline example — *"lower delays on hill
   repeaters, higher in lower or dense areas"* — is **two** rules and cannot
   be expressed at all today.
3. **Missing condition kind.** `RuleConditionKind` (`rules.go:21-26`) has
   `altitude_at_least_m`, `altitude_at_most_m` and `neighbors_at_least` — but
   **no `neighbors_at_most`**, so "higher delays where there are *few*
   neighbours" has no direct expression.
4. **No stress test.** Load is whatever `req.Messages` the user happened to
   configure. There is no notion of pushing load up until the network
   saturates, and therefore no measure of *capacity*.

### Two findings that should shape the whole approach

**Finding A — the most relevant knob is currently switched off.**
`RxDelayMs` (`delay.go:47`) is `(rxDelayBase^(0.85−score) − 1) × airtime`, a
direct port of firmware's `calcRxDelay`. Because *higher* score means a
*smaller* exponent, a node that received the packet strongly relays
**sooner** — this is firmware's own built-in "best-positioned node goes
first" mechanism, and it keys off measured SNR rather than needing terrain
data at all. But `rxDelayBase` defaults to **0, which disables it entirely**
(`prefs.go:33`, matching real firmware's own default).

So the user's hilltop intuition is already implemented in firmware — just
turned off. Enabling and sweeping `rxDelayBase` is very likely the
highest-leverage single change, and it should be searched *before*
concluding anything about altitude-keyed rules. State this explicitly in the
results UI: a recommendation of "turn rxdelay on" is a genuinely different
kind of advice from "set hilltop repeaters to 0.25".

**Finding B — a real bug that will bias this exact search.** `MaxRxDelayMs`
(`delay.go:57`) is declared and **never used anywhere**. Real firmware clamps
the score delay at 32 s (`Dispatcher.cpp:248-250`):

```cpp
if (_delay > MAX_RX_DELAY_MILLIS) { _delay = MAX_RX_DELAY_MILLIS; }
```

Without the clamp, high `rxDelayBase` candidates combined with long airtimes
(SF12, large payloads) produce delays real hardware would never apply, making
those candidates score worse than reality. **Fix this first**, before
measuring anything in this item — otherwise the search is biased against the
knob Finding A says matters most.

### 15a. A delivery objective

Add to `internal/meshsim/report.go`:

- **`DeliveryRatio()`** — per packet, the fraction of nodes that received at
  least one *clean* copy, out of the nodes that could possibly have received
  it; averaged over packets.
- **Reachability denominator (get this right).** The denominator must be the
  **reachable set**, computed by BFS over `Scenario.Links` from the origin —
  not the total node count. Isolated or out-of-range nodes would otherwise
  cap every score below 1 and add constant noise that swamps the differences
  between candidates. The BFS must respect the same gates the engine does:
  a node that cannot relay (`CanRelay == false`) or that would refuse the
  packet's region (`acceptsRegion`) is reachable itself but is a **leaf** —
  it does not extend reachability further. This is a new function and needs
  its own unit tests, independent of `Run`.
- Also expose, for reporting rather than optimisation: median and p95 flood
  completion time, total airtime, and (once item 13 lands) the `tx_busy` and
  per-`CollisionKind` rates.

Keep `CollisionRate()` unchanged and keep reporting it — it stays useful as a
diagnostic, it just stops being the thing being maximised.

### 15b. Stress test — an offered-load sweep

New entry point, e.g. `StressTest(req StressRequest) StressResult`:

- Generate load synthetically rather than from user-configured senders:
  *N messages/minute* spread over randomly chosen origins (seeded, so runs
  are reproducible and comparable), payload drawn from a configurable range.
  Restrict origins to nodes that can actually originate traffic.
- **Sweep N** across an increasing series and measure the metrics above at
  each level. The output is a **capacity curve**: delivery ratio versus
  offered load.
- Report the **knee** — the highest offered load at which delivery still
  holds above a threshold (suggest 95% of the delivery measured at minimal
  load, so the threshold adapts to a network that is imperfect even when
  idle). That number *is* "how many messages this network can handle".
- Sweeps are expensive: each load level × each trial is a full run. Reuse the
  existing Web Worker path (`public/meshsim-worker.js`,
  `wasm/meshsim.go`'s `jsSimSuggest`) and its progress callback — this must
  not run on the main thread. Consider a coarse sweep first, then refine
  around the knee, rather than a fine sweep across the whole range.

### 15c. Composite policies and named models

Introduce an ordered **`ConfigPolicy []ConfigRule`**. Later rules override
earlier ones on a per-field basis (so a policy can set a global default and
then override a subset). Generalise `applyRuleToScenario` to
`applyPolicyToScenario`; keep the single-rule path working so existing
`Suggest` behaviour and its tests survive.

Add the missing **`ConditionNeighborsAtMost`** to `rules.go`, and consider
`ConditionAltitudeAtMost` + neighbours in combination for the hub model
below.

**Candidate models to search.** Include each model *and its inverse* — do not
assume which way round is right. There is a real tension: a high, well-
connected repeater reaches the most *new* nodes so should arguably go first
(low delay), but it is also the most likely to collide and the most likely to
be redundant with a neighbour that also heard the packet (arguing high
delay). Which effect dominates is a property of the specific topology, which
is precisely why it should be measured rather than reasoned about.

| Model | Shape |
|---|---|
| `score-priority` | global `rxDelayBase` sweep — turn on firmware's own mechanism (Finding A). Search this first. |
| `hilltop-first` | altitude ≥ T → low txdelay; below T → high |
| `hilltop-last` | the inverse |
| `dense-slow` | neighbours ≥ N → high txdelay; below N → low |
| `dense-fast` | the inverse |
| `sparse-slow` | uses the new `neighbors_at_most` condition |
| `hub-and-spoke` | high altitude **and** high neighbour count → lowest delay; everything else → high |
| `score-priority + dense-slow` | the best global rxdelay combined with the best composite txdelay policy |
| `edge-first` | **few** neighbours → low delay. Distinct from `dense-fast`: a low-degree node is often the *only* route into its corner of the network, so if it hesitates its whole subtree gets nothing |
| `articulation-first` | nodes that are **cut vertices** (their removal disconnects the graph) relay first. Their relay is *never* redundant — by definition nothing else reaches the far side. See the new attribute note below |
| `mpr` / `coverage-gain` | delay inversely proportional to **marginal** coverage: how many neighbours this node covers that no other neighbour of the sender covers. This is the classic MultiPoint Relay heuristic from OLSR — real, well-established prior art for exactly this problem (suppressing redundant flood retransmissions) |
| `two-tier-backbone` | high altitude **and** high degree → low delay; everything else → high delay **and** a reduced `flood_max` so the fringe stops re-flooding into the backbone |
| `degree-proportional` | txdelay scaled *continuously* with neighbour count rather than a threshold step (needs a new proportional rule kind — a threshold is a crude approximation of "busier nodes wait longer") |
| `redundancy-suppress` | **measurement-driven**: from a baseline run, nodes with a high redundant-relay count (item 16) get higher delays. Targets repeaters that spend airtime without adding coverage |
| `airtime-aware` | **measurement-driven**: nodes with the highest measured duty cycle (item 16) back off most. Approximates firmware's adaptive budget behaviour with a static setting |
| `hop-limit-trim` | not a delay model at all — sweep `FloodMax` down on dense networks to cut redundant far-field re-flooding |

The last two are a genuinely different *category*: rather than keying off
topology, they key off what the previous run actually measured. Run a
baseline, read the per-node scoreboard (item 16), then derive the policy from
it. Worth implementing as a distinct stage after the topology models.

**New attributes needed.** `articulation-first` needs `IsArticulation bool`
on `NodeAttrs` (Tarjan's algorithm over the undirected projection of
`Scenario.Links`); `mpr` needs a per-node marginal-coverage figure. Both are
computed from the link graph, so they belong next to the existing
`NeighborCount` — and both need their own unit tests on hand-built graphs
with a known answer.

### New tuning dimensions beyond delay — and one trap

The tuner searches only `TxDelayFactor` and `RxDelayBase`. Phase 1 added two
more per-node settings that the engine genuinely honours, and both are
plausibly as valuable as delay tuning on a dense network:

- **`FloodMax`** (per-node, phase-1 item 5) — genuinely gates relaying in
  `Run`. Safe to search.
- **`DirectTxDelayFactor`** — now meaningful, since phase-1 item 7 added
  direct traffic (see the stale-comment note above).

**⚠ Trap — do not search `TxPowerDBm`.** It is stored in `NodePrefs`
(`prefs.go:25`), editable per-row in the nodes modal and in the bulk-apply
row (`simulator.js:758`, `:869`) — and **the engine never reads it**. Link
SNR comes from the propagation model or CoreScope, computed independently of
each node's configured power. Grep confirms `TxPowerDBm` appears only in
`prefs.go`; nothing in `engine.go` touches it. So:

1. Searching it today would produce a column of identical scores and
   meaningless "suggestions" — exactly the failure the existing
   `DirectTxDelayFactor` comment was written to avoid.
2. More seriously, **the UI already implies it works.** Someone can set tx
   power per repeater, run a simulation, and reasonably believe they have
   modelled it. They have not.

Fix before searching it: a dB change in tx power is a dB change in received
SNR, so `linkSNR()` can apply `link.SNRdB + (node.Prefs.TxPowerDBm −
referenceTxPowerDBm)`, where the reference is the propagation config's own
`tx_power_dbm` (default 22, `config.go:300`). That is physically correct,
small, and turns tx power into a real dimension — enabling a `tx-power-trim`
model (reduce power on dense/hilltop nodes to shrink their interference
footprint while keeping the links that matter), which is classic topology
control. Until then, either wire it up or surface in the UI that it is not
yet modelled — do not leave it silently inert.

**Search strategy — do not brute-force the product.** Composite policies
across two conditions and two parameters explode combinatorially, and the
whole thing must stay interactive. Three stages:

1. Baseline + global sweeps (~9 candidates, as today).
2. Named models above at coarse parameter granularity (~50–100).
3. **Coordinate descent** on the winner: vary one parameter at a time,
   keeping changes that improve delivery, until no single change helps
   (~30–50 more).

That lands in the same order of magnitude as today's 144-candidate search, so
the existing progress-reporting UX still fits.

`DirectTxDelayFactor` is currently excluded from the search
(`tune.go:14-18`) on the grounds that "Run only models flood traffic" —
**that comment is now stale**, since phase-1 item 7 added direct messages.
If the stress mix includes direct traffic, this becomes searchable; update
the comment either way.

### 15d. Output — settings someone can actually apply

The result must be a per-repeater action list, not just a ranked rule table.
For each node: current value → recommended value, and which rule produced it.
Render it in `#sim-predictions-modal` as a proper table (phase-1 item 10G
already asked for this), and add:

- **Copy-pasteable MeshCore CLI** per repeater, using the real command names
  already referenced throughout this codebase (`docs.meshcore.io/cli_commands`):
  `set txdelay <v>`, `set rxdelay <v>`, `set direct.txdelay <v>`.
- **CSV export** of the whole table.
- **Only show nodes whose settings actually change**, with a count of those
  left at defaults — a 77-node network where 6 nodes need changes should read
  as six actions, not seventy-seven rows.
- Show the predicted improvement honestly: delivery and capacity before →
  after, with the trial count and seed, so the number is reproducible.

### Tests

- Go: `DeliveryRatio()` on hand-built scenarios — full delivery, partial,
  and a scenario with an unreachable node (proving the denominator excludes
  it); a `CanRelay: false` node counts as reached but does not extend
  reachability; a region-refusing node likewise.
- Go: `MaxRxDelayMs` clamp is applied (Finding B) — a high `rxDelayBase` with
  a long airtime never yields a relay delay above 32 s.
- Go: `applyPolicyToScenario` — later rules override earlier ones per-field;
  a single-rule policy behaves identically to today's `applyRuleToScenario`.
- Go: `ConditionNeighborsAtMost` matches/rejects correctly.
- Go: `StressTest` is deterministic for a fixed seed, and its reported knee
  moves in the expected direction on a deliberately over-loaded scenario.
- Playwright: running a stress test renders a capacity curve and a per-node
  recommendation table containing at least one CLI command string.

### ⚠ Sequencing note

This item **depends on item 13**. Without the `tx_busy` half-duplex fix, the
stress test measures a network that can transmit and receive simultaneously —
which will overstate capacity most at exactly the high offered loads this
item exists to explore. Do not build 15 before 13.

---

## 16. Per-repeater run scoreboard (duty cycle + delivery)

**What the user asked for:** duty-cycle % used shown per repeater in the
repeaters modal — *"the duty cycle used is just for that simulation run… add
it to the results table too with whatever else you think is useful (received
packets x/x or %, etc)."*

### Where this goes — extend what exists, don't build a third table

There is already a sortable per-repeater results table: `computeRankings`
(`simulator.js:1961`), `RANKING_COLUMNS` (`:1985`),
`renderRankingsTableInto` (`:1993`), shown in the full-window "🏆 Rankings"
view. It currently has five columns (Repeater, Successful, Collisions (own),
Contention (caused), Success rate). **Extend this** — it already has sorting,
good/bad cell tinting and a full-window layout.

Then surface a **read-only subset** in `#sim-nodes-modal` as result columns
that appear only once `lastReport` exists, using the same conditional pattern
as the existing per-row 📨 button (`simulator.js:764`). Keep them visually
distinct from the editable settings columns — that table is already wide
after item 4/6 (13 inputs per row), so add at most duty-cycle % and
received-% there, and leave the full set to the rankings view.

**⚠ Existing metric is easy to misread.** `successRate` today is
`successCount / (successCount + collisionCount)` — "of the transmissions I
heard, what fraction did I decode". That is **not** what the user means by
"received packets x/x". Add delivery as a *separate* column and consider
relabelling the existing one to "Decode rate" so the two can't be conflated.

### Duty cycle — define it carefully, it is easy to make meaningless

Two different numbers, both worth showing, clearly labelled:

- **Airtime %** = this node's total TX airtime ÷ observation window. Use
  **`maxSimTimeMs`** as the denominator, not the run's busy span: tuning
  compares candidates against each other, and a variable denominator would
  make a policy that merely finishes sooner look worse. Note in the UI that a
  run whose activity ends early will read low. Optionally show the busy-span
  figure as a secondary.
- **Budget used %** = share of firmware's own 50% allowance consumed
  (`txBudget`, phase-1 item 9).

**Be honest that budget-used will read ~0 on a normal run.** Firmware's
budget window is a full hour and starts full (`dutyCycleWindowMs =
3_600_000`, `dutyCycleFactor = 0.5`) — phase-1's own tests confirmed the
budget is effectively never binding at realistic sim durations. So for a 60 s
run, **airtime % is the meaningful figure** and budget % is near zero. Budget
% only becomes interesting under item 15's stress sweep, which is exactly
where it earns its place. Say so in the column tooltip rather than letting it
look broken.

**Regulatory context — surface it, don't assert it.** The 869.4–869.65 MHz
sub-band that our new default 869.618 MHz sits in carries a duty-cycle limit
under ETSI EN 300 220 (commonly cited as 10%) that is far stricter than
MeshCore's own 50% self-limit. Showing airtime % lets someone sanity-check
against that. But **a 60-second simulation cannot validate an hourly
regulatory limit** — it can only show short-term utilisation. Word any such
hint as "check against your local regulations", never as a compliance claim.

**No new Go export is needed.** Item 12 already exports `Transmissions` with
`node`, `airtimeMs`, `cadDeferred` and `budgetDeferred` — so airtime per node
is a client-side group-and-sum. **Item 16 depends on item 12.** Only add a Go
export if you also want each node's final `remainingMs`.

### Columns to add

| Column | Meaning | Source |
|---|---|---|
| Duty cycle % | TX airtime ÷ sim window | item 12 transmissions |
| Budget used % | share of the 50% allowance | item 12 / `txBudget` |
| Received x/y (%) | distinct packets cleanly received ÷ packets that could have reached it | receptions + item 15a reachability |
| Relayed | packets forwarded onward | `isRelay` transmissions |
| Missed (busy TX) | packets lost to half-duplex | item 13 `tx_busy` |
| Collided (own) | existing | — |
| Contention caused | existing | — |
| Avg relay delay | mean RX→TX gap | item 12 pairing |
| Deferrals | CAD + budget hold-offs | item 12 flags |
| **Unique deliveries** | packets where this node was the **first** to deliver to some neighbour | receptions, per packet |
| **Redundant relays** | relays where every neighbour had already received that packet | receptions, per packet |

The last two are the most valuable additions and are not currently derivable
anywhere: together they answer *"is this repeater earning its airtime?"* A
node with high redundant relays and low unique deliveries is spending duty
cycle without adding coverage — a prime target for a higher delay or a
reduced `flood_max`, and precisely the input the `redundancy-suppress` and
`airtime-aware` models in item 15c consume.

### Also worth doing here

- **CSV export** of the scoreboard — pairs with item 15d's export, same
  button pattern.
- **Sort by duty cycle descending** as a one-click way to find the busiest
  repeaters.
- Tint duty cycle past a threshold using the existing `badHigh` mechanism in
  `RANKING_COLUMNS`.

### Tests

- Playwright: after a run, the rankings table shows a duty-cycle column with
  a plausible percentage, and a received x/y column; sorting by duty cycle
  reorders rows. Follow the existing pattern in `simulator.spec.js:195`
  ("repeater rankings can be sorted from the full-window view").
- JS-level: a node that never transmits reads 0%; a node transmitting for
  half the window reads ~50%. Easiest as a Go-side test of the underlying
  transmission totals plus a thin JS assertion, rather than mocking a report.

---

## 17. Show each hop's own path-hash size

**What the user asked for:** "add to the messages (for message senders in
the sim) if we are sending it as a 1 byte, 2 byte, or 3 byte hop for hop
recording in transport."

### What this actually is

Each repeater's own `HashSize` (1-3 bytes, `set hash_size` in real
firmware) governs how many bytes of its own path-hash it appends when it
relays a packet (see `nodeHash`, `internal/meshsim/engine.go`) — this is
what real `loop.detect` thresholds are defined against, and the whole
reason a 1-byte hash is more collision-prone than a 3-byte one (phase-1
item 5's own `TestNodeHashCollisionsAreMoreCommonAtSmallerSizes`). Every
node in a scenario can have a DIFFERENT HashSize, so a single packet's own
recorded path can genuinely mix hash sizes hop to hop — today's UI shows
`A → B → C` with no indication of what size each of those hops actually
recorded at.

### No engine change needed

`Reception.Path`/`Transmission` already carry real node indices (not raw
hash bytes) in hop order, and each node's own effective hash size is
already fully known client-side via `effectiveHashSize(n)`
(`public/simulator.js`) — the SAME function the nodes-modal table already
reads to populate its own "Hash size" column. This is a pure, additive
frontend change: wherever a path is rendered, look up
`effectiveHashSize(simNodes[hopIndex])` for each hop and show it alongside
the hop's own label.

### Where to change it

- `receptionOutcome`'s path label building — currently
  `(r.path || []).map(nodeLabel).join(" → ")` in the packet-row renderer
  (`public/simulator.js`). Change each hop to `${label} (${size}B)`, or a
  small superscript badge — whichever reads more cleanly at the existing
  row width.
- The "Message senders" list row (`public/simulator.js`, where a sender's
  own origin/region/count are shown) — add the origin's own
  `effectiveHashSize` as a small badge, so it's visible at the point a
  sender is being configured, not just after a run.
- `renderPacketChecklist`'s own detail text, if a hop-by-hop breakdown ever
  appears there too.

### Verification

- Manual: a scenario with two repeaters set to different hash sizes (e.g.
  1-byte and 3-byte) shows both sizes correctly in the same packet's own
  path trail after a run.
- Playwright: after a run, a path badge showing a hash-size figure is
  present in the packet inspector's own rows.

---

## Suggested order

0. **14 quick win** — flip `app.js:74` to `collapsed: true`. One line, removes
   the biggest on-screen block, independent of everything else.
1. **12 (Go)** — export `Transmissions`, with its tests. Self-contained and
   additive; nothing else depends on it.
2. **12 (JS)** — TX/RELAY rows, RX↔TX linking, filters, stat strip. Rebuild
   the image and run Playwright.
3. **13 (Go, part A)** — half-duplex `tx_busy`. Do this **alone** and
   re-measure the baseline table immediately: it is the one change here that
   materially moves results, and isolating it keeps the before/after
   attributable.
4. **13 (Go, parts B+C)** — `CollisionKind`. Pure reporting, should not move
   the baseline at all; if it does, something is wrong — stop and
   investigate.
5. **13 (JS)** — labels, colours, filters, stat-strip breakdown. Rebuild and
   run Playwright.
6. **15a + Finding B** — apply the `MaxRxDelayMs` clamp, then add
   `DeliveryRatio()` and the reachability BFS with their tests. Report the
   baseline table's delivery ratio alongside its collision rate; from here on
   delivery is the headline number.
7. **16** — the per-repeater scoreboard. Slot it here, before the search:
   duty cycle, unique deliveries and redundant relays are what the
   measurement-driven models in 15c consume, and they make the stress sweep's
   output legible while you build it.
8. **15b** — the offered-load sweep and capacity curve. Report the knee for
   the three baseline scenarios.
9. **15c** — `ConfigPolicy`, `neighbors_at_most`, the topology models and the
   three-stage search, then the measurement-driven models on top. Report which
   model wins on the real network and by how much — including if the answer is
   "none of them beat global rxdelay", which is a perfectly good result.
   Decide separately whether to wire up `TxPowerDBm` (see the trap note).
10. **15d** — the per-repeater action list, CLI strings and CSV export.
11. **14 (full)** — consolidated map panel, legend/bottleneck collapse, global
    declutter toggle. Deliberately last: it touches the same
    `simulator.js`/`style.css` regions as every other UI item above, and doing
    it earlier would mean restructuring the controls twice.

Report measured numbers after step 3 and step 4 before moving on. From step 6
onward, report **delivery ratio and capacity**, not just collision rate.
