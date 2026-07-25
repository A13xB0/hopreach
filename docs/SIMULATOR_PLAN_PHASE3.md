# Simulator plan, phase 3 — path-hash size is a packet property

Status: **done, deployed pending**. All five changes implemented, Go tests
added and passing, `docker compose up --build` + the full Playwright suite
(31 tests, all green) run locally. Not yet committed/pushed/released — see
"What actually happened" at the bottom before shipping.

## Why this exists

Phase 2 shipped "item 17" (v0.1.22, commit `9234550`): show each hop's own
path-hash size. It was built on a wrong model of how MeshCore actually
works, and the user caught it — their original instruction said to put the
setting on **message senders**, and it was implemented on **repeaters**
instead.

Three separate defects follow from that, plus two default changes the user
asked for on top. This phase fixes all five together, because they touch
the same code paths and splitting them would mean measuring baselines
twice.

### The firmware evidence

All from `github.com/meshcore-dev/MeshCore` (clone to `/tmp/mc-src` to
re-check; the analysis below was done against `main` as of 2026-07).

**1. The originator chooses the hash size, and it travels with the packet.**

```cpp
// Mesh.cpp:622-634 — Mesh::sendFlood
void Mesh::sendFlood(Packet* packet, uint32_t delay_millis, uint8_t path_hash_size) {
  if (path_hash_size == 0 || path_hash_size > 3) { /* reject */ }
  packet->setPathHashSizeAndCount(path_hash_size, 0);
```

```cpp
// Packet.h:79-83
uint8_t getPathHashSize()  const { return (path_len >> 6) + 1; }
uint8_t getPathByteLen()   const { return getPathHashCount() * getPathHashSize(); }
void setPathHashSizeAndCount(uint8_t sz, uint8_t n) { path_len = ((sz - 1) << 6) | (n & 63); }
```

`path_len` is one byte packing **hash size in the top 2 bits** and hash
count in the low 6. So the size is a per-packet field, set once at
origination, carried over the air.

**2. A relay appends at the *packet's* size, not its own.**

```cpp
// Mesh.cpp:330-336 — Mesh::routeRecvPacket
uint8_t n = packet->getPathHashCount();
if (packet->isRouteFlood() && !packet->isMarkedDoNotRetransmit()
  && (n + 1)*packet->getPathHashSize() <= MAX_PATH_SIZE && allowPacketForward(packet)) {
  self_id.copyHashTo(&packet->path[n * packet->getPathHashSize()], packet->getPathHashSize());
```

The relay's own configured `hash_size` is not consulted. **A path can
therefore never mix hash sizes hop-to-hop** — there is exactly one size for
the whole packet.

**3. Loop detect keys on the packet's size, not the listener's.**

```cpp
// examples/simple_repeater/MyMesh.cpp:399-413
static uint8_t max_loop_minimal[]  = { 0, /* 1-byte */ 4, /* 2-byte */ 2, /* 3-byte */ 1 };
static uint8_t max_loop_moderate[] = { 0, /* 1-byte */ 2, /* 2-byte */ 1, /* 3-byte */ 1 };
static uint8_t max_loop_strict[]   = { 0, /* 1-byte */ 1, /* 2-byte */ 1, /* 3-byte */ 1 };

bool MyMesh::isLooped(const mesh::Packet* packet, const uint8_t max_counters[]) {
  uint8_t hash_size = packet->getPathHashSize();
  ...
    if (self_id.isHashMatch(path, hash_size)) n++;
    path += hash_size;
  return n >= max_counters[hash_size];
}
```

Our threshold *values* in `loopDetectThreshold` already match these tables
exactly — do not change them. Only the **lookup key** is wrong.

**4. Path bytes are on the air, so they cost airtime.**

```cpp
// Packet.cpp:55-62 — Packet::writeTo
dest[i++] = path_len;
i += writePath(&dest[i], path, path_len);   // returns hash_count * hash_size
memcpy(&dest[i], payload, payload_len); i += payload_len;
```

