# Simulator plan, phase 8 — reproduce and repair real network episodes

Status: **not started**. Plan / handover document, same shape as phases 3–7.

## Goal (the user's own words)

> Use the real payloads so we can see actual and predicted, and replay it
> like a simulation we set up with senders. Reproduce it: set up the senders
> from that period of time around the packet, so we can then modify settings
> to see if we can eliminate the problems.

In one sentence: turn a real CoreScope time window into a **saved,
modifiable, reproducible simulator setup** — real repeaters, real
connectivity, real traffic as senders with real payloads — then run our own
prediction beside what actually happened, and let the user (or the
optimizer) change settings and re-run to see whether the real problems go
away.

This is the natural convergence of everything already built: the real-packet
replay, the surrounding-traffic window, saved setups, the payload/wire
decoder, and the adaptive optimizer. Most of the pieces exist; phase 8 is
mostly *wiring them together* plus one genuinely new comparison view.

## What already exists — reuse, don't rebuild

- **`fetchPacketsAroundTime(targetMs, windowMs)`** (`simulator.js`) — fetches
  every packet in ±window, already handles CoreScope's limit/offset-only
  API and reports partial-coverage (`hitCap`).
- **`replayFromHash` / `renderBottleneckAnalysis`** — the single-packet
  actual-vs-predicted comparison (proven edges vs a predicted flood). Phase 8
  generalises this from one packet to a whole window.
- **`buildRealTimeline`** — the ±30s real-activity replay animation; already
  turns window packets' `resolved_path`s into chronological hops.
- **Saved setups** (`SETUP_STORAGE_KEY`, `applySetupData`) — persist nodes,
  links, senders, and run controls. The reconstructed episode is just
  another setup, so "reproduce it" is largely free.
- **`parseMeshFrame`** (added phase 7) — decodes `raw_hex` into real
  `payloadLen` / `hashSize` / scoped-ness, validated against 400 real frames.
- **Proven-edge topology reconstruction** — validated in phase 7 at **100%
  delivery recall** against real floods; this is the trustworthy
  connectivity source.
- **The adaptive optimizer** (phases 4/6) — already minimises contention
  while protecting delivery. Point it at the reconstructed real scenario and
  "modify settings to eliminate the problems" is a button, not a manual
  chore.

## What the real data supports (re-verified for this plan)

### Identifying who sent each packet

Checked across 300 live packets, by `payload_type` → `decoded_json`:

| Type | Decoded | Origin identity available |
|---|---|---|
| 4 ADVERT | `pubKey` (full) | **Exact** — the advertiser |
| 0/1/2/8 REQ/RESPONSE/TXT_MSG/PATH | `srcHash` (1 byte) | Ambiguous — narrows to nodes whose key hashes to it |
| 5 GRP_TXT (channel) | `channelHash` only | **None** — encrypted, no source |
| 7 ANON_REQ | `ephemeralPubKey` | **None** by design |
| 3 ACK | — | **None** |

So the true origin is only cleanly known for adverts. **But every packet's
`resolved_path[0]` is a known node that heard the origin directly** — so the
universal reconstruction injects each packet at its first *observed* relay,
losing at most the single origin→relay0 hop. Adverts can refine to the true
origin.

### The design split that makes this tractable

Not all traffic is floodable in our model (direct route types 2/3 are
addressed, and we don't route them; channel/anon traffic has no known
origin). Rather than fight that, split the window's traffic by role:

- **Flood traffic (route 0/1) → tunable senders.** These reproduce as real
  flood senders (real payload, hash size, approx send time). Their timing is
  exactly what `txdelay`/`rxdelay`/`flood.max` tuning affects — the whole
  point of "eliminate the problems."
- **Everything else (direct/channel/anon) → fixed background interference.**
  Replayed as its *observed* hops (fixed transmissions at observed times and
  airtimes), contributing realistic channel occupancy and collisions without
  needing an origin or a routing model. It loads the air like reality did,
  but isn't itself the thing being tuned.

This is the key idea: **tune the floods; replay everything else as
background.** It sidesteps origin-identification and direct-routing entirely
while still reproducing the real contention.

### The hard limits (unchanged from phase 5, restated because they gate this)

