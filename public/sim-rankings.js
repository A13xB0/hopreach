// Per-repeater rankings: which repeaters actually carried the flood, which
// only added contention, and what each one would cost the network if it went
// away. Rendered into the results panel and the full-window modal.
//
// Split out of simulator.js. Everything it needs from the simulator arrives
// through the context object passed to init() — live state via getters (the
// simulator reassigns those arrays wholesale on every run) and helpers by
// reference. Nothing here reaches back into the simulator's closure.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimRankings = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  // Helpers, stable for the page's lifetime.
  let canRelay, effectiveDenyUnscoped, effectiveRegions, escapeHtml, map;

  // --- per-repeater rankings ----------------------------------------
  //
  // Two distinct "contention" measures, deliberately kept separate rather
  // than folded into one score: collisionCount is how often *this node's
  // own* reception failed because something else overlapped it — a direct
  // measure of how bad conditions are for whatever's trying to reach it.
  // contentionCaused is how often *this node's own transmissions* were
  // one of the overlapping causes behind some collision recorded
  // elsewhere (see engine.go's Reception.CollidedWith) — a node can have
  // a spotless collisionCount of its own while still being a genuine
  // source of contention for its neighbours, and that's exactly the case
  // this second column exists to surface.
  let lastRankings = null;
  let rankingsSortKey = "successCount";
  let rankingsSortDir = "desc";

  // A reception that never actually got decoded at all (weak_signal,
  // tx_busy) or was a genuine duplicate of an already-processed copy
  // (already_seen) isn't a "delivery" in any sense worth counting — mirrors
  // the exact same filter internal/meshsim.Report.DeliveryRatio applies on
  // the Go side, kept in sync
  // manually since this is plain JS, not generated from the Go source.
  function isCanonicalDelivery(r) {
    return self.HopReachMeshModel.isCanonicalDelivery(r);
  }

  // JS mirror of internal/meshsim.reachableFrom — a node this message could
  // possibly ever reach, given the CURRENT scenario's own topology and
  // per-node settings, regardless of what any specific simulated run's
  // random draws happened to produce. Used as computeRankings' own
  // "received x/y" denominator so an isolated/out-of-range node doesn't
  // silently make every repeater's delivery figure look worse than it is.
  // Gated exactly like the Go BFS: a node that can't relay or wouldn't
  // accept this region is included itself (reachable on this hop) but
  // doesn't extend the search past itself; the origin is exempt from both
  // gates (it always "sends," regardless of its own relay/region config).
  function computeReachableSet(originIndex, region) {
    const adj = new Map();
    for (const l of S.simLinks) {
      if (!adj.has(l.from)) adj.set(l.from, []);
      adj.get(l.from).push(l.to);
    }
    const reachable = new Set([originIndex]);
    const queue = [originIndex];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current !== originIndex) {
        const node = S.simNodes[current];
        if (!node) continue;
        const regions = effectiveRegions(node);
        const accepts = region === "" ? !effectiveDenyUnscoped(node) : regions.includes("*") || regions.includes(region);
        if (!canRelay(node) || !accepts) continue; // leaf: reachable itself, but doesn't relay onward
      }
      for (const to of adj.get(current) || []) {
        if (!reachable.has(to)) {
          reachable.add(to);
          queue.push(to);
        }
      }
    }
    return reachable;
  }

  // Item 16 — a per-repeater run scoreboard: is this repeater earning its
  // own airtime? successCount/collisionCount/contentionCaused are the
  // pre-existing columns; everything else here is new. dutyCyclePct and
  // relay/deferral figures come from report.transmissions (item 12) —
  // uniqueDeliveries/redundantRelays from attributing each canonical
  // delivery to whichever transmission actually caused it.
  function computeRankings(report) {
    const perNode = S.simNodes.map(() => ({
      successCount: 0,
      collisionCount: 0,
      contentionCaused: 0,
      txBusyCount: 0,
      dutyAirtimeMs: 0,
      relayedCount: 0,
      deliveredCount: 0,
      reachableCount: 0,
      uniqueDeliveries: 0,
      redundantRelays: 0,
      relayDelaySumMs: 0,
      relayDelayCount: 0,
      deferrals: 0,
    }));

    for (const r of report.receptions) {
      if (!perNode[r.node]) continue;
      if (r.collided) perNode[r.node].collisionCount++;
      else perNode[r.node].successCount++;
      if (r.dropReason === "tx_busy") perNode[r.node].txBusyCount++;
      for (const other of r.collidedWith || []) {
        if (perNode[other]) perNode[other].contentionCaused++;
      }
    }

    // deliveringPairs: "packetId:fromNode" — this sender's transmission of
    // this packet is the one that actually delivered it to at least one
    // listener (as opposed to arriving at a listener who'd already decoded
    // it from someone else, or arriving nowhere useful at all) — the input
    // "redundant relay" attribution below needs, at the per-packet level.
    const deliveringPairs = new Set();
    for (const r of report.receptions) {
      if (!isCanonicalDelivery(r)) continue;
      if (perNode[r.fromNode]) perNode[r.fromNode].uniqueDeliveries++;
      if (perNode[r.node]) perNode[r.node].deliveredCount++;
      deliveringPairs.add(`${r.packetId}:${r.fromNode}`);
    }

    for (const tx of report.transmissions || []) {
      if (!perNode[tx.node]) continue;
      perNode[tx.node].dutyAirtimeMs += tx.airtimeMs;
      if (tx.cadDeferred) perNode[tx.node].deferrals++;
      if (tx.budgetDeferred) perNode[tx.node].deferrals++;
      if (tx.isRelay) {
        perNode[tx.node].relayedCount++;
        // Every one of this node's own listeners already had a canonical
        // delivery attributed to a DIFFERENT sender for this exact packet
        // (or never got it via any path at all) — this relay's own
        // airtime produced zero unique deliveries, i.e. it was spent
        // without adding coverage. Feeds item 15c's redundancy-suppress
        // model.
        if (!deliveringPairs.has(`${tx.packetId}:${tx.node}`)) {
          perNode[tx.node].redundantRelays++;
        }
      }
    }

    for (const [key, tx] of S.transmissionIndex) {
      if (!tx.isRelay) continue;
      const cause = S.relayCauseIndex.get(key);
      if (cause && perNode[tx.node]) {
        perNode[tx.node].relayDelaySumMs += tx.atMs - cause.atMs;
        perNode[tx.node].relayDelayCount++;
      }
    }

    if (S.lastMessages) {
      S.lastMessages.forEach((m) => {
        // Go parity (report.go PerNodeStats): background transmissions are
        // fixed interference, not delivery targets — counting their
        // reachable sets in the denominator collapsed every percentage on
        // reconstructed episodes (SIMULATION_REVIEW.md B2).
        if (m.background) return;
        const reachable = computeReachableSet(m.origin, m.region || "");
        reachable.delete(m.origin);
        for (const nodeIndex of reachable) {
          if (perNode[nodeIndex]) perNode[nodeIndex].reachableCount++;
        }
      });
    }

    // The duration THIS report actually ran for — reading the input field
    // here meant editing it after a run silently rescaled every duty%
    // (SIMULATION_REVIEW.md B6).
    const maxSimTimeMs = S.lastRunMaxTimeMs;
    return S.simNodes.map((n, i) => {
      const p = perNode[i];
      const total = p.successCount + p.collisionCount;
      return {
        nodeIndex: i,
        label: n.label,
        successCount: p.successCount,
        collisionCount: p.collisionCount,
        contentionCaused: p.contentionCaused,
        successRate: total > 0 ? p.successCount / total : null,
        txBusyCount: p.txBusyCount,
        // Airtime ÷ the configured sim duration, not the run's own busy
        // span — a candidate that merely finishes early shouldn't read as
        // lower duty cycle than one that runs the full window.
        dutyCyclePct: maxSimTimeMs > 0 ? (p.dutyAirtimeMs / maxSimTimeMs) * 100 : 0,
        relayedCount: p.relayedCount,
        deliveryRatio: p.reachableCount > 0 ? p.deliveredCount / p.reachableCount : null,
        deliveredCount: p.deliveredCount,
        reachableCount: p.reachableCount,
        uniqueDeliveries: p.uniqueDeliveries,
        redundantRelays: p.redundantRelays,
        avgRelayDelayMs: p.relayDelayCount > 0 ? Math.round(p.relayDelaySumMs / p.relayDelayCount) : null,
        deferrals: p.deferrals,
      };
    });
  }

  const RANKING_COLUMNS = [
    { key: "label", label: "Repeater" },
    { key: "dutyCyclePct", label: "Duty cycle", format: (v) => `${v.toFixed(1)}%` },
    {
      key: "deliveryRatio",
      label: "Received",
      format: (v, r) => (v == null ? "—" : `${r.deliveredCount}/${r.reachableCount} (${Math.round(v * 100)}%)`),
    },
    { key: "uniqueDeliveries", label: "Unique deliveries", goodHigh: true },
    { key: "redundantRelays", label: "Redundant relays", badHigh: true },
    { key: "relayedCount", label: "Relayed" },
    { key: "successCount", label: "Successful", goodHigh: true },
    { key: "collisionCount", label: "Collisions (own)", badHigh: true },
    { key: "txBusyCount", label: "Missed (tx busy)", badHigh: true },
    { key: "contentionCaused", label: "Contention (caused)", badHigh: true },
    { key: "avgRelayDelayMs", label: "Avg relay delay", format: (v) => (v == null ? "—" : `${v}ms`) },
    { key: "deferrals", label: "Deferrals (CAD+budget)" },
    { key: "successRate", label: "Decode rate", format: (v) => (v == null ? "—" : `${Math.round(v * 100)}%`) },
  ];

  function renderRankingsTableInto(container) {
    if (!lastRankings) {
      container.innerHTML = "";
      return;
    }
    const rows = [...lastRankings].sort((a, b) => {
      const av = a[rankingsSortKey];
      const bv = b[rankingsSortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv) : (av ?? -1) - (bv ?? -1);
      return rankingsSortDir === "asc" ? cmp : -cmp;
    });
    const thead = RANKING_COLUMNS.map((c) => {
      const sorted = c.key === rankingsSortKey;
      const arrow = sorted ? (rankingsSortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th data-key="${c.key}" class="${sorted ? "sim-rank-sorted" : ""}">${escapeHtml(c.label)}${arrow}</th>`;
    }).join("");
    const tbody = rows
      .map((r) => {
        const cells = RANKING_COLUMNS.map((c) => {
          const raw = r[c.key];
          const display = c.format ? c.format(raw, r) : escapeHtml(String(raw));
          let cls = "";
          if (c.goodHigh && raw > 0) cls = "sim-rank-good";
          if (c.badHigh && raw > 0) cls = "sim-rank-bad";
          return `<td class="${cls}">${display}</td>`;
        }).join("");
        return `<tr data-node-index="${r.nodeIndex}">${cells}</tr>`;
      })
      .join("");
    container.innerHTML = `<table class="sim-rankings-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
    container.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (rankingsSortKey === key) rankingsSortDir = rankingsSortDir === "asc" ? "desc" : "asc";
        else {
          rankingsSortKey = key;
          rankingsSortDir = key === "label" ? "asc" : "desc";
        }
        renderRankingsTableInto(container);
      });
    });
    // Clicking a row pans the map to that repeater — the ranking table
    // doubles as a way to jump straight to a specific under-performer.
    container.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const n = S.simNodes[Number(tr.dataset.nodeIndex)];
        if (n) map.panTo([n.lat, n.lon]);
      });
    });
  }

  // Rankings only ever render into the full-window view now (see
  // setRankingsFullWindowOpen) — there's no separate small docked table to
  // keep in sync, so unlike the other results this doesn't need a
  // "render into whichever containers happen to be visible" helper.
  function renderRankings(report) {
    lastRankings = computeRankings(report);
    document.getElementById("sim-rankings-expand").classList.toggle("hidden", lastRankings.length === 0);
    if (!document.getElementById("sim-rankings-fullwindow").classList.contains("hidden")) {
      renderRankingsTableInto(document.getElementById("sim-rankings-fullwindow-body"));
    }
  }

  function setRankingsFullWindowOpen(open) {
    document.getElementById("sim-rankings-fullwindow").classList.toggle("hidden", !open);
    if (open) renderRankingsTableInto(document.getElementById("sim-rankings-fullwindow-body"));
  }

  function init(context) {
    ({ canRelay, effectiveDenyUnscoped, effectiveRegions, escapeHtml, map } = context);
    return api;
  }

  const api = {
    init,
    // Also used by the episode analysis, which asks the same question of a
    // reconstructed report: was this reception the delivery that counts?
    isCanonicalDelivery,
    computeRankings,
    renderRankings,
    renderRankingsTableInto,
    setRankingsFullWindowOpen,
  };
  return api;
});