```cpp
// Packet.cpp:20-23 — Packet::writePath
uint8_t hash_count = path_len & 63;
uint8_t hash_size  = (path_len >> 6) + 1;
size_t len = hash_count*hash_size;
```

So on-air length grows by `hash_size` bytes at every hop. `internal/meshsim`
does not model this at all today (see defect C).

## The five changes

| # | Defect / change | Severity |
|---|---|---|
| A | Hash size modelled per-repeater; should be per-message (originator's choice) | Wrong model, user-reported |
| B | `shouldDropForLoop` keys off the listener's hash size, not the packet's | Correctness, diverges from firmware |
| C | Path bytes don't count toward airtime | Correctness, gets worse at 3 bytes |
| D | Loop detect defaults to `off`; user wants `minimal` | Requested default change |
| E | Hash size defaults to 1; user wants 3 | Requested default change |

D and E are **deliberate divergences from firmware defaults** (firmware
ships `loop.detect off`, and the originator picks hash size per call). The
user has explicitly confirmed they want this. Say so plainly in tooltips and
doc comments rather than implying firmware behaves this way.

**Note the interaction:** `max_loop_minimal[3] == 1`. D and E together give
threshold 1 — identical to `strict`. That is the strictest possible loop
detection, up from today's effective 0 (never fires). Expect large shifts in
every collision/delivery figure.

---

## Work item 1 — Go engine: hash size becomes a packet property

### 1.1 `internal/meshsim/engine.go` — `Message`

Add to `Message` (currently `engine.go:211-240`):

```go
// HashSize is the path-hash size in bytes (1-3) this message's originator
// stamps onto the packet — real firmware's
// Mesh::sendFlood(packet, delay, path_hash_size), which does
// setPathHashSizeAndCount(path_hash_size, 0) (Mesh.cpp:634) and stores it
// in the top 2 bits of the wire-format path_len byte (Packet.h:83).
//
// It is a property of the PACKET, not of any relay: a relay appends its own
// hash at the packet's size, never its own configured one
// (Mesh.cpp:335), so a single path can never mix sizes. Loop detect's
// thresholds are read at this size too (MyMesh.cpp:404-413).
//
// Zero/unset falls back to defaultMessageHashSize.
HashSize int `json:"hashSize,omitempty"`
```

Add near the other firmware-default constants (`engine.go:79`ff):

```go
// defaultMessageHashSize is what a Message with no explicit HashSize uses.
// 3 bytes is a deliberate simulator default, NOT a firmware one — real
// firmware has each caller pass path_hash_size to sendFlood explicitly.
// 3 minimises hash collisions between unrelated nodes, so loop.detect
// false positives don't silently confound a run's results.
const defaultMessageHashSize = 3
```

Add a resolver method with clamping identical to `nodeHash`'s (1..3):

```go
func (m Message) effectiveHashSize() int { ... }
```

### 1.2 Thread it through the event/transmission structs

- `transmission` (`engine.go:400-429`): add `hashSize int`, documented as
  "set once by the originator, never changed by a relay".
- `event` (`engine.go:440`ff): add `hashSize int`.
- Origin push (`engine.go:501`): add `hashSize: m.effectiveHashSize()`.
- Both CAD/budget re-push sites (`engine.go:567`, `engine.go:581`): carry
  `hashSize: e.hashSize` through unchanged.
- `transmission` construction (`engine.go:597`): `hashSize: e.hashSize`.
- Relay push (`engine.go:759-763`): `hashSize: tx.hashSize` — **carried, not
  recomputed**. This is the crux of defect A; a relay must never substitute
  its own.

### 1.3 Loop detect keys on the packet (defect B)

`engine.go:735-736` currently:

```go
myHash := nodeHash(e.listener, listenerNode.HashSize)
if listenerNode.shouldDropForLoop(myHash, tx.path) {
```

Change to use `tx.hashSize` for both the hash truncation and the threshold
lookup. `shouldDropForLoop` (`engine.go:184-196`) needs its signature
changed to take the packet's hash size explicitly rather than reading
`n.HashSize`:

```go
func (n SimNode) shouldDropForLoop(myHash uint32, pathHashes []uint32, packetHashSize int) bool {
    threshold := loopDetectThreshold(n.LoopDetect, packetHashSize)
    ...
```

Leave `loopDetectThreshold` itself completely alone — its tables are
verified correct against `max_loop_*[]`.

### 1.4 Airtime includes path bytes (defect C)

`engine.go:591` currently:

```go
airtime := AirtimeMs(node.Prefs.Radio, e.payloadLen)
```

Per `Packet::writeTo`, on-air bytes above the payload are the `path_len`
byte plus `hash_count * hash_size`. Add a helper next to `AirtimeMs` in
`internal/meshsim/airtime.go`:

```go
// onAirLen returns the byte count actually transmitted for a packet whose
// payload is payloadLen and whose accumulated path holds hashCount hops at
// hashSize bytes each — matching Packet::writeTo's own layout
// (Packet.cpp:59-60): the path_len byte, then hash_count*hash_size path
// bytes, then the payload.
func onAirLen(payloadLen, hashCount, hashSize int) int {
    return payloadLen + 1 + hashCount*hashSize
}
```

Then `airtime := AirtimeMs(node.Prefs.Radio, onAirLen(e.payloadLen, len(e.path), e.hashSize))`.

Do **not** change `AirtimeMs`'s own signature — it's called from
`internal/meshsim` tests and mirrors RadioLib's formula directly. Keep the
path accounting in the caller.

Audit the other `AirtimeMs`/`payloadLen` call sites for consistency:
- `PacketScore(snr, sf, tx.payloadLen)` (`engine.go:741`) — real firmware
  scores on payload length; **leave as payload only** unless you can cite
  otherwise from `Dispatcher.cpp`. Note the decision in a comment.
- `Transmission.PayloadLen` (`engine.go:606`) — consider reporting on-air
  length instead, or add a separate field. Prefer **adding** `OnAirLen` and
  leaving `PayloadLen` meaning payload, so the frontend's existing
  `${tx.payloadLen}B` displays don't silently change meaning.

### 1.5 `SimNode.HashSize` narrows in meaning

Do not delete it — it stays as "the size this node stamps on packets **it
originates**", which is what `set hash_size` actually configures. Rewrite
its doc comment (`engine.go:35-45`) accordingly: it no longer has anything
to do with how this node evaluates loop detect on packets it receives.

### 1.6 `internal/meshsim/stress.go`

`generateStressMessages` (`stress.go:145-168`) builds `Message` values with
no `HashSize`. Either leave it (falls back to `defaultMessageHashSize`) or
plumb it through `StressRequest` for parity with the run path. Leaving it is
acceptable — document the choice in the function's doc comment either way.

---

## Work item 2 — Frontend: hash size moves to the sender form

### 2.1 `public/index.html` — sender form

The Message senders modal's form is at `index.html:315-356`. Add a hash-size
control to the `plan-row` at `:328-336` (alongside region / route type):

```html
<select id="sim-message-hash-size" title="Path-hash size this sender stamps on its packets (real firmware: the originator's own `set hash_size`). One size applies to the whole path — a relay appends at the packet's size, not its own. Smaller sizes collide more between unrelated repeaters, which makes loop.detect trip on legitimate traffic.">
  <option value="1">Hop hash: 1 byte</option>
  <option value="2">Hop hash: 2 bytes</option>
  <option value="3" selected>Hop hash: 3 bytes</option>
</select>
```

3 selected by default (change E).

### 2.2 `public/simulator.js` — generator plumbing

- `addMessage()` (`:664`ff): read `#sim-message-hash-size`, clamp 1..3,
  store `hashSize` on the generator object.
- `editSender()` (`:638`ff): restore it —
  `document.getElementById("sim-message-hash-size").value = String(g.hashSize || 3);`
  The `|| 3` also back-fills setups saved before this change (see 2.5).
- Message expansion (`:1390`): add `hashSize: g.hashSize || 3` to the pushed
  message object.
- Real-packet replay (`:3568`) builds a one-off message inline — give it an
  explicit `hashSize` too, defaulting to 3.

### 2.3 Sender list badge — now the message's size

`renderMessageList()` (`:600-632`) currently reads the *node's* size at
`:615`. Change it to the generator's own:

```js
const hashSizeBadge = ` <span class="sim-node-badge sim-badge-hashsize" title="Path-hash size this sender stamps on its packets — one size for the whole path">${g.hashSize || 3}B</span>`;
```

Note this no longer depends on `node`, so it can drop the `node ?` guard.

### 2.4 Revert the per-hop breadcrumb (defect A's visible symptom)

`nodeLabelWithHashSize` (`:1684-1696`) and its use at `:1926` render
`A (1B) → B (2B)`, which is **impossible** in real MeshCore. Delete the
function and revert `:1926` to plain `nodeLabel`. Its doc comment
explicitly claims paths "can genuinely mix hash sizes hop to hop" — that
claim is wrong and must not survive anywhere in the codebase.

Show the packet's single hash size once instead, in the packet-detail
header near the existing `${m.payloadLen}B` / region / direct summary
(`:2131`) — e.g. `· 3B hops`.

### 2.5 Back-compat for saved setups

`simMessageGenerators` is persisted verbatim in saved setups and exported
`.json` (`:431`, `:472`, `:533`). Generators saved before this change have
no `hashSize`. The `|| 3` fallbacks in 2.2/2.3 cover it — no migration step
needed, but **do not** add a required field without a fallback.

---

## Work item 3 — Loop detect defaults to `minimal` (change D)

`effectiveLoopDetect()` (`simulator.js:1209-1211`) returns `""` when there's
no override, which `loopDetectThreshold`'s `default:` case treats as "never
fires".

```js
// Deliberate divergence from firmware, which defaults loop.detect to off
// (docs.meshcore.io/cli_commands). A simulator run with loop detect
// entirely disabled doesn't surface the loop-suppression behaviour most
// real deployments actually want to reason about, so this starts every
// repeater at minimal instead. Explicitly selecting "off" in the settings
// table still means off.
const DEFAULT_LOOP_DETECT = "minimal";
```

- `effectiveLoopDetect` returns `DEFAULT_LOOP_DETECT` when unset.
- `renderNodesModalTable` (`:754`) — drop the now-dead `loopDetect || "off"`
  fallback.
- Update the `title` at `:787` to state both facts: firmware default is
  `off`, this simulator starts at `minimal`.
- Leave the Go `loopDetectThreshold` `default:` case alone. Empty **and**
  explicit `"off"` must both keep meaning "never fires" — collapsing them
  would make a user's explicit "off" silently behave as minimal.

Also keep `SimNode.HashSize`'s frontend default (`effectiveHashSize`,
`:1213-1217`) at its current `|| 1`? **No** — set it to 3 for consistency
with the message default, since it now means "what this repeater stamps on
packets it originates". Update its inline comment, which currently justifies
the 1 default.

