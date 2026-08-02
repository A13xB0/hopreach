(function () {
  const cfg = window.HOPREACH_CONFIG;
  const S = window.PlanState;

  // plan-state.js holds no config of its own, so seed the one derived value
  // here where cfg is owned.
  S.companionPinPropagation = { ...cfg.propagation, rxHeightM: S.companionPinHeightM };
  const { map, layersControl } = window.MCCoverageMap;

  const STORAGE_KEY = "hopreach.plans";
  const CONNECT_MAX_NEW_KEY = "hopreach.connectMaxNew";
  const AREA_MAX_NEW_KEY = "hopreach.areaMaxNew";
  const PREVIEW_WIDTH = 320;
  const DEBOUNCE_MS = 400;

                    // Below this the hop is over the demodulation threshold but has
  // essentially no headroom for ordinary fading — worth flagging even when
  // the simulation happens to deliver.
  const MARGINAL_HOP_DB = 5;
          
  const plannedMarkersLayer = L.layerGroup().addTo(map);
  const overrideMarkersLayer = L.layerGroup().addTo(map);
  const overrideLinesLayer = L.layerGroup().addTo(map); // dashed connector back to each override's original position
  const losLayer = L.layerGroup().addTo(map);
  const connectLayer = L.layerGroup().addTo(map); // the resulting hop chain from "Connect repeaters"
  const areaLayer = L.layerGroup().addTo(map); // the drawn polygon for "Cover an area"
  const neighborLayer = L.layerGroup().addTo(map); // transient, hover-driven
  const allNeighborsLayer = L.layerGroup(); // persistent, toggled — not added to map by default
    // Real repeaters' own observed-neighbour lines, all at once — the
  // general, always-available counterpart to allNeighborsLayer (which is
  // planned-repeaters-only and lives inside the Plan panel). See
  // renderAllRealNeighbors/setShowAllRealNeighbors below.
  const allRealNeighborsLayer = L.layerGroup();
    const pinnedNeighborLayer = L.layerGroup().addTo(map); // persistent, click-to-pin on a single real repeater
    // Separate layers: the marker persists across recomputes, while
  // showNeighborHighlight's target layer gets cleared+redrawn on every
  // call (that's how it erases the previous lines/tooltip) — sharing one
  // layer would wipe the marker out the moment a computation started.
  const companionMarkerLayer = L.layerGroup().addTo(map);
  const companionPinLayer = L.layerGroup().addTo(map); // predicted-neighbour lines + tooltip only
    
  // Real repeaters: {pubkey -> {id,label,lat,lon}}, populated by
  // window.onRepeatersLoaded (called from app.js once the real repeater
  // GeoJSON loads/reloads). Predicted neighbours for planned repeaters:
  // {repeaterId -> [{id,label,isReal,lat,lon,distanceKm,marginDb}]}, filled
  // in whenever a coverage preview result arrives. Observed neighbours for
  // real repeaters come straight from CoreScope, cached per pubkey since
  // they don't change within a session.
    const realNeighborCache = new Map();
  
  // Deleting a repeater/override removes its own cached neighbour entry,
  // but other sites' cached neighbour lists can still contain a reference
  // *to* it until the next preview result overwrites the whole cache —
  // which can be delayed indefinitely if that next preview happens to
  // error out. Purge it everywhere immediately instead of waiting.
  function purgeNeighborRef(id) {
    delete S.plannedNeighborsById[id];
    for (const key of Object.keys(S.plannedNeighborsById)) {
      const list = S.plannedNeighborsById[key];
      if (list && list.some((n) => n.id === id)) {
        S.plannedNeighborsById[key] = list.filter((n) => n.id !== id);
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
    S.plan.name = document.getElementById("plan-name").value || "Untitled plan";
    const all = loadAllPlans();
    all[S.plan.id] = S.plan;
    saveAllPlans(all);
    refreshPlanSelect();
  }

  function deleteCurrentPlan() {
    const all = loadAllPlans();
    delete all[S.plan.id];
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
      if (S.plan && id === S.plan.id) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function setActivePlan(p) {
    S.plan = normalizePlan(p);
    document.getElementById("plan-name").value = S.plan.name;
    S.plannedNeighborsById = {}; // stale predictions from the old plan; fresh ones arrive with the next preview
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
    const n = S.plan.repeaters.length + 1;
    S.plan.repeaters.push({ id: randomId(), label: `Planned #${n}`, lat, lon, antennaHeightM: null });
    renderRepeaterList();
    redrawPlannedMarkers();
    scheduleCoveragePreview();
  }

  function removeRepeater(id) {
    S.plan.repeaters = S.plan.repeaters.filter((r) => r.id !== id);
    purgeNeighborRef(id);
    renderRepeaterList();
    redrawPlannedMarkers();
    renderAllPlannedNeighbors();
    scheduleCoveragePreview();
  }

  function renderRepeaterList() {
    const list = document.getElementById("plan-repeater-list");
    list.innerHTML = "";
    if (S.plan.repeaters.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — use "Add repeater" and click the map.</div>';
      return;
    }
    for (const r of S.plan.repeaters) {
      const neighbors = S.plannedNeighborsById[r.id];
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
    for (const r of S.plan.repeaters) {
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
        const neighbors = S.plannedNeighborsById[r.id] || [];
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
    return S.plan.overrides.find((o) => o.pubkey === pubkey);
  }

  function grabForAdjustment(pubkey, label, lat, lon) {
    if (findOverride(pubkey)) return; // already adjusted — click again does nothing extra
    S.plan.overrides.push({ pubkey, label, origLat: lat, origLon: lon, lat, lon, antennaHeightM: null });
    renderOverrideList();
    redrawOverrideMarkers();
    scheduleCoveragePreview();
  }

  function removeOverride(pubkey) {
    S.plan.overrides = S.plan.overrides.filter((o) => o.pubkey !== pubkey);
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
    section.classList.toggle("hidden", S.mode !== "adjust-repeater" && S.plan.overrides.length === 0);
    list.innerHTML = "";
    if (S.plan.overrides.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — use "Adjust repeater" and click an existing repeater.</div>';
      return;
    }
    for (const o of S.plan.overrides) {
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
    for (const o of S.plan.overrides) {
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

  // --- coverage preview (Web Worker) ----------------------------------

  function ensureWorker() {
    if (S.worker) return S.worker;
    S.worker = new Worker("planner-worker.js");
    S.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.kind === "connect") {
        if (msg.generation !== S.connectGeneration) return; // superseded — discard
        if (msg.type === "status") setConnectStatus(msg.message);
        else if (msg.type === "results") renderConnectOptions(msg.options);
        else if (msg.type === "error") {
          setConnectStatus(msg.message);
          renderConnectOptionList([]);
        }
        return;
      }
      if (msg.kind === "area-coverage") {
        if (msg.generation !== S.areaGeneration) return; // superseded — discard
        if (msg.type === "status") setAreaStatus(msg.message);
        else if (msg.type === "result") renderAreaResult(msg);
        else if (msg.type === "error") setAreaStatus(msg.message);
        return;
      }
      if (msg.generation != null && msg.generation !== S.previewGeneration) {
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
    return S.worker;
  }

  function scheduleCoveragePreview() {
    clearTimeout(S.debounceTimer);
    S.debounceTimer = setTimeout(runCoveragePreview, DEBOUNCE_MS);
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
    const generation = ++S.previewGeneration;
    if (S.plan.repeaters.length === 0 && S.plan.overrides.length === 0) {
      if (S.previewOverlay) {
        layersControl.removeLayer(S.previewOverlay);
        map.removeLayer(S.previewOverlay);
        S.previewOverlay = null;
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
      ...S.plan.repeaters.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon, antennaHeightM: r.antennaHeightM, isReal: false, label: r.label })),
      ...S.plan.overrides.map((o) => ({ id: o.pubkey, lat: o.lat, lon: o.lon, antennaHeightM: o.antennaHeightM, isReal: true, label: o.label })),
    ];
  }

  // realRepeatersById at the adjusted position for any repeater currently
  // overridden — used wherever a real repeater is offered as a neighbour
  // candidate outside the worker's own site list, so an adjustment's new
  // position is what other planning tools reason about too, not its stale
  // original.
  function effectiveRealRepeaters() {
    if (S.plan.overrides.length === 0) return Object.values(S.realRepeatersById);
    return Object.values(S.realRepeatersById).map((r) => {
      const o = findOverride(r.id);
      return o ? { ...r, lat: o.lat, lon: o.lon } : r;
    });
  }

  function renderPreviewResult(msg) {
    if (S.previewOverlay) {
      layersControl.removeLayer(S.previewOverlay);
      map.removeLayer(S.previewOverlay);
      S.previewOverlay = null;
    }
    S.plannedNeighborsById = msg.neighbors || {};
    renderAllPlannedNeighbors();
    renderRepeaterList();
    if (msg.empty) {
      syncCoverageToggles(); // no preview to show — reflect that in the panel's own checkbox
      return;
    }

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
    S.previewOverlay = L.imageOverlay(canvas.toDataURL("image/png"), llBounds, { interactive: false }).addTo(map);
    layersControl.addOverlay(S.previewOverlay, "Planned coverage (preview)");
    syncCoverageToggles();
  }

  // --- coverage toggles, moved into the Plan panel itself (PLAN-01) ------
  //
  // Both checkboxes act on the SAME layer objects the floating Leaflet
  // layers control already manages (window.MCCoverageMap's own
  // coverageLayer, and this file's own previewOverlay) via plain
  // map.addLayer/removeLayer — never a second, parallel visibility flag.
  // Leaflet's own control listens for "add"/"remove" events on each
  // registered layer to keep its own checkbox in sync, so driving the
  // layer this way keeps both checkboxes for the same layer honest
  // whichever one was actually clicked.
  function setPreviewVisible(visible) {
    if (!S.previewOverlay) return;
    if (visible) S.previewOverlay.addTo(map);
    else map.removeLayer(S.previewOverlay);
  }

  // Reflects current layer state into the panel's own checkboxes — called
  // after a preview recomputes and whenever the panel opens, since neither
  // moment is a click on these checkboxes themselves.
  function syncCoverageToggles() {
    const coverageBox = document.getElementById("plan-toggle-coverage");
    const previewBox = document.getElementById("plan-toggle-preview");
    const previewRow = document.getElementById("plan-toggle-preview-row");
    if (coverageBox && window.MCCoverageMap) coverageBox.checked = window.MCCoverageMap.isCoverageVisible();
    if (previewBox) previewBox.checked = !!(S.previewOverlay && map.hasLayer(S.previewOverlay));
    // Nothing to preview until at least one repeater is planned — grey the
    // row out rather than let it silently do nothing when clicked.
    if (previewRow) previewRow.classList.toggle("plan-checkbox-row-disabled", !S.previewOverlay);
    if (previewBox) previewBox.disabled = !S.previewOverlay;
  }

  // --- module wiring ---
  //
  // Line of sight: the terrain profile chain, one hop at a time, with each hop's clearance drawn on the map.
  const {
    addLosPoint,
    clearLosChain,
    redrawLosChain,
    renderLosList,
  } = window.PlanLos.init({
    escapeHtml: (...a) => escapeHtml(...a),
    cfg, losLayer,
  });

  // Neighbour display shared by real (observed) and planned repeaters: the coloured link lines, the hover/pin popup, and fetching a real repeater's observed reach.
  const {
    clearNeighborHighlight,
    clearPinnedLines,
    renderAllPlannedNeighbors,
    setShowAllRealNeighbors,
    showNeighborHighlight,
  } = window.PlanNeighbors.init({
    escapeHtml: (...a) => escapeHtml(...a),
    grabForAdjustment: (...a) => grabForAdjustment(...a),
    selectConnectPoint: (...a) => selectConnectPoint(...a),
    allNeighborsLayer, allRealNeighborsLayer, cfg, map, neighborLayer, pinnedNeighborLayer, realNeighborCache,
  });

  // Connect repeaters: picking two endpoints and searching for the chain of new sites that would link them, with a route check on each option.
  const {
    clearConnectSelection,
    renderConnectOptionList,
    renderConnectOptions,
    selectConnectPoint,
    setConnectStatus,
  } = window.PlanConnect.init({
    effectiveRealRepeaters: (...a) => effectiveRealRepeaters(...a),
    ensureWorker: (...a) => ensureWorker(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    randomId: (...a) => randomId(...a),
    redrawPlannedMarkers: (...a) => redrawPlannedMarkers(...a),
    renderRepeaterList: (...a) => renderRepeaterList(...a),
    scheduleCoveragePreview: (...a) => scheduleCoveragePreview(...a),
    CONNECT_MAX_NEW_KEY, MARGINAL_HOP_DB, cfg, connectLayer,
  });

  // Cover an area: drawing the target polygon and running the auto-placer that suggests where new repeaters would do the most good.
  const {
    addAreaPoint,
    clearAreaSelection,
    renderAreaResult,
    setAreaStatus,
  } = window.PlanArea.init({
    effectiveRealRepeaters: (...a) => effectiveRealRepeaters(...a),
    ensureWorker: (...a) => ensureWorker(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    planSites: (...a) => planSites(...a),
    randomId: (...a) => randomId(...a),
    redrawPlannedMarkers: (...a) => redrawPlannedMarkers(...a),
    renderRepeaterList: (...a) => renderRepeaterList(...a),
    scheduleCoveragePreview: (...a) => scheduleCoveragePreview(...a),
    AREA_MAX_NEW_KEY, areaLayer, cfg,
  });

  // Exporting a plan as KML for Google Earth: planned and adjusted repeaters, their coverage rings, and the line-of-sight chain.
  window.PlanKml.init({
    escapeHtml: (...a) => escapeHtml(...a),
    randomId: (...a) => randomId(...a),
    setActivePlan: (...a) => setActivePlan(...a),
  });

  // Feature modules are initialised here, after the top-level consts exist.
  // Helpers are passed as arrow wrappers so they resolve at call time, which
  // keeps the order of these calls irrelevant.

  document.getElementById("plan-toggle-coverage").addEventListener("change", (e) => {
    if (window.MCCoverageMap) window.MCCoverageMap.setCoverageVisible(e.target.checked);
  });
  document.getElementById("plan-toggle-preview").addEventListener("change", (e) => {
    setPreviewVisible(e.target.checked);
  });

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
    ;

  document.getElementById("companion-pin-height").addEventListener("input", (e) => {
    const h = parseFloat(e.target.value);
    if (!Number.isFinite(h) || h < 0) return;
    S.companionPinHeightM = h;
    S.companionPinPropagation = { ...cfg.propagation, rxHeightM: h };
    if (S.companionMarker) {
      const ll = S.companionMarker.getLatLng();
      computeCompanionNeighbors(ll.lat, ll.lng); // live-update an already-placed pin, not just the next click
    }
  });

  function setCompanionPinMode(enabled) {
    S.companionPinMode = enabled;
    document.getElementById("companion-pin-toggle").classList.toggle("active", enabled);
    document.getElementById("companion-pin-hint").classList.toggle("hidden", !enabled);
    if (enabled && S.mode !== "off") setMode("off"); // mutually exclusive with add-repeater/los — one click target at a time
    if (!enabled) {
      companionMarkerLayer.clearLayers();
      companionPinLayer.clearLayers();
      S.companionMarker = null;
    }
  }

  document.getElementById("companion-pin-toggle").addEventListener("click", () => {
    setCompanionPinMode(!S.companionPinMode);
  });

  function placeCompanionPin(lat, lon) {
    if (S.companionMarker) {
      S.companionMarker.setLatLng([lat, lon]);
    } else {
      S.companionMarker = L.marker([lat, lon], {
        draggable: true,
        icon: L.divIcon({ className: "companion-pin-icon", html: '<div class="companion-pin-dot"></div>', iconSize: [18, 18] }),
      });
      S.companionMarker.on("dragend", () => {
        const ll = S.companionMarker.getLatLng();
        computeCompanionNeighbors(ll.lat, ll.lng);
      });
      S.companionMarker.addTo(companionMarkerLayer);
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
        const margin = Propagation.pathMargin(grid, S.companionPinPropagation, r.lat, r.lon, txHeightASL, lat, lon, d);
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
    S.mode = S.mode === next ? "off" : next;
    if (S.mode !== "off" && S.companionPinMode) setCompanionPinMode(false); // mutually exclusive, see above
    document.querySelectorAll(".plan-mode-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mode === S.mode);
    });
    document.getElementById("plan-repeater-section").classList.toggle("hidden", S.mode !== "add-repeater" && S.plan.repeaters.length === 0);
    renderOverrideList(); // also updates #plan-override-section's visibility for the current mode
    document.getElementById("plan-los-section").classList.toggle("hidden", S.mode !== "los" && S.losChain.length === 0);
    document.getElementById("plan-connect-section").classList.toggle("hidden", S.mode !== "connect-repeaters" && !S.connectPointA);
    if (S.mode !== "connect-repeaters") clearConnectSelection(); // stale A-selected-but-no-B state shouldn't linger when you switch away
    document.getElementById("plan-area-section").classList.toggle("hidden", S.mode !== "area-coverage" && S.areaPolygonPoints.length === 0);
    if (S.mode !== "area-coverage") clearAreaSelection(); // stale in-progress polygon shouldn't linger when you switch away
    const hint = document.getElementById("plan-mode-hint");
    if (S.mode === "add-repeater") {
      hint.textContent = "Click the map to place a repeater. Drag markers to move them. Preview coverage is capped to ~35km for speed — the real map has no such cap.";
      hint.classList.remove("hidden");
    } else if (S.mode === "adjust-repeater") {
      hint.textContent = "Click an existing repeater to adjust its position for yourself. Drag its new marker to move it; use the panel to set height or reset.";
      hint.classList.remove("hidden");
    } else if (S.mode === "los") {
      hint.textContent = "Click the map to build a hop chain — each new click adds another hop.";
      hint.classList.remove("hidden");
    } else if (S.mode === "connect-repeaters") {
      hint.textContent = "Click two existing repeaters — we'll work out the fewest new relays needed to connect them, reusing any existing repeater that helps.";
      hint.classList.remove("hidden");
    } else if (S.mode === "area-coverage") {
      hint.textContent = "Click the map to draw a polygon around an area (at least 3 points), then click Finish shape to place new repeaters for maximal coverage of it.";
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
  }

  map.on("click", (e) => {
    if (S.mode === "add-repeater") {
      addRepeaterAt(e.latlng.lat, e.latlng.lng);
    } else if (S.mode === "los") {
      addLosPoint(e.latlng.lat, e.latlng.lng);
    } else if (S.mode === "area-coverage") {
      addAreaPoint(e.latlng.lat, e.latlng.lng);
    } else if (S.companionPinMode) {
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
      if (S.showAllNeighborsEnabled) map.removeLayer(allNeighborsLayer);
      if (S.previewOverlay) map.removeLayer(S.previewOverlay);
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
      if (S.showAllNeighborsEnabled) allNeighborsLayer.addTo(map);
      if (S.previewOverlay) S.previewOverlay.addTo(map);
      syncCoverageToggles(); // panel-open re-adds these layers unconditionally, so the checkboxes need to catch back up
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
    if (confirm(`Delete "${S.plan.name}"? This can't be undone.`)) deleteCurrentPlan();
  });
  document.getElementById("plan-select").addEventListener("change", (e) => {
    const all = loadAllPlans();
    if (all[e.target.value]) setActivePlan(all[e.target.value]);
  });

  document.getElementById("plan-export").addEventListener("click", () => {
    S.plan.name = document.getElementById("plan-name").value || "Untitled plan";
    const blob = new Blob([JSON.stringify(S.plan, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${S.plan.name.replace(/[^a-z0-9-_ ]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
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
    getActivePlan: () => S.plan,
    getRealRepeaters: () => S.realRepeatersById,
    setShowAllRealNeighbors,
    getShowAllRealNeighbors: () => S.showAllRealNeighborsEnabled,
    // Lets simulator.js keep the two full-height right-side panels mutually
    // exclusive (both are pinned to the same edge at the same width, so
    // having both open at once would just overlap) without planner.js
    // needing to know simulator.js exists.
    closePanel: () => setPanelOpen(false),
  };

  // Test-only introspection hook (no UI/behavioural surface of its own).
  window.__hopreachPlannerDebug = {
    getPreviewBounds: () => (S.previewOverlay ? S.previewOverlay.getBounds() : null),
    getPreviewGeneration: () => S.previewGeneration,
    getMode: () => S.mode,
    getRepeaterCount: () => S.plan.repeaters.length,
    getOverrideCount: () => S.plan.overrides.length,
    getConnectPointA: () => S.connectPointA,
    getConnectPointB: () => S.connectPointB,
  };
})();
