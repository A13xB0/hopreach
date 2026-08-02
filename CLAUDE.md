# HopReach — project guide for AI assistants and maintainers

HopReach renders LoRa coverage maps for a MeshCore network: a Go pipeline
(fetch → filter → compute → write) plus a vanilla-JS frontend in `public/`,
with the propagation/terrain core compiled to WebAssembly. It does not observe
the mesh itself — it consumes an observation backend (CoreScope, MeshCore
Beacon) through `internal/meshsource`.

```
cmd/            hopreach (pipeline), hopreach-shareapi (share + mesh API + GPU broker), hopreach-gpuworker
internal/       meshsource (backend interface) · corescope · beacon · sources (factory) · meshapi (HTTP translation)
                meshsim (flood simulator engine) · compute · gpucompute · propagation · demgrid · coverage · geo
public/         browser app: one module per responsibility, loaded in order by index.html
wasm/           propagation + demgrid compiled to WebAssembly
tests/          Playwright e2e (needs a live container) · tests/unit (node --test, no browser)
docs/           specs and plans
```

---

## Rule 1 — files stay small and single-purpose

**This is the rule that gets broken first and hurts most. A 7500-line file is a
failure, not a style preference.**

- **Split by responsibility.** Every file has one clear purpose. A file mixing
  unrelated concerns gets split at the natural boundary.
- **Target < 400 lines per file, < 50 lines per function.** When a file
  outgrows that, extract cohesive chunks into their own files. Growing a file
  to 800+ instead of splitting is a failure — not a trade-off, a failure.
- **Don't over-split.** Splitting is driven by responsibility count, not line
  count alone. Ten related 20-line helpers belong together; a file per tiny
  helper is equally wrong.
- **Keep the public surface minimal.** Export only what other modules need.
  Cross-file dependencies stay explicit.
- **Don't refactor unrelated code.** Only restructure what your task requires.
  Never reorganise a file as a side effect of a feature — that turns a
  reviewable diff into an unreviewable one.
- **New code follows existing conventions**: current layout, naming, and
  module/export patterns. New code must look like it belongs.
- **New projects/subsystems: state the file layout in the plan *before*
  writing code**, so a reviewer sees the intended structure first.

### What "one module" looks like here (frontend)

`public/evidence.js` and `public/mesh-api.js` are the template. Same wrapper,
pure where possible, no DOM in the logic, and `require()`-able so `node --test`
can reach them:

```js
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HopReachThing = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  // …
  return { doThing, otherThing };   // the whole public surface, named
});
```

Modules never import each other; they attach to `window`/`self` and are loaded
in dependency order by `public/index.html`. Cross-module calls go through a
small named surface (`window.MeshApi`, `window.HopReachEvidence`,
`window.HopReachPlanner`, `window.MCCoverageMap`).

**If a candidate extraction can't be unit-tested under `node --test`, it wasn't
a clean seam** — find the real boundary instead.

### What "one file" looks like here (Go)

Same package, several files, split by concern (`engine.go`, `airtime.go`,
`channel.go`, `rules.go`). Because unexported identifiers stay package-visible,
splitting a Go file is a **pure move with no signature changes** — the safest
refactor available. Use it.

---

## Rule 2 — tests mirror source

One test file per source file/module, in the project's existing layout:

- Go: `foo.go` → `foo_test.go`, same package.
- Frontend logic: `public/foo.js` → `tests/unit/foo.test.mjs`, run by
  `npm run test:unit` (`node --test tests/unit/*.test.mjs`). No browser, no
  backend, no Docker.
- Behaviour that only exists in the browser: `tests/*.spec.js` (Playwright).

**A new module ships with its unit test in the same change.**

---

## Rule 3 — know which tests actually protect you

`tests/simulator.spec.js` is e2e against a **live container and a live
observation backend**. Several of its highest-value cases `test.skip` when the
mesh is quiet (no multi-observation packet, no resolvable path, no scope
stats). **A green run is not proof those paths were exercised** — check for
skips before trusting it, especially around packet replay and region decode.

Before refactoring a region whose only coverage is a skippable e2e test, add a
unit test or a recorded fixture first. Characterisation first, then move.

---

## Rule 4 — observation backends stay behind the interface

HopReach supports more than one backend. The rules that keep that true:

- Backend-specific field names, envelopes and timestamp formats are absorbed in
  `internal/<backend>`; **never** in `public/*.js` and never in the pipeline.
- The browser talks only to `/mesh-api/` (`internal/meshapi`), which serves one
  stable shape whatever is behind it. `public/mesh-api.js` is its only client.
- Adding a backend means implementing `meshsource.Source` and adding a case to
  `internal/sources`. If it means touching `simulator.js`, the abstraction has
  leaked — fix the abstraction.

See `docs/DATA_SOURCE_SPEC.md` (the contract) and
`docs/BEACON_COMPATIBILITY_PLAN.md` (a worked example).

---

## Rule 5 — accuracy claims must be honest

This tool tells people where their radios reach. That makes silent wrongness
the worst failure mode.

- Never invent a data point to fill a gap. An ambiguous path hop is *unknown*,
  not "probably the first candidate" — see `convertHop` in `internal/beacon`.
- Distinguish "no data" from "zero": a node never heard has a **null**
  timestamp, not the epoch.
- Where a reconstruction is partial, say so in the output (`path_complete`,
  `hitCap`) rather than presenting it as complete.
- Model divergences from real firmware belong in `docs/simulator-model.md`,
  disclosed rather than quietly carried.

---

## Commands

```bash
make wasm                  # rebuild public/hopreach.wasm after propagation/demgrid changes
go build ./... && go test ./...
npm run test:unit          # node unit tests, no browser
npx playwright test        # e2e; needs docker compose up
go run ./cmd/hopreach      # full pipeline against ./config.yaml
```
