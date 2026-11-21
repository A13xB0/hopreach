// "Show only this repeater's coverage" from a repeater's popup.
//
// The map's coverage is one best-server raster of every repeater, so it can't
// be filtered to one. Instead the one repeater is computed in a short-lived
// planner worker (same WASM propagation as the server), at the point its
// marker is drawn, and painted with the server's ramp in a pane of its own.
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

  const S = { pubkey: null, name: "", worker: null, overlay: null, bar: null, marker: null, popupOpen: false };

  function buildBar(name) {
    const bar = L.DomUtil.create("div", "focus-bar", map.getContainer());
    L.DomEvent.disableClickPropagation(bar);
    const title = L.DomUtil.create("span", "focus-bar-title", bar);
    const strong = document.createElement("strong");
    strong.textContent = name;
    title.append("Estimated coverage: ", strong, " only");
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

  function cancelJob() {
    if (S.worker) S.worker.terminate();
    S.worker = null;
  }

  function clearOverlay() {
    if (S.overlay) map.removeLayer(S.overlay);
    S.overlay = null;
  }

  // One worker per job, ended as soon as it answers or is superseded: a
  // terminated worker stops computing, and no WASM copy outlives the result.
  function compute() {
    cancelJob();
    const ll = MC.repeaterLatLng(S.pubkey);
    if (!ll) return stop();
    const w = new Worker("planner-worker.js");
    S.worker = w;
    const fail = (message) => {
      if (S.worker !== w) return;
      cancelJob();
      setStatus(`Could not compute: ${message}`);
    };
    w.onerror = (e) => {
      e.preventDefault();
      fail(e.message || "the worker failed to load");
    };
    w.onmessageerror = () => fail("unreadable result");
    w.onmessage = (e) => {
      if (S.worker !== w) return;
      const msg = e.data;
      if (msg.type === "progress") setStatus(`Computing… ${Math.round((100 * msg.done) / msg.total)}%`);
      else if (msg.type === "status") setStatus(msg.message);
      else if (msg.type === "error") fail(msg.message);
      else if (msg.type === "result") {
        cancelJob();
        render(msg);
      }
    };
    setStatus("Loading terrain…");
    w.postMessage({
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
    map.getContainer().classList.remove("focus-active");
  }

  // Esc ends the view only when nothing else wants it: not while typing, not
  // under an open popup or simulator modal (each closes on its own Esc).
  function escapeIsOurs(e) {
    if (!S.pubkey || S.popupOpen) return false;
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
  // A new map mode moves the marker, so recompute from where it now is.
  document.addEventListener("change", (e) => {
    if (e.target.id === "position-mode-select" && S.pubkey) compute();
  });
  // Capture phase: Leaflet closes a popup on Esc before a bubbling listener
  // could see that one was open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && escapeIsOurs(e)) stop();
  }, true);
})();
