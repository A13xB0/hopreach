// Unit tests for public/repeater-focus.js — run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const F = require("../../public/repeater-focus.js");

const props = { public_key: "abc123", name: "Hill", calibrated_lat: 56.5, calibrated_lon: -4.5 };

test("focusSite uses the reported position outside calibrated modes", () => {
  assert.deepEqual(F.focusSite(props, 56.1, -4.1, false), { id: "abc123", lat: 56.1, lon: -4.1, isReal: true, label: "Hill" });
});

test("focusSite uses the calibrated position in calibrated modes", () => {
  const s = F.focusSite(props, 56.1, -4.1, true);
  assert.equal(s.lat, 56.5);
  assert.equal(s.lon, -4.5);
});

test("focusSite falls back to reported when there is no calibrated position", () => {
  const s = F.focusSite({ public_key: "k", name: "X" }, 56.1, -4.1, true);
  assert.equal(s.lat, 56.1);
  assert.equal(s.lon, -4.1);
});

test("paintMargins matches the server ramp and leaves gaps transparent", () => {
  const rgba = new Uint8ClampedArray(12);
  F.paintMargins(rgba, new Float32Array([NaN, 0, 30]), 15, 190);
  assert.deepEqual([...rgba.slice(0, 4)], [0, 0, 0, 0]);
  assert.deepEqual([...rgba.slice(4, 8)], [249, 115, 22, 190]);
  assert.deepEqual([...rgba.slice(8, 12)], [34, 197, 94, 190]);
});
