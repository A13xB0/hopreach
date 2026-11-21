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

test("paintMargins truncates, as Go's uint8() does on the server", () => {
  const rgba = new Uint8ClampedArray(4);
  R.paintMargins(rgba, new Float32Array([9]), 15, 190, [0, 0, 0], [1, 1, 1]); // 0.6 each
  assert.deepEqual([...rgba], [0, 0, 0, 190]);
});

test("latitudeBands splits rows into contiguous bands with matching edges", () => {
  const bands = R.latitudeBands(10, 57, 55, 4);
  assert.deepEqual(bands.map((b) => [b.y0, b.y1]), [[0, 3], [3, 5], [5, 8], [8, 10]]);
  assert.equal(bands[0].north, 57);
  assert.equal(bands[3].south, 55);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].north, bands[i - 1].south);
});

test("latitudeBands never makes an empty band", () => {
  assert.equal(R.latitudeBands(3, 57, 55, 8).length, 3);
});
