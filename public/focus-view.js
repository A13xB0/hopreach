// "Show only this repeater's coverage" from a repeater's popup.
//
// Hides the combined coverage layer, computes the one repeater in the
// planner's preview worker (see repeater-focus.js for why), and shows a bar
// saying whose coverage this is, with a way back. Esc also returns.
(function () {
  "use strict";

  const MC = window.MCCoverageMap;
  if (!MC) return;
  const { map } = MC;
  const cfg = window.HOPREACH_CONFIG;
  const FOCUS_WIDTH = 480;

  const S = { worker: null, generation: 0, overlay: null, bar: null, wasVisible: false, active: false, marker: null };

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function showBar(html) {
    if (!S.bar) {
      S.bar = L.DomUtil.create("div", "focus-bar", map.getContainer());
      L.DomEvent.disableClickPropagation(S.bar);
      S.bar.addEventListener("click", (e) => {
        if (e.target.closest(".focus-bar-close")) stop();
      });
    }
    S.bar.innerHTML = html;
  }

  function ensureWorker() {
    if (S.worker) return S.worker;
    S.worker = new Worker("planner-worker.js");
    S.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.generation !== S.generation || !S.active) return;
      if (msg.type === "progress") setStatus(`Computing… ${Math.round((100 * msg.done) / msg.total)}%`);
      else if (msg.type === "status") setStatus(msg.message);
      else if (msg.type === "error") setStatus(`Could not compute: ${msg.message}`);
      else if (msg.type === "result" && !msg.empty) render(msg);
    };
    return S.worker;
  }

  function setStatus(text) {
    const el = S.bar && S.bar.querySelector(".focus-bar-status");
    if (el) el.textContent = text;
  }

  function render(msg) {
    const canvas = document.createElement("canvas");
    canvas.width = msg.imageWidth;
    canvas.height = msg.imageHeight;
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(msg.imageWidth, msg.imageHeight);
    window.HopReachFocus.paintMargins(img.data, new Float32Array(msg.margins), msg.marginGreenDb, 190);
    ctx.putImageData(img, 0, 0);
    const b = msg.bounds;
    clearOverlay();
    S.overlay = L.imageOverlay(canvas.toDataURL("image/png"), [[b.south, b.west], [b.north, b.east]], { interactive: false }).addTo(map);
    setStatus("Estimate, computed in your browser");
    S.bar.classList.add("done");
  }

  function clearOverlay() {
    if (S.overlay) map.removeLayer(S.overlay);
    S.overlay = null;
  }

  function start(props, latlng) {
    if (!S.active) S.wasVisible = MC.isCoverageVisible();
    S.active = true;
    MC.setCoverageVisible(false);
    clearOverlay();
    map.closePopup();
    showBar(`<span class="focus-bar-title">Coverage: <strong>${escapeHtml(props.name || "Repeater")}</strong> only</span>` +
      `<span class="focus-bar-status">Loading terrain…</span>` +
      `<button type="button" class="focus-bar-close">Show all</button>`);
    S.bar.classList.remove("done");
    const site = window.HopReachFocus.focusSite(props, latlng.lat, latlng.lng, MC.usesCalibratedPositions(MC.getPositionMode()));
    ensureWorker().postMessage({
      generation: ++S.generation,
      sites: [site],
      realRepeaters: [],
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
      imageWidth: FOCUS_WIDTH,
      maxRangeKm: Infinity,
    });
  }

  function stop() {
    if (!S.active) return;
    S.active = false;
    S.generation++;
    clearOverlay();
    if (S.bar) S.bar.remove();
    S.bar = null;
    MC.setCoverageVisible(S.wasVisible);
  }

  map.on("popupopen", (e) => {
    S.marker = e.popup._source;
  });
  map.getContainer().addEventListener("click", (e) => {
    if (!e.target.closest(".popup-focus")) return;
    const m = S.marker;
    const props = m && m.feature && m.feature.properties;
    if (props) start(props, m.getLatLng());
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stop();
  });
})();
