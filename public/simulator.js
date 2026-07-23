// LoRa flood simulator UI — a separate top-level mode (its own toggle +
// right-side panel) alongside "Plan", not a planning sub-mode: simulating
// floods is a distinct activity (testing/tuning delay settings against a
// scenario) from placing/adjusting repeaters, even though it reuses a
// plan's repeaters as one of its node sources.
//
// Runs meshsim.Run/Suggest (see internal/meshsim, wasm/meshsim.go,
// meshsim-bridge.js) — the exact same Go code the engine/tune tests verify,
// compiled to WebAssembly — so predictions made here are trustworthy
// enough to suggest real device settings from, not a hand-rolled
// approximation.
(function () {
  const cfg = window.HOPREACH_CONFIG;
  const { map } = window.MCCoverageMap;

  const SIM_MAX_RANGE_KM = 35; // same rationale as planner.js's PREVIEW_MAX_RANGE_KM
  const SIM_ZOOM_CAP = 11;
  const CORESCOPE_REACH_DAYS = 7; // fixed window — simulator.js has no window-selector UI of its own (see planner.js's for the map's own hover tooltips)

  // Each entry: {id, source: 'planned'|'real', refId, label, lat, lon}.
  // Prefs aren't stored per-node in v1 — Suggest's rule search already
  // covers config tuning (see internal/meshsim/tune.go); manual per-node
  // override editing is a possible future addition, not required here.
  let simNodes = [];
  // {from: nodeIndex, to: nodeIndex, snrDb} — directed, built by
  // buildLinks() below, cleared whenever the node list changes so a stale
  // link referencing a removed/renumbered node can never linger.
  let simLinks = [];
  // {id, nodeIndex, sendAtMs, payloadLen}
  let simMessages = [];
  let lastReport = null;
  let linksGeneration = 0;

  const simNodesLayer = L.layerGroup().addTo(map);
  const simResultsLayer = L.layerGroup().addTo(map);

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // --- node loading -------------------------------------------------

  function nodeKey(source, refId) {
    return `${source}:${refId}`;
  }

  function loadPlannedRepeaters() {
    const planner = window.HopReachPlanner;
    if (!planner) return;
    const plan = planner.getActivePlan();
    if (!plan || plan.repeaters.length === 0) {
      setStatus("sim-status", "The active plan has no repeaters to load — add some in Plan mode first.");
      return;
    }
    const existing = new Set(simNodes.map((n) => nodeKey(n.source, n.refId)));
    let added = 0;
    for (const r of plan.repeaters) {
      const key = nodeKey("planned", r.id);
      if (existing.has(key)) continue;
      simNodes.push({ id: randomId(), source: "planned", refId: r.id, label: r.label, lat: r.lat, lon: r.lon });
      added++;
    }
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
    setStatus("sim-status", `Loaded ${added} planned repeater${added === 1 ? "" : "s"}${added < plan.repeaters.length ? " (some already loaded)" : ""}.`);
  }

  function loadRealRepeaters() {
    const planner = window.HopReachPlanner;
    if (!planner) return;
    const real = Object.values(planner.getRealRepeaters());
    if (real.length === 0) {
      setStatus("sim-status", "No real repeater data loaded yet.");
      return;
    }
    const existing = new Set(simNodes.map((n) => nodeKey(n.source, n.refId)));
    let added = 0;
    for (const r of real) {
      const key = nodeKey("real", r.id);
      if (existing.has(key)) continue;
      simNodes.push({ id: randomId(), source: "real", refId: r.id, label: r.label, lat: r.lat, lon: r.lon });
      added++;
    }
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
    setStatus("sim-status", `Loaded ${added} real repeater${added === 1 ? "" : "s"}${added < real.length ? " (some already loaded)" : ""}.`);
  }

  function removeNode(id) {
    simNodes = simNodes.filter((n) => n.id !== id);
    simMessages = simMessages.filter((m) => simNodes[m.nodeIndex] !== undefined);
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
  }

  function clearNodes() {
    simNodes = [];
    simMessages = [];
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
    hideResults();
  }

  function invalidateLinks() {
    simLinks = [];
    linksGeneration++;
    setStatus("sim-links-status", "Connectivity not built yet for the current node set — click \"Build links\".");
  }

  // --- rendering: node list, message list -----------------------------

  function renderNodeList() {
    const list = document.getElementById("sim-node-list");
    list.innerHTML = "";
    if (simNodes.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — load planned and/or real repeaters above.</div>';
      return;
    }
    for (const n of simNodes) {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      const badgeClass = n.source === "planned" ? "sim-badge-planned" : "sim-badge-real";
      row.innerHTML = `
        <span class="sim-node-badge ${badgeClass}">${n.source}</span>
        <span class="plan-item-label">${escapeHtml(n.label)}</span>
        <span class="plan-item-actions"><button data-act="remove" title="Remove">✕</button></span>
      `;
      row.querySelector('[data-act="remove"]').onclick = () => removeNode(n.id);
      list.appendChild(row);
    }
  }

  function renderMessageNodeOptions() {
    const sel = document.getElementById("sim-message-node");
    const prevValue = sel.value;
    sel.innerHTML = "";
    simNodes.forEach((n, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = n.label;
      sel.appendChild(opt);
    });
    if (prevValue && Number(prevValue) < simNodes.length) sel.value = prevValue;
  }

  function renderMessageList() {
    const list = document.getElementById("sim-message-list");
    list.innerHTML = "";
    if (simMessages.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — pick a sender above and add a send.</div>';
      return;
    }
    for (const m of simMessages) {
      const node = simNodes[m.nodeIndex];
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(node ? node.label : "?")}</span>
        <span class="plan-item-sub">sends at ${m.sendAtMs}ms · ${m.payloadLen}B</span>
        <span class="plan-item-actions"><button data-act="remove" title="Remove">✕</button></span>
      `;
      row.querySelector('[data-act="remove"]').onclick = () => {
        simMessages = simMessages.filter((x) => x.id !== m.id);
        renderMessageList();
      };
      list.appendChild(row);
    }
  }

  function addMessage() {
    const sel = document.getElementById("sim-message-node");
    if (sel.options.length === 0) {
      setStatus("sim-status", "Load at least one node before scheduling a send.");
      return;
    }
    const nodeIndex = Number(sel.value);
    const sendAtMs = Math.max(0, parseInt(document.getElementById("sim-message-time").value, 10) || 0);
    const payloadLen = Math.min(255, Math.max(1, parseInt(document.getElementById("sim-message-payload").value, 10) || 20));
    simMessages.push({ id: randomId(), nodeIndex, sendAtMs, payloadLen });
    renderMessageList();
  }

  // --- map markers -----------------------------------------------------

  function redrawNodeMarkers() {
    simNodesLayer.clearLayers();
    for (const n of simNodes) {
      L.marker([n.lat, n.lon], {
        icon: L.divIcon({ className: "sim-marker-icon", iconSize: [12, 12] }),
      })
        .bindTooltip(`${n.label} (${n.source})`)
        .addTo(simNodesLayer);
    }
  }

  function redrawResultLines(report) {
    simResultsLayer.clearLayers();
    if (!report) return;
    for (const r of report.receptions) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      if (!from || !to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.8 }
      ).addTo(simResultsLayer);
    }
  }

  // --- connectivity building --------------------------------------------

  function boundsForNodes(nodes) {
    let south = 90, north = -90, west = 180, east = -180;
    for (const n of nodes) {
      south = Math.min(south, n.lat);
      north = Math.max(north, n.lat);
      west = Math.min(west, n.lon);
      east = Math.max(east, n.lon);
    }
    // Pad by the max propagation range so pairs near the bbox edge still
    // get a terrain grid wide enough to cover the path between them.
    const padDeg = SIM_MAX_RANGE_KM / 111;
    return { south: south - padDeg, north: north + padDeg, west: west - padDeg, east: east + padDeg };
  }

  // Converts a propagation-model margin (dB above the receiver's
  // sensitivity spec) into an approximate SNR for meshsim's threshold
  // check. Not a physically rigorous SNR derivation — margin and SNR are
  // different quantities — but a reasonable, clearly-documented proxy:
  // margin==0 (right at the sensitivity floor) is mapped to exactly that
  // SF's own reception threshold (right at the edge of decodability), and
  // margin scales 1:1 in dB from there, since both quantities move
  // linearly with received power. Good for relative comparisons between
  // candidate settings; not a certified RF measurement.
  function approxSnrFromMargin(marginDb, sf) {
    const thresholds = [-7.5, -10, -12.5, -15, -17.5, -20]; // SF7..SF12, mirrors internal/meshsim/score.go
    const idx = Math.min(Math.max(sf - 7, 0), 5);
    return thresholds[idx] + marginDb;
  }

  async function buildLinksFromModel(nodes) {
    await Propagation.ready;
    const bounds = boundsForNodes(nodes);
    const grid = await Terrain.buildLocalGrid(cfg.demTileURLBase, Math.min(cfg.demZoom, SIM_ZOOM_CAP), bounds);
    const links = [];
    const sf = 11; // DefaultLoRaParams' SF — see internal/meshsim.DefaultLoRaParams
    for (let i = 0; i < nodes.length; i++) {
      const groundM = grid.at(nodes[i].lat, nodes[i].lon);
      const txHeightASL = groundM + cfg.propagation.antennaHeightM;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const d = Propagation.haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
        if (d > SIM_MAX_RANGE_KM) continue;
        const margin = Propagation.pathMargin(grid, cfg.propagation, nodes[i].lat, nodes[i].lon, txHeightASL, nodes[j].lat, nodes[j].lon, d);
        if (margin < 0) continue; // below the model's own reception threshold — not a link
        links.push({ from: i, to: j, snrDb: approxSnrFromMargin(margin, sf) });
      }
    }
    return links;
  }

  async function fetchCorescopeLinksFor(nodeIndex, nodes) {
    const n = nodes[nodeIndex];
    if (n.source !== "real") return [];
    const resp = await fetch(`/corescope-api/api/nodes/${encodeURIComponent(n.refId)}/reach?days=${CORESCOPE_REACH_DAYS}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const links = [];
    for (const l of data.links || []) {
      const targetIdx = nodes.findIndex((x) => x.source === "real" && x.refId === l.pubkey);
      if (targetIdx === -1 || typeof l.avg_snr !== "number") continue;
      links.push({ from: nodeIndex, to: targetIdx, snrDb: l.avg_snr });
      if (l.bidir) links.push({ from: targetIdx, to: nodeIndex, snrDb: l.avg_snr });
    }
    return links;
  }

  async function buildLinksFromCorescope(nodes) {
    const realIndices = nodes.map((n, i) => i).filter((i) => nodes[i].source === "real");
    const perNode = await Promise.all(realIndices.map((i) => fetchCorescopeLinksFor(i, nodes)));
    return perNode.flat();
  }

  async function buildLinks() {
    if (simNodes.length < 2) {
      setStatus("sim-links-status", "Load at least 2 nodes first.");
      return;
    }
    const generation = ++linksGeneration;
    const source = document.getElementById("sim-connectivity-source").value;
    setStatus("sim-links-status", "Building connectivity…");
    document.getElementById("sim-build-links").disabled = true;
    try {
      const nodesSnapshot = simNodes;
      let links;
      if (source === "model") {
        links = await buildLinksFromModel(nodesSnapshot);
      } else if (source === "corescope") {
        links = await buildLinksFromCorescope(nodesSnapshot);
      } else {
        // blend: observed where CoreScope has data, model fills every gap
        // (including any pair involving a planned repeater, which
        // CoreScope has no history for at all).
        const [modelLinks, observedLinks] = await Promise.all([buildLinksFromModel(nodesSnapshot), buildLinksFromCorescope(nodesSnapshot)]);
        const observedPairs = new Set(observedLinks.map((l) => `${l.from}:${l.to}`));
        links = observedLinks.concat(modelLinks.filter((l) => !observedPairs.has(`${l.from}:${l.to}`)));
      }
      if (generation !== linksGeneration) return; // node set changed mid-build; discard stale result
      simLinks = links;
      setStatus("sim-links-status", `${simLinks.length} directed link${simLinks.length === 1 ? "" : "s"} built (${source}).`);
    } catch (err) {
      if (generation !== linksGeneration) return;
      setStatus("sim-links-status", `Failed to build links: ${err.message || err}`);
    } finally {
      if (generation === linksGeneration) document.getElementById("sim-build-links").disabled = false;
    }
  }

  // --- run / predict -----------------------------------------------------

  function scenarioFromState() {
    return {
      nodes: simNodes.map(() => ({ prefs: defaultPrefs(), canRelay: true })),
      links: simLinks,
    };
  }

  function defaultPrefs() {
    // Mirrors internal/meshsim.DefaultNodePrefs — kept in sync manually
    // since this is plain JS, not generated from the Go struct.
    return {
      txDelayFactor: 0.5,
      directTxDelayFactor: 0.3,
      rxDelayBase: 0,
      txPowerDbm: 22,
      radio: { freqMhz: 869.525, bwKhz: 250, sf: 11, cr: 5, preambleSymbols: 8, explicitHeader: true, crcEnabled: true },
    };
  }

  function messagesFromState() {
    return simMessages.map((m) => ({ origin: m.nodeIndex, sendAtMs: m.sendAtMs, payloadLen: m.payloadLen }));
  }

  async function runSimulation() {
    if (simNodes.length === 0) {
      setStatus("sim-status", "Load some nodes first.");
      return;
    }
    if (simLinks.length === 0) {
      setStatus("sim-status", 'No connectivity built yet — click "Build links" first.');
      return;
    }
    if (simMessages.length === 0) {
      setStatus("sim-status", "Schedule at least one send first.");
      return;
    }
    await MeshSim.ready;
    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    setStatus("sim-status", "Running…");
    try {
      const report = MeshSim.run(scenarioFromState(), messagesFromState(), seed, maxSimTimeMs);
      lastReport = report;
      renderResults(report);
      redrawResultLines(report);
      setStatus("sim-status", "Done.");
    } catch (err) {
      setStatus("sim-status", `Simulation failed: ${err.message || err}`);
    }
  }

  function renderResults(report) {
    const section = document.getElementById("sim-results-section");
    section.classList.remove("hidden");
    const total = report.receptions.length;
    const collided = report.receptions.filter((r) => r.collided).length;
    const rate = total > 0 ? ((collided / total) * 100).toFixed(1) : "0.0";
    document.getElementById("sim-results-summary").textContent = `${total} reception${total === 1 ? "" : "s"}, ${collided} collided (${rate}%).`;

    const log = document.getElementById("sim-results-log");
    log.innerHTML = "";
    for (const r of report.receptions) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      const row = document.createElement("div");
      row.className = `plan-list-item sim-list-item ${r.collided ? "sim-collided" : "sim-clean"}`;
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">from ${escapeHtml(from ? from.label : "?")} at ${r.atMs}ms · hop ${r.hopCount}${r.collided ? " · COLLIDED" : r.wasRelayed ? " · relayed" : ""}</span>
      `;
      log.appendChild(row);
    }
  }

  function hideResults() {
    document.getElementById("sim-results-section").classList.add("hidden");
    document.getElementById("sim-suggestions-section").classList.add("hidden");
    lastReport = null;
    simResultsLayer.clearLayers();
  }

  async function predictSettings() {
    if (simNodes.length === 0) {
      setStatus("sim-status", "Load some nodes first.");
      return;
    }
    if (simLinks.length === 0) {
      setStatus("sim-status", 'No connectivity built yet — click "Build links" first.');
      return;
    }
    if (simMessages.length === 0) {
      setStatus("sim-status", "Schedule at least one send first.");
      return;
    }
    await MeshSim.ready;
    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    const trials = Math.min(100, Math.max(1, parseInt(document.getElementById("sim-trials").value, 10) || 20));
    setStatus("sim-status", "Searching for better settings — this runs many simulations, may take a few seconds…");
    try {
      const result = MeshSim.suggest({
        scenario: scenarioFromState(),
        messages: messagesFromState(),
        maxSimTimeMs,
        trials,
        seed,
      });
      renderSuggestions(result);
      setStatus("sim-status", "Done.");
    } catch (err) {
      setStatus("sim-status", `Predict settings failed: ${err.message || err}`);
    }
  }

  function renderSuggestions(result) {
    const section = document.getElementById("sim-suggestions-section");
    section.classList.remove("hidden");
    const list = document.getElementById("sim-suggestions-list");
    list.innerHTML = "";
    const top = result.suggestions.slice(0, 10);
    top.forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      const better = s.collisionRate < result.baseline;
      row.innerHTML = `
        <span class="sim-suggestion-rank">#${i + 1}</span>
        <span class="plan-item-label">${escapeHtml(s.rule.name)}</span>
        <span class="sim-suggestion-rate ${better ? "sim-rate-better" : ""}">${(s.collisionRate * 100).toFixed(1)}% collisions (baseline ${(result.baseline * 100).toFixed(1)}%)</span>
      `;
      list.appendChild(row);
    });
  }

  // --- status hints, panel open/close --------------------------------

  function setStatus(elId, text) {
    const el = document.getElementById(elId);
    el.textContent = text;
    el.classList.toggle("hidden", !text);
  }

  function setSimPanelOpen(open) {
    document.getElementById("sim-panel").classList.toggle("hidden", !open);
    document.getElementById("map-wrap").classList.toggle("sim-open", open);
    if (open) {
      if (window.HopReachPlanner) window.HopReachPlanner.closePanel();
      simNodesLayer.addTo(map);
      simResultsLayer.addTo(map);
    } else {
      map.removeLayer(simNodesLayer);
      map.removeLayer(simResultsLayer);
    }
    map.invalidateSize();
  }

  document.getElementById("sim-toggle").addEventListener("click", () => {
    setSimPanelOpen(document.getElementById("sim-panel").classList.contains("hidden"));
  });
  document.getElementById("sim-panel-close").addEventListener("click", () => setSimPanelOpen(false));
  // Clicking into Plan mode should always leave Simulate closed — see
  // HopReachPlanner.closePanel's own comment for why this is one-directional
  // rather than a shared toggle-coordinator module.
  document.getElementById("plan-toggle").addEventListener("click", () => setSimPanelOpen(false));

  document.getElementById("sim-load-planned").addEventListener("click", loadPlannedRepeaters);
  document.getElementById("sim-load-real").addEventListener("click", loadRealRepeaters);
  document.getElementById("sim-nodes-clear").addEventListener("click", clearNodes);
  document.getElementById("sim-build-links").addEventListener("click", buildLinks);
  document.getElementById("sim-message-add").addEventListener("click", addMessage);
  document.getElementById("sim-run").addEventListener("click", runSimulation);
  document.getElementById("sim-predict").addEventListener("click", predictSettings);

  renderNodeList();
  renderMessageList();

  // Test-only introspection hook.
  window.__hopreachSimulatorDebug = {
    getNodeCount: () => simNodes.length,
    getLinkCount: () => simLinks.length,
    getMessageCount: () => simMessages.length,
    getLastReport: () => lastReport,
  };
})();
