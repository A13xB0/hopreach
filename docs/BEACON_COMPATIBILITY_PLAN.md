# Supporting MeshCore Beacon as a HopReach data source

Companion to `docs/DATA_SOURCE_SPEC.md` (what HopReach needs) — this is the
assessment of **MeshCore Beacon** (`github.com/MeshCore-Beacon/beacon-server`,
Go + Postgres + MQTT ingest) against it, and the plan to support it.

Read against beacon-server at commit as cloned 2026-08-02. **Trust its Go
structs and `docs/swagger.yaml`, not `beacon-docs`** — the published API
contract is materially out of date (documents `{"packets":[…]}` with opaque
string cursors where the code returns `{"items":[…], "nextCursor": <int64>,
"hasMore": bool}`, flat fields where the code nests, uppercase payload names
where the code emits lowercase).

---

## 0. Status: implemented and verified against a real Beacon

Every HopReach feature runs on both backends. Verified by loading ScotMesh's
own CoreScope data into a local Beacon (`cmd/corescope-to-beacon`) and running
the whole system twice — comparing against an unrelated Beacon would have
proved nothing, since the maps would differ because the networks differ.

Switch with one key:

```yaml
source:
  type: corescope   # or: beacon
```

### Feature parity

| Feature | CoreScope | Beacon | Notes |
|---|---|---|---|
| Repeater list + positions | ✅ | ✅ | identical set and coordinates on the same mesh |
| Node names, first/last heard | ✅ | ✅ | "never heard" stays null on both |
| Self-reported default scope | ✅ | ✅ | Beacon's node *list* omits it; filled per region (§0.1) |
| Observed reach / links | ✅ | ✅ | Beacon synthesises from neighbour lists both directions |
| Calibration against observed links | ✅ | ✅ | same `[]meshsource.ReachLink` |
| Coverage rasters, all tiers | ✅ | ✅ | pure function of positions + terrain |
| Region/scope catalogue | ✅ | ⚙️ | from `source.scopes` when set (§0.2) |
| Region tagging on repeaters | ✅ | ⚙️ | 32/77 with a configured list |
| Per-scope coverage rasters | ✅ | ⚙️ | follows the catalogue |
| Map's region filter control | ✅ | ⚙️ | follows the catalogue |
| Packet scope (per packet) | ✅ | ✅ | Beacon reports it directly |
| Observed region participation | ✅ | ✅ | both derived from traffic (§0.3) |
| Observed-unscoped signal | ✅ | ✅ | both derived from traffic |
| Packet window (replay) | ✅ | ✅ | Beacon filters server-side; CoreScope needs the offset search |
| Packet detail, all observations | ✅ | ✅ | |
| Resolved relay paths | ✅ | ✅ | list omits them; recovered by bounded detail fan-out |
| Per-hop resolution confidence | ❌ | ✅ | Beacon-only, and an upgrade — see §3 |
| Frame size for airtime | ✅ | ⚠️ | detail only (§0.4) |
| Packet replay end-to-end | ✅ | ✅ | |

### 0.1 Default scope is missing from Beacon's node list

Beacon's `ListNodes` query selects `ts.name AS default_scope_name` and its
`NodeSummary` type has the field, but the list response does not carry it —
only the per-node detail endpoint does. Left alone, every node arrives
unscoped and the map's scope filter is empty on Beacon while working on
CoreScope.

Filled with one `/nodes?scope=NAME` request per region rather than one detail
request per node, since that filter matches on exactly this field. Worth
raising upstream; the workaround is cheap and correct either way.

### 0.2 No region catalogue on Beacon, so the region features are off

CoreScope's scope list is "regions this instance knows". Beacon's
`/scopes?iatas=…` is "regions with observers in these IATAs" — it joins
through `observer_scopes`, so a region nobody local has been heard on is
absent. On the migrated sample that is 3 of 9.

