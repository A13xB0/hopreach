// Observer-evidence classification for the packet-replay episode analysis
// (docs/REPLAY_NEGATIVE_EVIDENCE_PLAN.md).
//
// A CoreScope observation list tells us who HEARD a packet — but the silent
// observers carry information too. An observer that was demonstrably alive
// (reporting other packets minutes either side) and idle at the target's
// transit time, yet recorded nothing, is strong evidence the packet never
// reached it. One that was mid-receive (or relaying) of an overlapping
// transmission could simply have missed it — LoRa is half-duplex and can't
// decode two overlapping frames. This module classifies observers into those
// states and prunes a simulation's delivery graph accordingly.
//
// Pure functions, no DOM, no fetch — loaded as a plain script by index.html
// (exposes window.HopReachEvidence) and require()-able by the node unit
// tests (tests/unit/evidence.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HopReachEvidence = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // LoRa time-on-air (SX127x formula, explicit header, CRC on). crDenom is
  // MeshCore's 5–8 coding-rate field. Preamble length mirrors MeshCore's
  // RadioLibWrapper::preambleLengthForSF (and internal/meshsim/airtime.go):
  // 32 symbols at SF ≤ 8, 16 above — a fixed 16 here undercounted every
  // SF8-and-below frame by half its preamble (SIMULATION_REVIEW.md C7).
  function loraAirtimeMs(payloadBytes, sf, bwKhz, crDenom) {
    if (!(payloadBytes > 0) || !(sf >= 5 && sf <= 12) || !(bwKhz > 0)) return 0;
    const cr = Math.min(8, Math.max(5, crDenom || 5)) - 4; // 1..4
    const tSymMs = Math.pow(2, sf) / (bwKhz * 1000) * 1000;
    const de = tSymMs >= 16 ? 1 : 0; // low data-rate optimization (RadioLib: >= 16ms)
    const preambleSymbols = sf <= 8 ? 32 : 16;
    const preambleMs = (preambleSymbols + 4.25) * tSymMs;
    const numerator = 8 * payloadBytes - 4 * sf + 28 + 16;
    const payloadSymbols = 8 + Math.max(Math.ceil(numerator / (4 * (sf - 2 * de))) * (cr + 4), 0);
    return preambleMs + payloadSymbols * tSymMs;
  }

  // Observer states, in decreasing evidential certainty about the target.
  const HEARD = "heard"; // in the target's own observation list
  const BUSY = "busy"; // occupied by an overlapping transmission — could have missed it
  const SILENT_ACTIVE = "silent-active"; // alive + idle + silent — the packet did not reach it
  const SILENT_UNKNOWN = "silent-unknown"; // no sign of life in the lookback — possibly offline

  // classifyObservers({
  //   targetMs, targetAirtimeMs, targetHash,
  //   heardObserverIds: Set|Array of observer ids that heard the target,
  //   events: [{ observerId, tMs, airtimeMs, hash, kind: "rx"|"relay" }] —
  //     every activity fact known about every observer across the liveness
  //     lookback (rx = it reported hearing a packet; relay = it appears as a
  //     relay in some packet's path, i.e. it transmitted),
  //   busySlopMs: timestamp slop (CoreScope stamps whole seconds; default 2000),
  //   livenessWindowMs: how close a sign of life must be to count (default 300000),
  // }) → Map observerId → { state, reason }
  function classifyObservers(opts) {
    const targetMs = opts.targetMs;
    const targetAir = Math.max(0, opts.targetAirtimeMs || 0);
    const slop = opts.busySlopMs == null ? 2000 : opts.busySlopMs;
    const liveWin = opts.livenessWindowMs == null ? 300000 : opts.livenessWindowMs;
    const heard = new Set(opts.heardObserverIds || []);
    const events = opts.events || [];

    // The target occupies [targetMs, targetMs + targetAir], widened by slop
    // both ways for the 1 s timestamp resolution.
    const tStart = targetMs - slop;
    const tEnd = targetMs + targetAir + slop;

    const byObserver = new Map();
    for (const e of events) {
      if (!e.observerId) continue;
      let rec = byObserver.get(e.observerId);
      if (!rec) byObserver.set(e.observerId, (rec = { events: [] }));
      rec.events.push(e);
    }
    for (const id of heard) if (!byObserver.has(id)) byObserver.set(id, { events: [] });

    const out = new Map();
    for (const [id, rec] of byObserver) {
      if (heard.has(id)) {
        out.set(id, { state: HEARD, reason: "observed the target packet" });
        continue;
      }
      let busyEvent = null;
      let nearestLifeMs = Infinity;
      for (const e of rec.events) {
        if (e.hash && opts.targetHash && e.hash === opts.targetHash) continue; // target activity isn't "other traffic"
        const air = Math.max(0, e.airtimeMs || 0);
        // A reception timestamp marks (roughly) frame completion; treat the
        // frame as occupying [tMs - air, tMs]. A relay transmission's exact
        // moment is unknown within its packet's second — same interval is
        // the best available.
        const eStart = e.tMs - air;
        const eEnd = e.tMs;
        if (eEnd >= tStart && eStart <= tEnd) busyEvent = busyEvent || e;
        nearestLifeMs = Math.min(nearestLifeMs, Math.abs(e.tMs - targetMs));
      }
      if (busyEvent) {
        const verb =
          busyEvent.kind === "relay"
            ? `transmitting (relaying ${shortHash(busyEvent.hash)})`
            : `receiving ${shortHash(busyEvent.hash)}`;
        out.set(id, {
          state: BUSY,
          reason: `was ${verb} at the target's transit — half-duplex, could have missed it`,
        });
      } else if (nearestLifeMs <= liveWin) {
        out.set(id, {
          state: SILENT_ACTIVE,
          reason: `alive (activity ${Math.round(nearestLifeMs / 1000)}s away) and idle at transit — the packet did not reach it this time`,
        });
      } else {
        out.set(id, { state: SILENT_UNKNOWN, reason: "no activity in the liveness window — possibly offline" });
      }
    }
    return out;
  }

  function shortHash(h) {
    return h ? String(h).slice(0, 8) : "another packet";
  }

  // constrainDeliveries({
  //   receptions: sim Report.receptions rows ({packetId, node, path, ...}),
  //   targetPid: the target packet's id,
  //   contradictedNodes: Set of node indices where silent-active observers
  //     prove the packet never arrived,
  //   isDelivery: (r) => bool — caller's canonical-delivery filter,
  // }) → { keptNodes:Set, prunedNodes:Set }
  //
  // A delivery chain is impossible if it passes through — or terminates at —
  // a node reality says never had the packet. A node stays "reached" only if
  // at least one of its delivery chains avoids every contradicted node.
  function constrainDeliveries(opts) {
    const contradicted = opts.contradictedNodes || new Set();
    const isDelivery = opts.isDelivery || (() => true);
    const deliveredNodes = new Set();
    const validNodes = new Set();
    for (const r of opts.receptions || []) {
      if (r.packetId !== opts.targetPid || !isDelivery(r)) continue;
      deliveredNodes.add(r.node);
      if (contradicted.has(r.node)) continue;
      const chain = Array.isArray(r.path) ? r.path : [];
      let blocked = false;
      for (const n of chain) {
        if (contradicted.has(n)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) validNodes.add(r.node);
    }
    const keptNodes = new Set();
    const prunedNodes = new Set();
    for (const n of deliveredNodes) {
      if (validNodes.has(n)) keptNodes.add(n);
      else prunedNodes.add(n);
    }
    return { keptNodes, prunedNodes };
  }

  // frontierAnalysis({
  //   provenTransmitters: node indices that CERTAINLY transmitted (origin +
  //     every relay in the target's observed paths — each one's TX was
  //     decoded by the next hop, so it demonstrably happened),
  //   links: [{from, to}] directed model links,
  //   stateOf: (nodeIndex) => "heard"|"busy"|"silent-active"|... or null,
  // })
  // → per-transmitter neighbour breakdown plus the two competing stories'
  //   costs: if the wave DIED at the proven core, every non-proven copy of
  //   a proven transmission must have been lost — all in the sender's local
  //   area (lossesIfDiedLocal, one ring). If instead the wave SPREAD as
  //   modelled, every silent-active observer anywhere must have
  //   independently lost its copy (silentActiveTotal, distributed).
  function frontierAnalysis(opts) {
    const proven = new Set(opts.provenTransmitters || []);
    const stateOf = opts.stateOf || (() => null);
    const adj = new Map();
    for (const l of opts.links || []) {
      if (!adj.has(l.from)) adj.set(l.from, []);
      adj.get(l.from).push(l.to);
    }
    const frontier = [];
    const lostAt = new Set(); // union — a node adjacent to two proven TXs is ONE loss
    for (const t of proven) {
      const neighbors = { proven: [], heard: [], silentActive: [], other: [] };
      for (const n of adj.get(t) || []) {
        if (proven.has(n)) neighbors.proven.push(n);
        else if (stateOf(n) === HEARD) neighbors.heard.push(n);
        else if (stateOf(n) === SILENT_ACTIVE) neighbors.silentActive.push(n);
        else neighbors.other.push(n);
      }
      // Copies that must have been lost for the wave to have died here:
      // every model-reachable neighbour that isn't proven and didn't hear
      // it. ("other" nodes have no observer feed — their copy may or may
      // not have decoded, but if any relayed, the wave would have grown, so
      // died-local requires their REBROADCASTS to have gone nowhere too;
      // counted as potential losses, reported separately.)
      for (const n of neighbors.silentActive) lostAt.add(n);
      frontier.push({ node: t, neighbors });
    }
    return { frontier, lossesIfDiedLocal: lostAt.size };
  }

  // Combines the ensemble's per-silent-observer clean-delivery rates into
  // P(every one of them stays silent if the model's spread were real):
  // Π(1 − p_i). Rates of exactly 1 clamp to 0.999 so one saturated
  // estimate from a small ensemble doesn't collapse the product to a
  // false hard zero.
  function allSilentProbability(cleanRates) {
    let p = 1;
    for (const r of cleanRates || []) {
      p *= 1 - Math.min(0.999, Math.max(0, r));
    }
    return p;
  }

  return {
    loraAirtimeMs,
    classifyObservers,
    constrainDeliveries,
    frontierAnalysis,
    allSilentProbability,
    STATES: { HEARD, BUSY, SILENT_ACTIVE, SILENT_UNKNOWN },
  };
});
