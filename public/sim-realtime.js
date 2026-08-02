// Real-packet timeline playback: turning observed transmissions into a scrubbable timeline, drawing it on the map, and the legend control that explains the colours.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimRealtime = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let map, matchesViewFilter, openModal, pulseAt, setStatus, setTransportSource, simProvenLayer, simRealActivityLayer, simViewMode, transportPause, transportPlay, transportSeekTo, transportToEnd;

  function buildRealTimeline(windowPackets, targetHash, pubkeyToIndex) {
    const byTransmission = new Map();
    for (const p of windowPackets) {
      const tMs = Date.parse(p.timestamp);
      if (Number.isNaN(tMs)) continue;
      const rawChain = p.resolved_path || [];
      const isTarget = p.hash === targetHash;
      const hops = [];
      for (let i = 0; i < rawChain.length - 1; i++) {
        if (rawChain[i] && rawChain[i + 1]) hops.push([rawChain[i].toLowerCase(), rawChain[i + 1].toLowerCase()]);
      }
      const observerKey = (p.observer_id || "").toLowerCase();
      const lastResolvedHop = [...rawChain].reverse().find((k) => k);
      if (observerKey && lastResolvedHop) hops.push([lastResolvedHop.toLowerCase(), observerKey]);
      for (const [fromKey, toKey] of hops) {
        const f = pubkeyToIndex.get(fromKey);
        const t = pubkeyToIndex.get(toKey);
        if (f == null || t == null) continue;
        const key = `${f}:${tMs}:${p.hash}`;
        let tx = byTransmission.get(key);
        if (!tx) {
          tx = { tMs, from: f, tos: [], isTarget, hash: p.hash };
          byTransmission.set(key, tx);
        }
        if (!tx.tos.includes(t)) tx.tos.push(t);
      }
    }
    const events = Array.from(byTransmission.values());
    events.sort((a, b) => a.tMs - b.tMs);
    return events;
  }

  // Per-repeater view of the loaded replay window: nodeIndex ->
  // { sent, heard, reach }.
  //
  // This is the same data the map draws, deliberately — the map's flood fan
  // and this table have to be one prediction, not two. They weren't at
  // first: the fan came from simLinks (who was in earshot of a real sender)
  // while the inspector read the engine's own report, so a repeater could
  // have a line drawn to it on the map and then report zero activity when
  // clicked. Both now come from here.
  //
  //   sent  — CoreScope observed this repeater relaying (a measurement)
  //   heard — CoreScope observed it receiving (a measurement)
  //   reach — our model puts it in earshot of a real sender, unobserved
  //
  // "reach" is the honest middle ground these floods need: a broadcast went
  // out, our model says this repeater could decode it, and no observer was
  // positioned to confirm either way.
      
  function buildReplayObservations(events) {
    const byNode = new Map();
    const at = (idx) => {
      let e = byNode.get(idx);
      if (!e) {
        e = { sent: [], heard: [] };
        byNode.set(idx, e);
      }
      return e;
    };
    for (const tx of events) {
      at(tx.from).sent.push({ tMs: tx.tMs, hash: tx.hash, isTarget: tx.isTarget, count: tx.tos.length });
      for (const to of tx.tos) {
        at(to).heard.push({ tMs: tx.tMs, hash: tx.hash, isTarget: tx.isTarget, from: tx.from });
      }
    }
    return byNode;
  }

  // Merges what was observed with what the engine predicts into one
  // time-ordered list for the replay to play through.
  //
  // The two halves are directly comparable because they share a clock:
  // buildWindowFloodMessages sends each real flood at its own offset from
  // the start of the window, so a predicted reception at sim time t belongs
  // at windowStartMs + t in real time. Predicted receptions are grouped back
  // into the transmissions that caused them the same way the simulator's own
  // replay does (see buildWaves) — one broadcast, many listeners.
  //
  // This replaced a fan drawn straight from simLinks. That could only ever
  // say "in earshot", because nothing had been simulated: no arrival time,
  // no hop count, no collision, no relay decision. These are engine
  // receptions, so the replay can show a predicted flood exactly as the
  // simulator shows its own — including where it collides.
  function buildReplayTimeline(observedTransmissions, report, windowStartMs, constraint) {
    const items = observedTransmissions.map((e) => ({ kind: "observed", ...e }));
    const groups = new Map();
    for (const r of (report && report.receptions) || []) {
      // Evidence-constrained: don't animate target receptions that reality
      // contradicts (healthy silent observers) as if they happened — that's
      // exactly the "left Fife and gone for a runner" artefact. Collided
      // arrivals there are excluded too: "it reached them and collided" is
      // precisely the disputed claim (see the episode likelihood analysis).
      // Other packets' receptions at those nodes still play.
      if (constraint && r.packetId === constraint.targetPid) {
        const excluded = constraint.excludedNodes || constraint.prunedNodes;
        if (excluded && excluded.has(r.node)) continue;
        if (excluded && Array.isArray(r.path) && r.path.some((n) => excluded.has(n))) continue;
      }
      const key = `${r.fromNode}:${r.packetId}:${r.atMs}`;
      let g = groups.get(key);
      if (!g) {
        g = { kind: "predicted", tMs: windowStartMs + r.atMs, from: r.fromNode, packetId: r.packetId, receptions: [] };
        groups.set(key, g);
      }
      g.receptions.push(r);
    }
    for (const g of groups.values()) items.push(g);
    items.sort((a, b) => a.tMs - b.tMs);
    return items;
  }

        // The actual ± window (seconds) used for the most recent replay — read
  // from the "Surrounding activity window" control in replayFromHash, kept
  // here so the status strings below can report the real figure used
  // rather than a stale hardcoded "±30s" (item 8).
  
  // The real-activity replay's status shows in two places at once — the
  // bottleneck modal and the map-docked control (see
  // ensureBottleneckLegendControl) — so everything goes through here rather
  // than setStatus directly, same pattern as setReplayStatus.
  
  function setRealReplayStatus(text) {
    S.lastRealReplayStatusText = text;
    setStatus("sim-bottleneck-replay-status", text);
    const mapStatus = document.getElementById("sim-map-real-replay-status");
    if (mapStatus) mapStatus.textContent = text;
  }

  // The packet being investigated is hot pink; other real traffic in the
  // same window is cyan. Both are saturated colours that hold up against a
  // dark basemap — slate grey was used for the context traffic and was
  // simply too close to the map itself to read. They also differ in weight
  // and opacity, not just hue, so they stay separable without the key and
  // for anyone with a colour deficiency.
  //
  // The violet fan is the flood itself: for every real transmission, every
  // other repeater our model says was in earshot. A flood is a broadcast, so
  // this is what actually went out over the air — the pink/cyan lines are
  // only the subset CoreScope had an observer in place to reconstruct.
  const REAL_TARGET_COLOR = "#f472b6";
  const REAL_CONTEXT_COLOR = "#22d3ee";
  const REAL_FLOOD_REACH_COLOR = "#a855f7";
  // Same red the simulator's own replay uses for a collided reception, so a
  // predicted collision looks the same wherever it's drawn.
  const REAL_PREDICTED_COLLIDED_COLOR = "#f87171";

  function showFloodReach() {
    const el = document.getElementById("sim-map-show-flood-reach");
    return el ? el.checked : true;
  }

  function playRealTimelineEvent(e, animate) {
    const from = S.simNodes[e.from];
    if (!from) return;

    if (e.kind === "predicted") {
      if (!showFloodReach()) return;
      for (const r of e.receptions) {
        // Honour the Simulator view's SHOW filter — these are engine
        // receptions, so "Collisions only" means the same thing here as it
        // does for the simulation's own replay. It used to filter one and
        // not the other, so the map showed hundreds of clean predicted hops
        // while claiming to be showing collisions only.
        if (!matchesViewFilter(r)) continue;
        const to = S.simNodes[r.node];
        if (!to) continue;
        // Predicted collisions are worth seeing — they're the whole reason
        // to simulate the surrounding traffic rather than the target alone.
        const color = r.collided ? REAL_PREDICTED_COLLIDED_COLOR : REAL_FLOOD_REACH_COLOR;
        L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          { color, weight: r.collided ? 2.5 : 1.5, opacity: r.collided ? 0.7 : 0.4, dashArray: "4 6", interactive: false }
        ).addTo(simRealActivityLayer);
      }
      return;
    }

    // An observed hop is by definition a successful delivery — reality only
    // records what got through — so it survives "Successes only" and is
    // hidden by "Collisions only", consistent with how the same filter reads
    // a simulated reception.
    if (simViewMode.filter === "collisions") return;
    const color = e.isTarget ? REAL_TARGET_COLOR : REAL_CONTEXT_COLOR;
    for (const toIdx of e.tos) {
      const to = S.simNodes[toIdx];
      if (!to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color, weight: e.isTarget ? 5 : 3, opacity: e.isTarget ? 1 : 0.8 }
      ).addTo(simRealActivityLayer);
      if (animate) pulseAt([to.lat, to.lon], color);
    }
    // Pulse the sender too — that's where the flood radiates from, and it
    // reads as a transmission rather than just a line appearing.
    if (animate) pulseAt([from.lat, from.lon], color);
  }

  // How many real transmissions have happened by srcMs (realTimelineEvents is sorted
  // by tMs) — the real replay's equivalent of countWavesUpTo.
  function countRealEventsUpTo(srcMs) {
    let lo = 0;
    let hi = S.realTimelineEvents.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S.realTimelineEvents[mid].tMs <= srcMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function realTransportSource() {
    return {
      kind: "real",
      label: `Real traffic ±${S.lastRealTimelineWindowSecs}s`,
      times: S.realTimelineEvents.map((e) => e.tMs),
      // The readout stays in real seconds relative to the window's start,
      // even though the scrubber moves through compressed play time — the
      // offset into the real window is the number that actually means
      // something when comparing against CoreScope.
      format: (srcMs) => {
        // Clamped at zero: the timeline's lead-in instant sits 1ms before
        // the first event, which would otherwise render as "+-0.0s".
        const offsetS = Math.max(0, (srcMs - S.realTimelineWindowStartMs) / 1000);
        const k = countRealEventsUpTo(srcMs);
        return `+${offsetS.toFixed(1)}s · ${k}/${S.realTimelineEvents.length}`;
      },
      render: (srcMs, prevSrcMs) => {
        const k = countRealEventsUpTo(srcMs);
        if (prevSrcMs != null) {
          const prevK = countRealEventsUpTo(prevSrcMs);
          if (k === prevK) return;
          for (let i = prevK; i < k; i++) playRealTimelineEvent(S.realTimelineEvents[i], S.realTimelineEvents[i].isTarget);
          S.realTimelineIndex = k;
          const e = S.realTimelineEvents[k - 1];
          const offsetS = ((e.tMs - S.realTimelineWindowStartMs) / 1000).toFixed(1);
          setRealReplayStatus(
            k >= S.realTimelineEvents.length
              ? `Replay finished — showing the full ±${S.lastRealTimelineWindowSecs}s window.`
              : `Playing… t=+${offsetS}s (${k}/${S.realTimelineEvents.length})${e.kind === "predicted" ? " · simulated" : e.isTarget ? " · this is the replayed packet" : " · observed"}`
          );
          return;
        }
        // Seek: rebuild the window's state at this instant from scratch.
        simRealActivityLayer.clearLayers();
        for (let i = 0; i < k; i++) playRealTimelineEvent(S.realTimelineEvents[i], false);
        S.realTimelineIndex = k;
        const offsetS = ((srcMs - S.realTimelineWindowStartMs) / 1000).toFixed(1);
        setRealReplayStatus(
          S.realTimelineEvents.length === 0
            ? `No other real activity found in this packet's ±${S.lastRealTimelineWindowSecs}s window.`
            : k >= S.realTimelineEvents.length
              ? `Showing the full ±${S.lastRealTimelineWindowSecs}s window.`
              : `t=+${offsetS}s (${k}/${S.realTimelineEvents.length})`
        );
      },
    };
  }

  function stopRealTimelineReplay() {
    if (S.transportSource && S.transportSource.kind === "real") transportPause();
  }

  function startRealTimelineReplay() {
    if (S.realTimelineEvents.length === 0) {
      setRealReplayStatus(`No other real activity found in this packet's ±${S.lastRealTimelineWindowSecs}s window.`);
      return;
    }
    S.realTimelineWindowStartMs = S.realTimelineEvents[0].tMs;
    simRealActivityLayer.clearLayers();
    S.realTimelineIndex = 0;
    setTransportSource(realTransportSource());
    transportPlay();
  }

  function skipRealTimelineToEnd() {
    if (S.realTimelineEvents.length === 0) {
      setRealReplayStatus(`No other real activity found in this packet's ±${S.lastRealTimelineWindowSecs}s window.`);
      return;
    }
    S.realTimelineWindowStartMs = S.realTimelineEvents[0].tMs;
    if (!S.transportSource || S.transportSource.kind !== "real") setTransportSource(realTransportSource());
    transportToEnd();
  }

  // The map-docked home for everything you need while *watching* a real
  // packet replay: the transport controls, the live status line, and a key
  // explaining the line colours (a replay can put five differently
  // coloured/styled line types on the map at once — proven+modeled,
  // proven+unmodeled, predicted-unconfirmed, plus the real-activity
  // replay's own target/context colours — which is genuinely hard to read
  // without one).
  //
  // The transport controls are duplicated here rather than living only in
  // the bottleneck modal because that modal covers the map: driving the
  // replay from it meant never being able to see the replay it was
  // driving. Both copies call the same functions and share one status
  // string (setRealReplayStatus), so they can't drift.
  
  function ensureBottleneckLegendControl() {
    if (S.bottleneckLegendControl) return;
    S.bottleneckLegendControl = L.control({ position: "bottomleft" });
    S.bottleneckLegendControl.onAdd = function () {
      const div = L.DomUtil.create("div", "sim-bottleneck-legend");
      // Item 14 — a real collapsible header, replacing the old static one.
      // Kept expanded by default (the shared helper's own normal default)
      // rather than collapsed: tests/simulator.spec.js asserts this key's
      // own row text is present right after a replay, with no prior
      // interaction with this control itself.
      const rows = `
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#4ade80"></span>Proven &amp; modeled</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#38bdf8"></span>Proven, outside our model</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:#facc15"></span>Predicted, unconfirmed</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:#818cf8"></span>Predicted, no evidence either way</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:${REAL_TARGET_COLOR}"></span>Replayed packet (window view)</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:${REAL_CONTEXT_COLOR}"></span>Other real traffic (window view)</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:${REAL_FLOOD_REACH_COLOR}"></span>Simulated flood (unobserved)</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:${REAL_PREDICTED_COLLIDED_COLOR}"></span>Simulated collision</div>
      `;
      div.innerHTML = `
        <div id="sim-map-real-replay-controls" class="sim-real-replay-controls hidden">
          <div class="plan-row sim-playback-buttons">
            <button id="sim-map-real-replay" title="Watch the real traffic in this packet's window play out on the map, in the order it actually happened">▶ Play real traffic</button>
            <button id="sim-map-real-replay-skip" title="Jump straight to the whole window drawn at once">⏭ Skip to end</button>
          </div>
          <label class="sim-flood-reach-toggle" title="These are floods, so every transmission was heard by everyone in earshot — not just the one path CoreScope could reconstruct. This plays our model's own simulation of the same window alongside the observations, filling in around them.">
            <input type="checkbox" id="sim-map-show-flood-reach" checked>
            Show the whole flood
          </label>
          <label class="sim-flood-reach-toggle" title="The static proven-vs-predicted summary for the target packet (the green/blue/amber lines in the key below). Off while replaying: it's every hop at once, so it covers the map before the replay has played anything and makes t=0 look like it already happened.">
            <input type="checkbox" id="sim-map-show-proven">
            Show proven/predicted overlay
          </label>
          <div class="plan-hint" id="sim-map-real-replay-status"></div>
        </div>
        ${window.HopReachMapControls.collapsibleHtml("Map key", rows, "sim-bottleneck-legend")}
        <button id="sim-map-open-bottleneck" class="sim-map-open-analysis" title="Open the full proven-vs-predicted breakdown (covers the map while it's open)">🔍 Bottleneck analysis</button>
      `;
      L.DomEvent.disableClickPropagation(div);
      window.HopReachMapControls.wireCollapsible(div);
      div.querySelector("#sim-map-real-replay").addEventListener("click", startRealTimelineReplay);
      div.querySelector("#sim-map-real-replay-skip").addEventListener("click", skipRealTimelineToEnd);
      // Toggling redraws the current instant in place rather than only
      // affecting the next play — same live-lens principle as "Keep all
      // paths" (see redrawPathsForKeepAllPaths).
      div.querySelector("#sim-map-show-flood-reach").addEventListener("change", () => {
        if (S.transportSource && S.transportSource.kind === "real") transportSeekTo(S.transportPlayMs);
      });
      div.querySelector("#sim-map-show-proven").addEventListener("change", (e) => {
        if (e.target.checked) simProvenLayer.addTo(map);
        else map.removeLayer(simProvenLayer);
      });
      div.querySelector("#sim-map-open-bottleneck").addEventListener("click", () => openModal("sim-bottleneck-modal"));
      return div;
    };
    S.bottleneckLegendControl.addTo(map);
  }

  // Shows/hides the map-docked transport controls and labels them with the
  // window actually in use, so "±20s" on the panel control and what the map
  // offers to play can never disagree.
  function syncRealReplayControls() {
    const wrap = document.getElementById("sim-map-real-replay-controls");
    if (!wrap) return;
    wrap.classList.toggle("hidden", S.realTimelineEvents.length === 0);
    const btn = document.getElementById("sim-map-real-replay");
    if (btn) btn.textContent = `▶ Play real ±${S.lastRealTimelineWindowSecs}s`;
    // Also called after the control is rebuilt from scratch (reopening the
    // simulator panel tears it down), so the status has to be restored onto
    // the fresh DOM rather than left blank.
    const mapStatus = document.getElementById("sim-map-real-replay-status");
    if (mapStatus) mapStatus.textContent = S.lastRealReplayStatusText;
  }

  function removeBottleneckLegendControl() {
    if (S.bottleneckLegendControl) {
      map.removeControl(S.bottleneckLegendControl);
      S.bottleneckLegendControl = null;
    }
  }

  function init(context) {
    ({ map, matchesViewFilter, openModal, pulseAt, setStatus, setTransportSource, simProvenLayer, simRealActivityLayer, simViewMode, transportPause, transportPlay, transportSeekTo, transportToEnd } = context);
    return api;
  }

  const api = {
    init,
    buildRealTimeline,
    buildReplayObservations,
    buildReplayTimeline,
    ensureBottleneckLegendControl,
    removeBottleneckLegendControl,
    setRealReplayStatus,
    skipRealTimelineToEnd,
    startRealTimelineReplay,
    stopRealTimelineReplay,
    syncRealReplayControls,
  };
  return api;
});
