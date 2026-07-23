(function () {
  const cfg = window.HOPREACH_CONFIG;
  const { map, layersControl } = window.MCCoverageMap;

  const STORAGE_KEY = "hopreach.plans";
  const CONNECT_MAX_NEW_KEY = "hopreach.connectMaxNew";
  const AREA_MAX_NEW_KEY = "hopreach.areaMaxNew";
  const PREVIEW_WIDTH = 320;
  const DEBOUNCE_MS = 400;

  let plan = null;
  let mode = "off"; // 'off' | 'add-repeater' | 'adjust-repeater' | 'los' | 'connect-repeaters' | 'area-coverage'
  let worker = null;
  let debounceTimer = null;
  let previewOverlay = null;
  let previewGeneration = 0;
  let connectGeneration = 0;
  let connectPointA = null;
  let connectPointB = null;
  let connectOptions = [];
  let connectSelectedIndex = null;
  let areaGeneration = 0;
  let areaPolygonPoints = [];
  let areaPolygonShape = null; // the live L.polygon/L.polyline preview while drawing

  const plannedMarkersLayer = L.layerGroup().addTo(map);
  const overrideMarkersLayer = L.layerGroup().addTo(map);
  const overrideLinesLayer = L.layerGroup().addTo(map); // dashed connector back to each override's original position
  const losLayer = L.layerGroup().addTo(map);
  const connectLayer = L.layerGroup().addTo(map); // the resulting hop chain from "Connect repeaters"
  const areaLayer = L.layerGroup().addTo(map); // the drawn polygon for "Cover an area"
  const neighborLayer = L.layerGroup().addTo(map); // transient, hover-driven
  const allNeighborsLayer = L.layerGroup(); // persistent, toggled — not added to map by default
  let showAllNeighborsEnabled = false;
  const pinnedNeighborLayer = L.layerGroup().addTo(map); // persistent, click-to-pin on a single real repeater
  let pinnedPubkey = null;
  // Separate layers: the marker persists across recomputes, while
  // showNeighborHighlight's target layer gets cleared+redrawn on every
  // call (that's how it erases the previous lines/tooltip) — sharing one
  // layer would wipe the marker out the moment a computation started.
  const companionMarkerLayer = L.layerGroup().addTo(map);
  const companionPinLayer = L.layerGroup().addTo(map); // predicted-neighbour lines + tooltip only
  let companionPinMode = false;
  let companionMarker = null;

  // Real repeaters: {pubkey -> {id,label,lat,lon}}, populated by
  // window.onRepeatersLoaded (called from app.js once the real repeater
  // GeoJSON loads/reloads). Predicted neighbours for planned repeaters:
  // {repeaterId -> [{id,label,isReal,lat,lon,distanceKm,marginDb}]}, filled
  // in whenever a coverage preview result arrives. Observed neighbours for
  // real repeaters come straight from CoreScope, cached per pubkey since
  // they don't change within a session.
  let realRepeatersById = {};
  const realNeighborCache = new Map();
  let plannedNeighborsById = {};

  // Deleting a repeater/override removes its own cached neighbour entry,
  // but other sites' cached neighbour lists can still contain a reference
  // *to* it until the next preview result overwrites the whole cache —
  // which can be delayed indefinitely if that next preview happens to
  // error out. Purge it everywhere immediately instead of waiting.
  function purgeNeighborRef(id) {
    delete plannedNeighborsById[id];
    for (const key of Object.keys(plannedNeighborsById)) {
      const list = plannedNeighborsById[key];
      if (list && list.some((n) => n.id === id)) {
        plannedNeighborsById[key] = list.filter((n) => n.id !== id);
      }
    }
  }

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function emptyPlan() {
    return { id: randomId(), name: "Untitled plan", repeaters: [], hopChains: [], overrides: [], notes: "" };
  }

  // Older saved/exported/shared plans predate the overrides field.
  function normalizePlan(p) {
    if (!Array.isArray(p.overrides)) p.overrides = [];
    return p;
  }

  // --- localStorage plan CRUD -------------------------------------------

  function loadAllPlans() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveAllPlans(all) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  function persistCurrentPlan() {
    plan.name = document.getElementById("plan-name").value || "Untitled plan";
    const all = loadAllPlans();
    all[plan.id] = plan;
    saveAllPlans(all);
    refreshPlanSelect();
  }

  function deleteCurrentPlan() {
    const all = loadAllPlans();
    delete all[plan.id];
    saveAllPlans(all);
    setActivePlan(emptyPlan());
  }

  function refreshPlanSelect() {
    const sel = document.getElementById("plan-select");
    const all = loadAllPlans();
    const ids = Object.keys(all);
    sel.innerHTML = "";
    if (ids.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(no saved plans)";
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      return;
    }
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = all[id].name || "(untitled)";
      if (plan && id === plan.id) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function setActivePlan(p) {
    plan = normalizePlan(p);
    document.getElementById("plan-name").value = plan.name;
    plannedNeighborsById = {}; // stale predictions from the old plan; fresh ones arrive with the next preview
    renderAllPlannedNeighbors();
    renderRepeaterList();
    renderOverrideList();
    renderLosList();
    redrawPlannedMarkers();
    redrawOverrideMarkers();
    redrawLosChain();
    refreshPlanSelect();
    scheduleCoveragePreview();
  }

  // --- planned repeaters ---------------------------------------------

  function addRepeaterAt(lat, lon) {
    const n = plan.repeaters.length + 1;
    plan.repeaters.push({ id: randomId(), label: `Planned #${n}`, lat, lon, antennaHeightM: null });
    renderRepeaterList();
    redrawPlannedMarkers();
    scheduleCoveragePreview();
  }

  function removeRepeater(id) {
    plan.repeaters = plan.repeaters.filter((r) => r.id !== id);
    purgeNeighborRef(id);
    renderRepeaterList();
    redrawPlannedMarkers();
    renderAllPlannedNeighbors();
    scheduleCoveragePreview();
  }

  function renderRepeaterList() {
    const list = document.getElementById("plan-repeater-list");
    list.innerHTML = "";
    if (plan.repeaters.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — use "Add repeater" and click the map.</div>';
      return;
    }
    for (const r of plan.repeaters) {
      const neighbors = plannedNeighborsById[r.id];
      const neighborLine =
        neighbors == null
          ? "calculating neighbours…"
          : `${neighbors.length} predicted neighbour${neighbors.length === 1 ? "" : "s"}`;
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(r.label)}</span>
        <span class="plan-item-sub">${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}${r.antennaHeightM != null ? ` · ${r.antennaHeightM}m mast` : ""}</span>
        <span class="plan-item-sub plan-item-neighbors">📡 ${neighborLine}</span>
        <span class="plan-item-actions">
          <button data-act="rename" title="Rename">✎</button>
          <button data-act="height" title="Set mast height">↕</button>
          <button data-act="delete" title="Delete">✕</button>
        </span>
      `;
      row.querySelector('[data-act="rename"]').onclick = () => {
        const name = prompt("Repeater label:", r.label);
        if (name) {
          r.label = name;
          renderRepeaterList();
          redrawPlannedMarkers();
        }
      };
      row.querySelector('[data-act="height"]').onclick = () => {
        const h = prompt(
          `Mast height above ground (m). Leave blank to use the default (${cfg.propagation.antennaHeightM}m):`,
          r.antennaHeightM != null ? String(r.antennaHeightM) : ""
        );
        if (h === null) return;
        r.antennaHeightM = h.trim() === "" ? null : parseFloat(h);
        renderRepeaterList();
        scheduleCoveragePreview();
      };
      row.querySelector('[data-act="delete"]').onclick = () => removeRepeater(r.id);
      if (neighbors && neighbors.length > 0) {
        row.addEventListener("mouseenter", () => showNeighborHighlight([r.lat, r.lon], r.label, neighbors, false));
        row.addEventListener("mouseleave", clearNeighborHighlight);
      }
      list.appendChild(row);
    }
  }

  function redrawPlannedMarkers() {
    plannedMarkersLayer.clearLayers();
    for (const r of plan.repeaters) {
      const marker = L.marker([r.lat, r.lon], {
        draggable: true,
        icon: L.divIcon({ className: "planned-marker-icon", html: '<div class="planned-marker-dot"></div>', iconSize: [16, 16] }),
      });
      // No separate marker.bindTooltip() here: showNeighborHighlight's own
      // tooltip already shows the label as its title, and having Leaflet's
      // built-in hover tooltip *and* the neighbour tooltip both trying to
      // show at once for the same hover is what caused the flicker.
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        r.lat = ll.lat;
        r.lon = ll.lng;
        renderRepeaterList();
        renderAllPlannedNeighbors(); // reposition this repeater's lines now; predictions catch up on the next preview
        scheduleCoveragePreview();
      });
      marker.on("mouseover", () => {
        const neighbors = plannedNeighborsById[r.id] || [];
        showNeighborHighlight(marker.getLatLng(), r.label, neighbors, false);
      });
      marker.on("mouseout", clearNeighborHighlight);
      marker.addTo(plannedMarkersLayer);
    }
  }

  // --- adjusted (real) repeaters ---------------------------------------
  //
  // A personal, local-only repositioning/height override of an *existing*
  // real repeater — never touches repeaters.geojson or anyone else's view.
  // Renders as a separate amber marker plus a dashed line back to the
  // repeater's real position; the official marker (app.js, driven by the
  // server data) is never hidden or replaced. Feeds into the same
  // coverage-preview worker as planned repeaters (see runCoveragePreview),
  // which is the literal "browser recalculates the coverage" ask.

  function findOverride(pubkey) {
    return plan.overrides.find((o) => o.pubkey === pubkey);
  }

  function grabForAdjustment(pubkey, label, lat, lon) {
    if (findOverride(pubkey)) return; // already adjusted — click again does nothing extra
    plan.overrides.push({ pubkey, label, origLat: lat, origLon: lon, lat, lon, antennaHeightM: null });
    renderOverrideList();
    redrawOverrideMarkers();
    scheduleCoveragePreview();
  }

  function removeOverride(pubkey) {
    plan.overrides = plan.overrides.filter((o) => o.pubkey !== pubkey);
    purgeNeighborRef(pubkey);
    renderOverrideList();
    redrawOverrideMarkers();
    renderAllPlannedNeighbors();
    renderRepeaterList();
    scheduleCoveragePreview();
  }

  function resetOverridePosition(pubkey) {
    const o = findOverride(pubkey);
    if (!o) return;
    o.lat = o.origLat;
    o.lon = o.origLon;
    renderOverrideList();
    redrawOverrideMarkers();
    scheduleCoveragePreview();
  }

  function renderOverrideList() {
    const section = document.getElementById("plan-override-section");
    const list = document.getElementById("plan-override-list");
    section.classList.toggle("hidden", mode !== "adjust-repeater" && plan.overrides.length === 0);
    list.innerHTML = "";
    if (plan.overrides.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — use "Adjust repeater" and click an existing repeater.</div>';
      return;
    }
    for (const o of plan.overrides) {
      const movedKm = Propagation.haversineKm(o.origLat, o.origLon, o.lat, o.lon);
      const movedM = movedKm * 1000;
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(o.label)}</span>
        <span class="plan-item-sub">${o.lat.toFixed(4)}, ${o.lon.toFixed(4)}${o.antennaHeightM != null ? ` · ${o.antennaHeightM}m mast` : ""}${movedM > 1 ? ` · moved ${movedM.toFixed(0)}m` : ""}</span>
        <span class="plan-item-actions">
          <button data-act="height" title="Set mast height">↕</button>
          <button data-act="reset" title="Reset to original position" ${movedM > 1 ? "" : "disabled"}>↺</button>
          <button data-act="delete" title="Remove adjustment">✕</button>
        </span>
      `;
      row.querySelector('[data-act="height"]').onclick = () => {
        const h = prompt(
          `Mast height above ground (m). Leave blank to use the default (${cfg.propagation.antennaHeightM}m):`,
          o.antennaHeightM != null ? String(o.antennaHeightM) : ""
        );
        if (h === null) return;
        o.antennaHeightM = h.trim() === "" ? null : parseFloat(h);
        renderOverrideList();
        scheduleCoveragePreview();
      };
      row.querySelector('[data-act="reset"]').onclick = () => resetOverridePosition(o.pubkey);
      row.querySelector('[data-act="delete"]').onclick = () => removeOverride(o.pubkey);
      list.appendChild(row);
    }
  }

  function redrawOverrideMarkers() {
    overrideMarkersLayer.clearLayers();
    overrideLinesLayer.clearLayers();
    for (const o of plan.overrides) {
      const marker = L.marker([o.lat, o.lon], {
        draggable: true,
        icon: L.divIcon({ className: "override-marker-icon", html: '<div class="override-marker-dot"></div>', iconSize: [14, 14] }),
      });
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        o.lat = ll.lat;
        o.lon = ll.lng;
        renderOverrideList();
        redrawOverrideMarkers();
        scheduleCoveragePreview();
      });
      marker.addTo(overrideMarkersLayer);

      const movedM = Propagation.haversineKm(o.origLat, o.origLon, o.lat, o.lon) * 1000;
      if (movedM > 1) {
        L.polyline([[o.origLat, o.origLon], [o.lat, o.lon]], {
          color: "#94a3b8",
          weight: 1.5,
          dashArray: "4 4",
          interactive: false,
        }).addTo(overrideLinesLayer);
      }
    }
  }

  // --- neighbours: shared display for both real (observed) and planned
  // (predicted) repeaters -------------------------------------------------

  function neighborQualityClass(n, isReal) {
    if (isReal) return n.bidir ? "nb-strong" : "nb-weak";
    if (n.marginDb >= cfg.propagation.marginGreenDb) return "nb-strong";
    if (n.marginDb >= 0) return "nb-marginal";
    return "nb-weak";
  }

  function neighborLineColor(n, isReal) {
    const cls = neighborQualityClass(n, isReal);
    return cls === "nb-strong" ? "#4ade80" : cls === "nb-marginal" ? "#facc15" : "#f87171";
  }

  // Draws connection lines + endpoint dots for one source's neighbours into
  // the given layer group. Shared by the hover highlight (one source at a
  // time, with a tooltip) and the persistent "show all" overlay (every
  // planned repeater at once, no tooltip — would be too busy).
  function drawNeighborLines(targetLayer, src, neighbors, isReal) {
    for (const n of neighbors) {
      if (n.lat == null || n.lon == null) continue; // e.g. a real repeater CoreScope has never gotten a GPS fix for
      L.polyline([src, [n.lat, n.lon]], {
        color: neighborLineColor(n, isReal),
        weight: 2,
        opacity: 0.85,
        interactive: false,
      }).addTo(targetLayer);
      L.circleMarker([n.lat, n.lon], {
        radius: 4,
        color: "#fff",
        weight: 1,
        fillColor: neighborLineColor(n, isReal),
        fillOpacity: 1,
        interactive: false,
      }).addTo(targetLayer);
    }
  }

  function showNeighborHighlight(sourceLatLng, sourceLabel, neighbors, isReal, loading, targetLayer) {
    targetLayer = targetLayer || neighborLayer;
    targetLayer.clearLayers();
    const src = Array.isArray(sourceLatLng) ? L.latLng(sourceLatLng[0], sourceLatLng[1]) : sourceLatLng;
    drawNeighborLines(targetLayer, src, neighbors, isReal);

    const rows = neighbors
      .map((n) => {
        const cls = neighborQualityClass(n, isReal);
        const detail = isReal
          ? n.bidir
            ? "bidirectional"
            : "one-way heard"
          : `+${n.marginDb.toFixed(1)}dB`;
        // distanceKm is null when CoreScope has never gotten a GPS fix for
        // this neighbour (position, and therefore distance, unknown) —
        // real, not a data error, so degrade gracefully rather than crash.
        const distance = n.distanceKm == null ? "distance unknown" : `${n.distanceKm.toFixed(1)}km`;
        return `<li><span class="nb-dot ${cls}"></span>${escapeHtml(n.label || n.id.slice(0, 8))} — ${distance}, ${detail}</li>`;
      })
      .join("");
    const subLine = loading
      ? "Loading neighbours…"
      : `${neighbors.length} ${isReal ? "observed" : "predicted"} neighbour${neighbors.length === 1 ? "" : "s"}`;
    const html = `
      <div class="neighbor-tooltip">
        <div class="neighbor-tooltip-title">${escapeHtml(sourceLabel)}</div>
        <div class="neighbor-tooltip-sub">${subLine}</div>
        ${!loading && neighbors.length === 0 ? '<div class="plan-empty">None within range.</div>' : ""}
        ${neighbors.length ? `<ul>${rows}</ul>` : ""}
      </div>
    `;
    // interactive:false on both the tooltip and every decoration shape
    // above is what actually matters here: without it, a shape landing
    // under the cursor (e.g. a neighbour circle drawn right where the
    // source marker already is) steals the hover, which fires this
    // marker's mouseout mid-hover, clears everything, and — since the
    // cursor hasn't moved — nothing is left to fire mouseover again until
    // the pointer physically moves, which reads as a flicker.
    L.tooltip({ direction: "top", offset: [0, -10], className: "neighbor-tooltip-wrap", permanent: true, interactive: false })
      .setLatLng(src)
      .setContent(html)
      .addTo(targetLayer);
  }

  function clearNeighborHighlight() {
    neighborLayer.clearLayers();
  }

  // Neighbours section merged directly into a real repeater's own info
  // popup (see the map's popupopen handler below) rather than opening a
  // second, separate box — that used to show two competing UI elements
  // for the same click.
  function neighborSectionHtml(neighbors, loading) {
    if (loading) return '<div class="popup-neighbors"><div class="popup-neighbors-title">Neighbours</div><div class="plan-hint">Loading…</div></div>';
    const rows = neighbors
      .map((n) => {
        const cls = neighborQualityClass(n, true);
        const detail = n.bidir ? "bidirectional" : "one-way heard";
        return `<li><span class="nb-dot ${cls}"></span>${escapeHtml(n.label || n.id.slice(0, 8))} — ${n.distanceKm.toFixed(1)}km, ${detail}</li>`;
      })
      .join("");
    return `
      <div class="popup-neighbors">
        <div class="popup-neighbors-title">${neighbors.length} observed neighbour${neighbors.length === 1 ? "" : "s"}</div>
        ${neighbors.length === 0 ? '<div class="plan-empty">None within range.</div>' : `<ul>${rows}</ul>`}
      </div>
    `;
  }

  function clearPinnedLines() {
    pinnedNeighborLayer.clearLayers();
    pinnedPubkey = null;
  }

  // Persistent "show all neighbours" overlay: every planned repeater's
  // predicted links at once, kept in sync with plannedNeighborsById
  // (re-rendered after every coverage preview result, so it stays current
  // as repeaters are added/moved/deleted — no need to re-toggle it).
  function renderAllPlannedNeighbors() {
    allNeighborsLayer.clearLayers();
    if (!showAllNeighborsEnabled) return;
    for (const r of plan.repeaters) {
      const neighbors = plannedNeighborsById[r.id];
      if (!neighbors || neighbors.length === 0) continue;
      drawNeighborLines(allNeighborsLayer, L.latLng(r.lat, r.lon), neighbors, false);
    }
  }

  function setShowAllNeighbors(enabled) {
    showAllNeighborsEnabled = enabled;
    document.getElementById("plan-show-all-neighbors").checked = enabled;
    if (enabled) {
      allNeighborsLayer.addTo(map);
      renderAllPlannedNeighbors();
    } else {
      map.removeLayer(allNeighborsLayer);
    }
  }

  document.getElementById("plan-show-all-neighbors").addEventListener("change", (e) => {
    setShowAllNeighbors(e.target.checked);
  });

  // Real repeaters: neighbours come from CoreScope's own observed reach
  // data (real radio traffic), not a prediction — there's no need to guess
  // when the network has already told us who actually hears whom. Windowed
  // to a configurable lookback (default 24h, user-adjustable up to 30d) so
  // a link from a week ago that's since gone quiet doesn't read as current.
  let reachWindowDays = 1;
  function setReachWindowDays(days) {
    reachWindowDays = days;
    // Old-window entries are simply superseded (new cache key), not wiped —
    // cheap to keep in case the user flips back.
  }

  async function fetchRealNeighbors(pubkey) {
    const cacheKey = `${pubkey}:${reachWindowDays}`;
    if (realNeighborCache.has(cacheKey)) return realNeighborCache.get(cacheKey);
    const promise = fetch(`/corescope-api/api/nodes/${encodeURIComponent(pubkey)}/reach?days=${reachWindowDays}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) =>
        (data.links || []).map((l) => ({
          id: l.pubkey,
          label: l.name,
          isReal: true,
          lat: l.lat,
          lon: l.lon,
          distanceKm: l.distance_km,
          bidir: !!l.bidir,
        }))
      )
      .catch((err) => {
        realNeighborCache.delete(cacheKey); // allow retry on a later hover
        throw err;
      });
    realNeighborCache.set(cacheKey, promise);
    return promise;
  }

  // A standalone map control (not inside the plan panel — hovering/clicking
  // real repeaters for their neighbours works regardless of whether the
  // panel is open). Added at "topright" after app.js's basemap layers
  // control, so Leaflet stacks it directly beneath that automatically.
  const neighborWindowControl = L.control({ position: "topright" });
  neighborWindowControl.onAdd = function () {
    const div = L.DomUtil.create("div", "neighbor-window-control");
    div.innerHTML = `
      <label for="plan-neighbor-window">Neighbours observed in the last</label>
      <select id="plan-neighbor-window">
        <option value="1" selected>24 hours</option>
        <option value="3">3 days</option>
        <option value="7">7 days</option>
        <option value="14">14 days</option>
        <option value="30">30 days</option>
      </select>
    `;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    div.querySelector("#plan-neighbor-window").addEventListener("change", (e) => {
      setReachWindowDays(parseInt(e.target.value, 10));
    });
    return div;
  };
  neighborWindowControl.addTo(map);

  // Called by app.js each time the real repeater layer (re)loads.
  window.onRepeatersLoaded = function (geojson, layer) {
    clearPinnedLines(); // the old pin may reference a marker that no longer exists post-reload
    realRepeatersById = {};
    // Planning tools (add-repeater prediction, LOS, companion pin) should
    // reason about whichever position set the map is currently showing.
    // Named distinctly from the outer `mode` (plan interaction mode, e.g.
    // "adjust-repeater") which the click handler below also needs.
    const displayMode = window.MCCoverageMap.getPositionMode ? window.MCCoverageMap.getPositionMode() : "standard";
    for (const f of geojson.features) {
      const pubkey = f.properties.public_key;
      const useCalibrated = window.MCCoverageMap.usesCalibratedPositions(displayMode) && f.properties.calibrated_lat != null && f.properties.calibrated_lon != null;
      realRepeatersById[pubkey] = {
        id: pubkey,
        label: f.properties.name,
        lat: useCalibrated ? f.properties.calibrated_lat : f.geometry.coordinates[1],
        lon: useCalibrated ? f.properties.calibrated_lon : f.geometry.coordinates[0],
      };
    }
    layer.eachLayer((marker) => {
      const props = marker.feature && marker.feature.properties;
      if (!props || !props.public_key) return;
      let hoverToken = 0;
      marker.on("mouseover", async () => {
        if (marker.isPopupOpen()) return; // popup already shows this same info merged in
        const token = ++hoverToken;
        showNeighborHighlight(marker.getLatLng(), props.name || "Repeater", [], true, true);
        try {
          const neighbors = await fetchRealNeighbors(props.public_key);
          if (token !== hoverToken || marker.isPopupOpen()) return; // mouse left, or a click opened the popup meanwhile
          showNeighborHighlight(marker.getLatLng(), props.name || "Repeater", neighbors, true, false);
        } catch {
          if (token === hoverToken) clearNeighborHighlight();
        }
      });
      marker.on("mouseout", () => {
        hoverToken++;
        clearNeighborHighlight();
      });
      // Grabbing a repeater for adjustment (or selecting it as a Connect
      // endpoint) takes priority over its info popup. Both handlers fire
      // in the same synchronous click dispatch (app.js's bindPopup
      // registered first, opening the popup; this handler runs second and
      // closes it immediately) so it never actually paints.
      marker.on("click", (e) => {
        if (mode === "adjust-repeater") {
          marker.closePopup();
          grabForAdjustment(props.public_key, props.name || "Repeater", marker.getLatLng().lat, marker.getLatLng().lng);
          L.DomEvent.stop(e);
        } else if (mode === "connect-repeaters") {
          marker.closePopup();
          const ll = marker.getLatLng();
          selectConnectPoint({ id: props.public_key, label: props.name || "Repeater", lat: ll.lat, lon: ll.lng });
          L.DomEvent.stop(e);
        }
      });
    });
  };

  // Click behaviour lives here instead: rather than a second floating box,
  // the neighbours list is appended straight into the marker's own info
  // popup (bound in app.js) once fetched, and connection lines are drawn
  // while that popup stays open. One global handler (Leaflet fires
  // popupopen/popupclose on the map for any popup) rather than per-marker,
  // so it survives repeater data reloading without re-binding.
  map.on("popupopen", async (e) => {
    const marker = e.popup._source;
    const props = marker && marker.feature && marker.feature.properties;
    if (!props || !props.public_key) return;
    // Opening a popup means the cursor is sitting right on the marker, so
    // its hover tooltip (showNeighborHighlight) may already be showing —
    // clear it so the popup (which will carry the same info, merged) is
    // the only thing visible, not both at once.
    clearNeighborHighlight();
    marker.setPopupContent(window.MCCoverageMap.popupHtml(props) + neighborSectionHtml([], true));
    try {
      const neighbors = await fetchRealNeighbors(props.public_key);
      if (pinnedPubkey !== null && pinnedPubkey !== props.public_key) return; // a different popup took over
      pinnedPubkey = props.public_key;
      drawNeighborLines(pinnedNeighborLayer, marker.getLatLng(), neighbors, true);
      marker.setPopupContent(window.MCCoverageMap.popupHtml(props) + neighborSectionHtml(neighbors, false));
    } catch {
      marker.setPopupContent(window.MCCoverageMap.popupHtml(props) + '<div class="popup-neighbors"><div class="plan-empty">Could not load neighbours.</div></div>');
    }
  });
  map.on("popupclose", clearPinnedLines);

  // --- coverage preview (Web Worker) ----------------------------------

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("planner-worker.js");
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.kind === "connect") {
        if (msg.generation !== connectGeneration) return; // superseded — discard
        if (msg.type === "status") setConnectStatus(msg.message);
        else if (msg.type === "results") renderConnectOptions(msg.options);
        else if (msg.type === "error") {
          setConnectStatus(msg.message);
          renderConnectOptionList([]);
        }
        return;
      }
      if (msg.kind === "area-coverage") {
        if (msg.generation !== areaGeneration) return; // superseded — discard
        if (msg.type === "status") setAreaStatus(msg.message);
        else if (msg.type === "result") renderAreaResult(msg);
        else if (msg.type === "error") setAreaStatus(msg.message);
        return;
      }
      if (msg.generation != null && msg.generation !== previewGeneration) {
        return; // superseded by a newer request — discard
      }
      if (msg.type === "status" || msg.type === "progress") {
        const status = document.getElementById("plan-coverage-status");
        status.classList.remove("hidden");
        status.textContent = msg.type === "progress" ? `Computing preview: row ${msg.done}/${msg.total}` : msg.message;
      } else if (msg.type === "result") {
        document.getElementById("plan-coverage-status").classList.add("hidden");
        renderPreviewResult(msg);
      } else if (msg.type === "error") {
        const status = document.getElementById("plan-coverage-status");
        status.classList.remove("hidden");
        status.textContent = `Preview failed: ${msg.message}`;
      }
    };
    return worker;
  }

  function scheduleCoveragePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runCoveragePreview, DEBOUNCE_MS);
  }

  function runCoveragePreview() {
    // Tag this request with a generation number and have the worker echo
    // it back. The debounce only spaces out when requests are *sent* — it
    // doesn't stop an old request (e.g. from before a repeater was
    // deleted) from still being mid-computation when a newer one starts,
    // and a Web Worker with an async onmessage handler can process a
    // second message before the first's awaits resolve. Without this
    // check, a slow stale result can arrive after a faster new one and
    // silently overwrite it — which is exactly why deleting a repeater
    // could appear to leave its old coverage on the map.
    const generation = ++previewGeneration;
    if (plan.repeaters.length === 0 && plan.overrides.length === 0) {
      if (previewOverlay) {
        layersControl.removeLayer(previewOverlay);
        map.removeLayer(previewOverlay);
        previewOverlay = null;
      }
      return;
    }
    ensureWorker().postMessage({
      generation,
      sites: planSites(),
      realRepeaters: effectiveRealRepeaters(),
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
      imageWidth: PREVIEW_WIDTH,
    });
  }

  // Overrides ride along as sites too — using the repeater's own pubkey as
  // id, at the adjusted lat/lon/height — so the same preview overlay that
  // shows a brand-new planned site's coverage also shows an adjusted real
  // repeater's, which is the "browser recalculates the coverage" ask. Real
  // repeaters that have been overridden are substituted to their adjusted
  // position in the candidate-neighbour list too (see
  // effectiveRealRepeaters), for consistency with the "take into account"
  // pattern used elsewhere for calibrated mode. Shared by the coverage
  // preview and the area-coverage tool's "what's already covered" baseline.
  function planSites() {
    return [
      ...plan.repeaters.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, antennaHeightM: r.antennaHeightM, isReal: false, label: r.label })),
      ...plan.overrides.map((o) => ({ id: o.pubkey, lat: o.lat, lon: o.lon, antennaHeightM: o.antennaHeightM, isReal: true, label: o.label })),
    ];
  }

  // realRepeatersById at the adjusted position for any repeater currently
  // overridden — used wherever a real repeater is offered as a neighbour
  // candidate outside the worker's own site list, so an adjustment's new
  // position is what other planning tools reason about too, not its stale
  // original.
  function effectiveRealRepeaters() {
    if (plan.overrides.length === 0) return Object.values(realRepeatersById);
    return Object.values(realRepeatersById).map((r) => {
      const o = findOverride(r.id);
      return o ? { ...r, lat: o.lat, lon: o.lon } : r;
    });
  }

  function renderPreviewResult(msg) {
    if (previewOverlay) {
      layersControl.removeLayer(previewOverlay);
      map.removeLayer(previewOverlay);
      previewOverlay = null;
    }
    plannedNeighborsById = msg.neighbors || {};
    renderAllPlannedNeighbors();
    renderRepeaterList();
    if (msg.empty) return;

    const { bounds, imageWidth, imageHeight, marginGreenDb } = msg;
    const margins = new Float32Array(msg.margins);
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(imageWidth, imageHeight);

    // Blue -> purple, distinct from the real coverage map's orange->green,
    // so "existing" and "proposed" read as different things when both are
    // shown at once.
    const blue = [56, 189, 248];
    const purple = [168, 85, 247];
    for (let i = 0; i < margins.length; i++) {
      const m = margins[i];
      const p = i * 4;
      if (Number.isNaN(m)) {
        imgData.data[p + 3] = 0;
        continue;
      }
      let t = m / marginGreenDb;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      imgData.data[p] = blue[0] + t * (purple[0] - blue[0]);
      imgData.data[p + 1] = blue[1] + t * (purple[1] - blue[1]);
      imgData.data[p + 2] = blue[2] + t * (purple[2] - blue[2]);
      imgData.data[p + 3] = 190;
    }
    ctx.putImageData(imgData, 0, 0);

    const llBounds = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
    previewOverlay = L.imageOverlay(canvas.toDataURL("image/png"), llBounds, { interactive: false }).addTo(map);
    layersControl.addOverlay(previewOverlay, "Planned coverage (preview)");
  }

  // --- line of sight ----------------------------------------------------

  let losChain = [];

  function addLosPoint(lat, lon, label) {
    losChain.push({ lat, lon, label: label || `Point ${losChain.length + 1}` });
    renderLosList();
    redrawLosChain();
  }

  function clearLosChain() {
    losChain = [];
    renderLosList();
    redrawLosChain();
  }

  function renderLosList() {
    const list = document.getElementById("plan-los-list");
    list.innerHTML = "";
    if (losChain.length === 0) {
      list.innerHTML = '<div class="plan-empty">Click the map to start a hop chain.</div>';
      return;
    }
    for (let i = 0; i < losChain.length; i++) {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `<span class="plan-item-label">${escapeHtml(losChain[i].label)}</span>`;
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
    for (const pt of losChain) {
      L.circleMarker([pt.lat, pt.lon], { radius: 5, color: "#e2e8f0", weight: 2, fillOpacity: 1 }).addTo(losLayer);
    }
    for (let i = 1; i < losChain.length; i++) {
      const a = losChain[i - 1];
      const b = losChain[i];
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

  // --- connect repeaters (auto-router) ----------------------------------
  //
  // Pick two existing repeaters; the worker works out the minimum number
  // of *new* repeaters needed to bridge them, reusing any existing
  // repeater that already helps along the way (see planner-worker.js's
  // handleConnect for the algorithm). Runs in the same worker as the
  // coverage preview, tagged with its own generation counter so a stale
  // connect result can't clobber a newer one (or vice versa).

  function connectStatusEl() {
    return document.getElementById("plan-connect-status");
  }

  function setConnectStatus(text) {
    const el = connectStatusEl();
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function clearConnectSelection() {
    connectGeneration++; // discard any in-flight result
    connectPointA = null;
    connectPointB = null;
    connectOptions = [];
    connectSelectedIndex = null;
    connectLayer.clearLayers();
    setConnectStatus(null);
    renderConnectOptionList([]);
    renderConnectList([]);
  }

  function selectConnectPoint(point) {
    if (!connectPointA) {
      connectPointA = point;
      connectLayer.clearLayers();
      L.circleMarker([point.lat, point.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
      setConnectStatus(`${point.label} selected — click a second repeater to connect it to.`);
      return;
    }
    if (point.id === connectPointA.id) return; // same repeater clicked again, ignore
    connectPointB = point;
    runConnectSearch();
  }

  function connectMaxNewInput() {
    return document.getElementById("plan-connect-max-new");
  }

  function runConnectSearch() {
    const generation = ++connectGeneration;
    connectOptions = [];
    connectSelectedIndex = null;
    setConnectStatus("Searching…");
    renderConnectOptionList([]);
    connectLayer.clearLayers();
    L.circleMarker([connectPointA.lat, connectPointA.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
    L.circleMarker([connectPointB.lat, connectPointB.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);

    let maxNewSites = parseInt(connectMaxNewInput().value, 10);
    if (!Number.isFinite(maxNewSites) || maxNewSites < 1) maxNewSites = undefined;

    ensureWorker().postMessage({
      kind: "connect",
      generation,
      pointA: connectPointA,
      pointB: connectPointB,
      realRepeaters: effectiveRealRepeaters(),
      maxNewSites,
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
    });
  }

  function renderConnectList(chain) {
    const list = document.getElementById("plan-connect-list");
    list.innerHTML = "";
    if (!chain || chain.length === 0) {
      list.innerHTML = '<div class="plan-empty">Click two existing repeaters to connect them.</div>';
      return;
    }
    for (const point of chain) {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      const label = point.isNew ? "New relay" : point.label || "Repeater";
      row.innerHTML = `<span class="plan-item-label">${escapeHtml(label)}</span><span class="plan-item-sub">${point.isNew ? "to be added to your plan" : "existing"}</span>`;
      list.appendChild(row);
    }
  }

  // Draws a chain (endpoint markers + hop line) without touching the plan.
  function drawConnectChain(chain) {
    connectLayer.clearLayers();
    L.circleMarker([connectPointA.lat, connectPointA.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
    L.circleMarker([connectPointB.lat, connectPointB.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
    for (let i = 0; i < chain.length; i++) {
      const point = chain[i];
      L.circleMarker([point.lat, point.lon], {
        radius: 6,
        color: point.isNew ? "#a855f7" : "#38bdf8",
        weight: 2,
        fillOpacity: 1,
      }).addTo(connectLayer);
      if (i > 0) {
        const prev = chain[i - 1];
        L.polyline([[prev.lat, prev.lon], [point.lat, point.lon]], { color: "#4ade80", weight: 3 }).addTo(connectLayer);
      }
    }
  }

  function renderConnectOptionList(options) {
    const container = document.getElementById("plan-connect-options");
    container.innerHTML = "";
    if (!options || options.length < 2) return; // nothing to choose between
    options.forEach((opt, i) => {
      const newCount = opt.newSites ? opt.newSites.length : 0;
      const row = document.createElement("div");
      row.className = "plan-list-item plan-connect-option" + (i === connectSelectedIndex ? " selected" : "");
      row.innerHTML =
        `<span class="plan-item-label">${newCount === 0 ? "Already connected" : `${newCount} new relay${newCount === 1 ? "" : "s"}`}</span>` +
        `<span class="plan-item-sub">option ${i + 1} of ${options.length}</span>` +
        `<span class="plan-item-actions"><button type="button">Use this path</button></span>`;
      row.addEventListener("mouseenter", () => previewConnectOption(i));
      row.addEventListener("click", () => previewConnectOption(i));
      row.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        applyConnectOption(i);
      });
      container.appendChild(row);
    });
  }

  function previewConnectOption(i) {
    const opt = connectOptions[i];
    if (!opt) return;
    connectSelectedIndex = i;
    drawConnectChain(opt.chain);
    renderConnectList(opt.chain);
    // Update the selected-row styling in place rather than rebuilding the
    // whole options list: this fires on every mouseenter, and rebuilding
    // destroys/recreates each row's own "Use this path" button — including
    // the one the mouse is currently moving toward — which made it
    // essentially unclickable (the button gets pulled out from under the
    // cursor before the click can land, and the browser drops a click
    // whose target was detached mid-gesture).
    const container = document.getElementById("plan-connect-options");
    container.querySelectorAll(".plan-connect-option").forEach((row, idx) => {
      row.classList.toggle("selected", idx === i);
    });
  }

  // Commits a chosen route: new relay sites become ordinary planned
  // repeaters — draggable, renameable, deletable, and they feed the
  // existing coverage preview exactly like anything added via "+ Add
  // repeater".
  function applyConnectOption(i) {
    const opt = connectOptions[i];
    if (!opt) return;
    if (opt.newSites && opt.newSites.length > 0) {
      const startCount = plan.repeaters.length;
      opt.newSites.forEach((site, idx) => {
        plan.repeaters.push({ id: randomId(), label: `Relay ${startCount + idx + 1}`, lat: site.lat, lon: site.lon, antennaHeightM: null });
      });
      renderRepeaterList();
      redrawPlannedMarkers();
      scheduleCoveragePreview();
    }
    drawConnectChain(opt.chain);
    renderConnectList(opt.chain);

    const newCount = opt.newSites ? opt.newSites.length : 0;
    setConnectStatus(
      newCount === 0
        ? "Already connected via existing repeaters — no new relays needed."
        : `${newCount} new relay${newCount === 1 ? "" : "s"} added to your plan.`
    );
    connectOptions = [];
    connectSelectedIndex = null;
    renderConnectOptionList([]); // path is committed — hide the picker
  }

  function renderConnectOptions(options) {
    connectOptions = options || [];
    connectSelectedIndex = 0;

    if (connectOptions.length === 0) {
      renderConnectOptionList([]);
      return;
    }

    // Only one route was found (or found to already exist) — nothing to
    // choose between, so apply it straight away.
    if (connectOptions.length === 1) {
      applyConnectOption(0);
      return;
    }

    drawConnectChain(connectOptions[0].chain);
    renderConnectList(connectOptions[0].chain);
    renderConnectOptionList(connectOptions);
    setConnectStatus(`${connectOptions.length} path options found — pick one to add to your plan.`);
  }

  document.getElementById("plan-connect-clear").addEventListener("click", clearConnectSelection);

  (function initConnectMaxNewInput() {
    const input = connectMaxNewInput();
    const saved = parseInt(localStorage.getItem(CONNECT_MAX_NEW_KEY), 10);
    if (Number.isFinite(saved) && saved >= 1 && saved <= 20) input.value = saved;
    input.addEventListener("change", () => {
      let v = parseInt(input.value, 10);
      if (!Number.isFinite(v) || v < 1) v = 1;
      if (v > 20) v = 20;
      input.value = v;
      localStorage.setItem(CONNECT_MAX_NEW_KEY, String(v));
      if (connectPointA && connectPointB) runConnectSearch();
    });
  })();

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
    areaGeneration++; // discard any in-flight result
    areaPolygonPoints = [];
    areaPolygonShape = null;
    areaLayer.clearLayers();
    setAreaStatus(null);
    renderAreaList([]);
    document.getElementById("plan-area-finish").disabled = true;
  }

  function redrawAreaShape() {
    areaLayer.clearLayers();
    for (const pt of areaPolygonPoints) {
      L.circleMarker([pt.lat, pt.lon], { radius: 4, color: "#facc15", weight: 2, fillOpacity: 1 }).addTo(areaLayer);
    }
    if (areaPolygonPoints.length >= 3) {
      areaPolygonShape = L.polygon(areaPolygonPoints.map((p) => [p.lat, p.lon]), { color: "#facc15", weight: 2, fillOpacity: 0.08 }).addTo(areaLayer);
    } else if (areaPolygonPoints.length === 2) {
      areaPolygonShape = L.polyline(areaPolygonPoints.map((p) => [p.lat, p.lon]), { color: "#facc15", weight: 2 }).addTo(areaLayer);
    } else {
      areaPolygonShape = null;
    }
  }

  function addAreaPoint(lat, lon) {
    areaPolygonPoints.push({ lat, lon });
    redrawAreaShape();
    document.getElementById("plan-area-finish").disabled = areaPolygonPoints.length < 3;
    setAreaStatus(
      `${areaPolygonPoints.length} point${areaPolygonPoints.length === 1 ? "" : "s"} — ${
        areaPolygonPoints.length < 3 ? "add at least 3 to finish the shape." : "click Finish shape, or keep clicking to add more."
      }`
    );
  }

  function runAreaCoverageSearch() {
    if (areaPolygonPoints.length < 3) return;
    const generation = ++areaGeneration;
    setAreaStatus("Searching…");
    renderAreaList([]);

    let maxNewSites = parseInt(areaMaxNewInput().value, 10);
    if (!Number.isFinite(maxNewSites) || maxNewSites < 1) maxNewSites = undefined;

    ensureWorker().postMessage({
      kind: "area-coverage",
      generation,
      polygon: areaPolygonPoints,
      maxNewSites,
      existingSites: planSites(),
      realRepeaters: effectiveRealRepeaters(),
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
    });
  }

  // New sites become ordinary planned repeaters — draggable, renameable,
  // deletable, and they feed the existing coverage preview exactly like
  // anything added via "+ Add repeater" or Connect repeaters.
  function renderAreaResult(msg) {
    const newSites = msg.newSites || [];
    const placed = [];

    if (newSites.length > 0) {
      const startCount = plan.repeaters.length;
      newSites.forEach((site, i) => {
        const label = `Area relay ${startCount + i + 1}`;
        plan.repeaters.push({ id: randomId(), label, lat: site.lat, lon: site.lon, antennaHeightM: null });
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

  // --- companion pin ---------------------------------------------------
  //
  // A single always-available pin, entirely separate from plan mode (no
  // side panel involved) — click the map to see who'd hear a handheld
  // device dropped there. Not part of any plan, not saved, resets on
  // reload. Reuses the exact same terrain/propagation engine as
  // everything else; the only real difference from a planned repeater is
  // which end of each link is the mast (the real repeaters, as always)
  // and which is the handheld (the pin, using RX_HEIGHT_M rather than
  // ANTENNA_HEIGHT_M — it's the receiving end, not a mast).
  const MAX_COMPANION_NEIGHBORS = 15;
  // Same rationale and values as planner-worker.js's PREVIEW_MAX_RANGE_KM/
  // PREVIEW_ZOOM_CAP: the full link-budget range (often ~80km) would need
  // 250+ DEM tiles for one point, which is not "click and see" fast — cap
  // both for a responsive interactive tool.
  const COMPANION_MAX_RANGE_KM = 35;
  const COMPANION_ZOOM_CAP = 10;

  // The pin's own height above ground — distinct from cfg.propagation's
  // antennaHeightM (a repeater's mast) and its own default rxHeightM
  // (tuned for the *real* map's assumed handheld height, not necessarily
  // how someone actually carries a device — hip vs. head height can matter
  // for a genuinely marginal link). User-adjustable, defaulting to 1m.
  // companionPinPropagation is a *new* object (not a mutated
  // cfg.propagation) each time the height changes: propagation.js's
  // handleFor() caches one WASM-side params handle per object reference,
  // so mutating cfg.propagation.rxHeightM in place would silently leave
  // every other caller (and this pin's own already-cached handle) reading
  // a stale value instead of picking up the change.
  let companionPinHeightM = 1;
  let companionPinPropagation = { ...cfg.propagation, rxHeightM: companionPinHeightM };

  document.getElementById("companion-pin-height").addEventListener("input", (e) => {
    const h = parseFloat(e.target.value);
    if (!Number.isFinite(h) || h < 0) return;
    companionPinHeightM = h;
    companionPinPropagation = { ...cfg.propagation, rxHeightM: h };
    if (companionMarker) {
      const ll = companionMarker.getLatLng();
      computeCompanionNeighbors(ll.lat, ll.lng); // live-update an already-placed pin, not just the next click
    }
  });

  function setCompanionPinMode(enabled) {
    companionPinMode = enabled;
    document.getElementById("companion-pin-toggle").classList.toggle("active", enabled);
    document.getElementById("companion-pin-hint").classList.toggle("hidden", !enabled);
    if (enabled && mode !== "off") setMode("off"); // mutually exclusive with add-repeater/los — one click target at a time
    if (!enabled) {
      companionMarkerLayer.clearLayers();
      companionPinLayer.clearLayers();
      companionMarker = null;
    }
  }

  document.getElementById("companion-pin-toggle").addEventListener("click", () => {
    setCompanionPinMode(!companionPinMode);
  });

  function placeCompanionPin(lat, lon) {
    if (companionMarker) {
      companionMarker.setLatLng([lat, lon]);
    } else {
      companionMarker = L.marker([lat, lon], {
        draggable: true,
        icon: L.divIcon({ className: "companion-pin-icon", html: '<div class="companion-pin-dot"></div>', iconSize: [18, 18] }),
      });
      companionMarker.on("dragend", () => {
        const ll = companionMarker.getLatLng();
        computeCompanionNeighbors(ll.lat, ll.lng);
      });
      companionMarker.addTo(companionMarkerLayer);
    }
    computeCompanionNeighbors(lat, lon);
  }

  async function computeCompanionNeighbors(lat, lon) {
    await Propagation.ready;
    const rangeKm = Math.min(Propagation.linkBudgetMaxRangeKm(cfg.propagation), COMPANION_MAX_RANGE_KM);
    const zoom = Math.min(cfg.demZoom, COMPANION_ZOOM_CAP);
    const candidates = effectiveRealRepeaters().filter((r) => Propagation.haversineKm(lat, lon, r.lat, r.lon) <= rangeKm);

    showNeighborHighlight([lat, lon], "Companion pin", [], false, true, companionPinLayer);

    if (candidates.length === 0) {
      showNeighborHighlight([lat, lon], "Companion pin", [], false, false, companionPinLayer);
      return;
    }

    const kmPerDegLat = 110.574;
    const kmPerDegLon = Math.max(1, 111.32 * Math.cos((lat * Math.PI) / 180));
    const latPad = rangeKm / kmPerDegLat;
    const lonPad = rangeKm / kmPerDegLon;
    const bounds = { south: lat - latPad, north: lat + latPad, west: lon - lonPad, east: lon + lonPad };

    try {
      const grid = await Terrain.buildLocalGrid(cfg.demTileURLBase, zoom, bounds);
      const found = [];
      for (const r of candidates) {
        const d = Propagation.haversineKm(lat, lon, r.lat, r.lon);
        if (d < 0.01) continue;
        const txHeightASL = grid.at(r.lat, r.lon) + cfg.propagation.antennaHeightM;
        const margin = Propagation.pathMargin(grid, companionPinPropagation, r.lat, r.lon, txHeightASL, lat, lon, d);
        if (margin >= 0) found.push({ id: r.id, label: r.label, isReal: false, lat: r.lat, lon: r.lon, distanceKm: d, marginDb: margin });
      }
      found.sort((a, b) => b.marginDb - a.marginDb);
      showNeighborHighlight([lat, lon], "Companion pin", found.slice(0, MAX_COMPANION_NEIGHBORS), false, false, companionPinLayer);
    } catch (err) {
      showNeighborHighlight([lat, lon], "Companion pin", [], false, false, companionPinLayer);
      console.error("companion pin:", err);
    }
  }

  // --- mode handling ------------------------------------------------

  function setMode(next) {
    mode = mode === next ? "off" : next;
    if (mode !== "off" && companionPinMode) setCompanionPinMode(false); // mutually exclusive, see above
    document.querySelectorAll(".plan-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    });
    document.getElementById("plan-repeater-section").classList.toggle("hidden", mode !== "add-repeater" && plan.repeaters.length === 0);
    renderOverrideList(); // also updates #plan-override-section's visibility for the current mode
    document.getElementById("plan-los-section").classList.toggle("hidden", mode !== "los" && losChain.length === 0);
    document.getElementById("plan-connect-section").classList.toggle("hidden", mode !== "connect-repeaters" && !connectPointA);
    if (mode !== "connect-repeaters") clearConnectSelection(); // stale A-selected-but-no-B state shouldn't linger when you switch away
    document.getElementById("plan-area-section").classList.toggle("hidden", mode !== "area-coverage" && areaPolygonPoints.length === 0);
    if (mode !== "area-coverage") clearAreaSelection(); // stale in-progress polygon shouldn't linger when you switch away
    const hint = document.getElementById("plan-mode-hint");
    if (mode === "add-repeater") {
      hint.textContent = "Click the map to place a repeater. Drag markers to move them. Preview coverage is capped to ~35km for speed — the real map has no such cap.";
      hint.classList.remove("hidden");
    } else if (mode === "adjust-repeater") {
      hint.textContent = "Click an existing repeater to adjust its position for yourself. Drag its new marker to move it; use the panel to set height or reset.";
      hint.classList.remove("hidden");
    } else if (mode === "los") {
      hint.textContent = "Click the map to build a hop chain — each new click adds another hop.";
      hint.classList.remove("hidden");
    } else if (mode === "connect-repeaters") {
      hint.textContent = "Click two existing repeaters — we'll work out the fewest new relays needed to connect them, reusing any existing repeater that helps.";
      hint.classList.remove("hidden");
    } else if (mode === "area-coverage") {
      hint.textContent = "Click the map to draw a polygon around an area (at least 3 points), then click Finish shape to place new repeaters for maximal coverage of it.";
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
  }

  map.on("click", (e) => {
    if (mode === "add-repeater") {
      addRepeaterAt(e.latlng.lat, e.latlng.lng);
    } else if (mode === "los") {
      addLosPoint(e.latlng.lat, e.latlng.lng);
    } else if (mode === "area-coverage") {
      addAreaPoint(e.latlng.lat, e.latlng.lng);
    } else if (companionPinMode) {
      placeCompanionPin(e.latlng.lat, e.latlng.lng);
    }
  });

  document.querySelectorAll(".plan-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  document.getElementById("plan-los-clear").addEventListener("click", clearLosChain);

  // --- panel + save/load/export/import/share -------------------------

  // The panel spans the full right edge, covering Leaflet's own top-right
  // (basemap/layers) and bottom-right (legend) controls when open — shift
  // them left to stay reachable rather than just having them disappear
  // underneath it.
  //
  // Closing the panel exits "plan mode" entirely: any active placement
  // mode turns off (so map clicks stop adding repeaters/hops once the
  // panel — and its mode buttons — are gone), and everything the plan
  // drew on the map (markers, LOS chain, coverage preview, neighbour
  // overlays) is hidden. The plan itself isn't touched — reopening the
  // panel brings it all straight back.
  function setPanelOpen(open) {
    document.getElementById("plan-panel").classList.toggle("hidden", !open);
    document.getElementById("map-wrap").classList.toggle("plan-open", open);

    if (!open) {
      setMode("off");
      clearNeighborHighlight();
      clearPinnedLines();
      map.removeLayer(plannedMarkersLayer);
      map.removeLayer(overrideMarkersLayer);
      map.removeLayer(overrideLinesLayer);
      map.removeLayer(losLayer);
      map.removeLayer(connectLayer);
      map.removeLayer(areaLayer);
      if (showAllNeighborsEnabled) map.removeLayer(allNeighborsLayer);
      if (previewOverlay) map.removeLayer(previewOverlay);
    } else {
      // Opening the panel shrinks the visible map area (right-side controls
      // shift, invalidateSize below reflows everything) — a marker the
      // mouse was hovering can slide out from under a now-stationary
      // cursor without the browser ever firing mouseout, leaving a
      // hover-triggered neighbour highlight stuck showing until the mouse
      // physically moves again. Clear it explicitly on open too, not just
      // on close.
      clearNeighborHighlight();
      plannedMarkersLayer.addTo(map);
      overrideMarkersLayer.addTo(map);
      overrideLinesLayer.addTo(map);
      losLayer.addTo(map);
      connectLayer.addTo(map);
      areaLayer.addTo(map);
      if (showAllNeighborsEnabled) allNeighborsLayer.addTo(map);
      if (previewOverlay) previewOverlay.addTo(map);
    }
    map.invalidateSize();
  }

  document.getElementById("plan-toggle").addEventListener("click", () => {
    setPanelOpen(document.getElementById("plan-panel").classList.contains("hidden"));
  });
  document.getElementById("plan-panel-close").addEventListener("click", () => setPanelOpen(false));

  document.getElementById("plan-new").addEventListener("click", () => setActivePlan(emptyPlan()));
  document.getElementById("plan-save").addEventListener("click", persistCurrentPlan);
  document.getElementById("plan-delete").addEventListener("click", () => {
    if (confirm(`Delete "${plan.name}"? This can't be undone.`)) deleteCurrentPlan();
  });
  document.getElementById("plan-select").addEventListener("change", (e) => {
    const all = loadAllPlans();
    if (all[e.target.value]) setActivePlan(all[e.target.value]);
  });

  document.getElementById("plan-export").addEventListener("click", () => {
    plan.name = document.getElementById("plan-name").value || "Untitled plan";
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.name.replace(/[^a-z0-9-_ ]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- KML export (Google Earth) --------------------------------------
  //
  // Placemarks for everything in the plan, plus coverage as GroundOverlay
  // imagery (KML's native way to drape a georeferenced raster). Two
  // sources: this plan's own predicted coverage (client-computed, no
  // persisted server file, so embedded as a data: URI to survive outside
  // this browser session) and the live site's own real-network coverage
  // for whichever "Map detail" mode is currently selected (served as real
  // files already, so referenced by absolute URL rather than embedded).
  function planToKML() {
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
    parts.push(`<name>${escapeHtml(plan.name || "hopreach plan")}</name>`);
    parts.push(
      '<Style id="mcc-planned"><IconStyle><color>ff4ade80</color><scale>1.1</scale>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/electronics.png</href></Icon></IconStyle></Style>'
    );
    parts.push(
      '<Style id="mcc-adjusted"><IconStyle><color>ff38bdf8</color><scale>1.1</scale>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/electronics.png</href></Icon></IconStyle></Style>'
    );

    if (plan.repeaters.length > 0) {
      parts.push("<Folder><name>Planned repeaters</name>");
      for (const r of plan.repeaters) {
        const desc = [
          "Planned repeater",
          r.antennaHeightM != null ? `Mast height: ${r.antennaHeightM}m` : null,
          `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`,
        ]
          .filter(Boolean)
          .join("&#10;");
        parts.push(
          `<Placemark><name>${escapeHtml(r.label)}</name><styleUrl>#mcc-planned</styleUrl>` +
            `<description>${escapeHtml(desc)}</description>` +
            `<Point><coordinates>${r.lon},${r.lat},0</coordinates></Point></Placemark>`
        );
      }
      parts.push("</Folder>");
    }

    if (plan.overrides.length > 0) {
      parts.push("<Folder><name>Adjusted repeaters</name>");
      for (const o of plan.overrides) {
        const desc = [
          "Adjusted position",
          o.antennaHeightM != null ? `Mast height: ${o.antennaHeightM}m` : null,
          `${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}`,
        ]
          .filter(Boolean)
          .join("&#10;");
        parts.push(
          `<Placemark><name>${escapeHtml(o.label || o.pubkey)}</name><styleUrl>#mcc-adjusted</styleUrl>` +
            `<description>${escapeHtml(desc)}</description>` +
            `<Point><coordinates>${o.lon},${o.lat},0</coordinates></Point></Placemark>`
        );
      }
      parts.push("</Folder>");
    }

    if (losChain.length > 1) {
      const coords = losChain.map((p) => `${p.lon},${p.lat},0`).join(" ");
      parts.push(
        "<Placemark><name>Line-of-sight chain</name><LineString><tessellate>1</tessellate>" +
          `<coordinates>${coords}</coordinates></LineString></Placemark>`
      );
    }

    const overlays = [];
    if (previewOverlay) {
      const b = previewOverlay.getBounds();
      overlays.push({
        name: "Planned coverage (preview)",
        href: previewOverlay.getElement().src, // already a data:image/png;base64,... URI
        north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
      });
    }
    const meta = window.MCCoverageMap.currentCoverageMeta ? window.MCCoverageMap.currentCoverageMeta() : null;
    if (meta && meta.tiles) {
      for (const t of meta.tiles) {
        overlays.push({
          name: "Estimated coverage",
          href: new URL(`data/${t.image}`, location.href).href,
          north: t.bounds.North, south: t.bounds.South, east: t.bounds.East, west: t.bounds.West,
        });
      }
    }
    for (const o of overlays) {
      parts.push(
        `<GroundOverlay><name>${escapeHtml(o.name)}</name><Icon><href>${o.href}</href></Icon>` +
          `<LatLonBox><north>${o.north}</north><south>${o.south}</south><east>${o.east}</east><west>${o.west}</west></LatLonBox></GroundOverlay>`
      );
    }

    parts.push("</Document></kml>");
    return parts.join("\n");
  }

  document.getElementById("plan-export-kml").addEventListener("click", () => {
    plan.name = document.getElementById("plan-name").value || "Untitled plan";
    const blob = new Blob([planToKML()], { type: "application/vnd.google-earth.kml+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${plan.name.replace(/[^a-z0-9-_ ]/gi, "_")}.kml`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  document.getElementById("plan-import-btn").addEventListener("click", () => {
    document.getElementById("plan-import-file").click();
  });
  document.getElementById("plan-import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported.repeaters)) throw new Error("not a valid plan file");
      imported.id = randomId(); // avoid clobbering an existing stored plan with the same id
      setActivePlan(imported);
    } catch (err) {
      alert(`Could not import plan: ${err.message || err}`);
    }
    e.target.value = "";
  });

  document.getElementById("plan-share").addEventListener("click", async () => {
    plan.name = document.getElementById("plan-name").value || "Untitled plan";
    const resultEl = document.getElementById("plan-share-result");
    resultEl.classList.remove("hidden");
    resultEl.textContent = "Sharing…";
    try {
      // Only structural data — no coverage raster — is ever sent; see
      // cmd/shareapi.
      const payload = { name: plan.name, repeaters: plan.repeaters, hopChains: plan.hopChains, overrides: plan.overrides, notes: plan.notes };
      const resp = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { url } = await resp.json();
      const fullUrl = new URL(url, location.href).toString();
      resultEl.innerHTML = `Link (expires in 7 days): <a href="${fullUrl}">${fullUrl}</a>`;
      if (navigator.clipboard) navigator.clipboard.writeText(fullUrl).catch(() => {});
    } catch (err) {
      resultEl.textContent = `Share failed: ${err.message || err}`;
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // --- init ------------------------------------------------------------

  async function init() {
    const params = new URLSearchParams(location.search);
    const sharedId = params.get("plan");
    if (sharedId) {
      try {
        const resp = await fetch(`/api/plans/${encodeURIComponent(sharedId)}`);
        if (resp.ok) {
          const shared = await resp.json();
          shared.id = randomId();
          setActivePlan(shared);
          setPanelOpen(true);
          return;
        }
      } catch {
        /* fall through to normal startup */
      }
    }

    // Deliberately does not auto-resume the last-saved plan — a fresh
    // session always starts blank. Saved plans are only ever loaded by
    // explicitly picking one from the "plan-select" dropdown.
    setActivePlan(emptyPlan());
  }

  init();

  // Small, deliberately narrow surface other frontend modules (simulator.js
  // — "load planned repeaters into the simulator") can read from without
  // reaching into this closure's private state. Snapshots are taken fresh
  // on each call (plan/realRepeatersById are reassigned, not mutated in
  // place, whenever a plan switches or the repeater layer reloads) so
  // callers always see current data, not a stale one-time copy.
  window.HopReachPlanner = {
    getActivePlan: () => plan,
    getRealRepeaters: () => realRepeatersById,
    // Lets simulator.js keep the two full-height right-side panels mutually
    // exclusive (both are pinned to the same edge at the same width, so
    // having both open at once would just overlap) without planner.js
    // needing to know simulator.js exists.
    closePanel: () => setPanelOpen(false),
  };

  // Test-only introspection hook (no UI/behavioural surface of its own).
  window.__hopreachPlannerDebug = {
    getPreviewBounds: () => (previewOverlay ? previewOverlay.getBounds() : null),
    getPreviewGeneration: () => previewGeneration,
    getMode: () => mode,
    getRepeaterCount: () => plan.repeaters.length,
    getOverrideCount: () => plan.overrides.length,
    getConnectPointA: () => connectPointA,
    getConnectPointB: () => connectPointB,
  };
})();
