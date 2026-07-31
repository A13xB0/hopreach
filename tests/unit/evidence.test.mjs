// Unit tests for public/evidence.js — run with `npm run test:unit`
// (plain node:test; no browser, no Playwright).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../../public/evidence.js");

const T = Date.parse("2026-07-31T00:15:31Z");
const AIR = 400; // ms — a plausible 105-byte SF9 frame

test("loraAirtimeMs: SF7/125k 50B lands in the published range", () => {
  const ms = E.loraAirtimeMs(50, 7, 125, 5);
  assert.ok(ms > 80 && ms < 130, `got ${ms}`);
});

test("loraAirtimeMs: SF≤8 uses the 32-symbol MeshCore preamble (drift pin)", () => {
  // Engine parity (internal/meshsim/airtime.go preambleSymbolsForSF): at
  // SF8/62.5kHz one symbol is 4.096ms, so the 16-extra-symbol difference
  // is ~65.5ms — assert the preamble term explicitly so a fixed-16
  // regression can't sneak back in.
  const sym = Math.pow(2, 8) / 62500 * 1000;
  const withPayloadZeroDiff = E.loraAirtimeMs(1, 8, 62.5, 5) - (32 + 4.25) * sym;
  assert.ok(withPayloadZeroDiff > 0, "airtime must exceed the 32-symbol preamble");
  const sf9 = E.loraAirtimeMs(1, 9, 62.5, 5);
  const sf9sym = Math.pow(2, 9) / 62500 * 1000;
  assert.ok(sf9 - (16 + 4.25) * sf9sym > 0);
  assert.ok(sf9 - (32 + 4.25) * sf9sym < 0, "SF9 must use the 16-symbol preamble");
});

test("loraAirtimeMs: SF12 much slower; garbage returns 0", () => {
  assert.ok(E.loraAirtimeMs(50, 12, 125, 5) > 1500);
  assert.equal(E.loraAirtimeMs(0, 7, 125, 5), 0);
  assert.equal(E.loraAirtimeMs(10, 99, 125, 5), 0);
});

// The bb03d26a case study, in miniature: Cadham heard it; Waulkmilton and
// NOC-PYMC were provably alive in the window (packets at +41s / +26s) and
// idle at transit; a fourth observer has nothing at all in the lookback.
test("classifyObservers: heard / silent-active / silent-unknown split", () => {
  const states = E.classifyObservers({
    targetMs: T,
    targetAirtimeMs: AIR,
    targetHash: "bb03d26ad149d4ee",
    heardObserverIds: ["cadham"],
    events: [
      { observerId: "cadham", tMs: T, airtimeMs: AIR, hash: "bb03d26ad149d4ee", kind: "rx" },
      { observerId: "waulkmilton", tMs: T + 41000, airtimeMs: 300, hash: "809ae8a6206f7b36", kind: "rx" },
      { observerId: "nocpymc", tMs: T + 26000, airtimeMs: 500, hash: "6ed5478cf85b5676", kind: "rx" },
      { observerId: "inverness", tMs: T - 20 * 60 * 1000, airtimeMs: 300, hash: "aaaa", kind: "rx" },
    ],
  });
  assert.equal(states.get("cadham").state, "heard");
  assert.equal(states.get("waulkmilton").state, "silent-active");
  assert.equal(states.get("nocpymc").state, "silent-active");
  assert.equal(states.get("inverness").state, "silent-unknown");
});

test("classifyObservers: overlapping rx marks busy, not silent", () => {
  const states = E.classifyObservers({
    targetMs: T,
    targetAirtimeMs: AIR,
    heardObserverIds: [],
    events: [
      // Frame completing 1s after the target started, well inside slop.
      { observerId: "busy-rx", tMs: T + 1000, airtimeMs: 800, hash: "other1", kind: "rx" },
      // A relay transmitting in the same second.
      { observerId: "busy-tx", tMs: T, airtimeMs: 600, hash: "other2", kind: "relay" },
    ],
  });
  assert.equal(states.get("busy-rx").state, "busy");
  assert.equal(states.get("busy-tx").state, "busy");
  assert.match(states.get("busy-tx").reason, /transmitting/);
});

