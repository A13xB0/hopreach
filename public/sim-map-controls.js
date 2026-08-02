// The map-docked simulator controls: the view-mode switcher that filters what the map draws, and the live run-stats readout beside it.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimMapControls = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let applyFinalGrowth, drawSelectedMessagePath, growthMarkers, map, redrawPathsForKeepAllPaths, renderStatStrip, simResultsLayer, simViewMode, transportSeekTo;

  // --- "Simulator view" map control --------------------------------------
  //
  // A Map-detail-style control, but only ever present while Simulate mode
  // itself is open (created/destroyed alongside it, see setSimPanelOpen) —
  // it has nothing to say about the base coverage map. Lets the *view* of
  // a run's results be changed without re-running anything: which
  // dimension a growth marker tracks, whether old wave lines stay on the
  // map as a trail or only the latest wave shows, and which half of what
  // happened (successes/collisions) is shown at all.
  
  function ensureSimViewControl() {
    if (S.simViewControl) return;
    S.simViewControl = L.control({ position: "topright" });
    S.simViewControl.onAdd = function () {
      const div = L.DomUtil.create("div", "position-mode-control sim-view-control");
      const body = `
        <label class="plan-checkbox-row"><input type="checkbox" id="sim-view-keep-paths" checked> Keep all paths</label>
        <div class="plan-section-title">Show</div>
        <select id="sim-view-filter">
          <option value="all">All</option>
          <option value="successes">Successes only</option>
          <option value="collisions">Collisions only</option>
        </select>
        <div class="plan-section-title">Grow circles by</div>
        <select id="sim-view-grow-by">
          <option value="success">Successful receptions</option>
          <option value="collision">Collisions (most-collided repeater)</option>
        </select>
      `;
      div.innerHTML = window.HopReachMapControls.collapsibleHtml("Simulator view", body, "sim-view");
      L.DomEvent.disableClickPropagation(div);
      window.HopReachMapControls.wireCollapsible(div);

      div.querySelector("#sim-view-keep-paths").addEventListener("change", (e) => {
        simViewMode.keepAllPaths = e.target.checked;
        // Apply immediately to what's already on screen — same idea as
        // the filter control below, and the reason this is a live lens
        // rather than a pre-run setting. A replay still in flight keeps
        // playing; its next wave picks the new mode up naturally.
        // (A selected message's own path lives on its own layer and is
        // filter-driven, not keepAllPaths-driven, so it's untouched here.)
        // Leaves a loaded packet replay alone: it accumulates its window by
        // design, and this used to wipe the analysis overlay it had drawn.
        if (S.transportSource && S.transportSource.kind === "real") return;
        redrawPathsForKeepAllPaths();
      });
      div.querySelector("#sim-view-filter").addEventListener("change", (e) => {
        simViewMode.filter = e.target.value;
        // Re-render whatever's currently on screen against the new
        // filter — a live replay in progress just keeps going (its next
        // wave picks the new filter up naturally), but a static
        // skip-to-end view or a selected message's own path needs an
        // explicit refresh to actually reflect the change. Routed through
        // redrawPathsForKeepAllPaths rather than redrawResultLines so a
        // filter change can't silently resurrect every path while
        // "Keep all paths" is unticked.
        // Whichever replay the transport is actually driving is the one that
        // has to re-render — filtering only ever touched the simulation's
        // layer, so changing it while watching a packet replay appeared to
        // do nothing at all.
        if (S.transportSource && S.transportSource.kind === "real") {
          transportSeekTo(S.transportPlayMs);
        } else if (S.lastReport && S.replayIndex >= S.replayWaves.length) {
          redrawPathsForKeepAllPaths();
        }
        drawSelectedMessagePath();
      });
      div.querySelector("#sim-view-grow-by").addEventListener("change", (e) => {
        simViewMode.growBy = e.target.value;
        growthMarkers.forEach((marker) => simResultsLayer.removeLayer(marker));
        growthMarkers.clear();
        S.nodeGrowthCounts = [];
        if (S.lastReport) applyFinalGrowth(S.lastReport);
      });
      return div;
    };
    S.simViewControl.addTo(map);
  }

  function removeSimViewControl() {
    if (S.simViewControl) {
      map.removeControl(S.simViewControl);
      S.simViewControl = null;
    }
  }

  // --- map-docked live run stats -------------------------------------
  //
  // Used to be Replay/Skip-to-end buttons plus a full reception-log copy —
  // both fully superseded once the shared scrub/play/pause transport
  // (setTransportSource) landed: that bar already plays, pauses and seeks
  // (dragging to the end IS "skip to end"), the Results modal has its own
  // Replay/Skip-to-end buttons for driving it from there, and the modal's
  // own reception log already shows the same rows this used to duplicate.
  // Found still sitting on the map doing nothing anyone was using — see
  // the git history for this comment.
  //
  // Repurposed into something the transport bar doesn't cover: a live
  // running tally (received/collided/delivery so far) that advances in
  // step with the scrubber, so watching a replay answers "is this actually
  // going well" without opening the modal that would cover the map you're
  // watching it play out on.
  
  function ensureSimPlaybackControl() {
    if (S.simPlaybackControl) return;
    S.simPlaybackControl = L.control({ position: "bottomleft" });
    S.simPlaybackControl.onAdd = function () {
      const div = L.DomUtil.create("div", "sim-playback-control");
      div.innerHTML = `
        <div class="map-control-header-static">Run so far</div>
        <div id="sim-map-live-stats" class="sim-stat-strip sim-stat-strip-compact"></div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    S.simPlaybackControl.addTo(map);
    updateMapLiveStats(0);
  }

  function removeSimPlaybackControl() {
    if (S.simPlaybackControl) {
      map.removeControl(S.simPlaybackControl);
      S.simPlaybackControl = null;
    }
  }

  // wavesPlayed is how many waves the transport has revealed so far (see
  // simTransportSource's own countWavesUpTo) — flattening exactly those
  // waves' own receptions, rather than reading the full report, is what
  // makes this track the scrubber instead of jumping straight to the final
  // tally the instant a run finishes.
  function updateMapLiveStats(wavesPlayed) {
    const el = document.getElementById("sim-map-live-stats");
    if (!el) return;
    const receptions = S.replayWaves.slice(0, wavesPlayed).flatMap((w) => w.receptions);
    const collided = receptions.filter((r) => r.collided).length;
    const total = receptions.length;
    const rate = total > 0 ? (collided / total) * 100 : 0;
    renderStatStrip(el, [
      // "receptions" (not "received") — same word the Results modal's own
      // stat strip uses for this exact total-including-collided count, see
      // renderResults, so the two never imply different things for the
      // same number.
      { label: "receptions", value: total },
      { label: "collided", value: collided, tone: rate >= 30 ? "bad" : "" },
    ]);
  }

  function init(context) {
    ({ applyFinalGrowth, drawSelectedMessagePath, growthMarkers, map, redrawPathsForKeepAllPaths, renderStatStrip, simResultsLayer, simViewMode, transportSeekTo } = context);
    return api;
  }

  const api = {
    init,
    ensureSimPlaybackControl,
    ensureSimViewControl,
    removeSimPlaybackControl,
    removeSimViewControl,
    updateMapLiveStats,
  };
  return api;
});
