// Unit tests for public/coverage-ramp.js — run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const R = require("../../public/coverage-ramp.js");

test("paintMargins runs from `from` at 0 dB to `to` at marginGreenDb", () => {
  const rgba = new Uint8ClampedArray(12);
  R.paintMargins(rgba, new Float32Array([0, 7.5, 15]), 15, 190, [0, 100, 200], [100, 200, 0]);
  assert.deepEqual([...rgba.slice(0, 4)], [0, 100, 200, 190]);
  assert.deepEqual([...rgba.slice(4, 8)], [50, 150, 100, 190]);
  assert.deepEqual([...rgba.slice(8, 12)], [100, 200, 0, 190]);
});

test("paintMargins clamps outside the range and leaves NaN transparent", () => {
  const rgba = new Uint8ClampedArray(12).fill(9);
  R.paintMargins(rgba, new Float32Array([NaN, -5, 40]), 15, 190, ...R.SERVER_RAMP);
  assert.equal(rgba[3], 0);
  assert.deepEqual([...rgba.slice(4, 8)], [249, 115, 22, 190]);
  assert.deepEqual([...rgba.slice(8, 12)], [34, 197, 94, 190]);
});