---

## Work item 4 — The picker bug that started this

Independent of the model fix, and still needed:

1. `renderMessageNodeOptions()` (`:582-593`) sets `opt.textContent = n.label`
   with nothing else. That `<select>` is the control used *when setting* a
   sender, so nothing about hash size was visible at the point of use. With
   work item 2 the size is now a field in the same form, which resolves the
   original complaint directly — but the picker should still be checked for
   whether anything else per-node belongs there. `opt.value` must stay
   `String(i)`: `editSender` (`:642`) and `addMessage` (`:670`) both depend
   on it being the raw index.
2. `applyNodesModalTable()` (`:823-883`) writes `simNodePrefsOverrides` but
   never re-renders the sender UI. Call `renderMessageNodeOptions()` and
   `renderMessageList()` after the apply loop. Safe mid-edit — the picker
   preserves its selection via `prevValue` (`:592`).

---

## Test plan

### Go (`internal/meshsim`)

New tests — put engine ones in `engine_test.go` next to the existing item-13
tests:

1. `TestRunRelayAppendsAtPacketHashSizeNotItsOwn` — origin sends at 3 bytes
   through a relay whose `SimNode.HashSize` is 1; assert the relay's onward
   transmission still reports hash size 3.
2. `TestRunLoopDetectUsesPacketHashSizeNotListeners` — a listener with
   `LoopDetect: "minimal"` and `HashSize: 1` (threshold would be 4)
   receiving a 3-byte packet must use threshold 1. Build a path that
   contains the listener's hash exactly once and assert `loop_detect`.
