// Neighbour display shared by real (observed) and planned repeaters: the coloured link lines, the hover/pin popup, and fetching a real repeater's observed reach.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanNeighbors = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.PlanState;

  let allNeighborsLayer, allRealNeighborsLayer, cfg, escapeHtml, grabForAdjustment, map, neighborLayer, pinnedNeighborLayer, realNeighborCache, selectConnectPoint;

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
        // Same guard the hover tooltip has always had. Without it an unknown
        // distance threw here — *after* the lines were drawn — so the popup
        // showed "Could not load neighbours" over a map full of them.
        const distance = n.distanceKm == null ? "distance unknown" : `${n.distanceKm.toFixed(1)}km`;
        return `<li><span class="nb-dot ${cls}"></span>${escapeHtml(n.label || n.id.slice(0, 8))} — ${distance}, ${detail}</li>`;
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
    S.pinnedPubkey = null;
  }

  // Persistent "show all neighbours" overlay: every planned repeater's
  // predicted links at once, kept in sync with plannedNeighborsById
  // (re-rendered after every coverage preview result, so it stays current
  // as repeaters are added/moved/deleted — no need to re-toggle it).
  function renderAllPlannedNeighbors() {
    allNeighborsLayer.clearLayers();
    if (!S.showAllNeighborsEnabled) return;
    for (const r of S.plan.repeaters) {
      const neighbors = S.plannedNeighborsById[r.id];
      if (!neighbors || neighbors.length === 0) continue;
      drawNeighborLines(allNeighborsLayer, L.latLng(r.lat, r.lon), neighbors, false);
    }
  }

  function setShowAllNeighbors(enabled) {
    S.showAllNeighborsEnabled = enabled;
    document.getElementById("plan-show-all-neighbors").checked = enabled;
    if (enabled) {
      allNeighborsLayer.addTo(map);
      renderAllPlannedNeighbors();
    } else {
      map.removeLayer(allNeighborsLayer);
    }
  }


  // Persistent "show all neighbours" overlay for REAL repeaters — every
  // currently-loaded real repeater's actual CoreScope-observed reach at
  // once, not just whichever one happens to be hovered. Off by default
  // (a busy region could mean dozens of parallel reach fetches) and
  // available regardless of mode — see app.js's general map control that
  // drives this via window.HopReachPlanner.setShowAllRealNeighbors.
  
  async function renderAllRealNeighbors() {
    const generation = ++S.renderAllRealNeighborsGeneration;
    if (!S.showAllRealNeighborsEnabled) {
      allRealNeighborsLayer.clearLayers();
      return;
    }
    const repeaters = Object.values(S.realRepeatersById);
    const results = await Promise.all(
      repeaters.map(async (r) => {
        try {
          return { r, neighbors: withDistance(await fetchRealNeighbors(r.id), r) };
        } catch {
          return { r, neighbors: [] }; // one repeater's fetch failing shouldn't blank out the rest
        }
      })
    );
    if (generation !== S.renderAllRealNeighborsGeneration) return; // toggled off/reloaded while fetching
    allRealNeighborsLayer.clearLayers();
    for (const { r, neighbors } of results) {
      if (neighbors.length === 0) continue;
      drawNeighborLines(allRealNeighborsLayer, L.latLng(r.lat, r.lon), neighbors, true);
    }
  }

  function setShowAllRealNeighbors(enabled) {
    S.showAllRealNeighborsEnabled = enabled;
    if (enabled) {
      allRealNeighborsLayer.addTo(map);
      renderAllRealNeighbors();
    } else {
      S.renderAllRealNeighborsGeneration++; // discard any fetch still in flight
      map.removeLayer(allRealNeighborsLayer);
    }
  }

  // Real repeaters: neighbours come from CoreScope's own observed reach
  // data (real radio traffic), not a prediction — there's no need to guess
  // when the network has already told us who actually hears whom. Windowed
  // to a configurable lookback (default 24h, user-adjustable up to 30d) so
  // a link from a week ago that's since gone quiet doesn't read as current.
    function setReachWindowDays(days) {
    S.reachWindowDays = days;
    // Old-window entries are simply superseded (new cache key), not wiped —
    // cheap to keep in case the user flips back.
  }

  // Distance from a source point to each neighbour, in km.
  //
  // Derived here rather than taken from the backend: it is pure geometry over
  // two positions both sides already report, so deriving it works identically
  // on every backend and cannot go stale. /mesh-api/'s link shape carries no
  // distance at all, which is why every neighbour read "distance unknown".
  //
  // A neighbour with no position keeps a null distance — genuinely unknown,
  // and rendered as such rather than as a fabricated 0km.
  function withDistance(neighbors, src) {
    if (!src) return neighbors;
    return neighbors.map((n) => ({
      ...n,
      distanceKm:
        n.lat == null || n.lon == null
          ? null
          : Propagation.haversineKm(src.lat, src.lng ?? src.lon, n.lat, n.lon),
    }));
  }

  async function fetchRealNeighbors(pubkey) {
    const cacheKey = `${pubkey}:${S.reachWindowDays}`;
    if (realNeighborCache.has(cacheKey)) return realNeighborCache.get(cacheKey);
    const promise = fetch(`${MeshApi.BASE}/nodes/${encodeURIComponent(pubkey)}/reach?days=${S.reachWindowDays}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) =>
        (data.links || []).map((l) => ({
          id: l.pubkey,
          label: l.name,
          isReal: true,
          lat: l.lat,
          lon: l.lon,
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




  // Deferred to init(): these run against things the context supplies, so at
  // module-load time there is nothing yet to bind to.
  function bindDom() {
    document.getElementById("plan-show-all-neighbors").addEventListener("change", (e) => {
      setShowAllNeighbors(e.target.checked);
    });

    neighborWindowControl.onAdd = function () {
      const div = L.DomUtil.create("div", "neighbor-window-control");
      // The one floating map control that never had a collapse mechanism at
      // all — every sibling (scope filter, map display, map detail) goes
      // through the shared collapsibleHtml/wireCollapsible pair, this one
      // was hand-rolled as a single always-expanded row. On a narrow
      // viewport that's one more permanently-open card in a stack that
      // already dominates the screen (see MOBILE-02), with no way to
      // collapse it even via Declutter (which only ever touches
      // .map-control-header elements). Brought in line with the others.
      const body = `
        <label for="plan-neighbor-window">Window</label>
        <select id="plan-neighbor-window">
          <option value="1" selected>24 hours</option>
          <option value="3">3 days</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
          <option value="30">30 days</option>
        </select>
      `;
      div.innerHTML = window.HopReachMapControls.collapsibleHtml("Neighbours observed", body, "neighbor-window");
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      window.HopReachMapControls.wireCollapsible(div);
      div.querySelector("#plan-neighbor-window").addEventListener("change", (e) => {
        setReachWindowDays(parseInt(e.target.value, 10));
      });
      return div;
    };

    neighborWindowControl.addTo(map);

    // Called by app.js each time the real repeater layer (re)loads.
    window.onRepeatersLoaded = function (geojson, layer) {
      clearPinnedLines(); // the old pin may reference a marker that no longer exists post-reload
      S.realRepeatersById = {};
      // Planning tools (add-repeater prediction, LOS, companion pin) should
      // reason about whichever position set the map is currently showing.
      // Named distinctly from the outer `mode` (plan interaction mode, e.g.
      // "adjust-repeater") which the click handler below also needs.
      const displayMode = window.MCCoverageMap.getPositionMode ? window.MCCoverageMap.getPositionMode() : "standard";
      for (const f of geojson.features) {
        const pubkey = f.properties.public_key;
        const useCalibrated = window.MCCoverageMap.usesCalibratedPositions(displayMode) && f.properties.calibrated_lat != null && f.properties.calibrated_lon != null;
        S.realRepeatersById[pubkey] = {
          id: pubkey,
          label: f.properties.name,
          // ISO timestamps of the first/last time CoreScope heard this
          // repeater at all — lets the simulator filter to repeaters that
          // were plausibly ALIVE at a given moment (now, or a historical
          // packet's own time): a mesh where 2/3 of known repeaters are long
          // dead makes the model predict hops through corpses.
          lastHeard: f.properties.last_heard || null,
          firstSeen: f.properties.first_seen || null,
          lat: useCalibrated ? f.properties.calibrated_lat : f.geometry.coordinates[1],
          lon: useCalibrated ? f.properties.calibrated_lon : f.geometry.coordinates[0],
          // Every region this repeater is believed to be in (observed_scopes
          // union default_scope; falls back to the older inferred_scopes
          // property for one release — see app.js's repeaterScopesOf) — lets
          // other tools (the simulator's own region filter) reuse the same
          // "which scopes is this repeater in" logic as the main map's, see
          // app.js's repeaterScopesOf.
          scopes: Array.from(
            new Set([...(f.properties.observed_scopes || f.properties.inferred_scopes || []), ...(f.properties.default_scope ? [f.properties.default_scope] : [])])
          ),
          // This repeater's own real configured path-hash size (1-3 bytes,
          // `set` via MeshCore's own hash_size setting) — the simulator's
          // loop.detect modeling (see internal/meshsim's own HashSize doc
          // comment) needs this to reproduce real collision-prone-at-small-
          // sizes behavior, not a guess.
          hashSize: f.properties.hash_size || null,
          // Whether this repeater has ever been seen relaying a plain
          // (unscoped) flood packet — undefined when corescope.scope_observation
          // is disabled server-side (the property is omitted entirely, see
          // output.go's buildFeatures), which the simulator treats the same
          // as "not observed" (see SimNode's own default). See
          // corescope.ObservedUnscoped's doc comment for why absence isn't
          // proof of denial, just the best signal available.
          observedUnscoped: f.properties.observed_unscoped === true,
          // Whether the feed carried the observation at all: with
          // corescope.scope_observation disabled (the default) the property
          // is absent for EVERY repeater — "no data", not "observed denying".
          // Consumers deriving denyUnscoped must treat unknown as the
          // firmware default (relaying allowed), or a stock deployment loads
          // a mesh where nothing forwards unscoped traffic
          // (SIMULATION_REVIEW.md D1).
          observedUnscopedKnown: f.properties.observed_unscoped !== undefined && f.properties.observed_unscoped !== null,
        };
      }
      renderAllRealNeighbors(); // keep the "show all real neighbours" overlay in sync with whatever's now loaded/filtered
      layer.eachLayer((marker) => {
        const props = marker.feature && marker.feature.properties;
        if (!props || !props.public_key) return;
        let hoverToken = 0;
        marker.on("mouseover", async () => {
          if (marker.isPopupOpen()) return; // popup already shows this same info merged in
          const token = ++hoverToken;
          showNeighborHighlight(marker.getLatLng(), props.name || "Repeater", [], true, true);
          try {
            const neighbors = withDistance(
              await fetchRealNeighbors(props.public_key), marker.getLatLng());
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
          if (S.mode === "adjust-repeater") {
            marker.closePopup();
            grabForAdjustment(props.public_key, props.name || "Repeater", marker.getLatLng().lat, marker.getLatLng().lng);
            L.DomEvent.stop(e);
          } else if (S.mode === "connect-repeaters") {
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
        const neighbors = withDistance(
          await fetchRealNeighbors(props.public_key), marker.getLatLng());
        if (S.pinnedPubkey !== null && S.pinnedPubkey !== props.public_key) return; // a different popup took over
        S.pinnedPubkey = props.public_key;
        drawNeighborLines(pinnedNeighborLayer, marker.getLatLng(), neighbors, true);
        marker.setPopupContent(window.MCCoverageMap.popupHtml(props) + neighborSectionHtml(neighbors, false));
      } catch {
        marker.setPopupContent(window.MCCoverageMap.popupHtml(props) + '<div class="popup-neighbors"><div class="plan-empty">Could not load neighbours.</div></div>');
      }
    });

    map.on("popupclose", clearPinnedLines);
  }

  function init(context) {
    ({ allNeighborsLayer, allRealNeighborsLayer, cfg, escapeHtml, grabForAdjustment, map, neighborLayer, pinnedNeighborLayer, realNeighborCache, selectConnectPoint } = context);
    bindDom();
    return api;
  }

  const api = {
    init,
    clearNeighborHighlight,
    clearPinnedLines,
    renderAllPlannedNeighbors,
    setShowAllRealNeighbors,
    showNeighborHighlight,
  };
  return api;
});