1. **Timestamps are second-resolution.** We know *which* packets were around
   and their approximate ordering, not sub-second overlap. So the
   reproduction is a *plausible* version of the contention, not the exact
   one. This is fine for tuning ("does raising txdelay reduce collisions
   under this real load?") but must never be presented as an exact replay of
   which specific packets collided.
2. **Observers are repeaters and are deaf while transmitting.** "Not
   observed" ≠ "not received." The actual-vs-predicted view must classify a
   missing observation as *observer was transmitting* (detectable: the
   observer appears as a relay of another window packet at an overlapping
   time) before calling it a prediction gap. (Phase 5 work item 2a.)
3. **Send time is inferred, not given.** A packet's timestamp is when an
   observer first *heard* it, not when it was sent. Use the earliest
   observation time as the injection time (propagation delay is negligible at
   these ranges; relay delay before the first observed hop is not, but is
   bounded and second-resolution swamps it anyway).

## Work items

### 1. Window → scenario reconstruction

New `reconstructEpisodeFromWindow(targetHash, windowSecs)`:
- Fetch the window (`fetchPacketsAroundTime`) and the node directory
  (`ensureNodeDirectory`).
- **Nodes**: every node appearing as an origin, relay, or observer in the
  window, placed at its real lat/lon. `CanRelay` from role; hash size /
  scopes from the node directory (already surfaced elsewhere).
- **Connectivity**: proven edges from every `resolved_path` in the window
  (real, validated) blended with the propagation model to fill gaps a single
  window didn't exercise — exactly the existing `blend` source, but seeded
  with the window's own proven edges.
- **Senders**: each flood packet (route 0/1) → one message generator/sender
  with `origin` (advert pubKey, else `resolved_path[0]`), `sendAtMs` =
  (earliest observation − window start), real `payloadLen`/`hashSize`
  (`parseMeshFrame`), and `region` set iff transport-coded.
- **Background**: non-flood packets recorded as fixed replayed transmissions
  (see work item 4's background-interference support).
- Load it via the existing saved-setup path so it lands in the normal
  workspace, fully editable.

### 2. Sender/origin identification

- Advert: true origin from `decoded_json.pubKey`.
- Otherwise: inject at `resolved_path[0]`, and label the sender clearly as
  "first observed hop (true origin one hop upstream, unobserved)" so the user
  isn't misled.
- Optional refinement for `srcHash` types: offer the candidate nodes whose
  key prefix-hashes to the observed `srcHash` as a picker, defaulting to the
  first-relay injection. Do **not** auto-guess a single origin from a 1-byte
  hash — that's exactly the overconfidence phase 5 warns against.

### 3. Actual-vs-predicted, whole window

Generalise `renderBottleneckAnalysis` from one packet to the window:
- For each real flood packet: **actual** = observers that heard it (+ real
  paths); **predicted** = our sim's canonical deliveries (+ our paths).
- Classify each real observation our sim missed as: *connectivity gap* (no
  path exists in our graph), *collision in sim* (we predict it collided),
  or *genuinely unexplained*. Classify each observer that DIDN'T hear it as
  *observer was transmitting* (deaf, exclude) vs *real miss*.
- Aggregate into a per-episode scorecard: recall vs the real observations,
  predicted-vs-actual collision counts, and a per-repeater problem list —
  the same shape the optimizer already consumes, so the two views agree.

### 4. Background interference + problem detection + repair

- **Background interference**: teach the engine (or the JS message layer) to
  accept *fixed, pre-scheduled transmissions* — a node transmits a given
  airtime at a given time, no flooding, no relay. Non-flood window traffic
  becomes these. They occupy the channel and cause collisions/CAD deferrals
  exactly like real background load. (Engine change: a new `FixedTx` input
  alongside `Message`, or a `Message` variant with `NoRelay`/`FixedHops`.)
- **Problem detection**: run the reconstructed scenario → baseline problem
  counts (collisions, missed deliveries net of deafness, redundant relays,
  contention) — these should roughly match the real observations (a built-in
  sanity check on the reconstruction itself).
- **Repair**: the user edits settings, or runs the adaptive optimizer, then
  re-runs. Show a **before/after** delta on the same problem counts — "12
  collisions → 3, delivery 78% → 91%". This is the payoff.

### 5. Reproducibility

- Save the reconstructed episode as a normal setup, plus **provenance**:
  target hash, window size, CoreScope fetch time, and the API's own data
  version if exposed — the same "record when it was sampled" discipline
  phase 4's `MeshMethod.Source` and phase 5's traffic profiles use. A network
  is not a constant; an episode is an observation of one moment.
- Fixed seed by default, so a re-run is byte-identical and a settings change
  is the *only* variable between before/after (the paired-comparison
  discipline the optimizer already relies on).
- Because second-resolution timing makes any single reconstruction one
  plausible draw, offer a "re-roll timing" (new seed) so the user can confirm
  a settings win holds across several plausible sub-second arrangements, not
  just one lucky one.

## Risks and things not to do

- **Don't present it as an exact replay of what collided.** Second-resolution
  timing forbids that. It's a faithful *load* reproduction with plausible
  sub-second timing — say so in the UI.
- **Don't treat "not observed" as "not delivered."** Observer deafness first
  (work item 3). Getting this wrong reports false prediction failures, worst
  at the busiest repeaters — the exact bias phase 5 flags.
- **Don't auto-pick an origin from a 1-byte `srcHash`.** Offer candidates;
  default to first-relay injection.
- **Don't overfit settings to one reconstructed episode.** Second-resolution
  noise means a settings change that "fixes" one reconstruction may be luck.
  Validate a win across a re-rolled timeline and, ideally, across a few
  different episodes before trusting it — the same hold-out discipline the
  optimizer already applies to seeds.
- **Don't try to route direct/channel traffic.** It's background interference,
  not a flood to reproduce (the design split in work item 1).

## Suggested order

1. **Work item 1 + 2** (reconstruction + sender identity) — this alone gives
   "load a real window as an editable setup," immediately useful and testable
   against the phase-7 recall benchmark.
2. **Work item 4's background interference** (fixed pre-scheduled tx) — the
   one real engine addition; unlocks realistic contention from non-flood
   traffic.
3. **Work item 3** (whole-window actual-vs-predicted with deafness) — the
   "see actual and predicted" view.
4. **Work item 4's repair loop + work item 5** (before/after + reproducibility)
   — the "modify settings to eliminate problems" payoff, mostly wiring the
   existing optimizer and saved-setups in.

## Verification (when built)

- Reconstruct several real windows; confirm the baseline sim's delivery
  recall against the real observations matches phase 7's ~100% union /
  ~96% single-trial figures (a regression guard on the reconstruction).
- Confirm a deliberately-bad setting (e.g. txdelay 0 everywhere) raises the
  predicted collision count, and the optimizer then lowers it back —
  end-to-end proof the repair loop works on real-shaped data.
- The usual: full Go + Playwright suites, the real-data recall check, no
  regression in the existing single-packet replay.