Both answers are defensible; they are simply not the same question. But the
features built on the list — the per-region coverage rasters and the map's
region filter — both *present themselves as the complete set*. Built from a
partial list they are quietly wrong in a way no user can see: a region that
is missing looks like a region with no repeaters in it, which is a wrong
answer rather than a missing one.

So it is declared rather than discovered. `meshsource.Capabilities.ScopeCatalog`
is false for Beacon **unless the operator supplies the list**:

```yaml
source:
  type: beacon
  scopes: ["#sco", "#fif", "#tay"]
```

Completeness is knowledge an operator usually has and a backend often does
not, so config is the right place for it. This is enumeration only —
membership is still decoded from real traffic, so a configured region nobody
has been heard on gets no observations rather than an invented one. Verified
on the migrated ScotMesh mesh: with the nine regions listed, Beacon tags
**32 of 77 repeaters** and renders per-region rasters.

Without a list, everything downstream switches off together:

| Layer | Behaviour when false |
|---|---|
| `cmd/hopreach` | skips scope observation and per-region rasters, logs why |
| `meta.json` | `capabilities.scope_catalog: false`, no `scope_coverage` |
| `/mesh-api/api/source` | reports the capability |
| `public/app.js` | the region filter control is never created |

The main coverage rasters, calibration, replay and everything else run
normally. A backend that cannot answer completely says so, and the feature is
absent rather than half-drawn — an absent control is visibly absent, and a
half-drawn map is not.

Note this is about *enumerating* regions. Anything keyed to a specific scope
still works on Beacon: a packet's own scope, region participation, and a
node's self-reported default scope.

### 0.3 Region participation is derived from traffic on both

Beacon exposes `/nodes?scope=…`, which is tempting and wrong for this: it
filters on a node's *self-reported* default scope, which is a different claim
from "observed relaying on that region". Using it would label repeaters as
observed participants on the strength of what they say about themselves —
precisely the weak signal observation exists to replace.

So both backends derive it from real traffic. What Beacon buys is a
server-side scope filter on the packet query, making each region a narrow
question instead of a walk of the whole history.

### 0.4 Frame size is detail-only on Beacon

Beacon's packet list carries no payload, so `frame_bytes` is 0 there and
present on CoreScope. It is populated from the detail response, which the
replay path fetches anyway for relay paths — so the simulator gets real
airtime. Anything reading only the list gets 0, which the front end already
treats as "not reported" rather than as a zero-length frame.

### 0.5 What "equivalent output" means

Not byte equality, and `tools/compare_backends.py` encodes why:

- The runs happen minutes apart, so a repeater can cross the active/degraded
  threshold between them.
- Beacon reports per-hop confidence and CoreScope cannot, so Beacon can
  honestly say "unknown" where CoreScope names a node. Flattening that would
  be the bug, not the fix.

- Beacon never deletes a node; CoreScope ages them out. See §0.8.

Positions are compared in **metres**, not by float equality: a repeater that
re-adverts between the two runs reports a slightly different GPS fix, which is
drift, not disagreement. A translation bug does not move a node by a metre —
it swaps coordinates or loses precision wholesale.

Result on the same mesh: **identical set, positions, names, self-reported
scopes and activity status** — see §0.9 for the latest run.

### 0.6 Reproducing it

```bash
docker run -d --name beacon-postgres -e POSTGRES_USER=beacon \
  -e POSTGRES_PASSWORD=beacon -e POSTGRES_DB=beacon -p 5433:5432 postgres:16-alpine
# beacon-server with a Scotland IATA config, then:
go run ./cmd/corescope-to-beacon -corescope https://YOUR-CORESCOPE \
  | docker exec -i beacon-postgres psql -U beacon -d beacon
python3 tools/compare_backends.py out-corescope out-beacon
bash tools/compare_mesh_api.sh http://localhost:9091 http://localhost:9092
```

### 0.7 Defects this found

Six, none of which a unit test with a fake source could have reached:

