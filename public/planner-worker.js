// Computes a coverage-preview raster for a set of planned repeater sites,
// off the main thread so dragging a marker never janks the map. Mirrors
// coverage.go's coverageRaster/coverageRow, scaled down to a modest preview
// size since this runs live on every edit rather than once a day. Also
// predicts each planned site's neighbours (other planned sites + nearby
// real repeaters) using the same terrain grid, since there's no observed
// radio data for a site that doesn't exist yet — unlike real repeaters,
// whose neighbours come from CoreScope's own reach data (see planner.js).
importScripts("wasm_exec.js", "wasm-bridge.js", "terrain.js", "propagation.js");

// The real (nightly, server-side) map searches out to the full link-budget
// range (often ~100km) because it's computed once a day over the whole
// region. A live preview recomputed on every marker drag can't afford
// that: at DEM_ZOOM≈11 a single 100km-radius site needs 250+ elevation
// tiles just to start. Cap the preview's search radius and use a coarser
// zoom — plenty to judge "does this fill the gap", not meant to reproduce
// the full map's extreme-range hilltop cases.
const PREVIEW_MAX_RANGE_KM = 35;
const PREVIEW_ZOOM_CAP = 10;
const MAX_NEIGHBORS_PER_SITE = 8;

self.onmessage = async (e) => {
  await Propagation.ready; // wasm/main.go's exports must be registered before any handler below touches them
  if (e.data.kind === "connect") return handleConnect(e.data);
  if (e.data.kind === "area-coverage") return handleAreaCoverage(e.data);
  if (e.data.kind === "scope-coverage") return handleScopeCoverage(e.data);
  return handlePreview(e.data);
};

async function handlePreview({ generation, sites, realRepeaters, config, imageWidth }) {

  if (!sites || sites.length === 0) {
    self.postMessage({ generation, type: "result", empty: true });
    return;
  }

  try {
    const propagation = config.propagation;
    const rangeKm = Math.min(Propagation.linkBudgetMaxRangeKm(propagation), PREVIEW_MAX_RANGE_KM);
    const zoom = Math.min(config.demZoom, PREVIEW_ZOOM_CAP);

    const kmPerDegLat = 110.574;
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const s of sites) {
      const kmPerDegLon = Math.max(1, 111.32 * Math.cos((s.lat * Math.PI) / 180));
      const latPad = rangeKm / kmPerDegLat;
      const lonPad = rangeKm / kmPerDegLon;
      south = Math.min(south, s.lat - latPad);
      north = Math.max(north, s.lat + latPad);
      west = Math.min(west, s.lon - lonPad);
      east = Math.max(east, s.lon + lonPad);
    }
    const bounds = { south, north, west, east };

    self.postMessage({ generation, type: "status", message: "Loading terrain…" });
    const grid = await Terrain.buildLocalGrid(config.demTileURLBase, zoom, bounds);

    const resolvedSites = sites.map((s) => {
      const groundM = grid.at(s.lat, s.lon);
      const antennaHeightM = s.antennaHeightM != null ? s.antennaHeightM : propagation.antennaHeightM;
      // isReal/label distinguish a personally-adjusted real repeater (see
      // planner.js's overrides) from a brand-new planned site, so it shows
      // up correctly (real name, "observed"-style styling) when it's
      // *another* site's predicted neighbour, not just when it's the
      // subject of its own prediction.
      return { id: s.id, lat: s.lat, lon: s.lon, txHeightM: groundM + antennaHeightM, isReal: !!s.isReal, label: s.label || null };
    });

    // --- neighbour prediction (cheap compared to the raster below) ---
    const neighbors = {};
    // resolvedSiteIds also covers real repeaters that have been personally
    // adjusted (their pubkey reused as the site id, see planner.js) — such
    // a repeater must only appear once, via its resolvedSites entry (which
    // has the adjusted position/height), not again via realCandidates at
    // its stale original position.
    const resolvedSiteIds = new Set(resolvedSites.map((s) => s.id));
    const realCandidates = (realRepeaters || []).filter((r) => {
      if (resolvedSiteIds.has(r.id)) return false;
      const kmPerDegLon = Math.max(1, 111.32 * Math.cos((r.lat * Math.PI) / 180));
      return r.lat >= bounds.south && r.lat <= bounds.north && r.lon >= bounds.west && r.lon <= bounds.east && kmPerDegLon > 0;
    });
    for (const s of resolvedSites) {
      const candidates = [];
      for (const other of resolvedSites) {
        if (other.id === s.id) continue;
        candidates.push({ id: other.id, label: other.label, isReal: other.isReal, lat: other.lat, lon: other.lon });
      }
      for (const r of realCandidates) {
        candidates.push({ id: r.id, label: r.label, isReal: true, lat: r.lat, lon: r.lon });
      }

      const found = [];
      for (const c of candidates) {
        const d = Propagation.haversineKm(s.lat, s.lon, c.lat, c.lon);
        if (d > rangeKm || d < 0.01) continue;
        const margin = Propagation.pathMargin(grid, propagation, s.lat, s.lon, s.txHeightM, c.lat, c.lon, d);
        if (margin >= 0) {
          found.push({ id: c.id, label: c.label, isReal: c.isReal, lat: c.lat, lon: c.lon, distanceKm: d, marginDb: margin });
        }
      }
      found.sort((a, b) => b.marginDb - a.marginDb);
      neighbors[s.id] = found.slice(0, MAX_NEIGHBORS_PER_SITE);
    }

    // --- coverage raster ---
    const avgLat = (south + north) / 2;
    const kmPerDegLon = 111.32 * Math.cos((avgLat * Math.PI) / 180);
    const widthKm = (east - west) * kmPerDegLon;
    const heightKm = (north - south) * kmPerDegLat;
    const imageHeight = Math.max(1, Math.round(imageWidth * (heightKm / widthKm)));

    const margins = new Float32Array(imageWidth * imageHeight).fill(NaN);

    for (let py = 0; py < imageHeight; py++) {
      const lat = north - ((py + 0.5) / imageHeight) * (north - south);
      for (let px = 0; px < imageWidth; px++) {
        const lon = west + ((px + 0.5) / imageWidth) * (east - west);
        let best = -Infinity;
        for (const s of resolvedSites) {
          const d = Propagation.haversineKm(lat, lon, s.lat, s.lon);
          if (d > rangeKm || d < 0.01) continue;
          const m = Propagation.pathMargin(grid, propagation, s.lat, s.lon, s.txHeightM, lat, lon, d);
          if (m > best) best = m;
        }
        if (best >= 0) margins[py * imageWidth + px] = best;
      }
      if (py % 5 === 0 || py === imageHeight - 1) {
        self.postMessage({ generation, type: "progress", done: py + 1, total: imageHeight });
      }
    }

    self.postMessage(
      {
        generation,
        type: "result",
        bounds,
        imageWidth,
        imageHeight,
        marginGreenDb: propagation.marginGreenDb,
        margins: margins.buffer,
        neighbors,
      },
      [margins.buffer]
    );
  } catch (err) {
    self.postMessage({ generation, type: "error", message: err.message || String(err) });
  }
}

