// Unit tests for public/sim-topology.js — run with `npm run test:unit`.
//
// Every function under test is a hand-maintained mirror of a Go one in
// internal/meshsim. Nothing checked the two agreed: inside simulator.js this
// code had no direct assertions, so a drifted mirror showed up only as a
// wrong "these repeaters will change" list — plausible-looking and silent.
//
// The graph fixtures below are chosen so the expected answers are derivable
// by hand from the definitions in topology.go, not copied from either
// implementation's output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../../public/sim-topology.js");

const nodesOf = (n) => Array.from({ length: n }, (_, i) => ({ lat: i, lon: i }));
const link = (from, to) => ({ from, to });

// ── neighbour sets ────────────────────────────────────────────────────────

test("neighborSets projects directed links to an undirected graph", () => {
  // topology.go does the same: a link either way makes the pair neighbours.
  const ns = T.neighborSets(nodesOf(3), [link(0, 1), link(2, 1)]);
  assert.deepEqual([...ns[0]], [1]);
  assert.deepEqual([...ns[1]].sort(), [0, 2]);
  assert.deepEqual([...ns[2]], [1]);
});

test("neighborSets: a link to a node that doesn't exist is dropped whole", () => {
  // topology.go drops such a link entirely (`if l.From < 0 || l.From >= n ||
  // ... { continue }`). Keeping the half that resolves instead gave node 0
  // phantom neighbours 99 and -1: an inflated neighbour count, and a
  // TypeError once the articulation DFS walked into index 99.
  const ns = T.neighborSets(nodesOf(2), [link(0, 1), link(0, 99), link(-1, 0)]);
  assert.deepEqual([...ns[0]], [1]);
  assert.deepEqual([...ns[1]], [0]);
  assert.deepEqual(T.findArticulationPoints(ns), [false, false]);
});

test("nodeAttrs counts neighbours the same way neighborSets does", () => {
  // The two used to carry separate copies of the same loop, so a fix to one
  // silently left the other diverged.
  const nodes = nodesOf(2);
  const links = [link(0, 1), link(0, 99)];
  assert.equal(T.nodeAttrs(nodes, links, null)[0].neighborCount,
    T.neighborSets(nodes, links)[0].size);
});

// ── articulation points (Tarjan low-link) ─────────────────────────────────

test("findArticulationPoints: the middle of a path is a cut vertex", () => {
  // 0 — 1 — 2 : removing 1 splits the graph; removing a leaf does not.
  const isArt = T.findArticulationPoints(T.neighborSets(nodesOf(3), [link(0, 1), link(1, 2)]));
  assert.deepEqual(isArt, [false, true, false]);
});

test("findArticulationPoints: a cycle has none", () => {
  const ring = [link(0, 1), link(1, 2), link(2, 3), link(3, 0)];
  assert.deepEqual(
    T.findArticulationPoints(T.neighborSets(nodesOf(4), ring)),
    [false, false, false, false]
  );
});

test("findArticulationPoints: the node joining two rings is the only one", () => {
  // Two triangles sharing node 0 — the classic repeater-that-must-not-back-off.
  const links = [
    link(0, 1), link(1, 2), link(2, 0),
    link(0, 3), link(3, 4), link(4, 0),
  ];
  assert.deepEqual(
    T.findArticulationPoints(T.neighborSets(nodesOf(5), links)),
    [true, false, false, false, false]
  );
});

test("findArticulationPoints: isolated nodes and leaves are never cut vertices", () => {
  // Node 3 has no links at all; node 2 is a leaf. Per the graph-theoretic
  // definition both are false — the articulation-first model depends on it.
  const isArt = T.findArticulationPoints(T.neighborSets(nodesOf(4), [link(0, 1), link(1, 2)]));
  assert.equal(isArt[3], false);
  assert.equal(isArt[2], false);
  assert.equal(isArt[1], true);
});

test("findArticulationPoints: each component is walked, not just the first", () => {
  // 0—1—2 and, disconnected from it, 3—4—5. Both middles must be found.
  const links = [link(0, 1), link(1, 2), link(3, 4), link(4, 5)];
  assert.deepEqual(
    T.findArticulationPoints(T.neighborSets(nodesOf(6), links)),
    [false, true, false, false, true, false]
  );
});

