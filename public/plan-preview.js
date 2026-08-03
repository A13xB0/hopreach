// The plan-mode coverage preview: the blue→purple overlay showing what a
// proposed repeater would cover.
//
// Two things live here that used to live in planner.js and planner-worker.js:
//
//   1. The quality choice. The preview used to hard-cap its search radius at
//      35km and its DEM zoom at 10, which made a proposed site's coverage
//      stop dead in a circle well short of where the real map's coverage for
//      an existing site carried on to ~78km. That looked like the planner
//      being pessimistic; it was just truncation. "Full" removes both caps,
//      so it searches exactly what the server's nightly raster searches.
//
//   2. A worker pool. Full range costs ~5x what the capped preview did, and
//      Go compiled to WebAssembly has no thread parallelism, so one worker
//      takes about half a minute. The raster is split into horizontal bands
//      (plan-preview-geometry.js) and several workers each take one, drawing
//      their band as soon as it lands so the coverage fills in progressively
//      instead of appearing all at once at the end.
//
// Bands come back through propagation.ComputeMarginsRows in WebAssembly —
// the same function the server's own map runs — rather than a JS loop
// re-deriving it, so the preview cannot drift from the real map's physics.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanPreview = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.PlanState;
  const G = window.PlanPreviewGeometry;

  const QUALITY_KEY = "hopreach.previewQuality";
  const DEBOUNCE_MS = 400;

  let cfg, layersControl, map, effectiveRealRepeaters, planSites, renderAllPlannedNeighbors, renderRepeaterList, syncCoverageToggles;

  // One pool for the whole session. Workers are expensive to start (each
  // loads and instantiates the WASM module), and a plan is edited many times
  // over, so they're kept alive between previews rather than respawned.
  let pool = [];
  // Everything about the preview currently being computed. Replaced wholesale
  // when a new one starts, so a late band from an old run has nowhere to land.
  let run = null;
  let debounceTimer = null;
  // Timings from the last completed preview — what the e2e tests assert on,
  // and the quickest way to see whether terrain or physics is the bottleneck.
  let lastRunStats = null;

  function currentQuality() {
    const saved = localStorage.getItem(QUALITY_KEY);
    return saved === "full" ? "full" : "fast";
  }

  // The search radius the preview is currently set to draw. plan-area.js
  // scores against this so the coverage percentage it reports and the overlay
  // the user then sees agree about how far a radio reaches.
  function previewRangeKm() {
    const q = G.qualityFor(currentQuality());
    return Math.min(Propagation.linkBudgetMaxRangeKm(cfg.propagation), q.maxRangeKm);
  }

  function statusEl() {
    return document.getElementById("plan-coverage-status");
  }

  function setStatus(text) {
    const el = statusEl();
    if (!el) return;
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function scheduleCoveragePreview() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runCoveragePreview, DEBOUNCE_MS);
  }

  function ensurePool(size) {
    while (pool.length < size) {
      const w = new Worker("planner-worker.js");
      w.onmessage = (e) => onBandMessage(e.data);
      pool.push(w);
    }
    return pool;
  }

  function clearOverlay() {
    if (!S.previewOverlay) return;
    layersControl.removeLayer(S.previewOverlay);
    map.removeLayer(S.previewOverlay);
    S.previewOverlay = null;
  }

  async function runCoveragePreview() {
    // Geometry is decided here on the main thread now, and deciding it needs
    // the link budget out of WebAssembly — so this can't start before the
    // module is up. A plan restored from localStorage at boot triggers a
    // preview immediately, well before that.
    await Propagation.ready;

    // Tag this request with a generation number and have the workers echo it
    // back. The debounce only spaces out when requests are *sent* — it
    // doesn't stop an old request (e.g. from before a repeater was deleted)
    // from still being mid-computation when a newer one starts. Without this
    // check a slow stale band can land after a faster new one and silently
    // overwrite it, which is exactly why deleting a repeater could appear to
    // leave its old coverage on the map.
    const generation = ++S.previewGeneration;

    const sites = planSites();
    if (sites.length === 0) {
      run = null;
      clearOverlay();
      setStatus(null);
      S.plannedNeighborsById = {};
      renderAllPlannedNeighbors();
      renderRepeaterList();
      syncCoverageToggles();
      return;
    }

    const geometry = G.previewGeometry({
      sites,
      linkBudgetKm: Propagation.linkBudgetMaxRangeKm(cfg.propagation),
      demZoom: cfg.demZoom,
      quality: currentQuality(),
    });

    const costs = G.rowCosts({ ...geometry, sites }, Propagation.haversineKm);
    const bands = planBands(geometry, sites, costs);

    run = {
      generation,
      geometry,
      bands,
      done: 0,
      timings: [],
      startedAt: performance.now(),
      margins: new Float32Array(geometry.imageWidth * geometry.imageHeight).fill(NaN),
      canvas: null,
    };

    setStatus(`Computing ${G.qualityFor(geometry.quality).label.toLowerCase()} preview…`);

    const workers = ensurePool(bands.length + 1);
    const config = { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation };

    bands.forEach((band, i) => {
      workers[i].postMessage({
        kind: "preview-band",
        generation, config, geometry, band,
        sites,
        gridBounds: G.bandGridBounds(geometry.bounds, geometry.imageHeight, band, sites),
      });
    });

    // Neighbour prediction is cheap but wants the whole terrain box, so it
    // gets its own worker rather than holding up a band.
    workers[bands.length].postMessage({
      kind: "preview-neighbors",
      generation, config, geometry, sites,
      realRepeaters: effectiveRealRepeaters(),
    });
  }

  // How many workers, and which rows each gets.
  //
  // These two decisions depend on each other: the pool has to be small enough
  // that the terrain grids fit in memory, but how much terrain a worker needs
  // depends on how many bands there are (a band covers the ground between the
  // sites and its own rows, so more bands means less each). Budgeting against
  // the whole raster instead is what you get if you don't resolve that, and it
  // costs real workers — it halved the pool on a 12-core machine.
  //
  // So: split optimistically on cores, measure the biggest band that produced,
  // and only shrink if that band's grid really is too big to run in parallel.
  function planBands(geometry, sites, costs) {
    const cores = navigator.hardwareConcurrency;
    const optimistic = G.poolSize({ cores, mosaicBytes: 0 });
    const bands = G.splitBands(geometry.imageHeight, optimistic, costs);

    const worstBandBytes = bands.reduce((worst, band) => Math.max(
      worst,
      G.mosaicBytes(G.bandGridBounds(geometry.bounds, geometry.imageHeight, band, sites), geometry.zoom)
    ), 0);

    const affordable = G.poolSize({ cores, mosaicBytes: worstBandBytes });
    if (affordable >= bands.length) return bands;
    return G.splitBands(geometry.imageHeight, affordable, costs);
  }

  function onBandMessage(msg) {
    if (msg.kind !== "preview") return;
    if (!run || msg.generation !== S.previewGeneration) return; // superseded — discard

    if (msg.type === "error") {
      setStatus(`Preview failed: ${msg.message}`);
      return;
    }

    if (msg.type === "neighbors") {
      S.plannedNeighborsById = msg.neighbors || {};
      renderAllPlannedNeighbors();
      renderRepeaterList();
      return;
    }

    if (msg.type !== "band") return;

    const band = new Float32Array(msg.margins);
    run.margins.set(band, msg.band.rowStart * run.geometry.imageWidth);
    run.done++;
    if (msg.timing) run.timings.push({ rows: msg.band.rowEnd - msg.band.rowStart, ...msg.timing });

    // Redraw with what's arrived so far. The overlay grows band by band
    // rather than sitting blank for the whole computation.
    drawOverlay(run);

    if (run.done >= run.bands.length) {
      setStatus(null);
      lastRunStats = {
        quality: run.geometry.quality,
        rangeKm: run.geometry.rangeKm,
        raster: [run.geometry.imageWidth, run.geometry.imageHeight],
        workers: run.bands.length,
        totalMs: Math.round(performance.now() - run.startedAt),
        bands: run.timings,
      };
    } else {
      setStatus(`Computing ${G.qualityFor(run.geometry.quality).label.toLowerCase()} preview… ${run.done}/${run.bands.length}`);
    }
  }

  // Blue -> purple, deliberately distinct from the real coverage map's
  // orange->green, so "existing" and "proposed" read as different things when
  // both are shown at once.
  const BLUE = [56, 189, 248];
  const PURPLE = [168, 85, 247];

  function drawOverlay(r) {
    const { imageWidth, imageHeight, bounds } = r.geometry;
    const marginGreenDb = cfg.propagation.marginGreenDb;

    if (!r.canvas) {
      r.canvas = document.createElement("canvas");
      r.canvas.width = imageWidth;
      r.canvas.height = imageHeight;
    }
    const ctx = r.canvas.getContext("2d");
    const imgData = ctx.createImageData(imageWidth, imageHeight);
    for (let i = 0; i < r.margins.length; i++) {
      const m = r.margins[i];
      const p = i * 4;
      if (Number.isNaN(m)) {
        imgData.data[p + 3] = 0;
        continue;
      }
      let t = m / marginGreenDb;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      imgData.data[p] = BLUE[0] + t * (PURPLE[0] - BLUE[0]);
      imgData.data[p + 1] = BLUE[1] + t * (PURPLE[1] - BLUE[1]);
      imgData.data[p + 2] = BLUE[2] + t * (PURPLE[2] - BLUE[2]);
      imgData.data[p + 3] = 190;
    }
    ctx.putImageData(imgData, 0, 0);

    // Whether the user had the overlay hidden must survive a redraw — a
    // partial band arriving is not a reason to turn it back on.
    const wasVisible = !S.previewOverlay || map.hasLayer(S.previewOverlay);
    clearOverlay();

    const llBounds = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
    S.previewOverlay = L.imageOverlay(r.canvas.toDataURL("image/png"), llBounds, { interactive: false });
    if (wasVisible) S.previewOverlay.addTo(map);
    layersControl.addOverlay(S.previewOverlay, "Planned coverage (preview)");
    syncCoverageToggles();
  }

  function bindDom() {
    const select = document.getElementById("plan-preview-quality");
    if (!select) return;
    select.value = currentQuality();
    updateQualityHint(select.value);
    select.addEventListener("change", () => {
      localStorage.setItem(QUALITY_KEY, select.value);
      updateQualityHint(select.value);
      runCoveragePreview();
    });
  }

  // The hint quotes a real distance, which means asking WebAssembly — and
  // init() runs while that module is still loading. Await it rather than
  // reading through an undefined bridge, which is the failure mode that
  // blanked the whole page once before.
  function updateQualityHint(quality) {
    const hint = document.getElementById("plan-preview-quality-hint");
    if (!hint) return;
    Propagation.ready.then(() => {
      const rangeKm = Math.round(Math.min(Propagation.linkBudgetMaxRangeKm(cfg.propagation), G.qualityFor(quality).maxRangeKm));
      hint.textContent = quality === "full"
        ? `Searches the full ${rangeKm} km link budget at the map's own terrain detail — matches the real coverage map, takes several seconds.`
        : `Capped at ${rangeKm} km on coarser terrain — quick, but stops short of what the real map shows.`;
    });
  }

  function init(context) {
    ({ cfg, layersControl, map, effectiveRealRepeaters, planSites, renderAllPlannedNeighbors, renderRepeaterList, syncCoverageToggles } = context);
    bindDom();
    return api;
  }

  const api = {
    init,
    currentQuality,
    lastRunStats: () => lastRunStats,
    previewRangeKm,
    runCoveragePreview,
    scheduleCoveragePreview,
  };
  return api;
});
