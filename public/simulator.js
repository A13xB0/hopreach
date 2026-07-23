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
  const SF_THRESHOLDS_DB = [-7.5, -10, -12.5, -15, -17.5, -20]; // SF7..SF12, mirrors internal/meshsim/score.go

  // Each entry: {id, source: 'planned'|'real'|'companion', refId, label, lat, lon}.
  // Only 'companion' nodes are user-renameable/movable-by-nature — a
  // planned/real repeater's identity comes from its source of truth (the
  // active plan / the live map), not this tool. Prefs aren't stored
  // per-node in v1 — Suggest's rule search already covers config tuning
  // (see internal/meshsim/tune.go); manual per-node override editing is a
  // possible future addition, not required here.
  let simNodes = [];
  // {from: nodeIndex, to: nodeIndex, snrDb} — directed, built by
  // buildLinks() below, cleared whenever the node list changes so a stale
  // link referencing a removed/renumbered node can never linger.
  let simLinks = [];
  // {id, nodeIndex, sendAtMs, payloadLen}
  let simMessages = [];
  let lastReport = null;
  let linksGeneration = 0;
  // Terrain grid from the last "model"/"blend" link build, reused so
  // predictSettings() can look up each node's altitude without a second
  // DEM fetch — cleared in invalidateLinks() since moving a node (or
  // changing the node set) invalidates it exactly the same way it
  // invalidates links.
  let cachedGrid = null;

  // "off" | "companion" — click-to-place mode for a virtual companion
  // radio, scoped to this panel only (reset to "off" whenever the panel
  // closes) — see setSimPanelOpen and the map click handler below. Named
  // distinctly from Plan mode's own, unrelated "📍 Companion pin" feature
  // (a neighbour-preview tool over real repeater data, not a simulation
  // node).
  let placementMode = "off";

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

  function canRelay(node) {
    return node.source !== "companion"; // a handheld companion originates/receives traffic but doesn't relay, same as real MeshCore companion apps
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

  function addCompanionAt(lat, lon) {
    const n = simNodes.filter((x) => x.source === "companion").length + 1;
    simNodes.push({ id: randomId(), source: "companion", refId: randomId(), label: `Companion ${n}`, lat, lon });
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
  }

  function setPlacementMode(next) {
    placementMode = placementMode === next ? "off" : next;
    document.getElementById("sim-add-companion").classList.toggle("active", placementMode === "companion");
    document.getElementById("sim-companion-hint").classList.toggle("hidden", placementMode !== "companion");
  }

  map.on("click", (e) => {
    if (placementMode === "companion") {
      addCompanionAt(e.latlng.lat, e.latlng.lng);
    }
  });

  function renameNode(id) {
    const n = simNodes.find((x) => x.id === id);
    if (!n) return;
    const name = prompt("Label:", n.label);
    if (name) {
      n.label = name;
      renderNodeList();
      renderMessageNodeOptions();
      redrawNodeMarkers();
    }
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
    cachedGrid = null;
    linksGeneration++;
    setStatus("sim-links-status", "Connectivity not built yet for the current node set — click \"Build links\".");
  }

  // --- rendering: node list, message list -----------------------------

  const SOURCE_BADGE = { planned: "sim-badge-planned", real: "sim-badge-real", companion: "sim-badge-companion" };

  function renderNodeList() {
    const list = document.getElementById("sim-node-list");
    list.innerHTML = "";
    if (simNodes.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — load repeaters or place a companion location below.</div>';
      return;
    }
    for (const n of simNodes) {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="sim-node-badge ${SOURCE_BADGE[n.source]}">${n.source}</span>
        <span class="plan-item-label">${escapeHtml(n.label)}</span>
        <span class="plan-item-actions">
          ${n.source === "companion" ? '<button data-act="rename" title="Rename">✎</button>' : ""}
          <button data-act="remove" title="Remove">✕</button>
        </span>
      `;
      if (n.source === "companion") row.querySelector('[data-act="rename"]').onclick = () => renameNode(n.id);
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
      const iconClass = n.source === "companion" ? "sim-marker-companion" : "sim-marker-icon";
      L.marker([n.lat, n.lon], {
        icon: L.divIcon({ className: iconClass, iconSize: [12, 12] }),
        draggable: n.source === "companion",
      })
        .addTo(simNodesLayer)
        .bindTooltip(`${n.label} (${n.source})`)
        .on("dragend", (e) => {
          const ll = e.target.getLatLng();
          n.lat = ll.lat;
          n.lon = ll.lng;
          invalidateLinks();
        });
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

  // Only nodes with at least one OTHER node within propagation range can
  // ever get a model-derived link at all (buildLinksFromModel already
  // skips any pair beyond SIM_MAX_RANGE_KM) — so a node with no in-range
  // neighbour contributes nothing but wasted bounding-box area. This
  // matters because the loaded node set isn't always geographically
  // compact: a packet replayed from CoreScope (see replayFromHash) can
  // pull in nodes from genuinely distant clusters — one real observed
  // packet's path spanned Scotland to Ireland, a real link far past this
  // tool's own SIM_MAX_RANGE_KM planning default (not a bug in the real
  // network — evidently a genuinely long, well-sited RF link — just one
  // our model doesn't attempt to predict). Fetching one terrain grid
  // covering that whole gap would mean requesting on the order of a
  // thousand DEM tiles at once, enough to genuinely exhaust the browser's
  // own connection resources (observed directly during testing, not a
  // hypothetical).
  function nodesWithInRangeNeighbor(nodes) {
    const keep = new Set();
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (Propagation.haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon) <= SIM_MAX_RANGE_KM) {
          keep.add(i);
          keep.add(j);
        }
      }
    }
    return nodes.filter((_, i) => keep.has(i));
  }

  function estimateTileCount(bounds, zoom) {
    const minTileX = Math.floor(Terrain.lonToTileX(bounds.west, zoom));
    const maxTileX = Math.floor(Terrain.lonToTileX(bounds.east, zoom));
    const minTileY = Math.floor(Terrain.latToTileY(bounds.north, zoom));
    const maxTileY = Math.floor(Terrain.latToTileY(bounds.south, zoom));
    return (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  }

  const MAX_GRID_TILES = 400; // keeps one grid fetch well within the browser's concurrent-request budget, even for a legitimately long, densely-spaced chain

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
    const idx = Math.min(Math.max(sf - 7, 0), 5);
    return SF_THRESHOLDS_DB[idx] + marginDb;
  }

  // CoreScope's reach API doesn't expose a raw SNR reading at all — only
  // real observation counts (we_hear/they_hear: how many times this
  // link's traffic was actually seen in each direction). This converts
  // "how many times we've actually seen it work" into the same SNR-shaped
  // number the engine's threshold check understands, rather than
  // borrowing the propagation model's own prediction — real traffic having
  // happened at all already accounts for everything the terrain model
  // can't see (foliage, buildings, antenna orientation, interference), so
  // it's arguably more trustworthy than a model guess for these specific
  // pairs. More observations -> a higher, safer estimate, capped so a
  // very high count doesn't produce an absurd value; even a single
  // observation clears every SF's threshold, since it genuinely happened.
  function snrFromObservationCount(count, sf) {
    const idx = Math.min(Math.max(sf - 7, 0), 5);
    const threshold = SF_THRESHOLDS_DB[idx];
    if (count <= 0) return threshold - 10;
    return threshold + Math.min(15, Math.log2(1 + count) * 3);
  }

  // ensureGrid returns the cached terrain grid if one's already been built
  // for the current node set, or fetches one fresh — used both by
  // buildLinksFromModel and, independently, by predictSettings() for
  // altitude lookups even when the last link build used pure "corescope"
  // connectivity (which never touches terrain at all).
  async function ensureGrid(nodes) {
    if (cachedGrid) return cachedGrid;
    await Propagation.ready;
    const clustered = nodesWithInRangeNeighbor(nodes);
    if (clustered.length < 2) {
      throw new Error("no two nodes are within propagation range of each other — nothing to fetch terrain for");
    }
    const bounds = boundsForNodes(clustered);
    // Even after clustering, a legitimately long, densely-spaced chain
    // could still need a big grid — fall back to a coarser zoom rather
    // than fetching an unbounded number of tiles, down to a floor past
    // which the terrain data would be too coarse to be useful anyway.
    let zoom = Math.min(cfg.demZoom, SIM_ZOOM_CAP);
    while (zoom > 4 && estimateTileCount(bounds, zoom) > MAX_GRID_TILES) zoom--;
    if (estimateTileCount(bounds, zoom) > MAX_GRID_TILES) {
      throw new Error(`the involved area is too large to fetch terrain for (${estimateTileCount(bounds, zoom)} tiles even at the coarsest usable zoom)`);
    }
    cachedGrid = await Terrain.buildLocalGrid(cfg.demTileURLBase, zoom, bounds);
    return cachedGrid;
  }

  async function buildLinksFromModel(nodes) {
    const grid = await ensureGrid(nodes);
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

  // Fetches nodeIndex's real observed reach data and returns the confirmed
  // directed links it implies. we_hear > 0 means this node has actually
  // heard the neighbour (neighbour -> this node); they_hear > 0 means the
  // neighbour has actually heard this node (this node -> neighbour) — two
  // independent, potentially asymmetric real observations, not a single
  // "bidir" flag.
  async function fetchCorescopeLinksFor(nodeIndex, nodes) {
    const n = nodes[nodeIndex];
    if (n.source !== "real") return [];
    const resp = await fetch(`/corescope-api/api/nodes/${encodeURIComponent(n.refId)}/reach?days=${CORESCOPE_REACH_DAYS}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const sf = 11;
    const links = [];
    for (const l of data.links || []) {
      const targetIdx = nodes.findIndex((x) => x.source === "real" && x.refId === l.pubkey);
      if (targetIdx === -1) continue;
      if (typeof l.we_hear === "number" && l.we_hear > 0) {
        links.push({ from: targetIdx, to: nodeIndex, snrDb: snrFromObservationCount(l.we_hear, sf) });
      }
      if (typeof l.they_hear === "number" && l.they_hear > 0) {
        links.push({ from: nodeIndex, to: targetIdx, snrDb: snrFromObservationCount(l.they_hear, sf) });
      }
    }
    return links;
  }

  async function buildLinksFromCorescope(nodes) {
    const realIndices = nodes.map((n, i) => i).filter((i) => nodes[i].source === "real");
    const perNode = await Promise.all(realIndices.map((i) => fetchCorescopeLinksFor(i, nodes)));
    return perNode.flat();
  }

  function isolatedNodeHint(nodes, links) {
    const connected = new Set();
    for (const l of links) {
      connected.add(l.from);
      connected.add(l.to);
    }
    const isolated = nodes.map((n, i) => (connected.has(i) ? null : n.label)).filter(Boolean);
    if (isolated.length === 0) return "";
    return ` ${isolated.length} node${isolated.length === 1 ? "" : "s"} with no links: ${isolated.join(", ")}.`;
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
        // blend: observed where CoreScope has real data, model fills every
        // gap (including any pair involving a planned repeater or
        // companion location, which CoreScope has no history for at all).
        const [modelLinks, observedLinks] = await Promise.all([buildLinksFromModel(nodesSnapshot), buildLinksFromCorescope(nodesSnapshot)]);
        const observedPairs = new Set(observedLinks.map((l) => `${l.from}:${l.to}`));
        links = observedLinks.concat(modelLinks.filter((l) => !observedPairs.has(`${l.from}:${l.to}`)));
      }
      if (generation !== linksGeneration) return; // node set changed mid-build; discard stale result
      simLinks = links;
      setStatus(
        "sim-links-status",
        `${simLinks.length} directed link${simLinks.length === 1 ? "" : "s"} built (${source}).${isolatedNodeHint(nodesSnapshot, simLinks)}`
      );
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
      nodes: simNodes.map((n) => ({ prefs: defaultPrefs(), canRelay: canRelay(n) })),
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
      startReplay();
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
    document.getElementById("sim-per-node-section").classList.add("hidden");
    document.getElementById("sim-bottleneck-section").classList.add("hidden");
    lastReport = null;
    stopReplay();
    simResultsLayer.clearLayers();
  }

  // --- animated flood replay ---------------------------------------------
  //
  // Receptions sharing the same (fromNode, packetId, atMs) are exactly the
  // set of listeners a single over-the-air transmission reached — the
  // engine schedules every listener's eventRxComplete at the identical
  // instant (send time + airtime), see engine.go's eventSend handling — so
  // grouping on that triple recovers each individual transmission
  // ("wave") without needing the backend to expose send times or airtime
  // directly. Waves are played back in order with a expanding/fading
  // pulse at the sender and lines drawn to each listener as it arrives,
  // instead of dumping the whole result on the map at once — this is what
  // actually answers "watch the flood happen," not just "here's the
  // final tally."

  let replayWaves = [];
  let replayIndex = 0;
  let replayTimer = null;

  function buildWaves(report) {
    const groups = new Map();
    for (const r of report.receptions) {
      const key = `${r.fromNode}:${r.packetId}:${r.atMs}`;
      let g = groups.get(key);
      if (!g) {
        g = { fromNode: r.fromNode, atMs: r.atMs, receptions: [] };
        groups.set(key, g);
      }
      g.receptions.push(r);
    }
    return Array.from(groups.values()).sort((a, b) => a.atMs - b.atMs);
  }

  // pulseAt draws an expanding, fading ring at latlng — a fixed-pixel
  // radius (circleMarker, not circle) so the effect reads the same at any
  // zoom level, like a radar sweep rather than a geographically-scaled
  // wavefront.
  function pulseAt(latlng, color) {
    const circle = L.circleMarker(latlng, {
      radius: 6,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.45,
      opacity: 0.9,
    }).addTo(simResultsLayer);
    const durationMs = 700;
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / durationMs);
      circle.setRadius(6 + t * 34);
      circle.setStyle({ opacity: 0.9 * (1 - t), fillOpacity: 0.45 * (1 - t) });
      if (t < 1) requestAnimationFrame(tick);
      else simResultsLayer.removeLayer(circle);
    }
    requestAnimationFrame(tick);
  }

  function playWave(wave) {
    const from = simNodes[wave.fromNode];
    if (from) pulseAt([from.lat, from.lon], "#a855f7");
    for (const r of wave.receptions) {
      const to = simNodes[r.node];
      if (!from || !to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
      ).addTo(simResultsLayer);
      if (r.collided) pulseAt([to.lat, to.lon], "#f87171");
    }
  }

  function stopReplay() {
    if (replayTimer) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  }

  function replayStep() {
    if (replayIndex >= replayWaves.length) {
      replayTimer = null;
      setStatus("sim-replay-status", replayWaves.length ? "Replay finished — showing final state." : "");
      return;
    }
    const wave = replayWaves[replayIndex];
    playWave(wave);
    setStatus("sim-replay-status", `Playing… t=${wave.atMs}ms (${replayIndex + 1}/${replayWaves.length})`);
    const next = replayWaves[replayIndex + 1];
    const deltaMs = next ? next.atMs - wave.atMs : 0;
    // Clamp so a long gap between sends doesn't stall playback for real
    // minutes, and a burst of near-simultaneous waves doesn't flash by too
    // fast to actually watch.
    const waitMs = Math.min(1200, Math.max(150, deltaMs));
    replayIndex++;
    replayTimer = setTimeout(replayStep, waitMs);
  }

  function startReplay() {
    stopReplay();
    simResultsLayer.clearLayers();
    replayWaves = lastReport ? buildWaves(lastReport) : [];
    replayIndex = 0;
    replayStep();
  }

  function skipToEnd() {
    stopReplay();
    redrawResultLines(lastReport);
    replayIndex = replayWaves.length;
    setStatus("sim-replay-status", replayWaves.length ? "Showing final state." : "");
  }

  // Per-node real-world attributes (altitude, neighbour count) the rule
  // search can key conditional overrides on — see internal/meshsim/
  // rules.go's NodeAttrs. Altitude comes from the same terrain grid link-
  // building already fetches (or a fresh one if the last build was pure
  // "corescope", which never touches terrain); neighbour count is derived
  // straight from the currently-built links, in either direction.
  function attrsFromState(nodes, grid) {
    const neighbors = nodes.map(() => new Set());
    for (const l of simLinks) {
      if (neighbors[l.from]) neighbors[l.from].add(l.to);
      if (neighbors[l.to]) neighbors[l.to].add(l.from);
    }
    return nodes.map((n, i) => ({
      altitudeM: grid ? grid.at(n.lat, n.lon) : 0,
      neighborCount: neighbors[i].size,
    }));
  }

  // Mirrors internal/meshsim/rules.go's RuleCondition.matches — kept in
  // sync manually, same as defaultPrefs() mirroring DefaultNodePrefs.
  function ruleMatchesAttrs(rule, attrs) {
    const c = rule.condition;
    switch (c.kind) {
      case "":
        return true;
      case "altitude_at_least_m":
        return attrs.altitudeM >= c.threshold;
      case "altitude_at_most_m":
        return attrs.altitudeM <= c.threshold;
      case "neighbors_at_least":
        return attrs.neighborCount >= c.threshold;
      default:
        return false;
    }
  }

  // Mirrors internal/meshsim/rules.go's ConfigRule.Apply.
  function applyRule(basePrefs, rule) {
    const out = { ...basePrefs };
    if (rule.txDelayFactor != null) out.txDelayFactor = rule.txDelayFactor;
    if (rule.directTxDelayFactor != null) out.directTxDelayFactor = rule.directTxDelayFactor;
    if (rule.rxDelayBase != null) out.rxDelayBase = rule.rxDelayBase;
    return out;
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
      // Altitude is a nice-to-have for the search (unlocks altitude-
      // conditional rules), not a hard requirement — a failed terrain
      // fetch shouldn't block prediction, just fall back to neighbour-
      // count-only/global rules (attrsFromState tolerates a null grid).
      const grid = await ensureGrid(simNodes).catch(() => null);
      const attrs = attrsFromState(simNodes, grid);
      const result = MeshSim.suggest({
        scenario: scenarioFromState(),
        messages: messagesFromState(),
        attrs,
        maxSimTimeMs,
        trials,
        seed,
      });
      renderSuggestions(result);
      renderPerNodePredictions(result, attrs);
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

  // Turns the single best-ranked rule into a concrete "this repeater:
  // these values" list — the ranked rule descriptions above answer "what
  // strategy works best," this answers "so what do I actually set on each
  // device." A node whose attrs don't match the best rule's condition
  // keeps the baseline defaults rather than searching further down the
  // ranked list for a node-specific alternative: each rule was validated
  // as a uniform whole-scenario override, not in combination with others,
  // so mixing rules per node isn't something the search actually verified.
  function renderPerNodePredictions(result, attrsList) {
    const section = document.getElementById("sim-per-node-section");
    const list = document.getElementById("sim-per-node-list");
    list.innerHTML = "";
    if (!result.suggestions.length) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    const best = result.suggestions[0];
    simNodes.forEach((n, i) => {
      const matches = ruleMatchesAttrs(best.rule, attrsList[i]);
      const prefs = matches ? applyRule(defaultPrefs(), best.rule) : defaultPrefs();
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(n.label)}</span>
        <span class="plan-item-sub">txdelay ${prefs.txDelayFactor.toFixed(2)} · rxdelay ${prefs.rxDelayBase.toFixed(1)}${matches ? "" : " (baseline — best rule doesn't apply here)"}</span>
      `;
      list.appendChild(row);
    });
  }

  // --- CoreScope real packet replay & bottleneck analysis ----------------
  //
  // CoreScope's own /api/packets/{hash} already resolves every observation's
  // relay path to full public keys (resolved_path) — no prefix-matching
  // needed on our side. Every consecutive pair in that chain, plus the
  // final hop into whichever CoreScope observer captured it, is a "proven"
  // edge: real evidence that specific transmission actually happened,
  // aggregated across every observation of the hash (a flood is commonly
  // heard via multiple paths/observers). Running our own engine from the
  // same origin over the same connectivity gives a "predicted" flood; a
  // predicted relay with no corresponding proven edge is exactly what the
  // user asked for — a candidate collision/bottleneck location a real
  // packet's own observed data can't reveal on its own (CoreScope only
  // ever tells you who *did* hear it, never why someone who should have
  // didn't).

  let nodeDirectoryCache = null; // lowercase pubkey -> {name, lat, lon, role}

  async function ensureNodeDirectory() {
    if (nodeDirectoryCache) return nodeDirectoryCache;
    const resp = await fetch("/corescope-api/api/nodes?limit=5000");
    if (!resp.ok) throw new Error(`CoreScope node directory fetch failed: HTTP ${resp.status}`);
    const data = await resp.json();
    nodeDirectoryCache = new Map();
    for (const n of data.nodes || []) {
      if (n.lat == null || n.lon == null || !n.public_key) continue; // can't place a node with no known position
      nodeDirectoryCache.set(n.public_key.toLowerCase(), { name: n.name || n.public_key.slice(0, 8), lat: n.lat, lon: n.lon, role: n.role });
    }
    return nodeDirectoryCache;
  }

  // Accepts either a bare hash or a pasted CoreScope link containing one —
  // packet hashes are consistently 16 hex characters in every real example
  // observed (see internal/meshsim's own port of MeshCore's formulas for
  // the broader packet-ID convention), so a straightforward regex over the
  // whole input handles both without needing to know CoreScope's exact URL
  // shape.
  function extractPacketHash(input) {
    const m = String(input).trim().match(/[0-9a-f]{16}/i);
    return m ? m[0].toLowerCase() : null;
  }

  function addProvenEdge(edges, from, to, tMs) {
    if (from === to) return;
    const key = `${from}:${to}`;
    const existing = edges.get(key);
    if (!existing || tMs < existing.firstMs) edges.set(key, { from, to, firstMs: tMs });
  }

  async function replayFromHash() {
    const hash = extractPacketHash(document.getElementById("sim-replay-hash-input").value);
    if (!hash) {
      setStatus("sim-replay-hash-status", "Couldn't find a packet hash (16 hex characters) in that input.");
      return;
    }
    document.getElementById("sim-replay-hash-go").disabled = true;
    setStatus("sim-replay-hash-status", "Fetching packet + node data from CoreScope…");
    try {
      const [packetData, nodeDir] = await Promise.all([
        fetch(`/corescope-api/api/packets/${encodeURIComponent(hash)}`).then((r) => {
          if (!r.ok) throw new Error(`packet fetch failed: HTTP ${r.status}`);
          return r.json();
        }),
        ensureNodeDirectory(),
      ]);
      const observations = packetData.observations || [];
      if (observations.length === 0) throw new Error("CoreScope has no observations for that hash.");

      const provenEdges = new Map();
      const allPubkeys = new Set();
      let originPubkey = null;
      for (const obs of observations) {
        // CoreScope's own resolved_path can be entirely null (path
        // resolution failed for this whole observation) or, more subtly,
        // a real array with individual null entries (some hops resolved,
        // one didn't) — treated as a genuine gap, not a straight-through
        // connection: a pair either side of a null hop is NOT a proven
        // direct edge, since the real relay actually went through
        // whichever node failed to resolve.
        const rawChain = obs.resolved_path || [];
        if (rawChain.length === 0) continue;
        if (originPubkey === null && rawChain[0]) originPubkey = rawChain[0].toLowerCase();
        const tMs = Date.parse(obs.timestamp) || 0;
        for (const k of rawChain) if (k) allPubkeys.add(k.toLowerCase());
        const observerKey = (obs.observer_id || "").toLowerCase();
        if (observerKey) allPubkeys.add(observerKey);
        for (let i = 0; i < rawChain.length - 1; i++) {
          if (rawChain[i] && rawChain[i + 1]) {
            addProvenEdge(provenEdges, rawChain[i].toLowerCase(), rawChain[i + 1].toLowerCase(), tMs);
          }
        }
        const lastResolvedHop = [...rawChain].reverse().find((k) => k);
        if (observerKey && lastResolvedHop) {
          addProvenEdge(provenEdges, lastResolvedHop.toLowerCase(), observerKey, tMs);
        }
      }
      if (originPubkey === null) throw new Error("Couldn't determine this packet's origin from CoreScope's data.");

      clearNodes(); // a replay is a fresh investigation, not additive to whatever was already set up
      const pubkeyToIndex = new Map();
      for (const pk of allPubkeys) {
        const info = nodeDir.get(pk);
        if (!info) continue; // CoreScope knows the key but has no position for it — can't place it
        pubkeyToIndex.set(pk, simNodes.length);
        simNodes.push({ id: randomId(), source: "real", refId: pk, label: info.name, lat: info.lat, lon: info.lon });
      }
      if (!pubkeyToIndex.has(originPubkey)) {
        throw new Error("The packet's origin has no known position — can't place it on the map.");
      }
      renderNodeList();
      renderMessageNodeOptions();
      redrawNodeMarkers();

      setStatus("sim-replay-hash-status", `Building predicted connectivity for ${simNodes.length} involved node${simNodes.length === 1 ? "" : "s"}…`);
      const source = document.getElementById("sim-connectivity-source").value;
      if (source === "model") simLinks = await buildLinksFromModel(simNodes);
      else if (source === "corescope") simLinks = await buildLinksFromCorescope(simNodes);
      else {
        const [modelLinks, observedLinks] = await Promise.all([buildLinksFromModel(simNodes), buildLinksFromCorescope(simNodes)]);
        const observedPairs = new Set(observedLinks.map((l) => `${l.from}:${l.to}`));
        simLinks = observedLinks.concat(modelLinks.filter((l) => !observedPairs.has(`${l.from}:${l.to}`)));
      }
      linksGeneration++;
      setStatus(
        "sim-links-status",
        `${simLinks.length} directed link${simLinks.length === 1 ? "" : "s"} built (${source}).${isolatedNodeHint(simNodes, simLinks)}`
      );

      await MeshSim.ready;
      // raw_hex is the whole on-air frame (header included, not stripped
      // to just the application payload) — close enough for an airtime
      // estimate; the header is a handful of bytes against a typical
      // 20-200 byte packet, not worth the extra complexity of parsing it
      // out precisely for this analytical purpose.
      const payloadLen = packetData.packet && packetData.packet.raw_hex ? Math.max(1, Math.floor(packetData.packet.raw_hex.length / 2)) : 20;
      const originIndex = pubkeyToIndex.get(originPubkey);
      const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
      const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
      const predictedReport = MeshSim.run(scenarioFromState(), [{ origin: originIndex, sendAtMs: 0, payloadLen }], seed, maxSimTimeMs);

      const routeType = packetData.packet ? packetData.packet.route_type : null;
      renderBottleneckAnalysis({ pubkeyToIndex, provenEdges, predictedReport });
      setStatus(
        "sim-replay-hash-status",
        `Loaded ${observations.length} real observation${observations.length === 1 ? "" : "s"} of packet ${hash}.` +
          (routeType !== 0 ? " Note: our model only predicts flood relaying — if this packet used direct routing, the prediction side won't be meaningful." : "")
      );
    } catch (err) {
      setStatus("sim-replay-hash-status", `Replay failed: ${err.message || err}`);
    } finally {
      document.getElementById("sim-replay-hash-go").disabled = false;
    }
  }

  function renderBottleneckAnalysis({ pubkeyToIndex, provenEdges, predictedReport }) {
    const provenPairIndices = new Set();
    for (const e of provenEdges.values()) {
      const f = pubkeyToIndex.get(e.from);
      const t = pubkeyToIndex.get(e.to);
      if (f != null && t != null) provenPairIndices.add(`${f}:${t}`);
    }

    const predictedPairs = new Map(); // "from:to" -> Reception
    for (const r of predictedReport.receptions || []) predictedPairs.set(`${r.fromNode}:${r.node}`, r);

    // Direction 1: the model expects this hop to work, but no real
    // observation ever confirmed it — a candidate collision/bottleneck.
    const unconfirmed = Array.from(predictedPairs.entries())
      .filter(([key]) => !provenPairIndices.has(key))
      .map(([, r]) => r)
      .sort((a, b) => a.atMs - b.atMs);

    // Direction 2: CoreScope proved this hop happened, but our model
    // doesn't even consider it a possible link at all (never appears in
    // simLinks — not merely "wasn't used in this particular simulated
    // run"). Real, observed example this surfaced: a packet's own origin
    // repeater had zero model-predicted links to anyone, entirely because
    // its nearest real neighbour is further away than this tool's default
    // planning-range cap — the model wasn't wrong about physics, its
    // defaults just didn't anticipate that link. Distinguishing this from
    // direction 1 matters: it points at the model's own assumptions
    // (range, antenna heights, terrain), not at the real network.
    const modeledPairIndices = new Set(simLinks.map((l) => `${l.from}:${l.to}`));
    const unmodeled = Array.from(provenEdges.values())
      .map((e) => ({ from: pubkeyToIndex.get(e.from), to: pubkeyToIndex.get(e.to), firstMs: e.firstMs }))
      .filter((e) => e.from != null && e.to != null && !modeledPairIndices.has(`${e.from}:${e.to}`))
      .sort((a, b) => a.firstMs - b.firstMs);

    const section = document.getElementById("sim-bottleneck-section");
    section.classList.remove("hidden");
    document.getElementById("sim-bottleneck-summary").textContent =
      `${provenEdges.size} proven hop${provenEdges.size === 1 ? "" : "s"} from real CoreScope observations, ` +
      `${predictedPairs.size} predicted by our model — ${unconfirmed.length} predicted but never confirmed, ` +
      `${unmodeled.length} proven but not even predicted possible.`;

    const list = document.getElementById("sim-bottleneck-list");
    list.innerHTML = "";
    if (unconfirmed.length === 0) {
      list.innerHTML = '<div class="plan-empty">Every predicted relay was confirmed by a real observation.</div>';
    }
    for (const r of unconfirmed) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      const row = document.createElement("div");
      row.className = "plan-list-item sim-list-item sim-collided";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(from ? from.label : "?")} → ${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">predicted at ~${r.atMs}ms, hop ${r.hopCount}${r.collided ? " · our model also predicts a collision here" : " · no real observer ever confirmed this hop"}</span>
      `;
      list.appendChild(row);
    }

    const unmodeledList = document.getElementById("sim-unmodeled-list");
    unmodeledList.innerHTML = "";
    if (unmodeled.length === 0) {
      unmodeledList.innerHTML = '<div class="plan-empty">Every real observed hop is at least within our model\'s own connectivity assumptions.</div>';
    }
    for (const e of unmodeled) {
      const from = simNodes[e.from];
      const to = simNodes[e.to];
      const row = document.createElement("div");
      row.className = "plan-list-item sim-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(from ? from.label : "?")} → ${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">real observed hop, but outside this tool's modeled range/terrain assumptions for that pair</span>
      `;
      unmodeledList.appendChild(row);
    }

    // Map: solid green for proven+modeled hops, solid blue for proven but
    // unmodeled (the model's own blind spot), dashed amber for
    // predicted-but-unconfirmed (the bottleneck candidates).
    simResultsLayer.clearLayers();
    const unmodeledPairs = new Set(unmodeled.map((e) => `${e.from}:${e.to}`));
    for (const e of provenEdges.values()) {
      const fIdx = pubkeyToIndex.get(e.from);
      const tIdx = pubkeyToIndex.get(e.to);
      const from = simNodes[fIdx];
      const to = simNodes[tIdx];
      if (!from || !to) continue;
      const isUnmodeled = unmodeledPairs.has(`${fIdx}:${tIdx}`);
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: isUnmodeled ? "#38bdf8" : "#4ade80", weight: 3, opacity: 0.9 }
      ).addTo(simResultsLayer);
    }
    for (const r of unconfirmed) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      if (!from || !to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: "#facc15", weight: 3, opacity: 0.9, dashArray: "6 6" }
      ).addTo(simResultsLayer);
    }
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
      setPlacementMode("off");
      stopReplay();
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
  document.getElementById("sim-add-companion").addEventListener("click", () => setPlacementMode("companion"));
  document.getElementById("sim-nodes-clear").addEventListener("click", clearNodes);
  document.getElementById("sim-build-links").addEventListener("click", buildLinks);
  document.getElementById("sim-message-add").addEventListener("click", addMessage);
  document.getElementById("sim-run").addEventListener("click", runSimulation);
  document.getElementById("sim-predict").addEventListener("click", predictSettings);
  document.getElementById("sim-replay").addEventListener("click", startReplay);
  document.getElementById("sim-skip-to-end").addEventListener("click", skipToEnd);
  document.getElementById("sim-replay-hash-go").addEventListener("click", replayFromHash);

  renderNodeList();
  renderMessageList();

  // Test-only introspection hook.
  window.__hopreachSimulatorDebug = {
    getNodeCount: () => simNodes.length,
    getLinkCount: () => simLinks.length,
    getMessageCount: () => simMessages.length,
    getLastReport: () => lastReport,
    getWaveCount: () => replayWaves.length,
    getNodes: () => simNodes,
    getLinks: () => simLinks,
  };
})();
