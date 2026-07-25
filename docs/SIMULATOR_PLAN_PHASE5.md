# Simulator plan, phase 5 — calibrate against the real network

Status: **not started**. Handover document, same shape as phases 3/4.

Three related asks, all about closing the loop between the simulator and
the real ScotMesh network rather than adding more simulated features:

1. **Infer the network's CURRENT settings** from real CoreScope packets —
   "start with the assumption they are the default then go from there."
   The point is a **baseline**: what is the mesh actually running today,
   so every later prediction has a real starting point instead of a guess.
2. **Improve real-packet replay** — a packet heard only *n* times: what
   traffic was around it, where the problem was, predicted vs actual.
   Critically including that **most observers are themselves repeaters,
   so they are deaf while transmitting**.
3. **Payload modelling is weak** — the current min/max uniform draw
   doesn't resemble real traffic.

---

## What the data actually supports (researched, not assumed)

All figures below were pulled live from the production CoreScope
(`scotmesh-corescope.mm7roq.compute.oarc.uk`) on 2026-07-25 while writing
this. **Re-check before building** — these are one sample of a live
network, not fixed properties.

### `/api/packets` list — per packet

`hash`, `timestamp`, `first_seen`, `observation_count`, `observer_id`,
`observer_name`, `observer_iata`, `snr`, `rssi`, `raw_hex`, `route_type`,
`payload_type`, `path_json` / `_parsedPath` (hop hashes),
`resolved_path` (full pubkeys), `decoded_json` (includes a
`sender_timestamp` for decrypted channel messages).

### `/api/packets/{hash}` — per observation

`{id, hash, observer_id, observer_name, observer_iata, snr, rssi,
direction, timestamp}`.

### The key finding: repeated observations ARE the timing signal

One packet (`d26b11006c97654b`) was heard by a **single observer four
times**:

| Time | SNR | RSSI |
|---|---|---|
| 09:52:49 | 1 | -107 |
| 09:52:51 | 6 | -78 |
| 09:52:52 | 11 | -60 |
| 09:52:55 | 11 | -52 |

Those are four *different relay hops* of the same flood reaching the same
receiver, at different signal strengths, spread over 6 seconds. **That
spread is a direct function of the relay delays**, which is exactly what
we want to infer. `RetransmitDelayMs` draws `random(0, 5·airtime·factor)`
per hop, so the accumulated spread over a multi-hop flood scales with
`txDelayFactor` — an observable, simulatable quantity.

### Sample characteristics (40 recent packets)

- `observation_count`: **24 of 40 were heard exactly once** — no timing
  signal at all from those. The usable 16 ranged 2–12.
- `resolved_path` length: 19 of 40 were empty/unresolved; the rest 1–11
  hops.
- `route_type`: 15 flood (0), 8 (1), 17 (2).

So roughly **40% of packets carry usable multi-observation timing**. That
is a real, workable sample from a live mesh, but it is not most traffic —
any calibration must be built to accumulate evidence across many packets
rather than expect a verdict from one.

### The hard limits — read before designing anything

1. **Timestamps are second-resolution.** Every observation timestamp ends
   `.000Z`. MeshCore per-hop delays are hundreds of milliseconds. **We
   therefore cannot measure a single hop's delay directly, ever.** Only
   *accumulated multi-hop spread* (seconds) is measurable. Any design
   that needs millisecond hop timing is dead on arrival — do not start
   down that path.
2. **Clock skew between observers is unknown and unbounded.** Two
   observers' absolute timestamps are not comparable. Only **spreads
   within a single observer's own observations** are safe. This is a
   sharp constraint and it rules out the most obvious approach
   (cross-observer arrival ordering).
3. **Observers are repeaters, and repeaters are deaf while transmitting**
   (the user's own point, and correct — `engine.go`'s `tx_busy`, phase 2
   item 13). An observer that missed a copy may simply have been keyed up.
   **Absence of an observation is therefore not evidence of a collision.**
   Any inference that treats "not heard" as "collided" will be
   systematically wrong, biased worst at exactly the busy repeaters that
   matter most.
