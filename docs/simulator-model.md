# Simulator model

Reference for what `internal/meshsim` actually models, where its numbers
come from, and where it deliberately diverges from real MeshCore firmware.
For how to *use* the simulator, see the
[LoRa flood simulator](../README.md#lora-flood-simulator) section of the
main README.

Every formula below is a from-source port of
[MeshCore](https://github.com/meshcore-dev/MeshCore), cited to the file it
came from. The same Go package compiles to WASM (`wasm/meshsim.go`) and runs
in the browser, so the simulator and the server share one implementation
rather than two that can drift.

## Event model

A discrete-event simulation over a directed graph of links, each carrying an
SNR margin. Three event kinds drive it:

| Event | Meaning |
| --- | --- |
| `eventSend` | A node keys its radio. Airtime is computed from the frame and radio parameters; the transmission occupies the channel for that whole duration. |
| `eventRxComplete` | A listener finishes receiving. Capture/collision is resolved here, against every transmission that overlapped. |
| `eventRelay` | A node that decided to relay actually transmits, after its retransmit delay has elapsed. |

Time is integer milliseconds from zero. A run is fully deterministic for a
given `(scenario, messages, seed)`, which is what makes paired comparisons
between two policies meaningful — the optimizer relies on this.

## Airtime and frame size

`AirtimeMs` implements the standard LoRa time-on-air calculation
(preamble + header + payload symbols, with low-data-rate optimisation
applied at the same thresholds RadioLib uses). Frame size comes from
`Packet::getRawLength`:

```
2 + pathLen + payloadLen + (hasTransportCodes ? 4 : 0)
```

The 4 transport bytes are present only on `TRANSPORT_FLOOD` (route type 0)
and `TRANSPORT_DIRECT` (3). This was validated against 400 real captured
frames with no exceptions.

One subtlety: firmware sizes its random *retransmit delay window* on
`getPathByteLen() + payload_len + 2` — the full frame **minus** the
transport bytes — while the actual transmission and the receive hold-back
use the full frame. `internal/meshsim` reproduces that difference rather
than using one size for both.

## Reception, capture and collisions

Reception is resolved in two stages, mirroring how a real LoRa radio
behaves:

1. **Acquisition.** A transmission that starts during the wanted signal's
   preamble window competes for the receiver's lock. The stronger signal
   wins if it leads by at least the capture margin (6 dB); otherwise
   neither locks and the reception fails as `no_lock`.
2. **Payload.** Once locked, interferers overlapping the payload are summed
   **in the linear power domain**, not compared pairwise — several
   individually-survivable interferers can still add up to corrupt the
   frame. Failing this stage is `corrupted`.

`ChannelParams` optionally replaces the hard SNR threshold with a
probabilistic model: a logistic packet-error-rate curve near the
sensitivity floor (`PERWidthDB`), and per-reception Gaussian fading applied
independently to the wanted signal and to every interferer
(`FadingSigmaDB`). The zero value is an exact hard threshold with no
fading, so existing behaviour is unchanged unless a caller opts in. The
browser opts in; the Go tests mostly don't.

Other reception outcomes: `tx_busy` (the listener's own transmitter was
keyed — radios are half duplex), `already_seen` (loop detection),
`region_mismatch`, and `weak_signal`.

## Timing

- **Retransmit delay** — `getRetransmitDelay`/`getDirectRetransmitDelay`
  from `Dispatcher.cpp`, driven by a packet score derived from SNR.
- **Receive hold-back** — `RxDelayMs` implements firmware's
  `(pow(rxDelayBase, 0.85 - score) - 1) * airtime`. Firmware processes
  immediately when the result is under 50 ms; that gate is reproduced. It
  matters: without it the expression goes **negative** for strong signals
  whenever `rxDelayBase > 1`, which silently breaks every relay from an
  affected node.
- **Max receive delay** — clamped at `MAX_RX_DELAY_MILLIS` (32 s), matching
  `Dispatcher.cpp`.
- **CAD and duty cycle** — a transmission can be deferred by channel
  activity detection or by an exhausted duty-cycle budget. A `Reception`
  therefore reports when a relay *actually aired*, which is not always when
  it was scheduled; a relay scheduled past the end of the simulation window
  produces no transmission at all.

## Regions (scopes)

Scoped and unscoped traffic are gated independently, as in firmware:

- Traffic tagged with a region relays only through nodes holding that
  region's key (`SimNode.Regions`, or `*` for any).
- Untagged traffic relays unless `DenyUnscoped` is set.

Holding region keys never revokes plain unscoped relaying, and denying
unscoped never blocks a region the node holds a key for.

A packet's region is recoverable from its own bytes. A region's transport
key is public — `sha256(name)[:16]`, per
`TransportKeyStore::getAutoKeyFor` — and the 2-byte transport code is
`HMAC-SHA256(key, payloadType || payload)` truncated little-endian, so
trying each candidate region name identifies the packet's region. This is
implemented on both sides: `internal/corescope` for the server,
`public/simulator.js` for the browser.

## Path hashes and loop detection

Path-hash size (1–3 bytes) is a property of the **message**, not of the
repeater relaying it: a relay appends its own hash at the packet's existing
size (`Mesh::sendFlood`), so a single path can never mix sizes hop to hop.
Loop detection reads the packet's size too (`MyMesh::isLooped`), never the
listener's own configured size — at 1 byte, unrelated repeaters collide in
the path often enough to suppress legitimate relays, which is exactly the
real-world failure this reproduces.

## Deliberate divergences

| Divergence | Why |
| --- | --- |
| `loop.detect` defaults to `minimal`, firmware defaults to `off` | A run with loop suppression disabled by default hides the behaviour most deployments want to reason about. An explicit `off` is still honoured. |
| Node path hashes derive from node index, not a public key | Full key material isn't modelled. Only hash *collisions* matter for reproducing loop-detect behaviour, and those are preserved. |
| `DenyUnscoped` exists at all | Firmware has no such switch; regions are purely additive. It's a what-if knob for asking "what if this repeater stopped carrying unscoped traffic". |
| Same-frequency, different-SF transmissions don't interfere | Real spreading factors are quasi-orthogonal. Treated as no interference rather than partial. |
| `AblationFlags` | Disables individual real mechanisms (half duplex, CAD, loop detect) to attribute a measured difference to one of them. A research instrument, deliberately not exposed in the UI — someone disabling half duplex to "improve" their numbers would get confidently wrong answers. Its zero value is byte-for-byte identical to a normal run. |

## Optimizer

`OptimizeStep` runs one bounded round of a top-K, tabu-aware search and
returns updated state, rather than searching to completion in one call —
a synchronous WASM call can't be interrupted, so a single long call could
never be cancelled. The browser drives the loop, which is what makes
progress reporting and real cancellation possible.

Each round re-measures the incumbent at a fresh round-specific seed,
generates candidate moves against the worst-contention and most-starved
nodes, screens them with a cheap trial budget, and re-evaluates only the
best candidate with a larger sample before accepting it.

Two properties are load-bearing:

- **Delivery is the objective; contention is only a proxy.** A move is
  accepted only if delivery doesn't regress. Optimising contention directly
  produces a network where every node backs off enormously — fewer
  collisions, less delivery.
- **Comparisons are paired.** Candidate and incumbent are evaluated at the
  same seeds (common random numbers). Comparing across different seeds
  measures noise, not the policy change.

Results are reported against a hold-out seed range the search never drew
from, since a long greedy search will otherwise overfit to its own random
draws.

## Validation against real traffic

The flood model has been checked against production CoreScope observations
by reconstructing the union of observed relay hops into a proven topology,
running the engine from the real origin, and comparing against the real
observer list: 100% recall across the union of trials, 96.6% on a single
trial, over 16 real advert packets and 63 real deliveries.

Two standing caveats when comparing predicted against observed:

- CoreScope only learns a hop happened when one of its observers reports a
  path through it. A predicted hop into a repeater no observer covers can
  be neither confirmed nor refuted — absence of evidence isn't evidence of
  absence.
- Observers are repeaters, and a repeater is deaf while transmitting. An
  observer that was itself relaying at the time will be missing from an
  observation list it would otherwise appear in.