test("classifyObservers: the target's own frames never make an observer busy", () => {
  const states = E.classifyObservers({
    targetMs: T,
    targetAirtimeMs: AIR,
    targetHash: "bb03",
    heardObserverIds: [],
    events: [
      { observerId: "x", tMs: T, airtimeMs: AIR, hash: "bb03", kind: "rx" },
      { observerId: "x", tMs: T - 60000, airtimeMs: 300, hash: "aa", kind: "rx" },
    ],
  });
  assert.equal(states.get("x").state, "silent-active");
});

test("constrainDeliveries: prunes contradicted nodes and chains through them", () => {
  // Topology: origin 0 → 1 (contradicted) → 2, and 0 → 3 → 4.
  // Node 2's only chain passes through 1 → pruned. Node 4 survives.
  const receptions = [
    { packetId: 7, node: 1, path: [0] },
    { packetId: 7, node: 2, path: [0, 1] },
    { packetId: 7, node: 3, path: [0] },
    { packetId: 7, node: 4, path: [0, 3] },
    { packetId: 9, node: 2, path: [0, 1] }, // different packet — ignored
  ];
  const { keptNodes, prunedNodes } = E.constrainDeliveries({
    receptions,
    targetPid: 7,
    contradictedNodes: new Set([1]),
  });
  assert.deepEqual([...keptNodes].sort(), [3, 4]);
  assert.deepEqual([...prunedNodes].sort(), [1, 2]);
});

test("constrainDeliveries: a node with one clean chain among blocked ones survives", () => {
  const receptions = [
    { packetId: 7, node: 5, path: [0, 1] }, // via contradicted 1
    { packetId: 7, node: 5, path: [0, 3] }, // clean alternate
  ];
  const { keptNodes, prunedNodes } = E.constrainDeliveries({
    receptions,
    targetPid: 7,
    contradictedNodes: new Set([1]),
  });
  assert.deepEqual([...keptNodes], [5]);
  assert.equal(prunedNodes.size, 0);
});

test("constrainDeliveries: honours the caller's delivery filter", () => {
  const receptions = [
    { packetId: 7, node: 6, path: [0], collided: true },
    { packetId: 7, node: 8, path: [0], collided: false },
  ];
  const { keptNodes } = E.constrainDeliveries({
    receptions,
    targetPid: 7,
    contradictedNodes: new Set(),
    isDelivery: (r) => !r.collided,
  });
  assert.deepEqual([...keptNodes], [8]);
});

test("frontierAnalysis: classifies each proven transmitter's neighbours", () => {
  // origin 0 → relays 1,2 proven; 1 also links to silent-active 3 and
  // unknown 4; 2 links to heard 5.
  const states = new Map([[3, "silent-active"], [5, "heard"]]);
  const { frontier, lossesIfDiedLocal } = E.frontierAnalysis({
    provenTransmitters: [0, 1, 2],
    links: [
      { from: 0, to: 1 }, { from: 0, to: 2 },
      { from: 1, to: 3 }, { from: 1, to: 4 },
      { from: 2, to: 5 },
    ],
    stateOf: (n) => states.get(n) || null,
  });
  const f1 = frontier.find((f) => f.node === 1);
  assert.deepEqual(f1.neighbors.silentActive, [3]);
  assert.deepEqual(f1.neighbors.other, [4]);
  const f2 = frontier.find((f) => f.node === 2);
  assert.deepEqual(f2.neighbors.heard, [5]);
  assert.equal(lossesIfDiedLocal, 1);
});

test("allSilentProbability: product of misses, saturated rates clamped", () => {
  assert.ok(Math.abs(E.allSilentProbability([0.5, 0.5]) - 0.25) < 1e-9);
  assert.equal(E.allSilentProbability([]), 1);
  // A rate of 1.0 clamps rather than zeroing the product outright.
  assert.ok(E.allSilentProbability([1]) > 0);
  assert.ok(E.allSilentProbability([1]) < 0.01);
});
