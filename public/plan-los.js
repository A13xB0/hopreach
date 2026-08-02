// Line of sight: the terrain profile chain, one hop at a time, with each hop's clearance drawn on the map.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanLos = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.PlanState;

  let cfg, escapeHtml, losLayer;

  // --- line of sight ----------------------------------------------------

  
  function addLosPoint(lat, lon, label) {
    S.losChain.push({ lat, lon, label: label || `Point ${S.losChain.length + 1}` });
    renderLosList();
    redrawLosChain();
  }

  function clearLosChain() {
    S.losChain = [];
    renderLosList();
    redrawLosChain();
  }

  function renderLosList() {
    const list = document.getElementById("plan-los-list");
    list.innerHTML = "";
    if (S.losChain.length === 0) {
      list.innerHTML = '<div class="plan-empty">Click the map to start a hop chain.</div>';
      return;
    }
    for (let i = 0; i < S.losChain.length; i++) {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `<span class="plan-item-label">${escapeHtml(S.losChain[i].label)}</span>`;
      list.appendChild(row);
      if (i > 0) {
        const hopRow = document.createElement("div");
        hopRow.className = "plan-hop-result";
        hopRow.id = `plan-hop-${i}`;
        hopRow.textContent = "Calculating…";
        list.appendChild(hopRow);
      }
    }
  }

  async function redrawLosChain() {
    losLayer.clearLayers();
    for (const pt of S.losChain) {
      L.circleMarker([pt.lat, pt.lon], { radius: 5, color: "#e2e8f0", weight: 2, fillOpacity: 1 }).addTo(losLayer);
    }
    for (let i = 1; i < S.losChain.length; i++) {
      const a = S.losChain[i - 1];
      const b = S.losChain[i];
      const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: "#64748b", weight: 3, dashArray: "4 4" }).addTo(losLayer);
      computeHop(a, b, i, line);
    }
  }

  async function computeHop(a, b, hopIndex, line) {
    await Propagation.ready;
    const distanceKm = Propagation.haversineKm(a.lat, a.lon, b.lat, b.lon);
    const rangeKm = Propagation.linkBudgetMaxRangeKm(cfg.propagation);
    const resultEl = document.getElementById(`plan-hop-${hopIndex}`);

    // Check the pure link-budget distance cutoff before fetching any
    // terrain: diffraction only ever adds loss relative to free space, so
    // if the distance alone already exceeds the link budget, no amount of
    // clear line-of-sight can save it — and a hop clicked far off-target
    // (e.g. hundreds of km) would otherwise force a terrain fetch spanning
    // that whole bounding box for no reason.
    if (distanceKm > rangeKm) {
      const status = `Out of range (${distanceKm.toFixed(1)}km > ${rangeKm.toFixed(0)}km max)`;
      if (resultEl) resultEl.textContent = status;
      line.setStyle({ color: "#f87171", dashArray: null, weight: 4 });
      return;
    }

    const kmPerDegLat = 110.574;
    const kmPerDegLon = Math.max(1, 111.32 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180));
    const pad = 1.5; // km of context around the straight path
    const bounds = {
      south: Math.min(a.lat, b.lat) - pad / kmPerDegLat,
      north: Math.max(a.lat, b.lat) + pad / kmPerDegLat,
      west: Math.min(a.lon, b.lon) - pad / kmPerDegLon,
      east: Math.max(a.lon, b.lon) + pad / kmPerDegLon,
    };

    try {
      const grid = await Terrain.buildLocalGrid(cfg.demTileURLBase, cfg.demZoom, bounds);
      const aGroundM = grid.at(a.lat, a.lon);
      const aHeightASL = aGroundM + cfg.propagation.antennaHeightM;

      let status, color;
      const margin = Propagation.pathMargin(grid, cfg.propagation, a.lat, a.lon, aHeightASL, b.lat, b.lon, distanceKm);
      if (margin < 0) {
        status = `Blocked — ${margin.toFixed(1)}dB (${distanceKm.toFixed(1)}km)`;
        color = "#f87171";
      } else if (margin < cfg.propagation.marginGreenDb) {
        status = `Marginal — +${margin.toFixed(1)}dB (${distanceKm.toFixed(1)}km)`;
        color = "#facc15";
      } else {
        status = `Clear — +${margin.toFixed(1)}dB (${distanceKm.toFixed(1)}km)`;
        color = "#4ade80";
      }
      if (resultEl) resultEl.textContent = status;
      line.setStyle({ color, dashArray: null, weight: 4 });
    } catch (err) {
      if (resultEl) resultEl.textContent = `Error: ${err.message || err}`;
    }
  }


  function init(context) {
    ({ cfg, escapeHtml, losLayer } = context);
    return api;
  }

  const api = {
    init,
    addLosPoint,
    clearLosChain,
    redrawLosChain,
    renderLosList,
  };
  return api;
});
