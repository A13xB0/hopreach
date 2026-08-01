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
