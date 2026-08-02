// Unit tests for public/mesh-frame.js — run with `npm run test:unit`
// (plain node:test; no browser, no Playwright).
//
// This code decides which region a real packet belongs to and how long its
// frame is. Until it was extracted from simulator.js its only coverage was
// an e2e case that test.skip()s whenever the live mesh has no scope stats —
// so on a quiet day a wrong answer here shipped green. These run always.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const MF = require("../../public/mesh-frame.js");

const hex = (b) => Buffer.from(b).toString("hex");
const nodeSha = (buf) => new Uint8Array(crypto.createHash("sha256").update(buf).digest());

// ── SHA-256 / HMAC: a hand-rolled port, so check it against node:crypto ───

test("sha256Bytes matches node:crypto on the standard vectors", () => {
  assert.equal(
    hex(MF.sha256Bytes(new Uint8Array(0))),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
  assert.equal(
    hex(MF.sha256Bytes(new TextEncoder().encode("abc"))),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("sha256Bytes matches node:crypto across block boundaries", () => {
  // 55/56/57 and 63/64/65 are where the length-padding block logic flips —
  // the classic place a from-scratch SHA-256 diverges.
  for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 200, 1000]) {
    const buf = crypto.randomBytes(n);
    assert.equal(hex(MF.sha256Bytes(new Uint8Array(buf))), hex(nodeSha(buf)), `n=${n}`);
  }
});

test("hmacSha256 matches node:crypto, including an over-length key", () => {
  for (const keyLen of [1, 16, 63, 64, 65, 200]) {
    const key = crypto.randomBytes(keyLen);
    const msg = crypto.randomBytes(37);
    const want = crypto.createHmac("sha256", key).update(msg).digest("hex");
    assert.equal(
      hex(MF.hmacSha256(new Uint8Array(key), new Uint8Array(msg))),
      want,
      `keyLen=${keyLen}`
    );
  }
});

// ── packet hash extraction ────────────────────────────────────────────────

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

// ── frame layout (port of Packet::readFrom) ───────────────────────────────

test("parseMeshFrame: flood carries a 4-byte transport code, hop-1 does not", () => {
  // routeType lives in the low 2 bits: 0 = TRANSPORT_FLOOD, 3 = TRANSPORT_DIRECT.
  const flood = MF.parseMeshFrame("00" + "11223344" + "00" + "aabbcc");
  assert.equal(flood.routeType, 0);
  assert.equal(flood.hasTransport, true);
  assert.equal(flood.payloadLen, 3);

  // routeType 1 has no transport code, so the same trailing bytes are payload.
  const plain = MF.parseMeshFrame("01" + "00" + "aabbcc");
  assert.equal(plain.routeType, 1);
  assert.equal(plain.hasTransport, false);
  assert.equal(plain.payloadLen, 3);
});

test("parseMeshFrame: path_len splits into hashCount and hashSize", () => {
  // Low 6 bits = hop count; high 2 bits + 1 = bytes per hop hash.
  // 0x82 = 0b10_000010 -> 2 hops of 3 bytes = 6 path bytes.
  const f = MF.parseMeshFrame("01" + "82" + "aabbccddeeff" + "1234");
  assert.equal(f.hashCount, 2);
  assert.equal(f.hashSize, 3);
  assert.equal(f.pathBytes, 6);
  assert.equal(f.payloadLen, 2);
});

test("parseMeshFrame: rejects anything too short to be a frame", () => {
  assert.equal(MF.parseMeshFrame(""), null);
  assert.equal(MF.parseMeshFrame(null), null);
  assert.equal(MF.parseMeshFrame("00"), null); // header only
  assert.equal(MF.parseMeshFrame("00112233"), null); // transport code truncated
  // A path longer than the bytes actually present is malformed, not a
  // negative-length payload.
  assert.equal(MF.parseMeshFrame("01" + "05" + "aa"), null);
});

// ── region decoding ───────────────────────────────────────────────────────

test("regionKeysFor derives sha256(name)[:16] and skips empty names", () => {
  const keys = MF.regionKeysFor(["#scotland", "", null, "#fife"]);
  assert.deepEqual([...keys.keys()], ["#scotland", "#fife"]);
  for (const [name, key] of keys) {
    assert.equal(key.length, 16, `${name} key must be 16 bytes`);
    assert.equal(hex(key), hex(nodeSha(Buffer.from(name, "utf8")).slice(0, 16)));
  }
});

// Builds a flood frame whose transport code genuinely matches `region`,
// the same way the firmware's TransportKeyStore::calcTransportCode does.
function frameForRegion(region, payloadType, payload) {
  const key = MF.regionKeysFor([region]).get(region);
  const msg = new Uint8Array([payloadType, ...payload]);
  const sig = MF.hmacSha256(key, msg);
  const header = 0 | (payloadType << 2); // routeType 0 = TRANSPORT_FLOOD
  return hex([header, sig[0], sig[1], 0, 0, 0, ...payload]);
}

test("decodeRegion recovers the region a packet was actually sent on", () => {
  const keys = MF.regionKeysFor(["#scotland", "#fife", "#tayside"]);
  const raw = frameForRegion("#fife", 3, [0xde, 0xad, 0xbe, 0xef]);
  assert.equal(MF.decodeRegion(raw, keys), "#fife");
});

test("decodeRegion returns unscoped rather than guessing", () => {
  const keys = MF.regionKeysFor(["#scotland", "#fife"]);

  // A packet on a region this deployment doesn't know must not be
  // attributed to the nearest candidate — an accuracy claim we can't make.
  const unknown = frameForRegion("#somewhere-else", 3, [0x01, 0x02]);
  assert.equal(MF.decodeRegion(unknown, keys), "");

  // Route types 1/2 carry no transport code at all: genuinely unscoped.
  assert.equal(MF.decodeRegion("01" + "00" + "aabbccdd", keys), "");

  assert.equal(MF.decodeRegion("", keys), "");
  assert.equal(MF.decodeRegion(null, keys), "");
  // No keys (backend unreachable) must read as unknown, not as a match.
  assert.equal(MF.decodeRegion(frameForRegion("#fife", 3, [1]), new Map()), "");
});

test("decodeRegion skips the accumulated path before hashing the payload", () => {
  // Two hops of 1 byte sit between path_len and the payload. Getting this
  // wrong would hash the wrong bytes and silently unscope every relayed
  // packet — floods that have travelled, i.e. most of them.
  const region = "#fife";
  const keys = MF.regionKeysFor([region]);
  const payload = [0x11, 0x22, 0x33];
  const payloadType = 5;
  const key = keys.get(region);
  const sig = MF.hmacSha256(key, new Uint8Array([payloadType, ...payload]));
  const relayed = hex([
    0 | (payloadType << 2), sig[0], sig[1], 0, 0,
    0x02,        // path_len: 2 hops, 1 byte each
    0xaa, 0xbb,  // the accumulated path
    ...payload,
  ]);
  assert.equal(MF.decodeRegion(relayed, keys), region);

  // Truncated capture: the claimed path runs past the end of the frame.
  assert.equal(MF.decodeRegion(hex([12, 0, 0, 0, 0, 0x3f, 0xaa]), keys), "");
});