// A scope's repeaters can span a much larger area than a single plan
// (potentially the whole configured region) — fetching terrain at
// PREVIEW_ZOOM_CAP for that whole area can mean requesting on the order
// of a thousand DEM tiles at once (confirmed directly: a real ~61-repeater
// scope spanning most of Scotland took 60+ seconds and still hadn't
// finished loading terrain). Step the zoom coarser, capped to a fixed
// tile-count budget, rather than fetching an unbounded number of tiles —
// the same fix already applied to the simulator's own connectivity
// builder (public/simulator.js) for the same underlying problem.
const SCOPE_COVERAGE_MAX_GRID_TILES = 400;

function estimateTileCount(bounds, zoom) {
  const minTileX = Math.floor(Terrain.lonToTileX(bounds.west, zoom));
  const maxTileX = Math.floor(Terrain.lonToTileX(bounds.east, zoom));
  const minTileY = Math.floor(Terrain.latToTileY(bounds.north, zoom));
  const maxTileY = Math.floor(Terrain.latToTileY(bounds.south, zoom));
  return (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
}

// --- scope coverage: best-margin raster over an arbitrary repeater set --
//
// Reuses the same raster-generation approach as handlePreview (best
// server per pixel, each site bounded to its own real link-budget range),
// but for a caller-supplied repeater set (e.g. "every repeater CoreScope
// believes is in scope #fif") rather than a plan's own sites — see
// app.js's scope-filter control, which drives this. Each pixel's
// candidate sites are pre-filtered by a cheap bounding-box check before
// the real (haversine + terrain) margin computation — with dozens of
// repeaters spread over hundreds of km, most (pixel, site) pairs are
// trivially out of range, and skipping them before ever calling into WASM
// is what keeps the raster loop itself interactive; the terrain zoom cap
// above is what keeps the *fetch* itself interactive.
async function handleScopeCoverage({ generation, scopeId, sites, config, imageWidth }) {
  if (!sites || sites.length === 0) {
    self.postMessage({ generation, type: "scope-result", scopeId, empty: true });
    return;
  }
  try {
    const propagation = config.propagation;
    const rangeKm = Math.min(Propagation.linkBudgetMaxRangeKm(propagation), PREVIEW_MAX_RANGE_KM);

    const kmPerDegLat = 110.574;
    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const s of sites) {
      const kmPerDegLon = Math.max(1, 111.32 * Math.cos((s.lat * Math.PI) / 180));
      const latPad = rangeKm / kmPerDegLat;
      const lonPad = rangeKm / kmPerDegLon;
      south = Math.min(south, s.lat - latPad);
      north = Math.max(north, s.lat + latPad);
      west = Math.min(west, s.lon - lonPad);
      east = Math.max(east, s.lon + lonPad);
    }
    const bounds = { south, north, west, east };

    let zoom = Math.min(config.demZoom, PREVIEW_ZOOM_CAP);
    while (zoom > 4 && estimateTileCount(bounds, zoom) > SCOPE_COVERAGE_MAX_GRID_TILES) zoom--;

    self.postMessage({ generation, type: "scope-status", scopeId, message: `Loading terrain for ${sites.length} repeater${sites.length === 1 ? "" : "s"}…` });
    const grid = await Terrain.buildLocalGrid(config.demTileURLBase, zoom, bounds);

    const resolvedSites = sites.map((s) => {
      const groundM = grid.at(s.lat, s.lon);
      const latPadDeg = rangeKm / kmPerDegLat;
      const lonPadDeg = rangeKm / Math.max(1, 111.32 * Math.cos((s.lat * Math.PI) / 180));
      return { lat: s.lat, lon: s.lon, txHeightM: groundM + propagation.antennaHeightM, latPadDeg, lonPadDeg };
    });

    const avgLat = (south + north) / 2;
    const kmPerDegLon = 111.32 * Math.cos((avgLat * Math.PI) / 180);
    const widthKm = (east - west) * kmPerDegLon;
    const heightKm = (north - south) * kmPerDegLat;
    const imageHeight = Math.max(1, Math.round(imageWidth * (heightKm / widthKm)));

    const margins = new Float32Array(imageWidth * imageHeight).fill(NaN);

    for (let py = 0; py < imageHeight; py++) {
      const lat = north - ((py + 0.5) / imageHeight) * (north - south);
      for (let px = 0; px < imageWidth; px++) {
        const lon = west + ((px + 0.5) / imageWidth) * (east - west);
        let best = -Infinity;
        for (const s of resolvedSites) {
          if (Math.abs(lat - s.lat) > s.latPadDeg || Math.abs(lon - s.lon) > s.lonPadDeg) continue;
          const d = Propagation.haversineKm(lat, lon, s.lat, s.lon);
          if (d > rangeKm || d < 0.01) continue;
          const m = Propagation.pathMargin(grid, propagation, s.lat, s.lon, s.txHeightM, lat, lon, d);
          if (m > best) best = m;
        }
        if (best >= 0) margins[py * imageWidth + px] = best;
      }
      if (py % 10 === 0 || py === imageHeight - 1) {
        self.postMessage({ generation, type: "scope-progress", scopeId, done: py + 1, total: imageHeight });
      }
    }

    self.postMessage(
      { generation, type: "scope-result", scopeId, bounds, imageWidth, imageHeight, marginGreenDb: propagation.marginGreenDb, margins: margins.buffer },
      [margins.buffer]
    );
  } catch (err) {
    self.postMessage({ generation, type: "scope-error", scopeId, message: err.message || String(err) });
  }
}