1. Beacon's node list omits `defaultScope` (§0.1).
2. Participation was using self-reported scope as if it were observed (§0.3).
3. Beacon's packet-detail handler dereferences `source_broker` without a nil
   guard, so a NULL panics the endpoint — worth reporting upstream.
4. Path resolution is scoped to the IATA an observation was filed under. That
   suits a global service where partitions are separate networks; a single
   mesh spanning four airports loses every hop that crossed a boundary, which
   reads as "unknown relay" rather than as a modelling artifact.
5. `cmd/corescope-to-beacon` numbered transport scopes by their position in
   the scope list and wrote that id literally, guarded only by
   `ON CONFLICT (name)`. Re-running it after the mesh gained or lost a region
   shifted every later id and collided on the PRIMARY KEY, which that conflict
   target does not catch — and one unhandled error aborts the transaction, so
   psql discarded the whole migration and left the previous data in place. The
   database looked populated and was silently a day stale. Scopes are now
   referenced by name and the id is the sequence's to assign.
6. The same tool used `ON CONFLICT ... DO NOTHING` for `nodes` and
   `node_iatas`, so a re-run refreshed nothing: a repeater that had moved kept
   its old coordinates, and `last_heard` stayed frozen at whatever the *first*
   migration saw. On a day-old copy that put 64 of 79 shared repeaters in a
   different activity bucket from CoreScope — the map showed live repeaters as
   silent. Both are now `DO UPDATE`, with `first_seen`/`first_heard` taking
   `LEAST` and `last_seen`/`last_heard` taking `GREATEST`.

Defects 5 and 6 are worth dwelling on, because both presented as *Beacon*
being a lower-fidelity source. They were the migration's, and the only reason
they surfaced is that the comparison was re-run from scratch rather than
trusting the first green result.

### 0.8 Nodes Beacon keeps and CoreScope drops

The one difference `tools/compare_backends.py` still reports, and it is not
fixable in HopReach: CoreScope ages nodes out of its list, Beacon never
deletes one. Two repeaters in the run below return HTTP 404 from CoreScope's
own node endpoint and are still served by Beacon.

This is left as a failure rather than whitelisted. A node present on one side
and absent on the other is also exactly what a translation bug looks like, and
the check is worth more catching that than it costs to explain these two.

### 0.9 Re-verified 2026-08-03

Both backends re-run from the same HEAD binary, against the same mesh, after
re-running the migration:

| | CoreScope | Beacon |
|---|---|---|
| repeaters in region | 79 | 81 |
| active / degraded | **57 / 15** | **57 / 15** |
| silent | 10 | 8 (+2 nodes CoreScope has deleted, §0.8) |
| position differences | — | none |
| activity-status differences | — | none |

Every `/mesh-api/` endpoint the browser calls answered on both
(`tools/compare_mesh_api.sh`), and the real web app loads against each
backend's output with zero page errors.

---

## 1. Verdict

**Yes — compatible, and in two respects better than what we have.** No
blocking gap. The work is an adapter, not a redesign.

- **Two genuine upgrades** over CoreScope: real server-side time filtering
  (`since`/`until`), which deletes the ugliest code in the replay path; and
  per-hop resolution *confidence*, which the negative-evidence logic can use.
- **Three real problems**, all solvable: resolved paths are deliberately
  absent from the packet *list*; there is no reach/links endpoint; and there
  is no raw full-frame hex.
- **One structural decision it forces**, which we should make regardless:
  stop letting the browser talk a vendor's shape.

---

## 2. Capability matrix

