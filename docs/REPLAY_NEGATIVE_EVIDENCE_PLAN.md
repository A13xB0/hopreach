# Packet-replay accuracy: negative observer evidence — plan

Trigger: replaying `bb03d26ad149d4ee` shows the packet spreading beyond Fife,
while reality recorded **no observation outside Fife**. The replay currently
treats "no observation" as "no information" — it never asks what the silent
observers were doing. This plan adds negative evidence to the loop and
collects the other accuracy gaps found while auditing the replay pipeline.

## Case study: bb03d26ad149d4ee (2026-07-31 00:15:31Z, route 0, 105 B)

What CoreScope actually recorded (fetched from the live ScotMesh instance):

| Observer | Activity around target | Heard it? | Verdict |
|---|---|---|---|
| Cadham Village 🏘️ (Fife) | 15 pkts in ±5 min | ✓ twice — direct at +0 s AND via 2 relays (`04f1fe…→50480d…`) at +3 s | **HEARD** |
| Waulkmilton_Farm | active −155…−150 s and +41 s | ✕ | **healthy & silent** — was reporting minutes either side, idle at 00:15:31 |
| NOC-PYMC-JLO | active −63 s and +26 s | ✕ | **healthy & silent** |
| SCO-ANG-02-RPT (Angus) | one pkt at −73 s | ✕ | **healthy & silent** (weaker — sparse feed) |
| INV MQTT OBSERVER (Inverness) | last at −188 s | ✕ | **healthy & silent** (weaker) |