// --- connect two repeaters with the fewest new relays --------------------
//
// A real global-optimum placement search is intractable (it's a
// geometric Steiner-tree-like problem); this is a heuristic that mirrors
// how a human would actually plan it: lean on existing infrastructure
// first (a BFS reachability graph over real repeaters, same predicted-
// margin test as neighbour prediction above), and only invent new sites
// to bridge a genuine gap, walking the straight line between the closest
// bridgeable pair of already-reachable repeaters and biasing each new
// candidate toward higher local ground (real masts do better on hills).
const CONNECT_MAX_RANGE_KM = 35; // same rationale as PREVIEW_MAX_RANGE_KM
const CONNECT_ZOOM_CAP = 10;
const CONNECT_DEFAULT_MAX_NEW_SITES = 6;
const CONNECT_CORRIDOR_PAD_KM = 40; // margin around the A-B box for the existing-repeater graph + candidate search
// Every reachable pair (up to this bound) is tried, not just the closest
// one — see the "multiple attempts, multiple paths" comment below.
const CONNECT_MAX_PAIRS_TRIED = 40;
// How many distinct route options to hand back for the user to choose
// between, ranked fewest-new-sites-first.
const CONNECT_MAX_PATH_OPTIONS = 3;

async function handleConnect({ generation, pointA, pointB, realRepeaters, config, maxNewSites }) {
  const post = (msg) => self.postMessage({ generation, kind: "connect", ...msg });
  const siteCap = maxNewSites > 0 ? maxNewSites : CONNECT_DEFAULT_MAX_NEW_SITES;
  try {
    const propagation = config.propagation;
    const rangeKm = Math.min(Propagation.linkBudgetMaxRangeKm(propagation), CONNECT_MAX_RANGE_KM);
    const zoom = Math.min(config.demZoom, CONNECT_ZOOM_CAP);

    const kmPerDegLat = 110.574;
    const midLat = (pointA.lat + pointB.lat) / 2;
    const kmPerDegLon = Math.max(1, 111.32 * Math.cos((midLat * Math.PI) / 180));
    const latPad = CONNECT_CORRIDOR_PAD_KM / kmPerDegLat;
    const lonPad = CONNECT_CORRIDOR_PAD_KM / kmPerDegLon;
    const bounds = {
      south: Math.min(pointA.lat, pointB.lat) - latPad,
      north: Math.max(pointA.lat, pointB.lat) + latPad,
      west: Math.min(pointA.lon, pointB.lon) - lonPad,
      east: Math.max(pointA.lon, pointB.lon) + lonPad,
    };

    post({ type: "status", message: "Loading terrain…" });
    const grid = await Terrain.buildLocalGrid(config.demTileURLBase, zoom, bounds);

    const groundAt = (lat, lon) => grid.at(lat, lon);
    const txHeightAt = (lat, lon) => groundAt(lat, lon) + propagation.antennaHeightM;
    function marginBetween(fromLat, fromLon, toLat, toLon) {
      const d = Propagation.haversineKm(fromLat, fromLon, toLat, toLon);
      if (d < 0.01 || d > rangeKm) return -Infinity;
      return Propagation.pathMargin(grid, propagation, fromLat, fromLon, txHeightAt(fromLat, fromLon), toLat, toLon, d);
    }

    // Only consider real repeaters inside the search corridor — keeps
    // this bounded, same capping philosophy as the preview/LOS tools.
    const candidates = (realRepeaters || []).filter(
      (r) => r.lat >= bounds.south && r.lat <= bounds.north && r.lon >= bounds.west && r.lon <= bounds.east && r.id !== pointA.id && r.id !== pointB.id
    );
    const nodes = [pointA, pointB, ...candidates];
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const adjacency = new Map(nodes.map((n) => [n.id, []]));

    post({ type: "status", message: `Checking existing infrastructure (${nodes.length} repeaters)…` });
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const n1 = nodes[i], n2 = nodes[j];
        // Either direction clearing counts as connected — real masts
        // share the same default antenna height in this model, so
        // genuine asymmetry is rare, and this matches how the rest of
        // the planning tools already treat predicted links.
        if (marginBetween(n1.lat, n1.lon, n2.lat, n2.lon) >= 0 || marginBetween(n2.lat, n2.lon, n1.lat, n1.lon) >= 0) {
          adjacency.get(n1.id).push(n2.id);
          adjacency.get(n2.id).push(n1.id);
        }
      }
    }

    function bfsPath(startId, targetId) {
      if (startId === targetId) return [startId];
      const visited = new Set([startId]);
      const prev = new Map();
      const queue = [startId];
      while (queue.length) {
        const cur = queue.shift();
        for (const next of adjacency.get(cur) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          prev.set(next, cur);
          if (next === targetId) {
            const path = [next];
            while (prev.has(path[0])) path.unshift(prev.get(path[0]));
            return path;
          }
          queue.push(next);
        }
      }
      return null;
    }

    function reachableSet(startId) {
      const visited = new Set([startId]);
      const queue = [startId];
      while (queue.length) {
        const cur = queue.shift();
        for (const next of adjacency.get(cur) || []) {
          if (!visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }
      return visited;
    }

    const toChainPoint = (n) => ({ id: n.id, lat: n.lat, lon: n.lon, label: n.label, isReal: true, isNew: false });

    // Already connected via existing repeaters only?
    const directPath = bfsPath(pointA.id, pointB.id);
    if (directPath) {
      post({
        type: "results",
        options: [{ newSites: [], chain: directPath.map((id) => toChainPoint(nodeById.get(id))) }],
      });
      return;
    }

    // Bridge the gap: try the closest reachable-set pairs first.
    const rA = [...reachableSet(pointA.id)].map((id) => nodeById.get(id));
    const rB = [...reachableSet(pointB.id)].map((id) => nodeById.get(id));
    const pairs = [];
    for (const a of rA) {
      for (const b of rB) {
        pairs.push({ a, b, d: Propagation.haversineKm(a.lat, a.lon, b.lat, b.lon) });
      }
    }
    pairs.sort((p, q) => p.d - q.d);

    post({ type: "status", message: "Searching for relay positions…" });

    // Search candidate positions along the great-circle from `from`
    // toward `to`, farthest first, each with a small local search biased
    // toward higher ground. Returns the farthest candidate with positive
    // margin back to `from`, or null if nothing along the path works.
    //
    // The local search radius/angular resolution matter a lot in real
    // mountainous terrain: a valley or pass that a relay could actually see
    // through is often wider than a couple of km, and can be a fairly
    // narrow angular slice around a candidate point — too tight a radius or
    // too few angles searched can miss it entirely even though a real,
    // usable site sits just a few km off the direct line (confirmed by
    // reproducing a real Highlands route that a narrower search couldn't
    // bridge at all, at any hop count, but this one does).
    function findNextRelay(from, to) {
      const totalKm = Propagation.haversineKm(from.lat, from.lon, to.lat, to.lon);
      const steps = 12;
      const searchRadiusKm = Math.min(15, totalKm * 0.15);
      const rings = 3;
      const angleCount = 16;
      for (let i = steps; i >= 1; i--) {
        const frac = i / steps;
        const baseLat = from.lat + (to.lat - from.lat) * frac;
        const baseLon = from.lon + (to.lon - from.lon) * frac;

        let best = null, bestElev = -Infinity;
        for (let ring = 0; ring <= rings; ring++) {
          const r = (ring / rings) * searchRadiusKm;
          const ac = ring === 0 ? 1 : angleCount;
          for (let a = 0; a < ac; a++) {
            const angle = (a / ac) * 2 * Math.PI;
            const lat = baseLat + (r * Math.cos(angle)) / kmPerDegLat;
            const lon = baseLon + (r * Math.sin(angle)) / kmPerDegLon;
            if (marginBetween(from.lat, from.lon, lat, lon) < 0) continue;
            const elev = groundAt(lat, lon);
            if (elev > bestElev) {
              bestElev = elev;
              best = { lat, lon };
            }
          }
        }
        if (best) return best;
      }
      return null;
    }

    // Try to bridge a->b in at most `cap` new sites, as few as possible.
    function bridgeGap(a, b, cap) {
      if (marginBetween(a.lat, a.lon, b.lat, b.lon) >= 0) return [];
      if (cap <= 0) return null;
      const sites = [];
      let cur = a;
      for (let i = 0; i < cap; i++) {
        const next = findNextRelay(cur, b);
        if (!next) return null; // stuck — no forward progress possible from here
        sites.push(next);
        if (marginBetween(next.lat, next.lon, b.lat, b.lon) >= 0) return sites;
        cur = next;
      }
      return null;
    }

    // Two bridges of the same length that land on essentially the same
    // ground aren't meaningfully different choices — skip offering both.
    function routesOverlap(bridgeA, bridgeB) {
      if (bridgeA.length !== bridgeB.length) return false;
      for (let i = 0; i < bridgeA.length; i++) {
        if (Propagation.haversineKm(bridgeA[i].lat, bridgeA[i].lon, bridgeB[i].lat, bridgeB[i].lon) > 1) return false;
      }
      return true;
    }

    // Multiple attempts, multiple paths: rather than committing to the
    // first (or even just the single best) pair that bridges — terrain
    // doesn't care about straight-line distance, so the closest reachable
    // pair isn't always the pair needing fewest new sites — every
    // reachable pair up to CONNECT_MAX_PAIRS_TRIED is tried, and up to
    // CONNECT_MAX_PATH_OPTIONS distinct results are kept (ranked fewest
    // new sites first) for the user to choose between.
    const pairsToTry = pairs.slice(0, CONNECT_MAX_PAIRS_TRIED);
    const options = []; // [{ bridge, a, b }], sorted, length <= CONNECT_MAX_PATH_OPTIONS
    for (let i = 0; i < pairsToTry.length; i++) {
      // Nothing can beat "no new sites needed" — stop once we have enough of those.
      if (options.length >= CONNECT_MAX_PATH_OPTIONS && options[0].bridge.length === 0) break;
      const { a, b } = pairsToTry[i];
      post({
        type: "status",
        message: `Searching for relay positions… (attempt ${i + 1}/${pairsToTry.length}, ${options.length} path${options.length === 1 ? "" : "s"} found so far)`,
      });
      const bridge = bridgeGap(a, b, siteCap);
      if (!bridge) continue;
      if (options.some((opt) => opt.bridge.length === bridge.length && routesOverlap(opt.bridge, bridge))) continue;
      options.push({ bridge, a, b });
      options.sort((x, y) => x.bridge.length - y.bridge.length);
      if (options.length > CONNECT_MAX_PATH_OPTIONS) options.length = CONNECT_MAX_PATH_OPTIONS;
    }

    if (options.length > 0) {
      const results = options.map(({ bridge, a, b }) => {
        const pathA = bfsPath(pointA.id, a.id) || [a.id];
        const pathB = bfsPath(b.id, pointB.id) || [b.id];
        const chain = [
          ...pathA.map((id) => toChainPoint(nodeById.get(id))),
          ...bridge.map((site, i) => ({ id: `relay-${i}`, lat: site.lat, lon: site.lon, label: null, isReal: false, isNew: true })),
          ...pathB.slice(1).map((id) => toChainPoint(nodeById.get(id))),
        ];
        return { newSites: bridge, chain };
      });
      post({ type: "results", options: results });
      return;
    }

    post({
      type: "error",
      message: `Couldn't find a path within ${siteCap} new repeater${siteCap === 1 ? "" : "s"} — try raising the limit, picking two repeaters that are closer together, or build a chain manually with Check line of sight.`,
    });
  } catch (err) {
    post({ type: "error", message: err.message || String(err) });
  }
}

