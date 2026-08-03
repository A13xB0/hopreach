// Cover an area: drawing the target polygon and running the auto-placer that suggests where new repeaters would do the most good.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanArea = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.PlanState;

  let AREA_MAX_NEW_KEY, areaLayer, cfg, effectiveRealRepeaters, ensureWorker, escapeHtml, planSites, previewRangeKm, randomId, redrawPlannedMarkers, renderRepeaterList, scheduleCoveragePreview;

  // --- cover an area (auto-placer) ---------------------------------------
  //
  // Draw a polygon; the worker works out where to put up to N new
  // repeaters to maximize coverage of the enclosed area, reusing whatever
  // coverage already exists from real repeaters and anything already in
  // the plan (see planner-worker.js's handleAreaCoverage for the
  // algorithm — greedy maximum-coverage, same "heuristic, not a solver"
  // framing as Connect repeaters).

  function areaMaxNewInput() {
    return document.getElementById("plan-area-max-new");
  }

  function setAreaStatus(text) {
    const el = document.getElementById("plan-area-status");
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function renderAreaList(sites) {
    const list = document.getElementById("plan-area-list");
    list.innerHTML = "";
    if (!sites || sites.length === 0) return;
    sites.forEach((site) => {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `<span class="plan-item-label">${escapeHtml(site.label)}</span><span class="plan-item-sub">new</span>`;
      list.appendChild(row);
    });
  }

  function clearAreaSelection() {
    S.areaGeneration++; // discard any in-flight result
    S.areaPolygonPoints = [];
    S.areaPolygonShape = null;
    areaLayer.clearLayers();
    setAreaStatus(null);
    renderAreaList([]);
    document.getElementById("plan-area-finish").disabled = true;
  }

  function redrawAreaShape() {
    areaLayer.clearLayers();
    for (const pt of S.areaPolygonPoints) {
      L.circleMarker([pt.lat, pt.lon], { radius: 4, color: "#facc15", weight: 2, fillOpacity: 1 }).addTo(areaLayer);
    }
    if (S.areaPolygonPoints.length >= 3) {
      S.areaPolygonShape = L.polygon(S.areaPolygonPoints.map((p) => [p.lat, p.lon]), { color: "#facc15", weight: 2, fillOpacity: 0.08 }).addTo(areaLayer);
    } else if (S.areaPolygonPoints.length === 2) {
      S.areaPolygonShape = L.polyline(S.areaPolygonPoints.map((p) => [p.lat, p.lon]), { color: "#facc15", weight: 2 }).addTo(areaLayer);
    } else {
      S.areaPolygonShape = null;
    }
  }

  function addAreaPoint(lat, lon) {
    S.areaPolygonPoints.push({ lat, lon });
    redrawAreaShape();
    document.getElementById("plan-area-finish").disabled = S.areaPolygonPoints.length < 3;
    setAreaStatus(
      `${S.areaPolygonPoints.length} point${S.areaPolygonPoints.length === 1 ? "" : "s"} — ${
        S.areaPolygonPoints.length < 3 ? "add at least 3 to finish the shape." : "click Finish shape, or keep clicking to add more."
      }`
    );
  }

  function runAreaCoverageSearch() {
    if (S.areaPolygonPoints.length < 3) return;
    const generation = ++S.areaGeneration;
    setAreaStatus("Searching…");
    renderAreaList([]);

    let maxNewSites = parseInt(areaMaxNewInput().value, 10);
    if (!Number.isFinite(maxNewSites) || maxNewSites < 1) maxNewSites = undefined;

    ensureWorker().postMessage({
      kind: "area-coverage",
      generation,
      polygon: S.areaPolygonPoints,
      maxNewSites,
      existingSites: planSites(),
      realRepeaters: effectiveRealRepeaters(),
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
      // Score against whatever range the coverage preview is currently set
      // to draw, so the percentage this reports and the overlay the user
      // then sees are talking about the same radio.
      previewRangeKm: previewRangeKm(),
    });
  }

  // New sites become ordinary planned repeaters — draggable, renameable,
  // deletable, and they feed the existing coverage preview exactly like
  // anything added via "+ Add repeater" or Connect repeaters.
  function renderAreaResult(msg) {
    const newSites = msg.newSites || [];
    const placed = [];

    if (newSites.length > 0) {
      const startCount = S.plan.repeaters.length;
      newSites.forEach((site, i) => {
        const label = `Area relay ${startCount + i + 1}`;
        S.plan.repeaters.push({ id: randomId(), label, lat: site.lat, lon: site.lon, antennaHeightM: null });
        placed.push({ label });
      });
      renderRepeaterList();
      redrawPlannedMarkers();
      scheduleCoveragePreview();
    }

    redrawAreaShape(); // keep the polygon outline visible after committing
    renderAreaList(placed);

    if (newSites.length === 0 && msg.afterPct >= 100) {
      setAreaStatus("Already fully covered by existing infrastructure — no new repeaters needed.");
    } else if (newSites.length === 0) {
      setAreaStatus(`No candidate site inside the shape could improve coverage (currently ${msg.afterPct}%).`);
    } else {
      setAreaStatus(
        `Placed ${newSites.length} new repeater${newSites.length === 1 ? "" : "s"} — coverage of the selected area improved from ${msg.beforePct}% to ${msg.afterPct}%.`
      );
    }
  }




  // Deferred to init(): these run against things the context supplies, so at
  // module-load time there is nothing yet to bind to.
  function bindDom() {
    document.getElementById("plan-area-finish").addEventListener("click", runAreaCoverageSearch);

    document.getElementById("plan-area-clear").addEventListener("click", clearAreaSelection);

    (function initAreaMaxNewInput() {
      const input = areaMaxNewInput();
      const saved = parseInt(localStorage.getItem(AREA_MAX_NEW_KEY), 10);
      if (Number.isFinite(saved) && saved >= 1 && saved <= 20) input.value = saved;
      input.addEventListener("change", () => {
        let v = parseInt(input.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        if (v > 20) v = 20;
        input.value = v;
        localStorage.setItem(AREA_MAX_NEW_KEY, String(v));
      });
    })();
  }

  function init(context) {
    ({ AREA_MAX_NEW_KEY, areaLayer, cfg, effectiveRealRepeaters, ensureWorker, escapeHtml, planSites, previewRangeKm, randomId, redrawPlannedMarkers, renderRepeaterList, scheduleCoveragePreview } = context);
    bindDom();
    return api;
  }

  const api = {
    init,
    addAreaPoint,
    clearAreaSelection,
    renderAreaResult,
    setAreaStatus,
  };
  return api;
});
