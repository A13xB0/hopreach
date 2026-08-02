// Unit tests for public/mesh-frame.js — run with `npm run test:unit`.
//
// This file used to test a frame parser, a from-scratch SHA-256/HMAC and
// region decoding. All of that moved to Go (internal/corescope's ParseFrame
// and RegionOfPacket, tested in frame_test.go against the real captured
// packet) when the browser stopped fetching a vendor's API directly. What
// remains is the part that is genuinely a browser concern.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MF = require("../../public/mesh-frame.js");

test("extractPacketHash: bare hash, pasted link, and lowercasing", () => {
  assert.equal(MF.extractPacketHash("bb03d26ad149d4ee"), "bb03d26ad149d4ee");
  assert.equal(MF.extractPacketHash("  BB03D26AD149D4EE  "), "bb03d26ad149d4ee");
  assert.equal(
    MF.extractPacketHash("https://corescope.example/packets/bb03d26ad149d4ee?x=1"),
    "bb03d26ad149d4ee"
  );
});

test("extractPacketHash: nothing 16 hex chars long means no hash", () => {
  assert.equal(MF.extractPacketHash("bb03d26a"), null); // only 8
  assert.equal(MF.extractPacketHash("not a hash at all"), null);
  assert.equal(MF.extractPacketHash(""), null);
});
