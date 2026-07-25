# Simulator plan, phase 6 — make the adaptive optimizer actually good

Status: **all tiers done and verified**, built in full at the user's
explicit request rather than following this document's own staged
"measure, then consider D and E" sequencing. Tier 1 (A1, A2, B, C, G(H),
H — tabu list with aspiration, change-triggered tabu clearing, top-K
best-improvement search, widened move set, settable round budget,
flood.max opt-in toggle). Tier 2 (D — adaptive/racing trial budget; E —
Late Acceptance Hill Climbing). Tier 3 (F — SPSA warm start, hybridized
per this doc's own recommendation so its output stays actionable; G —
learned contention-score weights, scoped to ranking only, never
acceptance thresholds). All Tier 2/3 features are opt-in, off by default,
exposed individually behind an "Advanced (experimental)" UI section with
an explicit "try one at a time" note — the risk this document itself
flags ("don't add all of these at once... land one, measure") is real,
so the UI keeps that choice available even though all four shipped in one
release. A real bug was found and fixed live during verification: LAHC's
own textbook "<=" comparison, combined with this domain's deterministic
(non-random) candidate proposal, could let a plateaued run "accept" a
long sequence of no-op lateral moves on the same node every round,
resetting staleness each time and burning the entire round budget without
ever converging — fixed by no longer resetting StaleRounds on a
LAHC-only acceptance (only a strict, non-LAHC improvement resets it; a
LAHC accept still counts toward the stale-rounds limit, exactly like a
rejection would).

Phase 4's optimizer works now (after the paired-comparison and
acceptance-rule fixes), but it is a **naive greedy hill-climber**. This
document diagnoses what's weak about it, researches how this class of
problem is actually solved, and recommends a concrete order of work.

The user's own instinct — *"back off if a repeater could not be optimised
more and try another repeater for a bit, and when it affects that repeater
then move back to it"* — is **exactly tabu search with an aspiration
criterion**, a well-established metaheuristic. It's the right idea and
it's Tier 1 below. There's also a domain-specific refinement of it that
isn't standard practice and is arguably better; see A2.

---

## Concrete diagnosis of what's wrong today

Measured on the 30-node repro fixture built while fixing the last round of
bugs, not hypothesised:

| # | Weakness | Consequence |
|---|---|---|
| 1 | **One move type**: back off the worst node's `txDelayFactor`. Never speeds a node up, never touches `rxDelayBase`/`floodMax`. | Whole regions of the solution space are unreachable. A starving articulation point can never be helped. |
| 2 | **Pure argmax selection** with no memory. | Hammers the same node repeatedly. Exactly what the user noticed. |
| 3 | **Accept-only greedy.** No mechanism to accept a worsening move. | Cannot escape a local optimum. Terminates on `staleRounds` and calls it done. |
| 4 | **One node evaluated per round.** | 30 nodes × 100 rounds ≈ 3 attempts each. Very slow convergence. |
| 5 | **Fixed trial budget per decision** regardless of how close the call is. | Wastes trials on obvious calls, under-samples genuinely close ones. Measured delivery still bounced 0.35–0.43 between rounds *after* the paired-seed fix. |
| 6 | **Contention score is an equal-weighted sum** of four dissimilar quantities. | Documented as "start simple" in phase 4; never revisited. |
| 7 | **No locality exploitation.** | Backing off node A only affects A's neighbourhood, but every round re-measures the entire network. |

---

## Research: how this class of problem is actually solved

This is **simulation optimization** — optimizing a stochastic simulator's
parameters where every evaluation is noisy and expensive. Four literatures
apply.

### 1. Local search metaheuristics (the user's own idea)

