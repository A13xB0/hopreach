# HopReach data-source spec — supporting a backend other than CoreScope

**Audience:** someone building (or adapting) a mesh-observation server so
HopReach can use it in place of a CoreScope instance.

**What HopReach is:** it renders LoRa coverage maps for a MeshCore network. It
does **not** observe the mesh itself — it consumes someone else's record of
what was heard, and turns that into (a) a list of repeaters with positions,
(b) real observed links between them used to calibrate the propagation model,
and (c) for the packet-replay simulator, individual packets and who heard them.

Everything below is derived from what HopReach actually reads today. If your
server answers these, HopReach works; anything else CoreScope exposes is
irrelevant to it.

---

## 0. TL;DR — the minimum

Three endpoints get you a working coverage map:

| # | Endpoint | Purpose | Without it |
|---|---|---|---|
| 1 | `GET /api/nodes` | the repeaters, with positions | nothing renders |
| 2 | `GET /api/nodes/{pubkey}/reach` | observed links between repeaters | maps render, but the propagation model is uncalibrated |
| 3 | `GET /api/scope-stats` | region/scope names | the scope filter and "send as region" UI is empty |

Two more unlock the packet-replay simulator (the tool that reconstructs what
actually happened to a single transmission):

| # | Endpoint | Purpose |
|---|---|---|
| 4 | `GET /api/packets` | recent packets, newest first, paginated |
| 5 | `GET /api/packets/{hash}` | one packet plus **every** observation of it |

All JSON, all `GET`, all read-only. HopReach never writes.

---

## 1. Transport, format and conventions

- **HTTP(S), JSON**, UTF-8. No auth today — HopReach passes no credentials, so
  either serve public read-only data or terminate auth in front of it (a
  reverse proxy adding a header would work without HopReach changes).
- **Browser access matters.** Endpoints 4 and 5 are called from the *browser*
  (the simulator), routed through HopReach's nginx at `/corescope-api/…`.
  Endpoints 1–3 are called both server-side and from the browser. So either
  allow the proxy origin or expect to sit behind HopReach's proxy — CORS on
  your side is not required if you're proxied.
- **Timestamps: ISO-8601 with an explicit offset** (`2026-08-02T01:23:45Z`).
  Parsed with `Date.parse` / Go's RFC3339. **Never** send a bare local
  datetime — an offsetless string is interpreted differently on the two sides
  and quietly shifts every packet by your timezone.
- **Public keys: lowercase hex**, full-length. HopReach lowercases before
  comparing, but consistency saves you debugging.
- **Lists are wrapped in an object**, keyed by the resource name
  (`{"nodes": [...], "total": 123}`). Don't return a bare top-level array.
- **Unknown fields are ignored**; missing optional fields must be `null` or
  absent rather than `0`/`""` — HopReach distinguishes "unknown" from "zero"
  in several places (see `last_heard`).

---

## 2. Endpoint 1 — `GET /api/nodes`

The node directory. **Required.**

```
GET /api/nodes?role=repeater&limit=500&offset=0
GET /api/nodes?limit=5000
```

- Must support `limit` + `offset` pagination; HopReach pages at 500 server-side
  and asks for up to 5000 in one shot from the browser.
- Must support `role=repeater` filtering. If you can't filter server-side,
  returning everything is acceptable — HopReach will over-fetch.

```json
{
  "nodes": [
    {
      "public_key": "a1b2c3…",          // required, lowercase hex
      "name": "Lucklaw Hill",            // nullable
      "role": "repeater",                // "repeater" | "companion" | …
      "lat": 56.36, "lon": -2.94,        // nullable — no position, no coverage
      "last_heard": "2026-08-01T22:14:00Z",   // nullable
      "first_seen": "2026-05-02T09:00:00Z",   // nullable
      "advert_count": 412,               // nullable
      "relay_count_1h": 3,               // nullable
      "relay_count_24h": 88,             // nullable
      "hash_size": 1,                    // nullable: 1|2|3 path-hash bytes
      "default_scope": "sco"             // nullable: region/scope name
    }
  ],
  "total": 660
}
```

Field notes that matter:

- **`lat`/`lon` null ⇒ the node is skipped** for coverage. That's correct
  behaviour, not an error.
- **`last_heard`** drives "is this repeater alive": HopReach classifies
  active / degraded / silent from it, and the replay's "load the network as it
  was" filter uses it. `null` means never heard — not "heard at epoch".
- **`relay_count_24h`** is used as a liveness/'"is it actually relaying"
  signal. Approximate is fine; monotonic-ish is enough.
- **`hash_size`** and **`default_scope`** only matter to the simulator (path
  hash width and which region a repeater floods into). Send them if you have
  them, omit if not.

## 3. Endpoint 2 — `GET /api/nodes/{pubkey}/reach`

**Observed** links from one repeater. This is the calibration input, and it's
the endpoint that most distinguishes a useful backend from a plain node list.

```
GET /api/nodes/{pubkey}/reach?days=7
```

```json
{
  "links": [
    {
      "pubkey": "d4e5f6…",     // the other end
      "name": "Bishop Hill",
      "lat": 56.22, "lon": -3.29,
      "bottleneck": 14,          // see below — the important one
      "bidir": true
    }
  ]
}
```

- **These must be *observed* links, not predicted ones.** HopReach uses them as
  ground truth to score its own propagation model; feeding predictions back in
  makes the calibration meaningless.
