(function () {
  const cfg = window.HOPREACH_CONFIG;

  document.getElementById("site-title").textContent = cfg.siteName;
  document.getElementById("site-subtitle").textContent = cfg.siteSubtitle;

  const map = L.map("map").setView(cfg.mapCenter, cfg.mapZoom);

  const baseLayers = {
    // _nolabels (not _all): place names/roads are drawn separately, in the
    // "labels" pane below, which sits *above* the coverage overlay — see
    // that pane's setup further down. Using _all here as well as the
    // separate labels layer would just double the text up.
    "Dark": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }),
    "Streets": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }),
    "Satellite": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
      maxZoom: 19,
    }),
    "Terrain": L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
      maxZoom: 17,
    }),
  };
  const BASEMAP_STORAGE_KEY = "hopreach.basemap";
  const savedBasemap = localStorage.getItem(BASEMAP_STORAGE_KEY);
  const initialBasemap = baseLayers[savedBasemap] ? savedBasemap : "Dark";
  baseLayers[initialBasemap].addTo(map);

  const layersControl = L.control.layers(baseLayers, {}, { collapsed: false, position: "topright" }).addTo(map);
  map.on("baselayerchange", (e) => localStorage.setItem(BASEMAP_STORAGE_KEY, e.name));

  // Roads and place names, drawn in their own panes above the coverage
  // overlay (imageOverlay defaults to Leaflet's overlayPane, z-index 400)
  // but below markers (markerPane, z-index 600) — so both stay legible
  // through the coverage tint instead of being hidden underneath it,
  // without covering up the repeater dots themselves. Only available for
  // the Dark basemap: CARTO publishes a matching label-only layer for it
  // for free: the other three basemaps here (OSM Streets, Esri Satellite,
  // OpenTopoMap Terrain) bake labels into the same raster as everything
  // else, with no equivalent free split layer to draw separately.
  //
  // CARTO's free raster tiles don't offer a roads-only (transparent
  // background) layer the way they do for labels — only the full
  // dark_nolabels raster, which already bakes roads into the same opaque
  // fill used for the base layer below the coverage overlay. Reusing that
  // same tile source a second time, in its own pane above the coverage
  // overlay, blended via mix-blend-mode: screen on the *pane* (Leaflet
  // 1.9.4's TileLayer has no per-tile className option to hang CSS off of
  // directly — the pane itself is the right place, and blending there
  // still composites correctly against everything painted beneath it)
  // gets the same practical effect without a second tile provider or API
  // key: the near-black background (~RGB 6-14) blends away to almost
  // nothing against whatever's beneath it, while the lighter road-line
  // pixels (~RGB 25-44+) punch through visibly. Same tile URL as the base
  // layer, so the browser serves it from the same tile cache rather than
  // doubling network requests.
  map.createPane("roads");
  map.getPane("roads").style.zIndex = 440;
  map.getPane("roads").style.pointerEvents = "none";
  map.getPane("roads").style.mixBlendMode = "screen";
  const darkRoads = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
    pane: "roads",
    maxZoom: 19,
  });

  map.createPane("labels");
  map.getPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
  const darkLabels = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png", {
    pane: "labels",
    maxZoom: 19,
  });
  function syncLabelsLayer(basemapName) {
    if (basemapName === "Dark") {
      if (!map.hasLayer(darkRoads)) darkRoads.addTo(map);
      if (!map.hasLayer(darkLabels)) darkLabels.addTo(map);
    } else {
      if (map.hasLayer(darkRoads)) map.removeLayer(darkRoads);
      if (map.hasLayer(darkLabels)) map.removeLayer(darkLabels);
    }
  }
  syncLabelsLayer(initialBasemap);
  map.on("baselayerchange", (e) => syncLabelsLayer(e.name));

  // Persistent (survives basemap switches, unlike each layer's own
  // attribution) link to the source repo, so anyone looking at the map can
  // find where it comes from. version-tag starts empty and is filled in by
  // loadMeta() once meta.json's own Version field is known — always
  // obvious at a glance which release actually generated what's on screen.
  map.attributionControl.addAttribution(
    '<a href="https://github.com/A13xB0/hopreach" target="_blank" rel="noopener">HopReach on GitHub</a> <span id="version-tag"></span> · <a href="analytics.html">Analytics</a>'
  );

  const statusColor = { active: "#4ade80", degraded: "#facc15", silent: "#64748b" };

  let clusters = null;
  let coverageLayer = null; // L.layerGroup wrapping the current set of tile overlays
  let coverageTileOverlays = []; // the individual L.imageOverlay instances, for opacity control (LayerGroup has no setOpacity)
  let legendControl = null;
  let lastGeneratedAt = null;
  let currentGeojson = null;
  let currentMeta = null;

  // "Map detail": which repeater positions + which coverage raster to show.
  // standard/precision use reported positions; calibrated/calibrated_precision
  // use positions nudged to fit observed reach data (see calibration.go).
  // precision/calibrated_precision are the same model rendered at a much
  // higher pixel resolution (COVERAGE_PRECISION_WIDTH) for a sharper result.
  const POSITION_MODE_KEY = "hopreach.positionMode";
  const MAP_DETAIL_OPTIONS = [
    { value: "standard", label: "Standard" },
    { value: "calibrated", label: "Calibrated" },
    { value: "precision", label: "Precision" },
    { value: "calibrated_precision", label: "Calibrated Precision" },
  ];
  const CALIBRATED_MODES = new Set(["calibrated", "calibrated_precision"]);
  let positionMode = localStorage.getItem(POSITION_MODE_KEY) || "standard";
  let positionModeControl = null;

  function usesCalibratedPositions(mode) {
    return CALIBRATED_MODES.has(mode);
  }

  function displayedLatLng(props, fallbackLatLng) {
    if (usesCalibratedPositions(positionMode) && props.calibrated_lat != null && props.calibrated_lon != null) {
      return L.latLng(props.calibrated_lat, props.calibrated_lon);
    }
    return fallbackLatLng;
  }

  // Scope-filter checkboxes: purely client-side, re-filters whatever was
  // already fetched — doesn't touch the server for the marker filtering
  // itself. The scope *list* does come from the server side, though: real,
  // currently-active region names straight from CoreScope's own analytics
  // (GET /api/scope-stats — the same "byRegion" list corescope.
  // scope_inference itself now uses), not a fixed config list, so a region
  // appearing/disappearing on the real mesh shows up here automatically.
  // "unscoped" is a synthetic option matching repeaters with neither a
  // reported nor an observed scope at all, not a literal region value.
  const scopeFilterState = {};

  // A repeater's real scope(s) for filtering/coverage purposes — a real
  // MeshCore repeater can have more than one region enabled at once, so
  // this is a set, not a single value. inferred_scopes (decoded from real
  // packets' own cryptographic transport codes — see
  // corescope.scope_inference) is the reliable signal; default_scope
  // (self-reported, sparse) is folded in too in case it names a region
  // inferred_scopes' own packet window happened to miss. Empty array
  // means no scope is known at all.
  function repeaterScopesOf(props) {
    const scopes = new Set(props.inferred_scopes || []);
    if (props.default_scope) scopes.add(props.default_scope);
    return Array.from(scopes);
  }

  function matchesScopeFilter(props) {
    const checked = Object.keys(scopeFilterState).filter((k) => scopeFilterState[k]);
    if (checked.length === 0) return true;
    const scopes = repeaterScopesOf(props);
    return checked.some((code) => (code === "unscoped" ? scopes.length === 0 : scopes.includes(code)));
  }

  // --- per-scope coverage overlays ----------------------------------
  //
  // Beyond filtering which markers show, each *checked* scope also gets
  // its own coverage-raster overlay — computed client-side (the same WASM
  // propagation model the planning tools use, via a dedicated Worker so
  // it never janks the map), restricted to only the repeaters believed to
  // actually be in that scope. Checking multiple scopes at once overlays
  // their (semi-transparent, distinctly coloured) coverage together, so
  // real per-region coverage can be visually compared, not just the
  // marker set.
  const SCOPE_COLORS = ["#38bdf8", "#f472b6", "#facc15", "#4ade80", "#a78bfa", "#fb923c", "#22d3ee", "#f87171"];
  let scopeCoverageWorker = null;
  let scopeCoverageGeneration = 0;
  const scopeOverlays = new Map(); // scope name -> L.imageOverlay
  let knownRegionNames = [];

  function ensureScopeCoverageWorker() {
    if (!scopeCoverageWorker) scopeCoverageWorker = new Worker("planner-worker.js");
    return scopeCoverageWorker;
  }

  function colorForScope(name) {
    const idx = Math.max(0, knownRegionNames.indexOf(name));
    return SCOPE_COLORS[idx % SCOPE_COLORS.length];
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function clearScopeOverlay(name) {
    const overlay = scopeOverlays.get(name);
    if (overlay) {
      map.removeLayer(overlay);
      layersControl.removeLayer(overlay);
      scopeOverlays.delete(name);
    }
  }

  function renderScopeOverlay(name, msg) {
    const { bounds, imageWidth, imageHeight, marginGreenDb } = msg;
    const margins = new Float32Array(msg.margins);
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(imageWidth, imageHeight);

    const rgb = hexToRgb(colorForScope(name));
    for (let i = 0; i < margins.length; i++) {
      const m = margins[i];
      const p = i * 4;
      if (Number.isNaN(m)) {
        imgData.data[p + 3] = 0;
        continue;
      }
      let t = m / marginGreenDb;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      imgData.data[p] = rgb[0];
      imgData.data[p + 1] = rgb[1];
      imgData.data[p + 2] = rgb[2];
      // Even marginal coverage (t near 0) stays visibly tinted rather than
      // fading to near-nothing — comparing *which* scope reaches an area
      // at all matters here more than the fine margin gradient a single
      // scope's own preview cares about.
      imgData.data[p + 3] = Math.round(70 + 90 * t);
    }
    ctx.putImageData(imgData, 0, 0);

    const llBounds = [
      [bounds.south, bounds.west],
      [bounds.north, bounds.east],
    ];
    const overlay = L.imageOverlay(canvas.toDataURL("image/png"), llBounds, { interactive: false }).addTo(map);
    layersControl.addOverlay(overlay, `Scope coverage: ${name}`);
    scopeOverlays.set(name, overlay);
  }

  function computeScopeCoverage(name) {
    clearScopeOverlay(name);
    if (!currentGeojson) return;
    const sites = currentGeojson.features
      .filter((f) => repeaterScopesOf(f.properties).includes(name))
      .map((f) => ({ lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
    if (sites.length === 0) return;

    const generation = ++scopeCoverageGeneration;
    const worker = ensureScopeCoverageWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.scopeId !== name || msg.generation !== generation) return;
      if (msg.type === "scope-result") {
        worker.removeEventListener("message", onMessage);
        if (!msg.empty) renderScopeOverlay(name, msg);
      } else if (msg.type === "scope-error") {
        worker.removeEventListener("message", onMessage);
        console.error(`scope coverage (${name}):`, msg.message);
      }
    }
    worker.addEventListener("message", onMessage);
    worker.postMessage({
      kind: "scope-coverage",
      generation,
      scopeId: name,
      sites,
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
      // Deliberately coarser than the planning preview's own 320px-ish
      // scale would suggest for a single site — a scope's repeaters can
      // span a whole region, and the raster loop is O(pixels × sites), so
      // a smaller image keeps that tractable for potentially dozens of
      // sites. This is a rough per-region overview, not a precise map.
      imageWidth: 400,
    });
  }

  async function initScopeFilterControl() {
    let regionNames = [];
    try {
      // window is one of CoreScope's own fixed enum values ("1h"/"24h"/
      // "7d"), not an arbitrary hour count — "7d" (its longest) gives this
      // the best chance of finding a region that's gone quiet recently,
      // since this call's only job is discovering which real regions
      // exist at all, not tallying anything within a specific window.
      const resp = await fetch("/corescope-api/api/scope-stats?window=7d");
      if (resp.ok) {
        const data = await resp.json();
        regionNames = (data.byRegion || []).map((r) => r.name).filter(Boolean);
      }
    } catch {
      // CoreScope unreachable — fall through to the local-data fallback below.
    }
    if (regionNames.length === 0 && currentGeojson) {
      const seen = new Set();
      for (const f of currentGeojson.features) {
        for (const s of repeaterScopesOf(f.properties)) seen.add(s);
      }
      regionNames = Array.from(seen).sort();
    }
    if (regionNames.length === 0) return; // nothing to filter by yet, on this instance

    knownRegionNames = regionNames;
    for (const name of regionNames) scopeFilterState[name] = false;
    scopeFilterState["unscoped"] = false;

    const scopeFilterControl = L.control({ position: "topright" });
    scopeFilterControl.onAdd = function () {
      const div = L.DomUtil.create("div", "scope-filter-control");
      const rows =
        regionNames.map((name) => `<label><input type="checkbox" data-scope="${escapeHtml(name)}"> ${escapeHtml(name)}</label>`).join("") +
        `<label><input type="checkbox" data-scope="unscoped"> Unscoped</label>`;
      div.innerHTML = `<div class="scope-filter-title">Filter by region scope</div>${rows}`;
      L.DomEvent.disableClickPropagation(div);
      div.querySelectorAll("input[type=checkbox]").forEach((input) => {
        input.addEventListener("change", (e) => {
          const name = e.target.dataset.scope;
          scopeFilterState[name] = e.target.checked;
          renderFilteredRepeaters();
          if (name !== "unscoped") {
            if (e.target.checked) computeScopeCoverage(name);
            else clearScopeOverlay(name);
          }
        });
      });
      return div;
    };
    scopeFilterControl.addTo(map);
  }
  initScopeFilterControl();

  function relativeTime(iso) {
    if (!iso) return "never";
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  // Exposed globally: planner.js appends a neighbours section to this same
  // popup (rather than opening a second, separate box) once it's fetched —
  // see the map's popupopen handler in planner.js.
  function popupHtml(props) {
    const status = props.status;
    return `
      <div class="popup-status ${status}">${status}</div>
      <div class="popup-title">${escapeHtml(props.name)}</div>
      <div class="popup-row"><span>Last heard</span><span>${relativeTime(props.last_heard)}</span></div>
      <div class="popup-row"><span>First seen</span><span>${props.first_seen ? new Date(props.first_seen).toLocaleDateString() : "–"}</span></div>
      <div class="popup-row"><span>Relays (1h / 24h)</span><span>${props.relay_count_1h ?? "–"} / ${props.relay_count_24h ?? "–"}</span></div>
      <div class="popup-row"><span>Adverts seen</span><span>${props.advert_count ?? "–"}</span></div>
      <div class="popup-row"><span>Elevation</span><span>${props.elevation_m ?? "–"} m</span></div>
      ${scopeRowsHtml(props)}
      <div class="popup-row"><span>Key</span><span>${escapeHtml((props.public_key || "").slice(0, 12))}</span></div>
      ${calibrationRowHtml(props)}
    `;
  }

  // default_scope (self-reported, often absent — see the map's own scope
  // filter above) and inferred_scopes (every region decoded from this
  // repeater's own real packets' cryptographic transport codes —
  // MeshCore's actual region-scoping mechanism, not a guess from channel
  // names — see corescope.scope_inference, off by default) are shown
  // separately, not merged: they can legitimately disagree, and that
  // disagreement is itself useful information, not noise to hide.
  // inferred_scopes can be more than one region — a real repeater can
  // have several enabled at once.
  function scopeRowsHtml(props) {
    const inferred = props.inferred_scopes || [];
    if (!props.default_scope && inferred.length === 0) return "";
    const rows = [];
    if (props.default_scope) {
      rows.push(`<div class="popup-row"><span>Scope (reported)</span><span>${escapeHtml(props.default_scope)}</span></div>`);
    }
    if (inferred.length > 0) {
      rows.push(`<div class="popup-row"><span>Scope${inferred.length > 1 ? "s" : ""} (observed)</span><span>${escapeHtml(inferred.join(", "))}</span></div>`);
    }
    return rows.join("");
  }

  // Shown whenever the server computed a calibration score for this
  // repeater, regardless of which position mode is currently displayed —
  // the correction (or lack of one) should always be visible, never silent.
  function calibrationRowHtml(props) {
    if (props.calibration_score_before == null) return "";
    const detail = props.calibrated
      ? `moved ${props.calibration_offset_m} m (score ${props.calibration_score_before} → ${props.calibration_score_after})`
      : `not adjusted (score ${props.calibration_score_before})`;
    return `<div class="popup-row"><span>Calibration</span><span>${detail}</span></div>`;
  }

  function formatEta(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return null;
    if (seconds < 60) return "<1m";
    const mins = Math.round(seconds / 60);
    if (mins < 60) return `~${mins}m`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `~${hours}h ${remMins}m`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function showError(msg) {
    const banner = document.getElementById("error-banner");
    banner.textContent = msg;
    banner.style.display = "block";
  }

  function addCoverageLegend(freqMHz) {
    if (legendControl) {
      map.removeControl(legendControl);
    }
    legendControl = L.control({ position: "bottomright" });
    legendControl.onAdd = function () {
      const div = L.DomUtil.create("div", "legend");
      div.innerHTML = `
        <div class="legend-title">Estimated coverage (${freqMHz} MHz)</div>
        <div class="legend-bar"></div>
        <div class="legend-labels"><span>marginal signal</span><span>strong signal</span></div>
        <div class="legend-opacity">
          <label for="coverage-opacity">Opacity</label>
          <input type="range" id="coverage-opacity" min="0" max="100" value="100">
        </div>
        <div class="legend-note">Terrain-aware estimate (free-space path loss + knife-edge diffraction over real elevation data). Best server per point — not foliage/building-aware.</div>
      `;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      div.querySelector("#coverage-opacity").addEventListener("input", (e) => {
        coverageTileOverlays.forEach((o) => o.setOpacity(e.target.value / 100));
      });
      return div;
    };
    legendControl.addTo(map);
  }

  function renderFilteredRepeaters(fitBounds) {
    if (!currentGeojson) return;
    const filtered = { type: "FeatureCollection", features: currentGeojson.features.filter((f) => matchesScopeFilter(f.properties)) };

    if (clusters) {
      map.removeLayer(clusters);
    }
    clusters = L.markerClusterGroup({ maxClusterRadius: 45 });
    const layer = L.geoJSON(filtered, {
      pointToLayer: (feature, latlng) =>
        L.circleMarker(displayedLatLng(feature.properties, latlng), {
          radius: 7,
          fillColor: statusColor[feature.properties.status] || statusColor.silent,
          color: "#0a1929",
          weight: 1.5,
          fillOpacity: 0.9,
        }),
      onEachFeature: (feature, layer) => {
        layer.bindPopup(popupHtml(feature.properties));
      },
    });
    clusters.addLayer(layer);
    map.addLayer(clusters);
    if (fitBounds && filtered.features.length > 0) {
      map.fitBounds(clusters.getBounds(), { padding: [30, 30], maxZoom: 10 });
    }
    // planner.js (loaded after this script) hooks in here to attach
    // neighbour-hover behaviour to the currently-visible real repeater
    // markers, and to get the plain-data list it needs for the planning
    // tools. Re-runs on every filter change too, since hidden repeaters
    // shouldn't be hoverable.
    if (typeof window.onRepeatersLoaded === "function") {
      window.onRepeatersLoaded(filtered, layer);
    }
  }

  function loadRepeaters() {
    fetch(`${cfg.dataUrl}?t=${Date.now()}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${cfg.dataUrl}: HTTP ${r.status}`);
        return r.json();
      })
      .then((geojson) => {
        const isFirstLoad = !lastGeneratedAt;
        currentGeojson = geojson;
        renderFilteredRepeaters(isFirstLoad);
      })
      .catch((err) => {
        console.error(err);
        showError(`Could not load repeater data: ${err.message}`);
      });
  }

  // Returns the coverage sub-object (image/bounds/assumptions) matching the
  // currently selected "Map detail" mode, falling back to standard if that
  // particular pass isn't available for some reason (e.g. it failed
  // server-side, or an older meta.json predates it).
  function currentCoverageMeta() {
    if (!currentMeta || !currentMeta.coverage) return null;
    return currentMeta.coverage[positionMode] || currentMeta.coverage.standard;
  }

  // Coverage rasters are served pre-split into a grid of tiles (see
  // writeCoverageTiles in main.go), not one giant image: a single
  // Precision-resolution PNG can run into tens of thousands of pixels on
  // a side, past which many GPUs fall back to a much slower software
  // compositing path for that whole layer — the direct cause of visible
  // "chugging" on every pan/zoom, not just a slow initial load. Several
  // moderately-sized textures are cheap for the browser to composite
  // where one huge one isn't.
  function applyCoverageLayer() {
    const cm = currentCoverageMeta();
    if (!cm || !cm.tiles || cm.tiles.length === 0) return;
    if (coverageLayer) {
      layersControl.removeLayer(coverageLayer);
      map.removeLayer(coverageLayer);
    }

    // Precision/Calibrated Precision are genuinely higher-resolution
    // rasters — smooth (bilinear) upscaling when zoomed in blurs that real
    // per-pixel detail into a soft gradient that reads as "not actually
    // sharper." Standard/Calibrated keep the browser's smooth default,
    // since at their coarser native resolution smoothing looks nicer than
    // visibly blocky pixels.
    const crisp = positionMode.includes("precision");

    coverageTileOverlays = cm.tiles.map((t) => {
      const b = t.bounds;
      const overlay = L.imageOverlay(`data/${t.image}?t=${Date.parse(currentMeta.generated_at)}`, [[b.South, b.West], [b.North, b.East]], {
        opacity: 1,
        interactive: false,
      });
      overlay.on("add", () => {
        const img = overlay.getElement();
        if (img) img.classList.toggle("coverage-crisp", crisp);
      });
      return overlay;
    });
    coverageLayer = L.layerGroup(coverageTileOverlays).addTo(map);
    layersControl.addOverlay(coverageLayer, "Estimated coverage");
    addCoverageLegend(cm.frequency_mhz);
  }

  // Builds the option list from whichever meta.coverage keys are actually
  // present, rather than hardcoding all four — keeps the frontend honest if
  // a pass ever fails server-side, and hides the control entirely if
  // there's no coverage data at all (shouldn't normally happen, standard is
  // always computed whenever there's any repeater to cover).
  function ensurePositionModeControl(coverage) {
    const available = MAP_DETAIL_OPTIONS.filter((o) => coverage && coverage[o.value]);
    if (available.length === 0) {
      if (positionModeControl) {
        map.removeControl(positionModeControl);
        positionModeControl = null;
      }
      positionMode = "standard";
      return;
    }
    if (!available.some((o) => o.value === positionMode)) {
      positionMode = "standard";
    }
    if (positionModeControl) {
      map.removeControl(positionModeControl);
      positionModeControl = null;
    }
    positionModeControl = L.control({ position: "topright" });
    positionModeControl.onAdd = function () {
      const div = L.DomUtil.create("div", "position-mode-control");
      const options = available.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
      div.innerHTML = `
        <div class="position-mode-title">Map detail</div>
        <select id="position-mode-select">${options}</select>
      `;
      L.DomEvent.disableClickPropagation(div);
      const select = div.querySelector("#position-mode-select");
      select.value = positionMode;
      select.addEventListener("change", (e) => {
        positionMode = e.target.value;
        localStorage.setItem(POSITION_MODE_KEY, positionMode);
        renderFilteredRepeaters();
        applyCoverageLayer();
      });
      return div;
    };
    positionModeControl.addTo(map);
  }

  function loadMeta() {
    fetch(`${cfg.metaUrl}?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((meta) => {
        currentMeta = meta;
        lastGeneratedAt = meta.generated_at;
        document.getElementById("count-active").textContent = meta.counts.active;
        document.getElementById("count-degraded").textContent = meta.counts.degraded;
        document.getElementById("count-silent").textContent = meta.counts.silent;
        document.getElementById("last-updated").textContent =
          `Last updated: ${new Date(meta.generated_at).toLocaleString()}`;
        const versionTag = document.getElementById("version-tag");
        if (versionTag && meta.version) versionTag.textContent = `(${meta.version})`;

        if (meta.coverage) {
          ensurePositionModeControl(meta.coverage);
          applyCoverageLayer();
        }
      })
      .catch((err) => console.error("meta.json load failed", err));
  }

  function loadData() {
    loadRepeaters();
    loadMeta();
  }

  // Tracks progress.json's own `stage` so each transition (not just the
  // final done/error) triggers a data reload — the backend now writes
  // meta.json incrementally, one coverage tier at a time (see
  // cmd/hopreach/run.go's writeTier), specifically so a tier that's
  // already finished shows up here without waiting for the whole run
  // (every remaining tier included) to complete first.
  let lastProgressStage = null;

  // A run that gets killed (OOM, a manual kill, a host reboot) never
  // reaches its own "done"/"error" write — progress.json just stops
  // updating, frozen mid-stage. Without treating that as stale, the
  // banner would show "still computing" forever for anyone loading the
  // page, even though nothing is actually running (confirmed in
  // production: a forced recompute OOM-killed mid-Precision-tier left
  // progress.json frozen on computing_coverage_precision). Generous
  // enough that a real (if slow) network-bound stage — a big DEM tile
  // fetch, a slow CoreScope response — doesn't false-positive.
  const PROGRESS_STALE_MS = 3 * 60 * 1000;

  function pollProgress() {
    fetch(`data/progress.json?t=${Date.now()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((progress) => {
        const banner = document.getElementById("progress-banner");
        const stale = progress && progress.updated_at && Date.now() - Date.parse(progress.updated_at) > PROGRESS_STALE_MS;
        if (!progress || progress.stage === "done" || progress.stage === "error" || stale) {
          const wasShowing = !banner.classList.contains("hidden");
          banner.classList.add("hidden");
          if (wasShowing) {
            // A generation just finished, failed, or (per `stale` above)
            // was silently killed — refresh the map data either way.
            loadData();
          }
          lastProgressStage = null;
          return;
        }
        if (progress.stage !== lastProgressStage) {
          lastProgressStage = progress.stage;
          // Reaching a new stage means whichever stage came before it (if
          // any produced a coverage tier) just finished and wrote its own
          // update to meta.json — pick that up now rather than waiting for
          // "done".
          loadData();
        }
        banner.classList.remove("hidden");
        const eta = formatEta(progress.eta_seconds);
        const backendLabel = { cpu: "CPU", gpu: "GPU", remote_gpu: "Remote GPU" }[progress.backend];
        document.getElementById("progress-text").textContent =
          (backendLabel ? `[${backendLabel}] ` : "") +
          (progress.message || progress.stage) +
          (eta ? ` — ${eta} remaining` : "");
        document.getElementById("progress-fill").style.width = `${Math.max(2, progress.percent)}%`;
      })
      .catch(() => {});
  }

  loadData();
  pollProgress();
  setInterval(pollProgress, 2000);

  // Minimal surface for planner.js to hook into — it's loaded after this
  // script and has no other way to reach the map/layers control.
  window.MCCoverageMap = {
    map,
    layersControl,
    popupHtml,
    getPositionMode: () => positionMode,
    usesCalibratedPositions,
    currentCoverageMeta,
  };
})();