[Tabu search](https://www.baeldung.com/cs/tabu-search) maintains a
short-term memory of recently-tried moves and forbids them for a **tabu
tenure**, which forces the search away from a local optimum instead of
cycling. Tenure length is the key knob: *short tenures allow exploration
close to a local optimum (intensification), long tenures drift away from
it (diversification)*
([CMU notes](https://web2.qatar.cmu.edu/~gdicaro/15382/additional/tabu-search.pdf)).

The **aspiration criterion** lets a tabu move through anyway when it would
produce a new best-known solution — present in almost every real
implementation.

Related, and worth knowing: **Late Acceptance Hill Climbing** accepts a
move if it beats the solution from *L* iterations ago, giving
escape-from-local-optima behaviour with a single parameter and no cooling
schedule to tune (unlike
[simulated annealing](https://adam-rumpf.github.io/documents/sa_ts_intro.pdf)).

### 2. Noisy-evaluation budget allocation

[Optimal Computing Budget Allocation](https://www.mdpi.com/2073-8994/11/10/1297)
(OCBA) is one of the most efficient ranking-and-selection algorithms:
spend simulation budget where it changes the *decision*, not uniformly.
Worth noting honestly — OCBA *itself* degrades under heavy noise, and
practitioners add robustness adjustments; it's a direction, not a
drop-in.

[Common Random Numbers](https://arxiv.org/pdf/1910.09259) (CRN) is the
variance-reduction technique already partially applied here (the
paired-seed fix). It can be pushed further.

### 3. Gradient-free high-dimensional optimization

[SPSA](https://en.wikipedia.org/wiki/Simultaneous_perturbation_stochastic_approximation)
perturbs **every** parameter at once and estimates a gradient from **two
evaluations per iteration, regardless of dimension** — versus
finite-differences needing 2× the parameter count. For 30 nodes that's 2
evaluations instead of 60. It's also noise-tolerant by construction.

### 4. Which node to try next = a bandit problem

[UCB1](https://www.jeremykun.com/2013/10/28/optimism-in-the-face-of-uncertainty-the-ucb1-algorithm/)
selects `argmax[Q(a) + c·√(ln t / N(a))]` — value plus an uncertainty
bonus that grows for arms tried less often. This is a principled
alternative to pure argmax that gets the "try another repeater for a bit"
behaviour *for free*, without an explicit tabu list.

### 5. Domain literature — the broadcast storm problem

The canonical framing
([Ni et al., *The Broadcast Storm Problem in a Mobile Ad Hoc Network*](https://link.springer.com/article/10.1023/A:1013763825347))
identifies flooding's three costs as **redundancy, contention, and
collision** — and finds that *schemes to reduce redundant rebroadcasts and
differentiate timing of rebroadcasts* are what help.

That is a direct match for this project:
- "differentiate timing of rebroadcasts" = `txDelayFactor`, the only thing
  our optimizer currently touches.
- "reduce redundant rebroadcasts" = the **counter-based schemes** in that
  literature, which map onto MeshCore's own `loop.detect` and onto our
  `RedundantRelays` metric — and which the optimizer **never adjusts**.

Optimizing only timing while ignoring redundancy is leaving half the
established solution space untouched.

---

## Recommendation

### Tier 1 — do these; biggest win per unit effort

**A1. Tabu list with aspiration.** Forbid a `(node, direction)` move for a
tenure after it's rejected. Aspiration: allow it anyway if it would set a
new global best. Directly fixes weakness #2 and implements the user's
idea. Start with tenure ≈ `√(nodeCount)`, make it configurable.

**A2. Domain-specific aspiration — clear a node's tabu when its situation
materially changes.** The user's phrasing was *"when it affects that
repeater then move back to it"*, which is sharper than standard tabu.
Standard tenure is a fixed iteration count; here we can do better, because
we can *observe* whether a node's own contention score moved since it was
tabu'd. If node A was rejected but a later accepted change to neighbour B
shifts A's score by more than some threshold, A is worth retrying
immediately — the reason it failed may no longer hold. **This is not
standard tabu practice and is a genuine improvement available because we
have per-node measurements.** Flagging it as the most interesting idea in
this document.

**B. Evaluate the top-K offenders per round, take the best.** This is
best-improvement vs first-improvement local search. Costs K× the
evaluations per round, but it is the most direct answer to *"the absolute
best results per round"* — each round makes the best available move rather
than the first acceptable one. Suggest K ≈ 3–5, configurable.

**C. Widen the move set.** Add: speed up (not just back off), adjust
`rxDelayBase`, adjust `floodMax`. Per the broadcast-storm literature, the
`floodMax`/redundancy axis is half the established solution space and is
currently untouched. Cheap to add — the rule machinery already supports
all three fields.

**`floodMax` must be individually disable-able, and should default to
OFF.** See work item H below — it is a categorically riskier move than
the delay knobs and needs its own opt-in.

### Tier 2 — do after Tier 1 lands and is measured

**D. Adaptive trial budget (racing / OCBA-lite).** Run 5 trials; if the
paired difference is decisive, decide; otherwise add more, up to a cap.
Same wall-clock budget buys substantially more decisions, and spends
samples where they actually change the outcome. Addresses weakness #5.

**E. Late Acceptance Hill Climbing** for escaping local optima. Preferred
over simulated annealing here: one parameter, no cooling schedule.
Addresses weakness #3.

### Tier 3 — worth knowing, probably not worth building here

**F. SPSA.** Genuinely the right tool for 30+ simultaneous continuous
parameters, and dramatically more sample-efficient. **But it produces a
diffuse "everything moved a little" result, which is the opposite of the
actionable output this tool exists to produce** — "4 named repeaters need
these exact CLI commands" is the product. A hybrid (SPSA to find the
region, per-node refinement for the final actionable deltas) is possible
but is a large build for uncertain benefit. Recommend **not** doing this
unless per-node search proves too slow in practice.

**G. Learn the contention-score weights.** Weakness #6 is real but
low-priority: phase 4 already made delivery the primary objective with
contention as a proxy/tiebreak, which limits how much the weighting can
mislead.

### Explicitly reconsidered and rejected

**UCB1 instead of a tabu list.** Elegant, and gets exploration for free.
Rejected because the "arms" here aren't stationary — a node's value
changes when its neighbours change, violating the assumption UCB's
regret guarantees rest on. A2's change-triggered tabu clearing models that
non-stationarity directly and is easier to explain in the UI, which
matters for a tool whose output people paste into real radios.

---

## Work item G — user-settable round budget

Today `OPTIMIZE_MAX_ROUNDS` (100) and `OPTIMIZE_STALE_ROUNDS_LIMIT` (25)
are hardcoded constants in `simulator.js`. Make both real inputs so a run
can be as long as the user wants.

### UI

Two fields next to the "🎯🔁 Optimize adaptively" button:

- **Max rounds** — default 100, `0` or blank meaning **unlimited (run
  until it stops improving, or I cancel)**.
- **Give up after N rounds with no improvement** — default 25, `0`
  meaning never give up on staleness alone.

### The interaction that will otherwise confuse people

**A big max-rounds does nothing if the stale limit trips first.** Setting
"1000 rounds" and leaving the stale limit at 25 gets you ~25 rounds and
looks like the setting was ignored. Two mitigations, do both:

1. Surface it in the UI copy: "whichever comes first."
2. When a run stops on staleness while `maxRounds` was set much higher,
   say so explicitly in the summary — "stopped after 25 of 1000 rounds: no
   improvement in 25 consecutive rounds. Raise the give-up threshold to
   keep searching." Don't let the user think the round budget was ignored.

### Go side

`optimizeDefaults` currently treats `MaxRounds <= 0` as "fall back to 30"
and `StaleRoundsLimit <= 0` as "fall back to 5". That collides with using
`0` to mean *unlimited*. Distinguish them explicitly rather than
overloading zero — e.g. a negative value, or a separate
`UnlimitedRounds bool`. **Whichever is chosen, the existing "never
default to unbounded" guarantee must be preserved for callers that simply
don't set the field**: an unset budget must still get a real default, and
only an *explicit* request should mean unlimited.

### Safety

Unlimited rounds is only acceptable because cancellation genuinely works
(phase 4's chunked worker + force-terminate backstop, covered by a
Playwright test). **If that ever regresses, unlimited must be removed at
the same time.** Note this next to the cancel implementation, not only
here.

Also worth surfacing: with Tier 1 **B** (top-K per round) and Tier 2 **D**
(adaptive budget), each round costs several times more than today. A
rounds×cost estimate in the UI ("~2s/round at these settings") would stop
someone setting 10,000 rounds and assuming it's instant.

---

## Work item H — `floodMax` changes must be separately disable-able

Requested by the user, and correct. It should be its own checkbox
("Allow changing flood.max", **default off**), not folded into the general
move set.

### Why `floodMax` is categorically riskier than the delay knobs

This is worth stating plainly, because it's the one place the optimizer
could do real harm that its own safety gate cannot catch:

1. **Delays change *when* a packet is relayed. `flood.max` changes
   *whether* it is relayed at all.** A delay set badly costs latency and
   some collisions; a `flood.max` set too low permanently severs
   everything beyond that hop count. Different kind of failure.
2. **The delivery-first acceptance gate cannot protect against this.** The
   gate only measures delivery *within the simulated scenario*. If the
   scenario's topology is incomplete — and it usually is, since links are
   model-derived or drawn from partial CoreScope observation — then
   trimming `flood.max` can look free in simulation while cutting off real
   nodes the simulator never knew existed. **This is the strongest
   argument for defaulting it off**, and it's a limitation of the gate,
   not something a better gate would fix.
3. **Community practice says leave it alone.** W6HS's own guide (phase 4
   work item 5) explicitly says keep `flood.max` at default "unless your
   design specifically requires a short-range network."
4. **It's harder to undo in the field.** A wrong txdelay is a one-line fix
   on one repeater; a too-low `flood.max` on several repeaters can make
   the far side of the mesh unreachable *and* hard to diagnose, because
   the symptom (distant nodes silent) doesn't obviously point at a hop
   limit.

### Recommendation

- Ship the capability (the broadcast-storm literature is clear that the
  redundancy axis matters), but **default off**.
- When enabled, never let the optimizer *raise* the risk silently: any
  accepted `flood.max` reduction should appear in the action list with an
  explicit warning that it changes reachability, not just timing.
- Consider a floor (never propose below some minimum) so a runaway search
  can't drive it to something absurd.

### Generalise it

Rather than one bespoke `floodMax` flag, make the whole move set
configurable — a small set of toggles for which knobs the optimizer may
touch:

```go
type OptimizeMoveSet struct {
    TxDelay      bool // default true
    RxDelay      bool // default true
    FloodMax     bool // default FALSE — see work item H
}
```

Same shape as `AblationFlags` (phase 4 work item 8), and the same
discipline: the zero value must be sensible. Note that unlike
`AblationFlags`, the sensible zero value here is **not** all-false (that
would disable the optimizer entirely) — so this needs an explicit
constructor or a "unset means default" resolution step, not a bare struct
literal. Easy to get wrong; call it out in the implementation.

---

## Suggested order

1. **G (settable rounds)** — independent of everything else, immediately
   useful, and makes measuring every later change easier (you can run a
   long search to see where a technique actually plateaus).
2. **C (widen move set) + H (move-set toggles)** — do these together;
   `floodMax` should never exist as a move without its own off switch.
3. **B (top-K per round)** — the direct answer to the user's question.
4. **A1 + A2 (tabu + change-triggered clearing)** — the user's own idea,
   plus the domain-specific improvement on it.
5. Measure. Only then consider **D** and **E**.

## Risks and things not to do

- **Don't add all of these at once.** Each changes the search trajectory;
  stacking them makes it impossible to tell which helped. Land one, measure
  on the 30-node repro fixture, then land the next.
- **Don't lose the delivery-first acceptance gate.** Every technique here
  changes *which moves are proposed*, never *what counts as an
  improvement*. The gate is the guard against the degenerate "everyone
  silent" outcome and against the #2053 zero-delay trap.
- **Don't optimize the contention score directly.** It's a proxy. Phase 4
  already learned this the expensive way.
- **Don't let per-round cost grow without bound.** B and D both multiply
  evaluations per round; the whole design depends on rounds staying short
  enough that cancellation stays responsive (phase 4's chunked worker
  contract).
- **Don't report a diffuse all-node result as an action list.** The
  product is a short list of named repeaters with specific commands. Any
  technique that produces "everything shifted 3%" needs a refinement stage
  before it can be shown.
- **Don't default `floodMax` changes on.** See work item H — the delivery
  gate structurally cannot catch the harm, because it only measures the
  topology the simulator happens to know about.
- **Don't offer unlimited rounds if cancellation ever regresses.** The two
  ship together or not at all (work item G).
- **Don't let `0` silently mean both "unset, use the default" and
  "unlimited".** Overloading zero here turns a forgotten field into an
  unbounded run.