- **`bottleneck`** = the observation count of the *weaker direction* of the
  pair. HopReach uses it directly as a confidence weight, so its meaning
  matters more than its scale: "how sure are we this link is real and mutually
  usable". If you only have a single direction, report that count and set
  `bidir:false`.
- `days` bounds the window. Honour it if you can; ignoring it degrades quality
  rather than breaking anything.

## 4. Endpoint 3 — `GET /api/scope-stats`

Region/scope names, used to populate the scope filter and the simulator's
"send as region" control.

```
GET /api/scope-stats?window=7d
```

```json
{ "byRegion": [ { "name": "sco" }, { "name": "fif" }, { "name": "ioi" } ] }
```

Only `byRegion[].name` is read. Anything else you include is ignored.

---

## 5. Packet replay (endpoints 4 and 5)

These power the simulator that reconstructs a single real transmission —
including *negative evidence*: which observers were alive and listening but
did **not** hear it. That's what makes the replay honest, and it's the part
that most depends on your data model.

### 5.1 `GET /api/packets` — recent packets

```
GET /api/packets?limit=500&offset=0&sort=timestamp&order=desc
```

**One row per packet, not per observation.** HopReach guards against
per-observation rows (it dedupes by `hash`) because otherwise one flood looks
like several nodes transmitting the same thing at the same instant. If your
model is observation-shaped, collapse it before returning.

```json
{
  "packets": [
    {
      "hash": "bb03d26ad149d4ee",         // stable packet id
      "timestamp": "2026-08-01T21:32:04Z",// when it was heard
      "observer_id": "aa11…",             // which observer this row came from
      "resolved_path": ["d4e5…", "a1b2…"],// relays, resolved to full pubkeys
      "route_type": 1,                     // 0/1 = flood (see below)
      "snr": -7.5,                         // nullable
      "raw_hex": "10a2…",                 // the raw frame, hex
      "decoded_json": "{\"pubKey\":\"…\"}"// stringified JSON, see below
    }
  ]
}
```

- **`sort=timestamp&order=desc` plus `offset` must work.** HopReach has no
  server-side time-range filter available, so it binary-searches backwards
  through offsets to find a historical window. Without stable ordering this
  cannot work.
- **`resolved_path`** is the killer feature: path *hashes* resolved to full
  public keys. If you only store raw hashes, resolving them is your job —
  HopReach can't (hashes are 1–3 bytes and ambiguous without the directory).
  Order is transmission order (first relay first). Empty array = heard direct.
- **`route_type`**: `0` or `1` mean flood; anything else is treated as
  directed and excluded from flood reconstruction.
- **`raw_hex`** is parsed for frame details (payload type, hash size). Send the
  frame exactly as received, no framing bytes added.
- **`decoded_json`** is a **stringified** JSON object (not a nested object).
  Only `pubKey` is read from it — the packet's originator, used to place the
  transmission. If you can't decode, send `"{}"`.

### 5.2 `GET /api/packets/{hash}` — one packet, every observation

```json
{
  "packet": { … same shape as a list row … },
  "observations": [
    {
      "observer_id": "aa11…",
      "observer_name": "Cadham",
      "timestamp": "2026-08-01T21:32:04Z",
      "resolved_path": ["d4e5…"],
      "snr": -7.5
    }
  ]
}
```

**This is the endpoint that must be complete.** The list gives one
representative observation per packet; the detail must give *all* of them,
because the replay compares "who heard it" against "who was listening", and a
missing observation reads as a delivery failure. An incomplete detail response
will make HopReach report coverage failures that didn't happen.

---

## 6. What HopReach infers, so you don't have to build it

Don't feel obliged to model these — they're computed from the above:

- **Observer liveness / negative evidence.** HopReach fetches packets in a
  ±5 minute window around the target and classifies each observer as heard /
  busy (its own airtime overlapped) / alive-but-silent / unknown.
- **Coverage, link budgets, terrain.** Entirely HopReach's side.
- **"Was the packet's failure local or distant."** Derived from the observed
  relay chain plus the silent-observer set.

## 7. Suggested build order

1. `/api/nodes` with positions and `last_heard` → maps render.
2. `/api/scope-stats` → the scope UI stops being empty. (Trivial.)
3. `/api/nodes/{pubkey}/reach` → calibration turns on, predictions get real.
4. `/api/packets` + `/api/packets/{hash}` → the replay simulator works.

Steps 1–3 are a normal "what nodes exist and who hears whom" database. Step 4
is the one that needs per-packet observation storage with resolved paths — if
that's not in your data model, stop at 3 and HopReach still does its main job.

## 8. Integration on the HopReach side (for Alex, not the friend)

Today `internal/corescope` is a concrete client, and the browser calls
`/corescope-api/…` through nginx. Supporting a second backend means:

1. Extract a `MeshDataSource` interface over the five calls above
   (`FetchRepeaters`, `FetchReach`, `FetchScopes`, `FetchPackets`,
   `FetchPacketDetail`) with the current client as its first implementation.
2. Move the base URL + backend kind into `config.yaml` and the nginx
   `/corescope-api/` proxy target (already templated by `-prepare`).
3. If a second backend's shapes differ, adapt **in the client**, not in
   `simulator.js` — the browser should keep seeing one shape.

A backend that matches this spec exactly needs only step 2.