// ── marginal coverage ─────────────────────────────────────────────────────

test("marginalCoverageFor counts neighbours no other neighbour also reaches", () => {
  // Star: 0 — {1,2,3}, none of which are linked to each other, so all three
  // are uniquely 0's.
  const star = T.neighborSets(nodesOf(4), [link(0, 1), link(0, 2), link(0, 3)]);
  assert.equal(T.marginalCoverageFor(0, star), 3);

  // Triangle: 1 and 2 can hear each other, so 0 covers nothing uniquely.
  const tri = T.neighborSets(nodesOf(3), [link(0, 1), link(0, 2), link(1, 2)]);
  assert.equal(T.marginalCoverageFor(0, tri), 0);
});

test("marginalCoverageFor is zero for a node with no neighbours", () => {
  assert.equal(T.marginalCoverageFor(0, T.neighborSets(nodesOf(2), [])), 0);
});

// ── the assembled attribute table ─────────────────────────────────────────

test("topologyAttrs assembles count, articulation and marginal coverage", () => {
  // 0 — 1 — 2, plus 3 hanging off 1.
  const links = [link(0, 1), link(1, 2), link(1, 3)];
  const attrs = T.topologyAttrs(nodesOf(4), links);
  assert.deepEqual(attrs[1], {
    neighborCount: 3,
    isArticulation: true,
    marginalCoverage: 3, // 0, 2 and 3 are mutually unreachable
  });
  assert.deepEqual(attrs[0], { neighborCount: 1, isArticulation: false, marginalCoverage: 1 });
});

test("nodeAttrs reads altitude from the grid, and tolerates not having one", () => {
  const grid = { at: (lat, lon) => lat * 100 + lon };
  const withGrid = T.nodeAttrs(nodesOf(2), [link(0, 1)], grid);
  assert.deepEqual(withGrid, [
    { altitudeM: 0, neighborCount: 1 },
    { altitudeM: 101, neighborCount: 1 },
  ]);
  // A failed terrain fetch must degrade to altitude 0, not throw — prediction
  // falls back to neighbour-count rules rather than failing outright.
  const noGrid = T.nodeAttrs(nodesOf(2), [link(0, 1)], null);
  assert.equal(noGrid[0].altitudeM, 0);
  assert.equal(noGrid[1].neighborCount, 1);
});

// ── rule conditions (mirror of rules.go RuleCondition.matches) ────────────

const ATTRS = {
  altitudeM: 300,
  neighborCount: 4,
  isArticulation: true,
  marginalCoverage: 2,
};
const matches = (condition, attrs = ATTRS, idx = 1) =>
  T.ruleMatchesAttrs({ condition }, attrs, idx);

test("ruleMatchesAttrs: an empty condition matches every node", () => {
  assert.equal(matches({ kind: "" }), true);
});

test("ruleMatchesAttrs: threshold conditions are inclusive at the boundary", () => {
  assert.equal(matches({ kind: "altitude_at_least_m", threshold: 300 }), true);
  assert.equal(matches({ kind: "altitude_at_least_m", threshold: 301 }), false);
  assert.equal(matches({ kind: "altitude_at_most_m", threshold: 300 }), true);
  assert.equal(matches({ kind: "altitude_at_most_m", threshold: 299 }), false);
  assert.equal(matches({ kind: "neighbors_at_least", threshold: 4 }), true);
  assert.equal(matches({ kind: "neighbors_at_most", threshold: 3 }), false);
  assert.equal(matches({ kind: "marginal_coverage_at_least", threshold: 2 }), true);
  assert.equal(matches({ kind: "marginal_coverage_at_least", threshold: 3 }), false);
});

test("ruleMatchesAttrs: is_articulation coerces a missing attribute to false", () => {
  assert.equal(matches({ kind: "is_articulation" }), true);
  assert.equal(matches({ kind: "is_articulation" }, { ...ATTRS, isArticulation: undefined }), false);
});

test("ruleMatchesAttrs: node_index_in matches the index, not the attributes", () => {
  // Optimizer policies target explicit node lists. Before this case existed
  // every optimizer rule rendered through the mirror matched nothing.
  assert.equal(matches({ kind: "node_index_in", nodes: [0, 1, 2] }, ATTRS, 1), true);
  assert.equal(matches({ kind: "node_index_in", nodes: [0, 2] }, ATTRS, 1), false);
  assert.equal(matches({ kind: "node_index_in", nodes: [1] }, ATTRS, null), false);
  assert.equal(matches({ kind: "node_index_in" }, ATTRS, 1), false);
});

