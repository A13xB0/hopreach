// "Show only this repeater's coverage" from a repeater's popup.
//
// The map's coverage is one best-server raster of every repeater, so it can't
// be filtered to one. Instead the one repeater is computed in its own planner
// worker (same WASM propagation as the server), at the point its marker is
// drawn, and painted with the server's ramp in a pane of its own.
// While it shows, a class on the map hides every other coverage image (main,
// region-scope, planner preview) without touching their layers, so nothing
// has to be put back afterwards. Show all or Esc returns.
(function () {
  "use strict";

  const MC = window.MCCoverageMap;
  if (!MC) return;
  const { map } = MC;
  const cfg = window.HOPREACH_CONFIG;
  const Ramp = window.HopReachRamp;
  const FOCUS_WIDTH = 480;
  const BANDS = 8; // see HopReachRamp.latitudeBands
  // The full link budget, as the server map uses, but never more than this:
  // with max_range_km unset the raw budget can reach hundreds of km.
  const FOCUS_MAX_RANGE_KM = 150;

  // Just under the overlay pane, which also holds the repeater markers (SVG).
  map.createPane("focusCoverage").style.zIndex = 399;

  const S = { pubkey: null, name: "", ll: null, worker: null, busy: false, failed: false, job: 0, overlay: null, bar: null, popupOpen: false };

  function buildBar(name) {
    const bar = L.DomUtil.create("div", "focus-bar", map.getContainer());
    L.DomEvent.disableClickPropagation(bar);
    const title = L.DomUtil.create("span", "focus-bar-title", bar);
    const strong = document.createElement("strong");
    strong.textContent = name;
    title.append("Preview estimate: ", strong, " only");
    L.DomUtil.create("span", "focus-bar-status", bar);
    const close = L.DomUtil.create("button", "focus-bar-close", bar);
    close.type = "button";
    close.textContent = "Show all";
    close.addEventListener("click", stop);
    return bar;
  }

  function setStatus(text, done) {
    if (!S.bar) return;
    S.bar.querySelector(".focus-bar-status").textContent = text;
    S.bar.classList.toggle("done", !!done);
    S.bar.classList.remove("ok"); // set by render() for a drawn result only
  }

  // Stops a job still running; while the view is open an idle worker is kept,
  // with its terrain cache, for the next repeater.
  function cancelJob() {
    if (S.worker && S.busy) {
      S.worker.terminate();
      S.worker = null;
    }
    S.busy = false;
  }

  function clearOverlay() {
    if (S.overlay) map.removeLayer(S.overlay);
    S.overlay = null;
  }

  function fail(message) {
    S.busy = false;
    S.failed = true;
    setStatus(`Could not compute: ${message}`);
  }

  function ensureWorker() {
    if (S.worker) return S.worker;
    const w = new Worker("planner-worker.js");
    w.onerror = (e) => {
      if (w !== S.worker) return;
      e.preventDefault();
      w.terminate();
      S.worker = null;
      fail(e.message || "the worker failed to load");
    };
    w.onmessageerror = () => {
      if (w !== S.worker || !S.busy) return;
      w.terminate();
      S.worker = null;
      fail("unreadable result");
    };
    w.onmessage = (e) => {
      const msg = e.data;
      if (w !== S.worker || msg.generation !== S.job) return;
      if (msg.type === "progress") setStatus(`Computing… ${Math.round((100 * msg.done) / msg.total)}%`);
      else if (msg.type === "status") setStatus(msg.message);
      else if (msg.type === "error") {
        // Its engine may never have loaded; the next job starts a fresh one.
        w.terminate();
        S.worker = null;
        fail(msg.message);
      }
      else if (msg.type === "result") {
        S.busy = false;
        render(msg);
      }
    };
    S.worker = w;
    return w;
  }

  // Computes the repeater at the point its marker is drawn now. Nothing to do
  // when that point hasn't moved and its result (or failure) is already in or
  // on its way: a redraw doesn't retry a failed run.
  function compute() {
    const ll = MC.repeaterLatLng(S.pubkey);
    if (!ll) return stop();
    if (S.ll && S.ll.equals(ll) && (S.overlay || S.busy || S.failed)) return;
    cancelJob();
    clearOverlay(); // never leave the old point's coverage up
    S.ll = ll;
    S.busy = true;
    S.failed = false;
    setStatus("Loading terrain…");
    ensureWorker().postMessage({
      generation: ++S.job,
      sites: [{ id: S.pubkey, lat: ll.lat, lon: ll.lng, isReal: true, label: S.name }],
      realRepeaters: [],
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
      imageWidth: FOCUS_WIDTH,
      maxRangeKm: FOCUS_MAX_RANGE_KM,
    });
  }

  function render(msg) {
    clearOverlay();
    const { imageWidth: w, imageHeight: h, bounds: b } = msg;
    const rgba = Ramp.paintMargins(new Uint8ClampedArray(w * h * 4), new Float32Array(msg.margins), msg.marginGreenDb, 190, ...Ramp.SERVER_RAMP);
    const img = new ImageData(rgba, w, h);
    const layers = Ramp.latitudeBands(h, b.north, b.south, BANDS).map((band) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = band.y1 - band.y0;
      canvas.getContext("2d").putImageData(img, 0, -band.y0, 0, band.y0, w, canvas.height);
      // Crisp like the server's tiles, which also keeps band edges from blending.
      return L.imageOverlay(canvas.toDataURL("image/png"), [[band.south, b.west], [band.north, b.east]], {
        interactive: false,
        pane: "focusCoverage",
        className: "focus-coverage",
      });
    });
    S.overlay = L.layerGroup(layers).addTo(map);
    // Say what makes the result partial rather than present it as complete:
    // failed tiles read as sea level, and a capped search stops short.
    const caveats = [];
    if (msg.failedTiles > 0) {
      caveats.push(`${msg.failedTiles} terrain tile(s) failed to load: parts may be wrong`);
      S.failed = true; // the button retries it
    }
    if (msg.rangeCappedKm) caveats.push(`only searched to ${Math.round(msg.rangeCappedKm)} km`);
    if (caveats.length) return setStatus(caveats.join("; "), true);
    setStatus("computed in your browser, at preview detail", true);
    S.bar.classList.add("ok");
  }


  function start(pubkey, name) {
    if (pubkey === S.pubkey && !S.failed) return map.closePopup(); // already showing (a failure retries)
    if (document.getElementById("map-wrap").classList.contains("sim-open")) return;
    if (S.bar) S.bar.remove();
    clearOverlay();
    S.pubkey = pubkey;
    S.name = name || "Repeater";
    S.ll = null;
    map.closePopup();
    map.getContainer().classList.add("focus-active");
    S.bar = buildBar(S.name);
    compute();
  }

  function stop() {
    if (!S.pubkey) return;
    if (S.worker) S.worker.terminate(); // nothing held once the view is gone
    S.worker = null;
    S.busy = false;
    clearOverlay();
    if (S.bar) S.bar.remove();
    S.bar = null;
    S.pubkey = null;
    S.ll = null;
    map.getContainer().classList.remove("focus-active");
  }

  // Esc ends the view only when nothing else wants it: not while typing, and
  // not while a popup Leaflet will close (the map has focus). Simulator modals
  // can't be open: Simulate ends the view.
  function escapeIsOurs(e) {
    if (!S.pubkey) return false;
    if (S.popupOpen && map.getContainer().contains(document.activeElement)) return false;
    return !(e.target.closest && e.target.closest("input, textarea, select, [contenteditable]"));
  }

  map.on("popupopen", () => {
    S.popupOpen = true;
  });
  map.on("popupclose", () => {
    S.popupOpen = false;
  });
  map.on("simulatedeclutter", (e) => {
    if (e.on) stop();
  });
  map.getContainer().addEventListener("click", (e) => {
    const button = e.target.closest(".popup-focus");
    if (button && button.dataset.pubkey) start(button.dataset.pubkey, button.dataset.name);
  });
  // Markers are redrawn on a Map detail change or a data reload, and may have
  // moved (or gone); compute() does nothing if the point is the same.
  map.on("repeatersrendered", () => {
    if (S.pubkey) compute();
  });
  // Capture phase: Leaflet closes a popup on Esc before a bubbling listener
  // could see that one was open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && escapeIsOurs(e)) stop();
  }, true);
})();