4. **`observation_count == 1` for ~60% of packets** — no spread, no
   signal. Those packets can still contribute *path* evidence but not
   *timing* evidence.
5. **We do not know the real settings** — that is the entire point. There
   is no ground truth to validate an inference against, only
   self-consistency. Say so plainly in any output.

---

## Work item 1 — infer current network settings (the baseline)

**Goal**, in the user's words: "finding what the current settings of the
network are... it provides a nice baseline."

### Approach: simulate-and-compare, not solve

We cannot read settings off the wire. What we CAN do is: for each
candidate `txDelayFactor`, simulate the real observed topology and
compare the **distribution of per-observer inter-arrival spreads** the
simulation produces against the one CoreScope actually recorded. The
candidate whose distribution best matches is the best estimate.

This is the same shape as the existing `SuggestPolicy` search — sweep
candidates, score each, rank — with a different objective function. Reuse
that structure rather than inventing a second search.

### The observable: per-observer arrival spread

For one packet and one observer with ≥2 observations, the spread is
`max(timestamp) - min(timestamp)` in seconds. Aggregate across many
packets into a distribution (median, p25/p75). Simulate the same packets
and compute the same statistic from `Report.Receptions` grouped by
`(packetID, node)`.

**Bucket to whole seconds before comparing** — the real data has
1-second granularity, so the simulated statistic must be degraded to
match, or the comparison is measuring resolution rather than delay. This
is easy to get wrong and would silently produce a confident, meaningless
answer.

### Starting assumption, per the user

Begin at firmware defaults (`txDelayFactor 0.5`, `rxDelayBase 0`,
`directTxDelayFactor 0.3` — `prefs.go`'s `DefaultNodePrefs`), sweep
around them, and report how far the evidence moves us. Report the whole
ranked sweep, not just a winner — with a ~40% usable sample and
second-resolution timing, adjacent candidates will often be
indistinguishable, and showing that honestly is the point.

### Output

A per-candidate table (candidate → match score → simulated vs observed
spread distribution), plus an explicit confidence statement covering: how
many packets contributed, how many were unusable, and whether the top
candidates are actually separable. **If they are not separable, say
that** rather than reporting a false winner.

### What NOT to do

- Don't compare absolute timestamps across observers (clock skew).
- Don't infer a *per-node* setting — the sample per node is far too thin.
  This estimates a **network-wide** typical value; anything finer needs
  evidence we don't have.
- Don't present the result as "your network is set to X". It is "the
  observed timing is most consistent with X, given these assumptions."

---

## Work item 2 — improve real-packet replay

The existing replay (`replayFromHash`, `simulator.js`) already fetches
observations, builds proven edges, and compares predicted vs proven. What
it does not do is explain **why a packet was heard only n times**.

### 2a. Observer deafness — the correctness fix, do this first

Today, a predicted-but-unconfirmed hop renders as "the model expected this
and reality didn't back it up," implicitly suggesting a collision. That is
wrong whenever the observer was transmitting at the time — it heard
nothing because its own radio was keyed, exactly as `tx_busy` models.

For each unconfirmed hop, check whether that observer has its own
transmission (any packet in the surrounding-activity window it appears as
a relay in) overlapping the expected arrival. If so, classify it
**"observer was transmitting — can't be evidence either way"** and
exclude it from the discrepancy count.

This is a correctness fix, not a feature: without it the tool reports
false collision evidence, worst at the busiest repeaters.

### 2b. "Heard only n times" — the surrounding-traffic explanation

For a target packet, use the already-fetched ±window traffic to build a
contention picture: which other packets were on the air, overlapping
whose expected reception, at which nodes. Then classify each expected-
but-missing observation as one of:

- observer was transmitting (2a)
- another packet's airtime overlapped the expected arrival (real
  collision candidate)
- no overlapping traffic found — genuinely unexplained (say so; don't
  invent a cause)

Reuse `AblationFlags`-free normal `Run` output for the predicted side;
the classification is a post-processing step over `Report.Receptions`
plus the real window, not new engine work.