| HopReach needs (per DATA_SOURCE_SPEC) | Beacon offers | Verdict |
|---|---|---|
| `GET /api/nodes`, paginated, `role=repeater` | `GET /api/v1/nodes?type=2`, **cursor** pagination (`cursor`=last_seen epoch ms, `limit`) | ✅ adapt. `nodeType` 2=repeater, 3=room_server |
| `public_key` lowercase hex | `publicKey`, full 64-hex lowercase | ✅ identical |
| `lat` / `lon` | `lat` / **`lng`** | ✅ rename |
| `last_heard` | **absent from `NodeSummary`** — has `stale` bool + `iatas[].lastHeard` | ⚠️ derive `max(iatas[].lastHeard)` |
| `role` string | `nodeTypeName` (`"repeater"`) | ✅ rename |
| `hash_size`, `default_scope` | `defaultScope` yes; `hash_size` **not on node** (it's per-observation `pathLength.hashSize`) | ⚠️ minor, sim-only |
| `relay_count_24h` | not present; `knownNeighborCount` is the nearest thing | ⚠️ liveness must come from `stale`/`lastHeard` |
| `GET /nodes/{pubkey}/reach` with `bottleneck`,`bidir` | **no reach endpoint.** `node_neighbors` table exists (per-IATA, `observationCount`, `firstSeen`/`lastSeen`, occasional `snr`), exposed as `GET /nodes/{uuid}/neighbors` | ❌ **synthesize** — §3.2 |
| `GET /api/scope-stats` → `byRegion[].name` | `GET /scopes` → bare `[]string` *or* `[]ScopeSummary` (polymorphic on whether `iatas` is set) | ✅ trivial adapt |
| `GET /api/packets` one row per packet, newest first | `GET /api/v1/packets` — genuinely one row per packet (`packets` + `packet_observations` two-table model), `ORDER BY last_heard_at DESC` | ✅ better than required |
| `offset` + `sort=timestamp&order=desc` for historical windows | **no offset/sort params** — cursor only… **but `since`/`until` (epoch ms) exist** | ✅✅ **upgrade**, see §3.1 |
| packet `timestamp` ISO-8601 | `firstHeardAt`/`lastHeardAt` **epoch ms integers** | ✅ convert |
| packet `resolved_path` on **list rows** | **deliberately `nil` on REST list.** Code comment: *"full resolution stays a `GET /packets/{packetHash}`-only feature"* | ❌ **the main problem** — §3.3 |
| packet `raw_hex` (full frame) | **not stored.** `raw_header` (1 byte) + `raw_payload` (no header/path) + per-observation `pathBytes` | ⚠️ **but unnecessary** — §3.4 |
| `decoded_json.pubKey` (origin) | `originPubkey` on packet **detail**; `parsedPayload` JSONB | ✅ better, detail-only |
| `route_type` 0/1 = flood | `routeType` int + `routeTypeName` (`FLOOD`/`DIRECT`/`TRANSPORT_FLOOD`/`TRANSPORT_DIRECT`) | ✅ same encoding |
| `GET /api/packets/{hash}` with **every** observation | `GET /api/v1/packets/{packetHash}` → full `observations[]`, each with `observerId`, `observerName`, `iata`, `heardAt`, `rssi`, `snr`, `pathBytes`, **`resolvedPath`** | ✅ excellent match |
| per-observation SNR | `snr` (float32) + `rssi` | ✅ better |
| observers as first-class | full `observers` table + `/observers`, telemetry, status | ✅✅ better than CoreScope |
| auth | none, CORS `*`, GET-only | ✅ same posture |

---

## 3. The five hard problems

### 3.1 Pagination is cursor-only — and that's *good* here ✅

HopReach currently binary-searches backwards through `offset` to find a
historical window, because CoreScope has no time filter. That code
(`fetchPacketsAroundTime`, the offset probing, the `hitCap` handling) exists
solely to work around a missing feature.

Beacon has `?since=<epochMs>&until=<epochMs>`. The entire replay window fetch
collapses to **one request**:

```
GET /api/v1/packets?since={t-window}&until={t+window}&limit=500&iatas=EDI
```

and the ±5-minute observer-liveness sweep is a second one. Delete the search.

**Consequence for the abstraction:** the data-source interface must expose
*intent* (`FetchPacketsBetween(from, to)`), not mechanism (`offset`). If we
model it as "fetch by offset" we inherit CoreScope's weakness forever.

### 3.2 No reach/links endpoint — synthesize from neighbours ❌→✅

Beacon stores exactly the right data, just doesn't aggregate it:

```sql
CREATE TABLE node_neighbors (
  node_id UUID, neighbor_id UUID, iata CHAR(3),
  first_seen TIMESTAMPTZ, last_seen TIMESTAMPTZ,
  observation_count BIGINT NOT NULL DEFAULT 1,
  snr REAL,               -- usually NULL
  PRIMARY KEY (node_id, neighbor_id, iata)
);
```

`observation_count` is semantically what `bottleneck` needs. The adapter
builds reach itself:

1. Sweep `/nodes?type=2&limit=…` once → pubkey ↔ UUID map (node path params
   are **UUIDs, not pubkeys** — `/nodes/{uuid}`; pubkey is only a *filter*).
2. For each repeater, `GET /nodes/{uuid}/neighbors` → `[]NodeNeighbor`
   (`publicKey`, `observationCount`, `firstSeen`, `lastSeen`, `snr?`).
3. Build a directed edge map, then per unordered pair:
   `bottleneck = min(count(A→B), count(B→A))`, `bidir = both present`.
   One-directional: `bottleneck = that count`, `bidir = false` — matching how
   `ReachLink` is already documented in our client.

**Cost:** N+1 requests (N ≈ repeaters in region). At ~75 nodes that's fine
once per run, and it's server-side Go, not the browser. Cache per run.

**Caveats to honour:**
- Edges are **per-IATA** — filter to the configured IATA(s) or you'll mix
  networks.
- Edges are **never deleted** when they stop being reported, so `lastSeen`
  must be used to age them out — otherwise calibration is fed dead links.
- `node_neighbors` is populated from path-hop derivation *and* observers'
  zero-hop `/neighbors` MQTT topic. Both are observed, not predicted — which
  is what calibration requires. ✅

### 3.3 `resolvedPath` is nil on the packet list ❌ — the real problem

The replay builds its topology from `resolved_path` on **every packet in the
window**. Beacon returns those only from `GET /packets/{hash}`.

Three options:

| Option | How | Verdict |
|---|---|---|
| **A. N+1 detail fetches** | one `GET /packets/{hash}` per window packet, fanned out server-side with a concurrency cap | **Recommended.** Window is ±30–120 s; on ScotMesh that's tens of packets, not thousands. Parallel + cached it's a second or two, in Go, once. |
| **B. WebSocket feed** | `/ws` with `configure {"resolvePath": true}` gives resolved paths live | Good for a *live* map later; useless for replaying a packet from last Tuesday. Not a substitute. |
| **C. Ask Beacon for it** | add `?resolve=true` to `/packets` | Best long-term; see §7. Don't block on it. |

Do **A**, structured so **C** is a one-line switch when it lands.

**Shape difference that matters:** Beacon's resolution is *richer* than
CoreScope's flat pubkey list —

```go
type ResolvedHop struct {
    Confidence string         `json:"confidence"` // "high" | "ambiguous" | "none"
    SNR        *float32       `json:"snr,omitempty"`
    Nodes      []ResolvedNode `json:"nodes"`      // plural!
}
```

A 1-byte path hash can match several nodes; Beacon says so instead of
guessing. Our canonical shape must flatten it, and the flattening rule is a
**correctness decision**, not a formatting one:

- `confidence == "high"` and exactly one node → take that pubkey.
- `confidence == "ambiguous"` → treat the hop as **unknown**, not as
  `nodes[0]`. Picking arbitrarily invents a relay that may not exist, which is
  exactly the class of error `SIMULATION_REVIEW.md` was written about.
- `confidence == "none"` → unknown hop.

Then feed the ambiguity through: a replay whose chain contains an unknown hop
should be *marked* as such rather than silently treated as fully resolved.
That's a genuine accuracy improvement over the CoreScope path, and it's the
one place I'd spend extra effort.

### 3.4 No raw frame hex ⚠️ — turns out we don't need it

`parseMeshFrame(p.raw_hex)` exists to recover payload type and hash size.
Beacon hands both over already, structured and decoded:

```json
"header":     { "payloadType": 4, "payloadTypeName": "grp_txt", "routeType": 1, "routeTypeName": "FLOOD" },
"pathLength": { "raw": "0c", "hashSize": 1, "hopCount": 3 }
```

So the adapter fills the canonical fields directly and `parseMeshFrame` is
simply not called on this path. Reassembling a synthetic frame from
header + path + payload would be possible but pointless — and lossy, since
transport codes are stored decoded (`region_code`/`sub_region_code` ints), not
as raw bytes.

Note `beacon-docs` advertises a per-observation `rawPacket` field. **It does
not exist in the code.** Don't design around it.

### 3.5 IATA is the partition key ⚠️

Beacon is multi-region by 3-letter IATA code (derived from the MQTT topic);
`regions` are just named groupings of IATAs. HopReach is single-region.

Every list call must be pinned (`?iatas=EDI,GLA` or `?region=<slug>`) or we
pull the whole world and calibrate against links on another continent. This
becomes a required config key with **no default** — better to fail loudly at
startup than to silently ingest everything.

Also note: with `iatas` set, `/packets` switches to a different query ordered
by *site-local* `heard_at`, and the cursor becomes site-local. Since we're
using `since`/`until` rather than cursor paging, this mostly doesn't bite —
but don't mix a cursor from one filter set into another.

---

## 4. Architecture — the decision this forces

Today `simulator.js` fetches `/corescope-api/…` straight through nginx and
parses CoreScope's shapes in the browser. If we point that proxy at Beacon,
the browser needs a second parser for every response — and the two vendors'
shapes differ in nearly every field name, timestamp format and envelope.

**Do not put vendor knowledge in the browser.** Instead:

```
                 ┌──────────────────────────┐
  browser ──────►│  /mesh-api/…             │  canonical shape
  (simulator.js) │  (HopReach, Go)          │  == DATA_SOURCE_SPEC
                 └───────────┬──────────────┘
                             │  MeshDataSource interface
                 ┌───────────┴──────────────┐
                 │                          │
        ┌────────▼────────┐        ┌────────▼────────┐
        │ corescopeSource │        │  beaconSource   │
        │ (today's client)│        │  (new adapter)  │
        └─────────────────┘        └─────────────────┘
```

- `internal/meshsource` defines the interface + canonical DTOs:
  `FetchRepeaters`, `FetchReach(pubkey)`, `FetchScopes`,
  `FetchPacketsBetween(from,to)`, `FetchPacketDetail(hash)`.
- Existing `internal/corescope` becomes the first implementation, unchanged in
  behaviour.
- `internal/beacon` is the new one, owning: epoch-ms↔time conversion, `lng`→
  `lon`, `items`→ list, cursor paging, the neighbours→reach synthesis (§3.2),
  the N+1 detail fan-out (§3.3), and the confidence flattening.
- HopReach serves `/mesh-api/` itself (in `hopreach-shareapi`, which already
  hosts `/admin/recompute` and the GPU broker), replacing the nginx passthrough.
  `simulator.js` changes exactly one constant: the base path.

**This is worth doing even if Beacon never ships**, because it also removes
the "browser depends on a third party's JSON shape" coupling that made the
CoreScope list-wrapping surprises expensive.

---

## 5. Phasing

| Phase | Scope | Ships value alone? |
|---|---|---|
| **P0** | Point a dev HopReach at a live Beacon instance by hand; capture real responses for `/nodes`, `/nodes/{id}/neighbors`, `/packets?since&until`, `/packets/{hash}` into `testdata/` | yes — settles every unknown in §8 |
| **P1** | `internal/meshsource`: interface + canonical DTOs + table tests. Move `internal/corescope` behind it. **No behaviour change** — the regression net for everything after | yes |
| **P2** | Serve `/mesh-api/` from hopreach-shareapi in canonical shape; switch `simulator.js` to it; retire the `/corescope-api/` proxy | yes — decouples the browser |
| **P3** | `internal/beacon`: nodes + scopes + reach synthesis. Coverage maps + calibration work end to end on Beacon | **yes — this is the milestone**: a working coverage map from Beacon |
| **P4** | Beacon packets: `since`/`until` window fetch, detail fan-out, confidence flattening → replay simulator works | yes |
| **P5** | Propagate hop-confidence into the replay verdicts (mark chains containing ambiguous hops) — an accuracy gain on **both** backends | yes |
| **P6** | Optional: `/ws` live feed for a real-time map | later |

P0–P3 is the honest "can we do this" milestone. P4 is the expensive one.

## 6. Test strategy

- **Golden-file adapter tests** (`testdata/beacon/*.json` from P0) → canonical
  DTOs. This is where field renames, epoch-ms conversion and envelope
  unwrapping get pinned; they're the failures that are silent otherwise.
- **Confidence-flattening tests**: high/single → resolved; ambiguous → unknown
  (explicitly *not* `nodes[0]`); none → unknown; empty path → direct.
- **Reach-synthesis tests**: A→B 10 obs and B→A 3 obs ⇒ `bottleneck 3, bidir
  true`; one-way ⇒ `bidir false`; stale edge past the age cutoff dropped;
  edges from another IATA excluded.
- **Cross-source equivalence**: run both adapters against the same physical
  network and diff the canonical output — repeater counts, positions, edge
  sets. Differences are either a real data gap or an adapter bug, and both are
  worth knowing before trusting a map.

## 7. What to ask the Beacon devs for (in priority order)

None of these block us; all of them make the integration cheaper and the
result better. Worth passing on as a friendly wishlist:

1. **`?resolve=true` on `GET /packets`** — opt-in resolved paths on the list,
   as the WS feed already does with `configure {"resolvePath":true}`. Removes
   the entire N+1 fan-out (§3.3). Biggest single win.
2. **An aggregated links endpoint** — `GET /links?iata=…` returning edges with
   `observation_count` both directions. The data is already in
   `node_neighbors`; only the aggregation is missing. Would delete §3.2.
3. **`lastSeen` on `NodeSummary`** — it's already selected and sorted on in the
   SQL, just not serialised. Removes the `max(iatas[].lastHeard)` workaround.
4. **Pubkey-addressable node paths** — `GET /nodes/by-pubkey/{hex}` so
   consumers don't need to hold a UUID map.
5. **Fix `beacon-docs`** to match the code, or delete it — an out-of-date
   contract is worse than none. (`items`/int cursor/nesting/case, and the
   `rawPacket`/`totalBytes`/`summary` fields that don't exist.)
6. Consider populating `summary` or removing the field.

## 8. Unknowns to settle in P0

- **Packet hash length.** `meshcore-go v1.0.8` isn't vendored locally so it
  couldn't be read; docs suggest 8 bytes / 16 hex. Our replay keys on the hash
  as an opaque string, so any length works — but confirm it's stable and
  matches what CoreScope calls the same packet, or cross-source comparison is
  impossible.
- **How much of the path is genuinely resolvable** in practice — what fraction
  of hops come back `high` vs `ambiguous` on a real network. This decides
  whether §3.5's ambiguity handling is a footnote or a headline.
- **Whether `node_neighbors` is dense enough** for calibration on a real
  network, versus CoreScope's reach data. If Beacon's edges are sparse,
  calibration quality drops and we should say so rather than quietly ship a
  worse map.
- **Observation completeness** — Beacon dedups to **one observation per
  observer per packet** (`UNIQUE (packet_hash, observer_id)`), so repeat
  hearings by the same observer collapse. That's the right model for our
  negative-evidence logic, but confirm it doesn't drop *distinct* receptions we
  care about.
- **Retention**: default 30 days (`720h`). Replays older than that are simply
  unavailable; CoreScope's window may differ.
