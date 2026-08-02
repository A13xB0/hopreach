// MeshCore on-air frame parsing and region (scope) decoding.
//
// Everything here is a pure function of bytes: no DOM, no fetch, no shared
// state. That is the whole point — this used to sit in the middle of a
// 7500-line simulator.js where the only thing exercising it was an e2e test
// that skips whenever the live mesh has no scope stats to report. As its own
// module it is reachable from `node --test`, so the SHA-256 port and the
// frame layout are pinned by assertions that always run.
//
// The frame layout is a direct port of Packet::readFrom (src/Packet.cpp);
// the region decode mirrors internal/corescope/scope.go's decodePacketRegion.
// Callers own the region-key cache and any network fetch — see
// ensureRegionKeys in simulator.js.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MeshFrame = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Accepts either a bare hash or a pasted CoreScope link containing one —
  // packet hashes are consistently 16 hex characters in every real example
  // observed (see internal/meshsim's own port of MeshCore's formulas for
  // the broader packet-ID convention), so a straightforward regex over the
  // whole input handles both without needing to know CoreScope's exact URL
  // shape.
  function extractPacketHash(input) {
    const m = String(input).trim().match(/[0-9a-f]{16}/i);
    return m ? m[0].toLowerCase() : null;
  }

  // Parses a MeshCore on-air frame (CoreScope's raw_hex) into its
  // components — a direct port of Packet::readFrom (src/Packet.cpp),
  // validated against 400 real frames: header, then 4 transport-code bytes
  // when the route type is TRANSPORT_FLOOD (0) or TRANSPORT_DIRECT (3),
  // then the path_len byte (hashCount = low 6 bits, hashSize = (high 2 bits)
  // + 1), then hashCount*hashSize path bytes, then the application payload.
  // Returns null for anything too short to be a valid frame.
  function parseMeshFrame(rawHex) {
    if (!rawHex || typeof rawHex !== "string") return null;
    const bytes = [];
    for (let i = 0; i + 1 < rawHex.length; i += 2) bytes.push(parseInt(rawHex.substr(i, 2), 16));
    if (bytes.length < 2) return null;
    const routeType = bytes[0] & 0x03;
    let i = 1;
    const hasTransport = routeType === 0 || routeType === 3;
    if (hasTransport) i += 4;
    if (i >= bytes.length) return null;
    const pathLen = bytes[i];
    i += 1;
    const hashCount = pathLen & 0x3f;
    const hashSize = (pathLen >> 6) + 1;
    const pathBytes = hashCount * hashSize;
    const payloadLen = bytes.length - i - pathBytes;
    if (payloadLen < 0) return null;
    return { routeType, hasTransport, hashCount, hashSize, pathBytes, payloadLen: Math.max(1, payloadLen) };
  }

  // Which region (scope) a real packet's flood actually belongs to, decoded
  // from its own over-the-air bytes. A direct port of
  // internal/corescope/scope.go's decodePacketRegion — see that function for
  // the wire format and the firmware reference
  // (TransportKeyStore::calcTransportCode).
  //
  // A region's transport key is public — sha256(name)[:16], no secret
  // involved — but the packet carries only a 2-byte transport code derived
  // from it, so recovering the region means computing that code for every
  // candidate region name and looking for the one that matches.
  // SHA-256 and HMAC-SHA256 in plain JS rather than via SubtleCrypto.
  // window.crypto.subtle is undefined outside a secure context — which any
  // plain-http deployment on something other than localhost is, including
  // this project's own production setup. Reaching for it meant region
  // decoding threw, got swallowed, and silently left every packet unscoped:
  // a whole replay of "Region mismatch — not relayed" for users on the very
  // deployment this is built for, while working perfectly on localhost.
  // These inputs are tiny (a region name, one packet payload) and nothing
  // here is a secret — the region keys are public by construction — so a
  // straightforward implementation costs nothing and always works.
  // Verified against 500 random vectors from node:crypto plus the standard
  // empty-string and "abc" digests.
  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Bytes(bytes) {
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bitLen = bytes.length * 8;
    const buf = new Uint8Array((bytes.length + 9 + 63) & ~63);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 4, bitLen >>> 0, false);
    dv.setUint32(buf.length - 8, Math.floor(bitLen / 4294967296), false);
    const w = new Uint32Array(64);
    for (let off = 0; off < buf.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15];
        const y = w[i - 2];
        const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i], false);
    return out;
  }

  function hmacSha256(keyBytes, msgBytes) {
    const B = 64;
    const k = keyBytes.length > B ? sha256Bytes(keyBytes) : keyBytes;
    const pad = new Uint8Array(B);
    pad.set(k);
    const inner = new Uint8Array(B + msgBytes.length);
    const outer = new Uint8Array(B + 32);
    for (let i = 0; i < B; i++) {
      inner[i] = pad[i] ^ 0x36;
      outer[i] = pad[i] ^ 0x5c;
    }
    inner.set(msgBytes, B);
    outer.set(sha256Bytes(inner), B);
    return sha256Bytes(outer);
  }

  // Region name -> its 16-byte transport key, sha256(name)[:16].
  //
  // Split out of the old ensureRegionKeys so the derivation is testable
  // without a backend: fetching the candidate names is IO and stays with the
  // caller, turning them into keys is arithmetic and lives here.
  function regionKeysFor(names) {
    const keys = new Map();
    for (const name of names || []) {
      if (!name) continue;
      keys.set(name, sha256Bytes(new TextEncoder().encode(name)).slice(0, 16));
    }
    return keys;
  }

  function decodeRegion(rawHex, keys) {
    if (!rawHex || typeof rawHex !== "string") return "";
    if (keys.size === 0) return "";
    const raw = [];
    for (let i = 0; i + 1 < rawHex.length; i += 2) raw.push(parseInt(rawHex.substr(i, 2), 16));
    if (raw.length < 6) return "";
    const header = raw[0];
    const routeType = header & 0x03;
    // Only TRANSPORT_FLOOD (0) / TRANSPORT_DIRECT (3) carry a transport code
    // at all; a plain flood is genuinely unscoped.
    if (routeType !== 0 && routeType !== 3) return "";
    const payloadType = (header >> 2) & 0x0f;
    const transportCode1 = raw[1] | (raw[2] << 8); // little-endian, matching the firmware's uint16_t
    const pathLenByte = raw[5];
    const hopCount = pathLenByte & 0x3f;
    const hashSize = (pathLenByte >> 6) + 1;
    const pathEnd = 6 + hopCount * hashSize;
    if (pathEnd > raw.length) return ""; // malformed/truncated capture
    const payload = raw.slice(pathEnd);
    const msg = new Uint8Array(1 + payload.length);
    msg[0] = payloadType;
    msg.set(Uint8Array.from(payload), 1);
    for (const [name, key] of keys) {
      const sig = hmacSha256(key, msg);
      if ((sig[0] | (sig[1] << 8)) === transportCode1) return name;
    }
    return "";
  }

  return {
    extractPacketHash,
    parseMeshFrame,
    sha256Bytes,
    hmacSha256,
    regionKeysFor,
    decodeRegion,
  };
});