The user's actual run used a ±60 s window, which contains just **3 packets**:
the target (+0 s, Cadham), `6ed547…` (+26 s, heard by NOC-PYMC-JLO) and
`809ae8…` (+41 s, heard by Waulkmilton_Farm). So both NOC-PYMC-JLO and
Waulkmilton_Farm sit in `allObservers` **provably alive within the window**,
neither is exonerated by the same-second deaf check (nothing overlaps the
target's second), and both become "over-predicted, or a real miss we can't
explain" rows while the map still shows the full model spread — exactly the
reported symptom. The evidence to constrain the prediction was already in
the window; the algorithm just doesn't use it. Reality: the packet was relayed twice *inside* Fife
and still reached no observer beyond it. Note Waulkmilton_Farm heard a
comparable Fife packet (`36e1a1e6…`) directly earlier the same night — the
link exists in quiet conditions, which is exactly why the terrain model
predicts escape. Something situational (the user's collision theory —
plausibly at a relay, which CoreScope can never log, because two overlapped
transmissions decode as nothing) killed it *this time*.

**Conclusion:** the model's "could reach" is being presented as "did reach".
Four healthy observers say it didn't.

## Root causes in the current code (`public/simulator.js`)

1. **Negative evidence is collected but toothless.** `computeEpisodeStats`
   lists over-predictions ("our sim over-predicted, or a real miss we can't
   explain") but nothing constrains the map, the headline, or the topology.
   The terrain-fill links let the simulated flood go anywhere terrain allows.
2. **The deaf check is too narrow.** Same-second + relaying-only:
   - misses observers **mid-RX** of another packet (half-duplex — can't
     decode two overlapping frames);
   - ignores airtime (a 2 s SF11 frame occupies far more than its start
     second) and CoreScope's 1 s timestamp resolution;
   - can never see an observer's **own transmissions** (CoreScope logs what
     observers hear, not what they send) — invisible deafness that must stay
     an acknowledged unknown, not be conflated with "unreachable".
3. **No liveness model.** A silent observer might simply be offline. The
   ±30 s reconstruction window is far too short to tell (here, every
   non-hearing observer's nearest activity was 26 s–3 min away) — liveness
   needs its own wider lookback.
4. **The window fetch silently truncates for old packets.**
   `fetchPacketsAroundTime` doubles `limit` fetching the *newest* packets
   until the window is covered — a packet 1,700 rows deep (like this one)
   either drags in thousands of rows or hits `REAL_TIMELINE_MAX_LIMIT` and
   returns partial coverage. Missing window traffic = missing busy/deaf
   evidence AND missing background channel load.

## Design

### A. Observer evidence classification (pure function + tests)

For every observer in the reconstruction, classified **at the real target
time** (not sim time):

| State | Rule | Evidential weight |
|---|---|---|
| `heard` | in the target's observations | ground truth ✓ |
| `busy` | relayed **or observed** any other packet whose airtime window (frame bytes × radio params, ±2 s slop for 1 s timestamps) overlaps the target's transit | could have missed it — **no** negative weight |
| `silent-active` | not busy, and own feed shows activity within the liveness lookback (default ±5 min, its own cheap fetch) | **strong**: packet did not reach it *this time* |
| `silent-unknown` | no activity in the lookback | none — possibly offline |

Airtime comes from the same LoRa time-on-air math the sim already has
(`internal/meshsim/airtime.go` semantics, mirrored in JS); radio params from
the packet's own frame where parseable, else region defaults.

### B. Evidence-constrained predicted reach (the headline fix)

After a run, prune the delivery graph (`Reception` already carries
`FromNode` + full `Path`):

1. Remove the target's sim-deliveries at every `silent-active` observer.
2. Transitively remove any downstream delivery whose **every** delivery path
   passes through a removed node.
3. The **primary** map result and headline become the constrained reach.
   The raw model spread stays available as a clearly-labelled secondary
   layer ("model says it *could* reach here in quiet air — contradicted by
   N observers this time"), because `silent-active` proves *this packet
   didn't arrive*, not that the link never works (see Waulkmilton above).

For bb03d26… this collapses the predicted spread to Fife: every escape path
runs past Waulkmilton_Farm / NOC-PYMC-JLO, both healthy and silent.

### C. Analysis table + headline upgrades

- Over-prediction rows get the four-state label and plain-language reasons:
  "was mid-receive of `6ed547…` — could have missed it" vs "healthy and
  silent — the packet never reached here".
- Headline: "Constrained by observer evidence, this packet reached ~N
  repeaters (model alone claimed M)."
- Keep the invisible-TX caveat in the UI copy: an observer that was
  *transmitting* at that instant leaves no CoreScope trace, so
  `silent-active` at a repeater-observer is strong-but-not-certain.

### D. Window fetch correctness (prerequisite for honest evidence)

Replace newest-first limit-doubling with an **offset binary search** on
`sort=timestamp&order=desc` (two dozen 1-row probes locate any historical
time in seconds — validated against the live instance), then one bounded
fetch spanning the window; same approach powers the ±5 min liveness
lookback cheaply. Kills the silent truncation cap entirely.

## Further accuracy improvements (audit findings, in priority order)

1. **Proven-edge SNR is fabricated.** Every real edge gets `snrDb: 20`;
   CoreScope observations carry the *actual* SNR/RSSI — grade proven edges
   with real values so collision capture behaves like the real link, not an
   idealized one.
2. **Origin inference is one hop late for non-adverts.** The flood is
   injected at the first *observed* relay; the true sender is one hop
   upstream and unpositioned. At minimum stamp hop-count comparisons with
   the offset; better, synthesize an unpositioned virtual origin node so
   first-hop airtime and contention are modelled.
3. **Deterministic single run overstates certainty.** CoreScope's 1 s
   timestamps mean reconstructed send order within a second is arbitrary —
   and collision conclusions flip on it. Run N seeds with ±1 s timing
   jitter and report per-node delivery **probability**; the reach layer
   shows P ≥ threshold instead of a binary flood. (The engine is already
   seeded-RNG — `rng.go` — so this is a loop, not a rewrite.)
4. **Path-level recall, not just observer-level.** Cadham's second
   observation proves two specific relays fired; the comparison currently
   only scores "observer heard: yes/no". Scoring each real relay hop the
   sim did/didn't reproduce localizes *where* the model diverges.
5. **Window packets contribute only one observation each** to proven
   topology (the target's full detail is special-cased). Fetching details
   for the top few window packets (bounded) would thicken the proven-edge
   graph where it matters most: the minute around the target.

## Phases

1. **Evidence core**: classification function (shared JS module w/ unit
   tests — the repo already runs JS tests via Playwright; plain node-test
   for the pure module), window-fetch binary search + liveness lookback.
2. **Constrained reach**: delivery-graph pruning + map layer split +
   headline/table copy. Validate against bb03d26… (must collapse to Fife)
   and against a healthy multi-observer packet like 36e1a1e6… (must NOT
   over-prune).
3. **Edge realism**: real SNR on proven edges; origin-offset handling.
4. **Probabilistic reach**: N-seed jittered runs → per-node probability.

Phase 1+2 are the user-visible fix; 3+4 are follow-on accuracy work that can
land independently.

---

# Round 3: collided-at-observers vs died-near-origin — failure localization

New symptom (full 61-node alive-at-time network): the sim now spreads the
target far and shows it **colliding at the distant observers**. Ground
truth from the user: real people outside Fife never received it, and few
observers heard it — so the killing collision was **local to the sender's
area**, not out at the observers. The sim found a *different wrong story*
that also produces silent observers.

## The core subtlety the current algorithm misses

**A collided arrival and a never-arrival are indistinguishable in a
CoreScope log.** An observer that receives only overlapping copies decodes
nothing and logs nothing. So `silent-active` refutes *clean delivery* only
— and the sim's "reached them all but every copy collided" story is
technically consistent with every observer log. The two stories differ
enormously in what they claim about the mesh (wave crossed Scotland vs
wave died in Fife), and the current display picks whichever one the seed
happened to produce. That must become an explicit, evidence-scored
discrimination instead.

## How to discriminate: parsimony, made quantitative

- *Died near origin*: ONE event (a relay's rebroadcast lost to a local
  collision) explains every silent observer at once.
- *Collided at the ring*: requires an independent unlucky collision at
  EVERY distant receiver simultaneously — despite capture effect,
  different geometries, and timing jitter. Across an ensemble of jittered
  runs, some timelines deliver cleanly to some of them.

So: run the existing 10× jittered ensemble and compute, per silent-active
observer, `p_i = P(clean delivery under the model)`. Then
`P(all silent | model spread) = Π(1 − p_i)`. If that's tiny (it will be,
with 4–5 healthy silent observers), report plainly: *"if the flood had
really spread as modelled, the chance of every healthy observer staying
silent is X% — the flood almost certainly died earlier."*

## Failure-frontier inference ("where did it die")

Evidence pins a **proven core** that certainly transmitted: the origin,
plus every relay in the observed paths (bb03d26: origin → `04f1fe…` →
`50480d…` → Cadham). The wave therefore died **at or after the proven
relays' rebroadcasts**. Hypothesis space = cuts in the flood expansion:

- H0: no cut (model spread is right) — scored by the ensemble likelihood
  above;
- H_k: transmission k's rebroadcast was lost (one per proven relay and
  per first-ring model neighbour of the origin);
- boundary hypothesis: everything beyond the proven core failed.

Score each cut with the link-graph BFS (fast, no sim runs): reach under
the cut must still cover every `heard` observer, and is penalized per
silent-active observer it cleanly reaches. Prefer minimal cuts. Report
the winner on the map (highlight the frontier ring + the lost
transmission) and in text: *"most consistent story: [relay]'s rebroadcast
was lost — a single local loss near the sender explains all N silent
observers"* — the user's manual conclusion, derived automatically. Cause
attribution stays honest: a collision at a relay is unobservable in
CoreScope (nothing decodes), so name overlapping window transmissions if
any exist, else say "cause unobservable — consistent with a local
collision or interference".

## Display honesty fixes that ride along

1. Target receptions at silent-active observers that the sim marks
   COLLIDED currently still animate/read as "it got there (and collided)"
   — reclassify as **ambiguous** ("a collision would explain the silence —
   see likelihood analysis"), count them separately in the bottleneck
   summary, and stop animating them into contradicted territory (prune
   target receptions at contradicted nodes regardless of collided flag —
   their presence there is exactly the disputed claim).
2. Episode headline gains the ensemble verdict: constrained reach,
   model reach, and `P(all silent | model)` with the plain-language
   conclusion.

## Phases

1. Pruning + ambiguity relabel (display honesty; small).
2. Ensemble likelihood in the 10× runs + headline verdict.
3. Failure-frontier inference (BFS cut scoring) + map highlight + text
   conclusion.
