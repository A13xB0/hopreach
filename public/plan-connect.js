// Connect repeaters: picking two endpoints and searching for the chain of new sites that would link them, with a route check on each option.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanConnect = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.PlanState;

  let CONNECT_MAX_NEW_KEY, MARGINAL_HOP_DB, cfg, connectLayer, effectiveRealRepeaters, ensureWorker, escapeHtml, randomId, redrawPlannedMarkers, renderRepeaterList, scheduleCoveragePreview;

  // --- connect repeaters (auto-router) ----------------------------------
  //
  // Pick two existing repeaters; the worker works out the minimum number
  // of *new* repeaters needed to bridge them, reusing any existing
  // repeater that already helps along the way (see planner-worker.js's
  // handleConnect for the algorithm). Runs in the same worker as the
  // coverage preview, tagged with its own generation counter so a stale
  // connect result can't clobber a newer one (or vice versa).

  function connectStatusEl() {
    return document.getElementById("plan-connect-status");
  }

  function setConnectStatus(text) {
    const el = connectStatusEl();
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.textContent = text;
    el.classList.remove("hidden");
  }

  function clearConnectSelection() {
    S.connectGeneration++; // discard any in-flight result
    S.connectPointA = null;
    S.connectPointB = null;
    S.connectOptions = [];
    S.connectSelectedIndex = null;
    connectLayer.clearLayers();
    setConnectStatus(null);
    renderConnectOptionList([]);
    renderRouteCheck(null);
    renderConnectList([]);
  }

  function selectConnectPoint(point) {
    if (!S.connectPointA) {
      S.connectPointA = point;
      connectLayer.clearLayers();
      L.circleMarker([point.lat, point.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
      setConnectStatus(`${point.label} selected — click a second repeater to connect it to.`);
      return;
    }
    if (point.id === S.connectPointA.id) return; // same repeater clicked again, ignore
    S.connectPointB = point;
    runConnectSearch();
  }

  function connectMaxNewInput() {
    return document.getElementById("plan-connect-max-new");
  }

  function runConnectSearch() {
    const generation = ++S.connectGeneration;
    S.connectOptions = [];
    S.connectSelectedIndex = null;
    setConnectStatus("Searching…");
    renderConnectOptionList([]);
    connectLayer.clearLayers();
    renderRouteCheck(null);
    L.circleMarker([S.connectPointA.lat, S.connectPointA.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
    L.circleMarker([S.connectPointB.lat, S.connectPointB.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);

    let maxNewSites = parseInt(connectMaxNewInput().value, 10);
    if (!Number.isFinite(maxNewSites) || maxNewSites < 1) maxNewSites = undefined;

    ensureWorker().postMessage({
      kind: "connect",
      generation,
      pointA: S.connectPointA,
      pointB: S.connectPointB,
      realRepeaters: effectiveRealRepeaters(),
      maxNewSites,
      config: { demTileURLBase: cfg.demTileURLBase, demZoom: cfg.demZoom, propagation: cfg.propagation },
    });
  }

  // The route's verdict from the flood simulator (planner-worker.js's
  // checkRoute). Two separate things worth saying, because they fail
  // independently: whether a packet actually gets end to end across
  // repeated trials, and which single hop is the weakest — a route can
  // deliver reliably today and still be worth knowing has one 1dB hop
  // holding it together.
  function renderRouteCheck(check) {
    const el = document.getElementById("plan-connect-check");
    if (!el) return;
    if (!check) {
      // Must keep the component class: there's no bare `.hidden` rule in
      // this stylesheet, only scoped ones, so `hidden` alone wouldn't hide
      // anything and stale verdict text would linger.
      el.className = "plan-route-check hidden";
      el.innerHTML = "";
      return;
    }
    if (check.error) {
      el.className = "plan-route-check warn";
      el.innerHTML = `<span class="plan-route-check-head">Route check unavailable</span><span class="plan-route-check-detail">${escapeHtml(check.error)}</span>`;
      return;
    }

    const { delivered, trials, hops, weakestHop } = check;
    const allDelivered = delivered === trials;
    const noneDelivered = delivered === 0;
    // A hop scraping past the 0 dB demodulation threshold counts as
    // "connected" by the search's own test and still isn't something to
    // rely on. Delivery is measured across the whole local mesh (the
    // surrounding real repeaters are in the scenario too, so an alternate
    // path can carry the packet), which means every trial can succeed while
    // this specific chain still hangs on one fragile hop — so it downgrades
    // the verdict rather than sitting as a green tick with a caveat.
    const marginal = !!weakestHop && weakestHop.marginDb < MARGINAL_HOP_DB;
    const tone = noneDelivered ? "bad" : allDelivered && !marginal ? "good" : "warn";

    let head;
    if (noneDelivered) head = `Simulated — did not get through in any of ${trials} trials`;
    else if (!allDelivered) head = `Simulated — got through in only ${delivered} of ${trials} trials`;
    else if (marginal) head = `Simulated — delivered in all ${trials} trials, but one hop is marginal`;
    else head = `Simulated OK — delivered in all ${trials} trials`;

    const parts = [`${hops} hop${hops === 1 ? "" : "s"}`];
    if (weakestHop) {
      parts.push(
        `weakest hop ${weakestHop.marginDb.toFixed(1)} dB (${escapeHtml(weakestHop.fromLabel)} → ${escapeHtml(weakestHop.toLabel)}, ${weakestHop.km.toFixed(1)} km)`
      );
    }
    if (marginal && !noneDelivered) {
      parts.push("that hop has very little headroom for fading");
    }

    el.className = `plan-route-check ${tone}`;
    el.innerHTML =
      `<span class="plan-route-check-head">${escapeHtml(head)}</span>` +
      `<span class="plan-route-check-detail">${parts.join(" · ")}</span>`;
  }

  function renderConnectList(chain) {
    const list = document.getElementById("plan-connect-list");
    list.innerHTML = "";
    if (!chain || chain.length === 0) {
      list.innerHTML = '<div class="plan-empty">Click two existing repeaters to connect them.</div>';
      return;
    }
    for (const point of chain) {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      const label = point.isNew ? "New relay" : point.label || "Repeater";
      row.innerHTML = `<span class="plan-item-label">${escapeHtml(label)}</span><span class="plan-item-sub">${point.isNew ? "to be added to your plan" : "existing"}</span>`;
      list.appendChild(row);
    }
  }

  // Draws a chain (endpoint markers + hop line) without touching the plan.
  function drawConnectChain(chain) {
    connectLayer.clearLayers();
    L.circleMarker([S.connectPointA.lat, S.connectPointA.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
    L.circleMarker([S.connectPointB.lat, S.connectPointB.lon], { radius: 6, color: "#38bdf8", weight: 2, fillOpacity: 1 }).addTo(connectLayer);
    for (let i = 0; i < chain.length; i++) {
      const point = chain[i];
      L.circleMarker([point.lat, point.lon], {
        radius: 6,
        color: point.isNew ? "#a855f7" : "#38bdf8",
        weight: 2,
        fillOpacity: 1,
      }).addTo(connectLayer);
      if (i > 0) {
        const prev = chain[i - 1];
        L.polyline([[prev.lat, prev.lon], [point.lat, point.lon]], { color: "#4ade80", weight: 3 }).addTo(connectLayer);
      }
    }
  }

  function renderConnectOptionList(options) {
    const container = document.getElementById("plan-connect-options");
    container.innerHTML = "";
    if (!options || options.length < 2) return; // nothing to choose between
    options.forEach((opt, i) => {
      const newCount = opt.newSites ? opt.newSites.length : 0;
      const row = document.createElement("div");
      row.className = "plan-list-item plan-connect-option" + (i === S.connectSelectedIndex ? " selected" : "");
      row.innerHTML =
        `<span class="plan-item-label">${newCount === 0 ? "Already connected" : `${newCount} new relay${newCount === 1 ? "" : "s"}`}</span>` +
        `<span class="plan-item-sub">option ${i + 1} of ${options.length}</span>` +
        `<span class="plan-item-actions"><button type="button">Use this path</button></span>`;
      row.addEventListener("mouseenter", () => previewConnectOption(i));
      row.addEventListener("click", () => previewConnectOption(i));
      row.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        applyConnectOption(i);
      });
      container.appendChild(row);
    });
  }

  function previewConnectOption(i) {
    const opt = S.connectOptions[i];
    if (!opt) return;
    S.connectSelectedIndex = i;
    drawConnectChain(opt.chain);
    renderConnectList(opt.chain);
    renderRouteCheck(opt.check);
    // Update the selected-row styling in place rather than rebuilding the
    // whole options list: this fires on every mouseenter, and rebuilding
    // destroys/recreates each row's own "Use this path" button — including
    // the one the mouse is currently moving toward — which made it
    // essentially unclickable (the button gets pulled out from under the
    // cursor before the click can land, and the browser drops a click
    // whose target was detached mid-gesture).
    const container = document.getElementById("plan-connect-options");
    container.querySelectorAll(".plan-connect-option").forEach((row, idx) => {
      row.classList.toggle("selected", idx === i);
    });
  }

  // Commits a chosen route: new relay sites become ordinary planned
  // repeaters — draggable, renameable, deletable, and they feed the
  // existing coverage preview exactly like anything added via "+ Add
  // repeater".
  function applyConnectOption(i) {
    const opt = S.connectOptions[i];
    if (!opt) return;
    if (opt.newSites && opt.newSites.length > 0) {
      const startCount = S.plan.repeaters.length;
      opt.newSites.forEach((site, idx) => {
        S.plan.repeaters.push({ id: randomId(), label: `Relay ${startCount + idx + 1}`, lat: site.lat, lon: site.lon, antennaHeightM: null });
      });
      renderRepeaterList();
      redrawPlannedMarkers();
      scheduleCoveragePreview();
    }
    drawConnectChain(opt.chain);
    renderConnectList(opt.chain);
    renderRouteCheck(opt.check);

    const newCount = opt.newSites ? opt.newSites.length : 0;
    setConnectStatus(
      newCount === 0
        ? "Already connected via existing repeaters — no new relays needed."
        : `${newCount} new relay${newCount === 1 ? "" : "s"} added to your plan.`
    );
    S.connectOptions = [];
    S.connectSelectedIndex = null;
    renderConnectOptionList([]); // path is committed — hide the picker
  }

  function renderConnectOptions(options) {
    S.connectOptions = options || [];
    S.connectSelectedIndex = 0;

    if (S.connectOptions.length === 0) {
      renderConnectOptionList([]);
      return;
    }

    // Only one route was found (or found to already exist) — nothing to
    // choose between, so apply it straight away.
    if (S.connectOptions.length === 1) {
      applyConnectOption(0);
      return;
    }

    drawConnectChain(S.connectOptions[0].chain);
    renderConnectList(S.connectOptions[0].chain);
    renderRouteCheck(S.connectOptions[0].check);
    renderConnectOptionList(S.connectOptions);
    setConnectStatus(`${S.connectOptions.length} path options found — pick one to add to your plan.`);
  }




  // Deferred to init(): these run against things the context supplies, so at
  // module-load time there is nothing yet to bind to.
  function bindDom() {
    document.getElementById("plan-connect-clear").addEventListener("click", clearConnectSelection);

    (function initConnectMaxNewInput() {
      const input = connectMaxNewInput();
      const saved = parseInt(localStorage.getItem(CONNECT_MAX_NEW_KEY), 10);
      if (Number.isFinite(saved) && saved >= 1 && saved <= 20) input.value = saved;
      input.addEventListener("change", () => {
        let v = parseInt(input.value, 10);
        if (!Number.isFinite(v) || v < 1) v = 1;
        if (v > 20) v = 20;
        input.value = v;
        localStorage.setItem(CONNECT_MAX_NEW_KEY, String(v));
        if (S.connectPointA && S.connectPointB) runConnectSearch();
      });
    })();
  }

  function init(context) {
    ({ CONNECT_MAX_NEW_KEY, MARGINAL_HOP_DB, cfg, connectLayer, effectiveRealRepeaters, ensureWorker, escapeHtml, randomId, redrawPlannedMarkers, renderRepeaterList, scheduleCoveragePreview } = context);
    bindDom();
    return api;
  }

  const api = {
    init,
    clearConnectSelection,
    renderConnectOptionList,
    renderConnectOptions,
    selectConnectPoint,
    setConnectStatus,
  };
  return api;
});