test("ruleMatchesAttrs: an unrecognised condition matches nothing", () => {
  // Failing closed matters: a condition kind this mirror hasn't learned yet
  // must not silently apply a policy to every repeater.
  assert.equal(matches({ kind: "some_future_condition", threshold: 0 }), false);
});

// ── rule application (mirror of ConfigRule.ApplyWithAttrs) ────────────────

const BASE = { txDelayFactor: 1, directTxDelayFactor: 2, rxDelayBase: 3 };

test("ruleScaleValueAt interpolates, clamps, and survives a zero-width range", () => {
  const scale = { atMin: 0, atMax: 10, valueAtMin: 1, valueAtMax: 3 };
  assert.equal(T.ruleScaleValueAt(scale, 5), 2);
  assert.equal(T.ruleScaleValueAt(scale, -100), 1, "clamped below atMin");
  assert.equal(T.ruleScaleValueAt(scale, 100), 3, "clamped above atMax");
  // atMin === atMax must return valueAtMin rather than dividing by zero.
  assert.equal(T.ruleScaleValueAt({ atMin: 4, atMax: 4, valueAtMin: 7, valueAtMax: 9 }, 4), 7);
});

test("applyRule sets only the fields the rule names, and never mutates the base", () => {
  const out = T.applyRule(BASE, { txDelayFactor: 9 }, ATTRS);
  assert.deepEqual(out, { txDelayFactor: 9, directTxDelayFactor: 2, rxDelayBase: 3 });
  assert.equal(BASE.txDelayFactor, 1, "the caller's prefs must be untouched");
});

test("applyRule: a scale computes txDelayFactor from an attribute and wins", () => {
  const scale = { attr: "neighbor_count", atMin: 0, atMax: 8, valueAtMin: 0, valueAtMax: 8 };
  // neighborCount 4 of 8 -> 4. Set txDelayFactor too: scale takes the tie,
  // same as the Go side.
  assert.equal(T.applyRule(BASE, { txDelayFactor: 99, scale }, ATTRS).txDelayFactor, 4);

  const alt = { attr: "altitude_m", atMin: 0, atMax: 600, valueAtMin: 0, valueAtMax: 6 };
  assert.equal(T.applyRule(BASE, { scale: alt }, ATTRS).txDelayFactor, 3);

  // An attribute the scale can't resolve leaves the constant in place rather
  // than writing a null delay factor onto a real radio.
  const unknown = { attr: "not_a_real_attr", atMin: 0, atMax: 1, valueAtMin: 0, valueAtMax: 1 };
  assert.equal(T.applyRule(BASE, { txDelayFactor: 99, scale: unknown }, ATTRS).txDelayFactor, 99);
});

// ── policy application (mirror of applyPolicyToScenario) ──────────────────

test("applyPolicyToNodeState applies matching rules in order, last wins", () => {
  const policy = [
    { condition: { kind: "" }, txDelayFactor: 5, floodMax: 20 },
    { condition: { kind: "neighbors_at_least", threshold: 4 }, txDelayFactor: 7 },
    { condition: { kind: "neighbors_at_least", threshold: 99 }, txDelayFactor: 42 },
  ];
  const { prefs, floodMax } = T.applyPolicyToNodeState(BASE, 64, policy, ATTRS, 1);
  assert.equal(prefs.txDelayFactor, 7, "later matching rule overrides the earlier one");
  assert.equal(prefs.rxDelayBase, 3, "untouched fields keep the baseline");
  assert.equal(floodMax, 20, "a non-matching rule must not clear an earlier floodMax");
});

test("applyPolicyToNodeState with no matching rules returns the baseline", () => {
  const policy = [{ condition: { kind: "neighbors_at_least", threshold: 99 }, txDelayFactor: 42 }];
  const { prefs, floodMax } = T.applyPolicyToNodeState(BASE, 64, policy, ATTRS, 1);
  assert.deepEqual(prefs, BASE);
  assert.equal(floodMax, 64);
});
