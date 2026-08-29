// Unit tests for public/carto-tiles.js — run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("../../public/carto-tiles.js");

const URL = "https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png";

test("withKey: no key leaves the URL untouched", () => {
  assert.equal(C.withKey(URL, ""), URL);
  assert.equal(C.withKey(URL, undefined), URL);
});

test("withKey: a key rides as the first query parameter", () => {
  assert.equal(C.withKey(URL, "abc123"), URL + "?key=abc123");
});

test("withKey: an existing query string gets & rather than a second ?", () => {
  assert.equal(C.withKey(URL + "?x=1", "abc"), URL + "?x=1&key=abc");
});

test("withKey: the key is URL-encoded", () => {
  assert.equal(C.withKey(URL, "a b&c"), URL + "?key=a%20b%26c");
});