// --- maximal-coverage placement over a drawn area ------------------------
//
// A true optimal placement is a maximum-coverage / set-cover problem
// (NP-hard); this uses the standard greedy maximum-coverage heuristic —
// repeatedly add whichever candidate site newly covers the most
// still-uncovered ground — which is provably within ~63% (1 - 1/e) of
// optimal. Same "principled heuristic, not a solver" framing as the
// connect-repeaters search above. Candidate sites are restricted to
// strictly inside the drawn polygon.
const AREA_MAX_BBOX_KM = 100; // cap on the polygon's bounding-box diagonal
const AREA_ZOOM_CAP = 10;
const AREA_DEFAULT_MAX_NEW_SITES = 6;
const AREA_SAMPLE_GRID_COLS = 26; // "is this bit of the area covered?" grid
const AREA_CANDIDATE_GRID_COLS = 14; // candidate new-site grid (coarser)
// Greedy set-cover is deterministic for a fixed candidate grid, but a fixed
// grid can easily miss the actual best site (it just wasn't a grid point
// this time) — each attempt shifts the candidate grid by a fraction of a
// cell so a different set of physical positions gets tried, keeping
// whichever attempt covers the most ground for the same site budget.
const AREA_MAX_ATTEMPTS = 3;

// Standard ray-casting point-in-polygon test, treating lon/lat as a plain
// x/y plane — fine at this scale/latitude (a single region within
// Scotland), same approach latitude-scaling is skipped elsewhere in this
// file for anything that only needs topological inside/outside, not a
// metric distance.
function pointInPolygon(lat, lon, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i].lat, xi = polygon[i].lon;
    const yj = polygon[j].lat, xj = polygon[j].lon;
    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

