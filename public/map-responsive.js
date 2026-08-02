// Responsive map chrome: the declutter button, bottom clearances, the phone-only map-options sheet, and the drag-to-dismiss bottom sheets the panels become on a narrow screen.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MapResponsive = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.MapState;

  let NARROW_VIEWPORT_PX, map;

  // Item 14's own "manage it better" answer: one button that collapses
  // every collapsible map control on screen at once (whichever ones
  // actually exist right now — some, like the simulator view options or
  // the bottleneck key, only exist while their own mode is active), and
  // restores each to whatever it individually was before, not just a
  // blanket re-expand (an intentionally-collapsed control, e.g. "Map
  // display" which defaults closed, should stay closed on restore).
  // Session-only — deliberately not persisted, this is a momentary "clear
  // the map" action, not a saved preference the way each control's own
  // collapsed state already is.
  
  function setMapControlHeaderCollapsed(header, collapsed) {
    const body = header.parentElement && header.parentElement.querySelector(".map-control-body");
    if (!body) return;
    const chevron = header.querySelector(".map-control-chevron");
    body.classList.toggle("hidden", collapsed);
    if (chevron) chevron.textContent = collapsed ? "▸" : "▾";
    const key = header.dataset.storageKey;
    if (key) localStorage.setItem(`hopreach.mapControlCollapsed.${key}`, collapsed ? "1" : "0");
  }

  function toggleMapDeclutter() {
    const headers = document.querySelectorAll(".map-control-header");
    const btn = document.getElementById("map-declutter-toggle");
    if (S.mapDeclutterSnapshot === null) {
      S.mapDeclutterSnapshot = new Map();
      headers.forEach((header) => {
        const body = header.parentElement && header.parentElement.querySelector(".map-control-body");
        if (!body) return;
        S.mapDeclutterSnapshot.set(header, body.classList.contains("hidden"));
        setMapControlHeaderCollapsed(header, true);
      });
      btn.classList.add("active");
      btn.title = "Restore every map control to how it was";
    } else {
      headers.forEach((header) => {
        setMapControlHeaderCollapsed(header, S.mapDeclutterSnapshot.has(header) ? S.mapDeclutterSnapshot.get(header) : false);
      });
      S.mapDeclutterSnapshot = null;
      btn.classList.remove("active");
      btn.title = "Collapse (or restore) every map control at once";
    }
  }

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

  // Declared here, created in init(). `.addTo(map)` is a side effect that
  // needs the real Leaflet map, which arrives with the context — building it
  // at module load throws inside Leaflet before this module ever registers
  // itself, taking app.js and everything downstream of it with it.
  let layersControl;

  // Everything docked along the bottom of the map has to stack without
  // overlapping, and none of the heights are knowable up front: the
  // #map-tools button row wraps to a second line on narrow viewports, and
  // the replay transport bar is only present while there's something to
  // replay. So measure both and publish two CSS variables the stack is
  // built from (see style.css) — bottom to top, that's the transport bar,
  // then #map-tools, then Leaflet's own bottom control corners.
  const mapToolsEl = document.getElementById("map-tools");
  const mapWrapEl = document.getElementById("map-wrap");
  const transportEl = document.getElementById("sim-transport");
  function syncBottomClearances() {
    if (!mapToolsEl || !mapWrapEl) return;
    const gapPx = 12; // matches #map-tools' own 0.75rem bottom offset
    // A hidden bar is display:none, so this is 0 and the stack collapses
    // back down on its own.
    const transportH = transportEl ? transportEl.getBoundingClientRect().height : 0;
    const toolsH = mapToolsEl.getBoundingClientRect().height;
    mapWrapEl.style.setProperty("--transport-clearance", `${Math.round(transportH)}px`);
    mapWrapEl.style.setProperty("--map-tools-clearance", `${Math.round(transportH + toolsH + gapPx * 2)}px`);
    // The row's height on its own, without the desktop layout's gaps: the
    // phone tab bar is flush to the bottom edge and everything above it
    // (transport bar, sheets, Leaflet's corners) stacks directly on top,
    // so the mobile block needs the bare measurement rather than the
    // padded desktop clearance.
    mapWrapEl.style.setProperty("--tools-h", `${Math.round(toolsH)}px`);
  }

  // ===================================================================
  // Phone layout: the Map options sheet, and panels-as-bottom-sheets
  // ===================================================================
  const isNarrow = () => window.innerWidth <= NARROW_VIEWPORT_PX;

  // The controls that live stacked down the map's right edge on desktop
  // and belong together in one sheet on a phone, in the order they should
  // appear there. Deliberately an allowlist rather than "everything in
  // the corner": the simulator also docks run-scoped controls there (the
  // replay's own map key, the live stat strip) which are readouts for
  // what's happening on the map right now and would be useless filed away
  // behind a settings sheet.
  const MAP_OPTIONS_CONTROLS = [
    ".leaflet-control-layers",
    ".map-display-control",
    ".neighbor-window-control",
    ".position-mode-control",
    ".scope-filter-control",
    ".sim-view-control",
    ".legend",
  ];

  // Where each control came from, so a phone → desktop resize can put it
  // back exactly where Leaflet had it rather than leaving it orphaned in
  // a sheet that's now display:none.
  const controlHomes = new WeakMap();
  const optionsSheet = document.getElementById("map-options-sheet");
  const optionsBody = document.getElementById("map-options-body");
  const optionsToggle = document.getElementById("map-options-toggle");

  // These are MOVED, not cloned: a copy would be a second set of inputs
  // with no listeners on them (Leaflet binds to the element it created),
  // so the sheet's controls would look right and do nothing.
  function syncMapOptionsSheet() {
    if (!optionsBody) return;
    const narrow = isNarrow();
    MAP_OPTIONS_CONTROLS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (narrow) {
          if (el.parentElement === optionsBody) return;
          controlHomes.set(el, { parent: el.parentElement, next: el.nextElementSibling });
          optionsBody.appendChild(el);
        } else {
          const home = controlHomes.get(el);
          if (!home || el.parentElement !== optionsBody || !home.parent) return;
          // Only reuse the remembered sibling if it's still where it was;
          // otherwise fall back to appending to the original corner.
          const before = home.next && home.next.parentElement === home.parent ? home.next : null;
          home.parent.insertBefore(el, before);
          controlHomes.delete(el);
        }
      });
    });
    if (!narrow) return;

    // Controls arrive whenever they happen to mount — the region filter
    // waits on a live CoreScope call, so it lands after the legend and the
    // sheet ends up in load order rather than reading order. Re-append in
    // the allowlist's order, but only when it's actually wrong: appendChild
    // on a control the user is mid-interaction with would drop focus.
    const desired = MAP_OPTIONS_CONTROLS.flatMap((sel) =>
      [...optionsBody.children].filter((el) => el.matches(sel))
    );
    const current = [...optionsBody.children];
    if (desired.length === current.length && desired.every((el, i) => el === current[i])) return;
    desired.forEach((el) => optionsBody.appendChild(el));
  }

  function setMapOptionsOpen(open) {
    if (!optionsSheet) return;
    if (open) syncMapOptionsSheet();
    optionsSheet.classList.toggle("hidden", !open);
    if (optionsToggle) optionsToggle.classList.toggle("active", open);
  }



  // Drag the grabber to resize a sheet between three heights: minimised to
  // a title strip, half, or nearly full.
  //
  // Dragging DOWN bottoms out at minimised — it deliberately cannot close
  // the sheet. Closing a panel is destructive (setSimPanelOpen(false) stops
  // any replay, drops the transport bar and removes every simulator layer
  // from the map), and "shrink this out of the way so I can watch the run"
  // is the single most likely reason to drag a sheet down mid-simulation.
  // Having that gesture tear the run down was exactly backwards. Closing
  // stays available, but only through the explicit × next to the title.
  const SHEET_PEEK_PX = 68; // grabber + the sticky title row
  const SHEET_SNAP_FRACTIONS = [0.45, 0.88];
  const TAP_SLOP_PX = 6;

  function initBottomSheet(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    const grab = panel.querySelector(".panel-grab");
    if (!grab) return;

    let startY = 0;
    let startH = 0;
    let moved = 0;
    let dragging = false;

    const availableH = () =>
      mapWrapEl.getBoundingClientRect().height -
      (parseFloat(getComputedStyle(mapWrapEl).getPropertyValue("--tools-h")) || 0) -
      (parseFloat(getComputedStyle(mapWrapEl).getPropertyValue("--transport-clearance")) || 0);

    // Ascending, so "the next one up" is just the following entry.
    const snapPoints = () => [SHEET_PEEK_PX, ...SHEET_SNAP_FRACTIONS.map((f) => Math.round(availableH() * f))];

    const setHeight = (px) => {
      panel.style.setProperty("--sheet-h", `${Math.round(px)}px`);
      // Minimised, the body would still be scrollable behind a 68px window,
      // so the title strip could be scrolled away leaving an unlabelled
      // stub with no way back. Clipping it keeps the strip stable.
      panel.classList.toggle("sheet-minimised", Math.round(px) <= SHEET_PEEK_PX + 1);
    };

    // Exposed so the header's own minimise button drives the same state as
    // the drag, rather than a second, subtly different notion of "small".
    panel.__hopreachSheet = {
      minimise: () => setHeight(SHEET_PEEK_PX),
      restore: () => setHeight(snapPoints()[1]),
      isMinimised: () => panel.classList.contains("sheet-minimised"),
    };

    grab.addEventListener("pointerdown", (e) => {
      if (!isNarrow()) return;
      dragging = true;
      moved = 0;
      startY = e.clientY;
      startH = panel.getBoundingClientRect().height;
      grab.classList.add("dragging");
      grab.setPointerCapture(e.pointerId);
    });

    grab.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      moved = Math.max(moved, Math.abs(dy));
      const avail = availableH();
      // Floors at the peek height rather than 0 — see SHEET_PEEK_PX.
      const h = Math.max(SHEET_PEEK_PX, Math.min(avail, startH - dy));
      setHeight(h);
    });

    const endDrag = (e) => {
      if (!dragging) return;
      dragging = false;
      grab.classList.remove("dragging");
      if (e && e.pointerId !== undefined && grab.hasPointerCapture(e.pointerId)) {
        grab.releasePointerCapture(e.pointerId);
      }
      const h = panel.getBoundingClientRect().height;
      const points = snapPoints();

      if (moved <= TAP_SLOP_PX) {
        // Treated as a tap: step up to the next height, wrapping back round
        // to minimised from the tallest. One repeatable gesture cycles the
        // whole range without needing an accurate drag.
        const next = points.find((p) => p > h + 1);
        setHeight(next === undefined ? points[0] : next);
        return;
      }
      setHeight(points.reduce((best, p) => (Math.abs(p - h) < Math.abs(best - h) ? p : best)));
    };
    grab.addEventListener("pointerup", endDrag);
    grab.addEventListener("pointercancel", endDrag);
  }




  const darkRoads = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png", {
    pane: "roads",
    maxZoom: 19,
  });

  // Deferred to init(): these run against things the context supplies, so at
  // module-load time there is nothing yet to bind to.
  function bindDom() {
    document.getElementById("map-declutter-toggle").addEventListener("click", toggleMapDeclutter);

    baseLayers[initialBasemap].addTo(map);

    map.on("baselayerchange", (e) => localStorage.setItem(BASEMAP_STORAGE_KEY, e.name));

    window.HopReachSyncBottomClearances = syncBottomClearances;

    if (mapToolsEl && mapWrapEl && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(syncBottomClearances);
      ro.observe(mapToolsEl);
      if (transportEl) ro.observe(transportEl);
      syncBottomClearances();
    }

    if (optionsToggle && optionsSheet) {
      optionsToggle.addEventListener("click", () => setMapOptionsOpen(optionsSheet.classList.contains("hidden")));
      const optionsClose = document.getElementById("map-options-close");
      if (optionsClose) optionsClose.addEventListener("click", () => setMapOptionsOpen(false));
      // Only one sheet at a time — opening Plan or Simulate puts a sheet in
      // exactly the space this one occupies.
      ["plan-toggle", "sim-toggle"].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener("click", () => setMapOptionsOpen(false));
      });
    }

    // Controls mount at different times — the region scope filter waits on a
    // live CoreScope call, the simulator's view options only exist while
    // Simulate is open — so the sheet is kept in step by watching the corners
    // rather than by syncing once at startup and hoping. Moving a control OUT
    // of a corner re-triggers this, which then finds it already in the sheet
    // and does nothing, so it settles rather than looping.
    if (typeof MutationObserver !== "undefined") {
      const cornerObserver = new MutationObserver(() => {
        if (isNarrow()) syncMapOptionsSheet();
      });
      [".leaflet-top.leaflet-right", ".leaflet-bottom.leaflet-right"].forEach((sel) => {
        const corner = document.querySelector(sel);
        if (corner) cornerObserver.observe(corner, { childList: true });
      });
    }

    initBottomSheet("plan-panel");

    initBottomSheet("sim-panel");

    // The header's minimise button is the discoverable version of dragging
    // the grabber all the way down: shrink to the title strip to watch a run
    // on the map, press again to come back. Deliberately never closes — the
    // × beside it is the only thing that does.
    document.querySelectorAll(".panel-minimise").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sheet = btn.closest("#plan-panel, #sim-panel");
        const api = sheet && sheet.__hopreachSheet;
        if (!api) return;
        const minimised = api.isMinimised();
        if (minimised) api.restore();
        else api.minimise();
        btn.textContent = minimised ? "▾" : "▴";
        btn.setAttribute("aria-label", minimised ? "Minimise to watch the map" : "Expand the panel");
      });
    });

      window.addEventListener("resize", () => {
      if (S.resizeRaf) cancelAnimationFrame(S.resizeRaf);
      S.resizeRaf = requestAnimationFrame(() => {
        syncMapOptionsSheet();
        if (!isNarrow()) {
          setMapOptionsOpen(false);
          // Drop any dragged height so the desktop sidebar isn't stuck at
          // whatever the phone sheet was last left at.
          ["plan-panel", "sim-panel"].forEach((id) => {
            const p = document.getElementById(id);
            if (p) p.style.removeProperty("--sheet-h");
          });
        }
        syncBottomClearances();
      });
    });

    syncMapOptionsSheet();

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
  }

  function init(context) {
    ({ NARROW_VIEWPORT_PX, map } = context);
    layersControl = L.control.layers(
      baseLayers, {}, { collapsed: true, position: "topright" }).addTo(map);
    // The api literal below is evaluated at module load, when this is still
    // undefined, so publishing it has to happen here — after it exists and
    // before init() returns the object the caller destructures.
    api.layersControl = layersControl;
    bindDom();
    return api;
  }

  const api = {
    init,
    darkRoads,
    initialBasemap,
    // layersControl is filled in by init(); see the note there.
    layersControl: undefined,
  };
  return api;
});
