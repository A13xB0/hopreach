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

  // Just under the overlay pane, which also holds the repeater markers (SVG).
  map.createPane("focusCoverage").style.zIndex = 399;

  const S = { pubkey: null, name: "", ll: null, worker: null, busy: false, job: 0, overlay: null, bar: null, marker: null, popupOpen: false };

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
  }

  // Stops a job still running; an idle worker is kept, with its terrain cache,
  // for the next repeater.
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
    setStatus(`Could not compute: ${message}`);
  }

  function ensureWorker() {
    if (S.worker) return S.worker;
    const w = new Worker("planner-worker.js");
    w.onerror = (e) => {
      if (w !== S.worker) return;
      e.preventDefault();
      S.worker = null;
      fail(e.message || "the worker failed to load");
    };
    w.onmessageerror = () => w === S.worker && fail("unreadable result");
    w.onmessage = (e) => {
      const msg = e.data;
      if (w !== S.worker || msg.generation !== S.job) return;
      if (msg.type === "progress") setStatus(`Computing… ${Math.round((100 * msg.done) / msg.total)}%`);
      else if (msg.type === "status") setStatus(msg.message);
      else if (msg.type === "error") fail(msg.message);
      else if (msg.type === "result") {
        S.busy = false;
        render(msg);
      }
    };
    S.worker = w;
    return w;
  }

  // Computes the repeater at the point its marker is drawn now. Nothing to do
  // when that point hasn't moved and its result is showing or on its way.
  function compute() {
    const ll = MC.repeaterLatLng(S.pubkey);
    if (!ll) return stop();
    if (S.ll && S.ll.equals(ll) && (S.overlay || S.busy)) return;
    cancelJob();
    clearOverlay(); // never leave the old point's coverage up
    S.ll = ll;
    S.busy = true;
    setStatus("Loading terrain…");
    ensureWorker().postMessage({
      generation: ++S.job,
      sites: [{ id: S.pubkey, lat: ll.lat, lon: ll.lng, isReal: true, label: S.name }],
      realRepeaters: [],
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
      imageWidth: FOCUS_WIDTH,
      maxRangeKm: Infinity, // the full link budget, as the server map uses
    });
  }

  function render(msg) {
    clearOverlay();
    if (msg.empty) return setStatus("No coverage computed", true);
    const canvas = document.createElement("canvas");
    canvas.width = msg.imageWidth;
    canvas.height = msg.imageHeight;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(msg.imageWidth, msg.imageHeight);
    Ramp.paintMargins(img.data, new Float32Array(msg.margins), msg.marginGreenDb, 190, ...Ramp.SERVER_RAMP);
    ctx.putImageData(img, 0, 0);
    const b = msg.bounds;
    S.overlay = L.imageOverlay(canvas.toDataURL("image/png"), [[b.south, b.west], [b.north, b.east]], {
      interactive: false,
      pane: "focusCoverage",
    }).addTo(map);
    setStatus("computed in your browser, at preview detail", true);
  }

  function start(props) {
    if (S.bar) S.bar.remove();
    clearOverlay();
    S.pubkey = props.public_key;
    S.name = props.name || "Repeater";
    S.ll = null;
    map.closePopup();
    map.getContainer().classList.add("focus-active");
    S.bar = buildBar(S.name);
    compute();
  }

  function stop() {
    if (!S.pubkey) return;
    cancelJob();
    clearOverlay();
    if (S.bar) S.bar.remove();
    S.bar = null;
    S.pubkey = null;
    S.ll = null;
    map.getContainer().classList.remove("focus-active");
  }

  // Esc ends the view only when nothing else wants it: not while typing, not
  // while a popup Leaflet will close (the map has focus), not under an open
  // simulator modal.
  function escapeIsOurs(e) {
    if (!S.pubkey) return false;
    if (S.popupOpen && map.getContainer().contains(document.activeElement)) return false;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return false;
    const backdrop = document.getElementById("sim-modal-backdrop");
    return !(backdrop && !backdrop.classList.contains("hidden"));
  }

  map.on("popupopen", (e) => {
    S.popupOpen = true;
    S.marker = e.popup._source;
  });
  map.on("popupclose", () => {
    S.popupOpen = false;
  });
  map.on("simulatedeclutter", (e) => {
    if (e.on) stop();
  });
  map.getContainer().addEventListener("click", (e) => {
    if (!e.target.closest(".popup-focus")) return;
    const props = S.marker && S.marker.feature && S.marker.feature.properties;
    if (props && props.public_key) start(props);
  });
  // A new map mode may move the marker; compute() skips it if it didn't.
  document.addEventListener("change", (e) => {
    if (e.target.id === "position-mode-select" && S.pubkey) compute();
  });
  // Capture phase: Leaflet closes a popup on Esc before a bubbling listener
  // could see that one was open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && escapeIsOurs(e)) stop();
  }, true);
})();