3. `TestMessageEffectiveHashSizeDefaultsAndClamps` — 0 → 3, 4 → 3, -1 → 1.
4. `TestOnAirLenIncludesPathBytes` — table-driven against the
   `payloadLen + 1 + hashCount*hashSize` formula.
5. `TestRunAirtimeGrowsWithHopCount` — same payload, deeper path ⇒ strictly
   longer `Transmission.AirtimeMs`. This is the regression guard for defect
   C.

Existing tests at `engine_test.go:543-544`, `:1004-1005`, `:1061-1062` set
`nodes[x].HashSize = 1` to pin loop-detect thresholds. **They will break** —
that field no longer drives loop detect. Convert each to set the hash size
on the `Message` instead. Read each test's intent before editing; do not
just make them pass.

Re-run `go test ./internal/meshsim/...` and expect stress/policy determinism
tests to need new golden values, since airtime changed. Verify each shift is
explainable before updating a golden.

### Playwright (`tests/simulator.spec.js`)

- Sender form exposes `#sim-message-hash-size`, defaults to `3`.
- Add a sender, assert the list badge reads `3B`; edit it to 1, save, assert
  the badge reads `1B` — covers the edit round-trip that `editSender`
  regressed on.
- A fresh node row's `select[data-field="loopDetect"]` defaults to
  `minimal`.