async function handleAreaCoverage({ generation, polygon, maxNewSites, existingSites, realRepeaters, config }) {
  const post = (msg) => self.postMessage({ generation, kind: "area-coverage", ...msg });
  const siteCap = maxNewSites > 0 ? maxNewSites : AREA_DEFAULT_MAX_NEW_SITES;
  try {
    if (!polygon || polygon.length < 3) {
      post({ type: "error", message: "Draw at least 3 points before finishing the shape." });
      return;
    }
    const propagation = config.propagation;

    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const v of polygon) {
      south = Math.min(south, v.lat);
      north = Math.max(north, v.lat);
      west = Math.min(west, v.lon);
      east = Math.max(east, v.lon);
    }
    const diagonalKm = Propagation.haversineKm(south, west, north, east);
    if (diagonalKm > AREA_MAX_BBOX_KM) {
      post({
        type: "error",
        message: `Selected area is too large for a live preview (~${Math.round(diagonalKm)}km across, max ${AREA_MAX_BBOX_KM}km) — try a smaller area.`,
      });
      return;
    }

    // Deliberately reuses PREVIEW_MAX_RANGE_KM (not AREA_MAX_BBOX_KM, which
    // only bounds how large a shape you can draw) — this is what actually
    // gets *rendered* by the coverage-preview overlay once these sites
    // land in the plan. Scoring against a longer range than the renderer
    // will ever draw is exactly what caused this tool to report coverage
    // percentages the map didn't visually back up: a site could be
    // credited with "covering" a point 50km away that the preview's own
    // 35km search radius will never draw a pixel for.
    const rangeKm = Math.min(Propagation.linkBudgetMaxRangeKm(propagation), PREVIEW_MAX_RANGE_KM);
    const zoom = Math.min(config.demZoom, AREA_ZOOM_CAP);
    const bounds = { south, north, west, east };

    const midLat = (south + north) / 2;
    const kmPerDegLat = 110.574;
    const kmPerDegLon = Math.max(1, 111.32 * Math.cos((midLat * Math.PI) / 180));
    const widthKm = (east - west) * kmPerDegLon;
    const heightKm = (north - south) * kmPerDegLat;

    // The terrain grid is padded by rangeKm beyond the polygon's own bbox —
    // without this, an existing repeater just outside the drawn shape
    // (which can legitimately cover part of the interior) would have its
    // path profile computed against terrain clamped to the polygon's edge
    // rather than the real ground between it and the interior, silently
    // corrupting that link's margin.
    const latPad = rangeKm / kmPerDegLat;
    const lonPad = rangeKm / kmPerDegLon;
    const gridBounds = { south: south - latPad, north: north + latPad, west: west - lonPad, east: east + lonPad };

    post({ type: "status", message: "Loading terrain…" });
    const grid = await Terrain.buildLocalGrid(config.demTileURLBase, zoom, gridBounds);

    function buildGridPoints(cols, phaseRow = 0, phaseCol = 0) {
      const rows = Math.max(1, Math.round(cols * (heightKm / Math.max(widthKm, 0.001))));
      const points = [];
      for (let ry = 0; ry < rows; ry++) {
        const lat = north - ((ry + 0.5 + phaseRow) / rows) * (north - south);
        for (let rx = 0; rx < cols; rx++) {
          const lon = west + ((rx + 0.5 + phaseCol) / cols) * (east - west);
          if (pointInPolygon(lat, lon, polygon)) points.push({ lat, lon });
        }
      }
      return points;
    }

    function centroid() {
      let clat = 0, clon = 0;
      for (const v of polygon) { clat += v.lat; clon += v.lon; }
      return { lat: clat / polygon.length, lon: clon / polygon.length };
    }

    const samplePoints = buildGridPoints(AREA_SAMPLE_GRID_COLS);
    if (samplePoints.length === 0) samplePoints.push(centroid()); // very small/thin polygon

    function resolveSite(s) {
      const groundM = grid.at(s.lat, s.lon);
      const antennaHeightM = s.antennaHeightM != null ? s.antennaHeightM : propagation.antennaHeightM;
      return { id: s.id, lat: s.lat, lon: s.lon, txHeightM: groundM + antennaHeightM };
    }

    // Existing infrastructure is free to use, same philosophy as
    // connect-repeaters: baseline coverage comes from real repeaters
    // (adjusted position if overridden) plus anything already in the
    // current plan. Dedup real repeaters that are also present via an
    // override, same pattern handlePreview uses above.
    const resolvedExisting = (existingSites || []).map(resolveSite);
    const existingIds = new Set(resolvedExisting.map((s) => s.id));
    const resolvedReal = (realRepeaters || []).filter((r) => !existingIds.has(r.id)).map(resolveSite);
    const baseline = [...resolvedExisting, ...resolvedReal];

    function marginFromSite(site, lat, lon) {
      const d = Propagation.haversineKm(site.lat, site.lon, lat, lon);
      if (d > rangeKm || d < 0.01) return -Infinity;
      return Propagation.pathMargin(grid, propagation, site.lat, site.lon, site.txHeightM, lat, lon, d);
    }

    post({ type: "status", message: "Checking existing coverage…" });
    const covered = samplePoints.map((sp) => baseline.some((s) => marginFromSite(s, sp.lat, sp.lon) >= 0));
    const totalCount = samplePoints.length;
    let coveredCount = covered.filter(Boolean).length;
    const beforePct = Math.round((100 * coveredCount) / totalCount);

    if (coveredCount === totalCount) {
      post({ type: "result", newSites: [], beforePct: 100, afterPct: 100, polygon });
      return;
    }

    // Candidate new-site grid, each nudged toward locally higher ground
    // within its cell (real masts do better on hills) — same ring-search
    // bias findNextRelay uses above, just scored by actual newly-covered
    // count rather than elevation alone. The nudge radius/angle count need
    // to be genuinely generous, not just "a fraction of a grid cell": a
    // real dominant hilltop can sit well outside a narrow search disc, and
    // settling for a mediocre nearby point instead means the greedy loop
    // needs *more* sites to reach full coverage than a handful of truly
    // well-placed ones would (confirmed by the same class of bug in
    // findNextRelay above, on a real route a too-narrow search couldn't
    // bridge at all).
    function buildCandidates(phaseRow, phaseCol) {
      let candidatePoints = buildGridPoints(AREA_CANDIDATE_GRID_COLS, phaseRow, phaseCol);
      if (candidatePoints.length === 0) candidatePoints = [centroid()];
      const nudgeRadiusKm = Math.max(1, Math.min(widthKm, heightKm) / AREA_CANDIDATE_GRID_COLS);
      return candidatePoints.map((c) => {
        let best = c, bestElev = grid.at(c.lat, c.lon);
        for (let ring = 1; ring <= 3; ring++) {
          const r = (ring / 3) * nudgeRadiusKm;
          for (let a = 0; a < 16; a++) {
            const angle = (a / 16) * 2 * Math.PI;
            const lat = c.lat + (r * Math.cos(angle)) / kmPerDegLat;
            const lon = c.lon + (r * Math.sin(angle)) / kmPerDegLon;
            if (!pointInPolygon(lat, lon, polygon)) continue;
            const elev = grid.at(lat, lon);
            if (elev > bestElev) { bestElev = elev; best = { lat, lon }; }
          }
        }
        return resolveSite(best);
      });
    }

    // Greedy set-cover over one candidate grid — deterministic for that
    // grid, but a fixed grid can miss the true best site simply because it
    // wasn't a grid point. Multiple attempts (below) shift the grid by a
    // fraction of a cell each time and keep whichever attempt covers the
    // most ground for the same site budget, rather than trusting the
    // first grid alignment tried.
    function runGreedy(candidates, attemptLabel) {
      const covered2 = covered.slice();
      let coveredCount2 = coveredCount;
      const chosen = [];
      let remaining = candidates.slice();
      for (let iter = 0; iter < siteCap && remaining.length > 0; iter++) {
        let bestIdx = -1, bestGain = 0, bestNewlyCovered = null;
        for (let ci = 0; ci < remaining.length; ci++) {
          const c = remaining[ci];
          let gain = 0;
          const newlyCovered = [];
          for (let si = 0; si < samplePoints.length; si++) {
            if (covered2[si]) continue;
            if (marginFromSite(c, samplePoints[si].lat, samplePoints[si].lon) >= 0) {
              gain++;
              newlyCovered.push(si);
            }
          }
          if (gain > bestGain) {
            bestGain = gain;
            bestIdx = ci;
            bestNewlyCovered = newlyCovered;
          }
        }
        if (bestIdx === -1) break; // no remaining candidate improves coverage at all — stop early

        chosen.push(remaining[bestIdx]);
        for (const si of bestNewlyCovered) covered2[si] = true;
        coveredCount2 += bestGain;
        remaining.splice(bestIdx, 1);

        const pct = Math.round((100 * coveredCount2) / totalCount);
        post({ type: "status", message: `${attemptLabel} — Evaluating candidate sites… (${chosen.length}/${siteCap} placed, ${pct}% covered)` });
        if (coveredCount2 === totalCount) break; // fully covered — no need to keep searching
      }
      return { chosen, coveredCount: coveredCount2 };
    }

    let best = null; // { chosen, coveredCount }
    for (let attempt = 0; attempt < AREA_MAX_ATTEMPTS; attempt++) {
      const phase = attempt / AREA_MAX_ATTEMPTS;
      const attemptLabel = `Attempt ${attempt + 1}/${AREA_MAX_ATTEMPTS}`;
      post({ type: "status", message: `${attemptLabel} — Evaluating candidate sites… (0/${siteCap} placed, ${beforePct}% covered)` });
      const candidates = buildCandidates(phase, phase);
      const result = runGreedy(candidates, attemptLabel);
      if (!best || result.coveredCount > best.coveredCount || (result.coveredCount === best.coveredCount && result.chosen.length < best.chosen.length)) {
        best = result;
      }
      if (best.coveredCount === totalCount) break; // can't beat full coverage
    }

    const afterPct = Math.round((100 * best.coveredCount) / totalCount);
    post({
      type: "result",
      newSites: best.chosen.map((c) => ({ lat: c.lat, lon: c.lon })),
      beforePct,
      afterPct,
      polygon,
    });
  } catch (err) {
    post({ type: "error", message: err.message || String(err) });
  }
}