### 2c. Predicted vs actual, side by side

Extend the existing bottleneck view into a per-observer table: expected
arrivals vs actual, with each discrepancy carrying its 2b classification.
The existing `renderBottleneckAnalysis` is the natural home.

### Honesty requirement

`observation_count` is bounded by **how many observers exist and were
listening**, not by how well the packet propagated. A packet heard once
in a corner with one observer is not worse-delivered than one heard 12
times in Edinburgh. Normalise by observers plausibly in range, or state
the caveat prominently — otherwise this metric will systematically
flatter dense areas.

---

## Work item 3 — payload modelling

**Current state:** `messagesFromState` draws `randomInt(minPayload,
maxPayload)` uniformly (`simulator.js`), defaults 10–50 bytes. Real
traffic is nothing like uniform.

**Measured, 60 recent packets — on-air bytes** (`raw_hex` length):
min 22, p25 28, **median 41**, p75 108, max 146.

By `payload_type`:

| Type | n | Median | Range |
|---|---|---|---|
| 0 | 4 | 23 | 22–38 |
| 1 | 9 | 32 | 22–70 |
| 2 | 20 | 38 | 22–70 |
| 4 | 10 | 133 | 123–146 |
| 5 | 12 | 88 | 47–139 |
| 7 | 1 | 69 | 69 |
| 8 | 4 | 32 | 22–51 |

Two clear problems with the current model:

1. **The default 10–50 range is wrong at the bottom.** The real minimum
   observed is 22 bytes on air; nothing is 10. And `raw_hex` is the whole
   frame while `payloadLen` is the application payload, so the two aren't
   directly comparable — **resolve which quantity the UI field actually
   means before changing defaults**, or this "fix" will just introduce a
   different systematic error. (Phase 3 added `onAirLen`; the UI field
   is payload, the measurement above is frame. Don't conflate them.)
2. **Uniform is the wrong shape.** The distribution is strongly bimodal —
   a dense cluster of short control/text traffic around 22–40 bytes and a
   separate cluster of large packets (types 4/5) at 88–146. A uniform
   draw over 10–50 never generates the large cluster at all, and airtime
   scales with length, so the simulator is systematically *under*-modelling
   airtime and therefore contention.

### Proposed

Offer traffic **profiles** instead of a bare min/max: a named mix
(e.g. "typical ScotMesh traffic") that samples from the real measured
distribution by payload type, alongside the existing manual min/max for
deliberate what-ifs. Keep min/max — it's the right tool for "what if
everyone sent 200-byte messages" — but stop making it the only option.

Source the profile from a real measured sample and **record when it was
sampled**, the same provenance discipline phase 4's `MeshMethod.Source`
uses: a traffic mix is an observation of one network at one time, not a
constant.

---

## Suggested order

1. **2a (observer deafness)** — a correctness fix to an existing shipped
   feature that currently reports misleading evidence. Smallest, highest
   value.
2. **3 (payload profiles)** — self-contained, improves every simulation
   including the calibration in 1.
3. **1 (settings inference)** — the biggest and most speculative; benefits
   from 3 landing first, since a wrong payload distribution directly
   biases the airtime that drives the spreads being matched.
4. **2b/2c** — richest UI work, most valuable once 1 gives a real baseline
   to replay against.

## Risks and things not to do

- **Don't build anything needing millisecond hop timing.** Second-
  resolution timestamps make it impossible. This is the single most
  important constraint in this document.
- **Don't compare timestamps across observers.** Clock skew is unknown.
- **Don't treat "not observed" as "collided."** Observers are deaf while
  transmitting (2a).
- **Don't report a single inferred setting without a separability check.**
  With ~40% usable packets and 1-second resolution, adjacent candidates
  will frequently be indistinguishable — reporting a winner anyway would
  be exactly the overconfidence phase 4 work item 8 found in another
  project's simulator.
- **Don't conflate `raw_hex` frame length with `payloadLen`.** See work
  item 3.
- **Don't hardcode a traffic profile without recording when it was
  sampled.** It's an observation, not a constant.