- Changing a hash size in Repeaters & settings + Apply re-renders the sender
  list (work item 4.2).
- Assert the packet path breadcrumb contains **no** per-hop `(NB)` suffix.

Existing loop-detect assertions at `simulator.spec.js:318-382` were checked
— none asserts the default is `off`; `:370`'s `not.toHaveValue("moderate")`
still passes under `minimal`. Re-run and confirm.

---

## Verification before commit

```bash
gofmt -l . && go vet ./... && go test ./...
make wasm
docker compose up --build -d
npx playwright test
```

Then re-measure and update the baseline tables in
`docs/SIMULATOR_PLAN_PHASE2.md` (items 13 part A and 15a). Those numbers
were taken with loop detect off, 1-byte hashes, and no path-byte airtime —
all three now change, so leaving them unmarked would present stale figures
as current. Either re-measure or explicitly label them as pre-phase-3.

## Deploy

The user has authorised deploying this line of work, but **confirm before
production** — the standing authorisation in memory covers incident
response, not feature releases, and this one changes simulation results
users may have already recorded. Local build + test first, then ask.

Release notes must call out that phase 2's per-hop hash-size display was
wrong and has been corrected, not quietly drop it — v0.1.22's changelog
described it as a feature.

## Things not to do

- Don't change `loopDetectThreshold`'s tables. Verified correct against
  `max_loop_*[]`.
- Don't make empty `LoopDetect` mean `minimal` in Go. The frontend supplies
  the default; Go must keep empty ≡ off so an explicit "off" is honoured.
- Don't delete `SimNode.HashSize`. It still models `set hash_size` for
  packets the node originates.
