// Fetching and interpreting a real packet's surrounding activity: the node directory, the observer-liveness evidence, the time window itself, and turning those packets into engine messages.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimWindow = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { DEFAULT_MESSAGE_HASH_SIZE } = window.SimConstants;

  // --- CoreScope real packet replay & bottleneck analysis ----------------
  //
  // CoreScope's own /api/packets/{hash} already resolves every observation's
  // relay path to full public keys (resolved_path) — no prefix-matching
  // needed on our side. Every consecutive pair in that chain, plus the
  // final hop into whichever CoreScope observer captured it, is a "proven"
  // edge: real evidence that specific transmission actually happened,
  // aggregated across every observation of the hash (a flood is commonly
  // heard via multiple paths/observers). Running our own engine from the
  // same origin over the same connectivity gives a "predicted" flood; a
  // predicted relay with no corresponding proven edge is exactly what the
  // user asked for — a candidate collision/bottleneck location a real
  // packet's own observed data can't reveal on its own (CoreScope only
  // ever tells you who *did* hear it, never why someone who should have
  // didn't).

  
  async function ensureNodeDirectory() {
    if (S.nodeDirectoryCache) return S.nodeDirectoryCache;
    const resp = await fetch(`${MeshApi.BASE}/nodes?limit=5000`);
    if (!resp.ok) throw new Error(`CoreScope node directory fetch failed: HTTP ${resp.status}`);
    const data = await resp.json();
    S.nodeDirectoryCache = new Map();
    for (const n of data.nodes || []) {
      if (n.lat == null || n.lon == null || !n.public_key) continue; // can't place a node with no known position
      S.nodeDirectoryCache.set(n.public_key.toLowerCase(), { name: n.name || n.public_key.slice(0, 8), lat: n.lat, lon: n.lon, role: n.role });
    }
    return S.nodeDirectoryCache;
  }

  function addProvenEdge(edges, from, to, tMs) {
    if (from === to) return;
    const key = `${from}:${to}`;
    const existing = edges.get(key);
    if (!existing || tMs < existing.firstMs) edges.set(key, { from, to, firstMs: tMs });
  }

  // --- ±30s real-activity replay ("literally play in time what happened")
  //
  // CoreScope's own /api/packets has no server-side time-range filter,
  // only limit/offset over its most-recent-first order — so getting
  // "everything within windowMs of targetMs" means growing the page size
  // until the oldest packet fetched is at or before targetMs - windowMs
  // (or giving up at a sane cap, for a target packet old enough that its
  // window has scrolled well off the recent list — whatever coverage was
  // achieved by then is still shown, just possibly missing the window's
  // oldest edge).
  const REAL_TIMELINE_MAX_LIMIT = 4800;

  // Returns {packets, hitCap}: hitCap is true when REAL_TIMELINE_MAX_LIMIT
  // was reached before the window's oldest edge was actually covered — a
  // wide window (see the "Surrounding activity window" control) on a busy
  // mesh can hit this, and the caller should surface that as partial
  // coverage rather than silently presenting it as the whole window (item
  // 8's own requirement).
  // Shared by both replay entry points ("🔗 Replay" onto the current
  // workspace and "🏗️ Reconstruct window"): classifies every observer's
  // state at the target's transit from the ±liveness activity span.
  // See public/evidence.js and docs/REPLAY_NEGATIVE_EVIDENCE_PLAN.md.
  function buildObserverEvidence({ detail, targetMs, hash, liveness }) {
    const radioDefaults = self.HopReachMeshModel.defaultPrefs().radio;
    // frame_bytes is the whole on-air frame as the backend measured it.
    // A backend that can't say omits it, hence the fallback — a zero here
    // would mean "instantaneous transmission", which is worse than a guess.
    const airOf = (frameBytes, fallbackBytes) =>
      HopReachEvidence.loraAirtimeMs(frameBytes || fallbackBytes || 24, radioDefaults.sf, radioDefaults.bwKhz, radioDefaults.cr);
    const observerNames = new Map();
    for (const lp of liveness) {
      const oid = (lp.observer_id || "").toLowerCase();
      if (oid && !observerNames.has(oid)) observerNames.set(oid, lp.observer_name || oid.slice(0, 8));
    }
    for (const o of detail.observations || []) {
      const oid = (o.observer_id || "").toLowerCase();
      if (oid && !observerNames.has(oid)) observerNames.set(oid, o.observer_name || oid.slice(0, 8));
    }
    const evidenceEvents = [];
    for (const lp of liveness) {
      const tMs = Date.parse(lp.timestamp);
      if (Number.isNaN(tMs)) continue;
      const air = airOf(lp.frame_bytes);
      const oid = (lp.observer_id || "").toLowerCase();
      if (oid) evidenceEvents.push({ observerId: oid, tMs, airtimeMs: air, hash: lp.hash, kind: "rx" });
      for (const relay of lp.resolved_path || []) {
        const rk = (relay || "").toLowerCase();
        if (rk && observerNames.has(rk)) evidenceEvents.push({ observerId: rk, tMs, airtimeMs: air, hash: lp.hash, kind: "relay" });
      }
    }
    const heardIds = new Set((detail.observations || []).map((o) => (o.observer_id || "").toLowerCase()).filter(Boolean));
    const evidenceMap = HopReachEvidence.classifyObservers({
      targetMs,
      targetAirtimeMs: airOf(detail.packet && detail.packet.frame_bytes, 105),
      targetHash: hash,
      heardObserverIds: heardIds,
      events: evidenceEvents,
    });
    return {
      observerNames,
      observerEvidence: [...evidenceMap.entries()].map(([pubkey, v]) => ({ pubkey, name: observerNames.get(pubkey) || pubkey.slice(0, 8), state: v.state, reason: v.reason })),
    };
  }

  // Locates any historical time window with an offset binary search over the
  // timestamp-sorted list (about twenty 1-row probes), then pages the window
  // out — bounded cost for ANY packet age, unlike the old newest-first
  // limit-doubling which silently truncated at REAL_TIMELINE_MAX_LIMIT for
  // packets deep in the history. livenessMs additionally returns the wider
  // span the observer-evidence classification needs (who was provably alive
  // around the target), without making the reconstruction window itself any
  // bigger.
  // Packets around a moment, plus a wider slice for observer liveness.
  //
  // Was ~80 lines of backwards `offset` binary search with a legacy fallback,
  // because CoreScope has no time filter. The mesh API takes a time range, so
  // this is now two straight requests — and on a backend that filters
  // server-side (Beacon) they are genuinely cheap.
  async function fetchPacketsAroundTime(targetMs, windowMs, livenessMs) {
    const liveHalf = Math.max(windowMs, livenessMs || 0);
    const liveness = await MeshApi.packetsBetween(
      targetMs - liveHalf, targetMs + liveHalf, REAL_TIMELINE_MAX_LIMIT);
    const inWindow = liveness.filter((p) => {
      const t = Date.parse(p.timestamp);
      return !Number.isNaN(t) && t >= targetMs - windowMs && t <= targetMs + windowMs;
    });
    // hitCap: the backend returned exactly as many rows as we allowed, so the
    // oldest edge of the window may be truncated. Callers surface this rather
    // than presenting partial coverage as complete.
    return {
      packets: inWindow,
      liveness,
      hitCap: liveness.length >= REAL_TIMELINE_MAX_LIMIT,
    };
  }

  // The origin (true sender) of a real packet, lowercased, if identifiable —
  // only ADVERTs self-identify (their decoded pubKey). Everything else's true
  // origin is one hop upstream of the first observed relay and not in the
  // data, so callers fall back to the first observed relay.
  function originPubkeyOfPacket(p) {
    try {
      const dec = JSON.parse(p.decoded_json || "{}");
      if (dec.pubKey) return String(dec.pubKey).toLowerCase();
    } catch {
      /* not decodable — fall through */
    }
    return null;
  }

  // Region decoding is the backend's job now (internal/corescope's
  // RegionOfPacket, or a backend like Beacon that simply reports the scope).
  // The browser used to do it itself, which meant a hand-rolled SHA-256 here
  // because SubtleCrypto is undefined off a secure context. These two read
  // what the API already decoded.

  // carriesTransportCode reports whether a packet has a transport code at
  // all — route types 0/3. A plain flood is genuinely unscoped, which is a
  // different fact from "scoped, but we couldn't name the region".
  function carriesTransportCode(p) {
    return p && (p.route_type === 0 || p.route_type === 3);
  }

  // regionOfPacket prefers the real decoded region name. A transport-coded
  // packet whose region we can't name still needs a non-empty marker so the
  // engine adds its 4 transport-code bytes to the airtime; the reconstructed
  // nodes all hold the "*" wildcard, so this never gates relaying.
  function regionOfPacket(p) {
    if (p && p.scope) return p.scope;
    return carriesTransportCode(p) ? "scoped" : "";
  }

  // Every real flood in the window, as simulator messages — real origin,
  // real payload/hash size, and its real time offset from the start of the
  // window as its send time.
  //
  // This is what makes the replay's predicted side a genuine simulation
  // rather than a geometric guess. It used to run one packet from one
  // origin, and "predicted" elsewhere meant a raw fan of every link out of a
  // real sender — which can say "in earshot" but can't say received,
  // relayed, collided, or dropped, because nothing was actually simulated.
  // Feeding the whole window through the engine means the predicted half of
  // the replay is the same thing a normal run produces, with the same
  // outcomes and the same vocabulary.
  //
  // Sim time lines up with real time by construction (sendAtMs is the offset
  // from the window's start), so predicted events and real observations are
  // directly comparable rather than living on two unrelated clocks.
  //
  // Only route types 0/1 — our model relays floods, not addressed traffic
  // (see the isDirect note in replayFromHash).
  async function buildWindowFloodMessages(windowPackets, pubkeyToIndex, windowStartMs) {
    // The live API returns one row per packet (verified); dedupe by hash
    // anyway so a per-observation-row instance can't multiply sends.
    const byHash = new Map();
    for (const p of windowPackets) {
      if (p.route_type !== 0 && p.route_type !== 1) continue;
      const tMs = Date.parse(p.timestamp);
      if (Number.isNaN(tMs)) continue;
      const prev = byHash.get(p.hash);
      if (!prev || tMs < prev.tMs) byHash.set(p.hash, { p, tMs });
    }
    const msgs = [];
    for (const { p, tMs } of byHash.values()) {
      // Only an advert self-identifies its true origin; for everything else
      // the first resolved hop is the earliest point in the path we can
      // actually place on the map.
      const chain = (p.resolved_path || []).filter(Boolean);
      const originKey = originPubkeyOfPacket(p) || (chain.length ? chain[0].toLowerCase() : null);
      if (!originKey) continue;
      const origin = pubkeyToIndex.get(originKey);
      if (origin == null) continue;
      msgs.push({
        origin,
        sendAtMs: Math.max(0, tMs - windowStartMs),
        payloadLen: p.payload_len || 20,
        hashSize: p.hash_size || DEFAULT_MESSAGE_HASH_SIZE,
        // Real ScotMesh traffic is overwhelmingly scoped (TRANSPORT_FLOOD).
        // Replaying it untagged made every repeater that doesn't relay
        // unscoped traffic refuse the lot — a whole window of "Region
        // mismatch — not relayed" that says nothing about the real network,
        // only about our having thrown the region away.
        region: p.scope || "",
        sourceHash: p.hash,
      });
    }
    msgs.sort((a, b) => a.sendAtMs - b.sendAtMs);
    return msgs;
  }

  // Reconstructs the real CoreScope time window around the packet in the
  // replay input as a fully editable simulator setup: real repeaters at
  // their real positions, connectivity from the
  // real proven relay edges observed in the window, and every real packet as
  // either a flood sender (real payload/hash size) or — for direct/channel/
  // anon traffic we don't route — a fixed background transmission that still
  // loads the channel. After this, the user tweaks settings or runs the
  // optimizer and re-runs to see whether the real problems shrink.
  // the rest of the model's predicted reach out from the same sender.



  function init(context) {
    return api;
  }

  const api = {
    init,
    addProvenEdge,
    buildObserverEvidence,
    buildWindowFloodMessages,
    carriesTransportCode,
    ensureNodeDirectory,
    fetchPacketsAroundTime,
    originPubkeyOfPacket,
    regionOfPacket,
  };
  return api;
});