- Don't change `AirtimeMs`'s signature; add the path bytes at the call site.
- Don't let any comment survive claiming a path can mix hash sizes per hop.

## What actually happened

**`PacketScore`'s open judgement call resolved with firmware evidence, not
left as a guess.** `Dispatcher::checkRecv` (src/Dispatcher.cpp:206) calls
`_radio->packetScore(_radio->getLastSNR(), len)` where `len` is
`_radio->recvRaw(raw, MAX_TRANS_UNIT)` — the raw, on-air received length,
not the application payload. So `PacketScore` now takes
`onAirLen(tx.payloadLen, len(tx.path), tx.hashSize)`, matching `AirtimeMs`'s
own treatment exactly, not left as payload-only. This also confirms
`getEstAirtimeFor(len)` on the same line uses the same raw length, which is
exactly what this phase already assumed for `AirtimeMs`.

**Airtime is quantized, not linear** — `AirtimeMs`'s own `ceil()` over
whole LoRa symbols means consecutive hops (each +hashSize accumulated path
bytes) don't always change the reported airtime; two adjacent hops can
legitimately report identical `AirtimeMs`. `TestRunAirtimeGrowsWithHopCount`
asserts monotonic non-decrease hop-to-hop plus a strict increase between
the shallowest and deepest hop reached, not "every hop strictly exceeds the
last" — the latter is false against the real formula, confirmed by direct
computation (hops 2→3 and 6→7 plateau at the default radio params).

**Test fallout beyond what the plan anticipated:** the plan's own
`effectiveHashSize` clamp example ("-1 → 1") didn't match what got
implemented — `Message.effectiveHashSize()` treats any `HashSize <= 0`
(zero or negative) as "unset," falling back to `defaultMessageHashSize`,
consistent with the field's own doc comment ("Zero/unset falls back to..").
The test was corrected to match the implementation, not the other way
around — clamping negative input to the 1-byte floor vs. treating it as
unset are both defensible, but only one matches what the code actually
says it does.

Several existing timing-exact tests (`engine_test.go`, previously
comparing `r.AtMs` against `AirtimeMs(DefaultLoRaParams(), 20)`) needed a
`+1` correction, since every packet — even an origin's own first send with
an empty path — now carries the `path_len` byte's own airtime cost per
`Packet::writeTo`. Fixed at `:384`, `:436`/`:433`, `:1267`(ish, see
`scheduledRelayAt`).

**One deliberate scope decision, not made unilaterally without flagging:**
the real-packet-replay call site (`simulator.js`, the bottleneck-analysis
prediction run) could recover the REAL packet's own hash size by decoding
`raw_hex`'s `path_len` byte directly (`Packet.h`'s `getPathHashSize`) for
full fidelity, rather than defaulting to `DEFAULT_MESSAGE_HASH_SIZE`. Left
as the documented default per this plan's own instruction — flagged in a
code comment at the call site as a known possible follow-up, not silently
decided.

**Added mid-execution, outside this plan's original scope:** the user
separately asked (mid-session, not part of this document) to change the
simulator's default connectivity source from "Propagation model" to
"Blend" (`index.html`'s `#sim-connectivity-source`, plus
`applySetupData`'s own legacy-setup fallback in `simulator.js`). Done in
the same pass since it touched the same files and was trivial, with its
own Playwright regression test. Unrelated to path-hash size; noted here
only so this document's diff doesn't look unexplained.

**Verification actually run:** `gofmt -l .`, `go vet ./...`,
`go test ./...` (all packages, not just `internal/meshsim`), `make wasm`,
`docker compose up --build`, `npx playwright test` (full suite, all spec
files, 31/31 passing) — all green. Not yet done: updating
`docs/SIMULATOR_PLAN_PHASE2.md`'s baseline tables (items 13 part A, 15a) to
mark them as pre-phase-3, and the commit/push/release/deploy sequence
itself, which needs explicit confirmation first per this doc's own
deploy-gate note above.
