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
  // active plan / the live map), not this tool.
  let simNodes = [];
  // {from: nodeIndex, to: nodeIndex, snrDb} — directed, built by
  // buildLinks() below, cleared whenever the node list changes so a stale
  // link referencing a removed/renumbered node can never linger.
  let simLinks = [];
  // Message *generators*, not individual sends — {id, nodeIndex, count,
  // minPayload, maxPayload, minGapMs, maxGapMs}. Each one expands into
  // `count` concrete sends (see messagesFromState) with a random payload
  // length and a random gap since the previous send, both freshly drawn
  // per message rather than fixed — "10 messages, 1-5s apart, 10-50B
  // each" reads as one real batch instead of ten manual rows to fill in.
  let simMessageGenerators = [];
  let lastReport = null;
  // The exact expanded {origin, sendAtMs, payloadLen, region} array passed
  // to MeshSim.run — index-aligned with each Reception's own packetId, so
  // the "Sent messages" list (see renderSentMessagesList/selectSentMessage)
  // can show each one's own origin/region without re-deriving it from the
  // generators (which don't map 1:1 to packetIds once expanded).
  let lastMessages = null;
  let selectedPacketId = null;
  let linksGeneration = 0;
  // Terrain grid from the last "model"/"blend" link build, reused so
  // predictSettings() can look up each node's altitude without a second
  // DEM fetch — cleared in invalidateLinks() since moving a node (or
  // changing the node set) invalidates it exactly the same way it
  // invalidates links.
  let cachedGrid = null;

  // Per-node manual overrides on top of defaultPrefs() — keyed by the
  // node's own stable `id` (not array index, which shifts as nodes are
  // added/removed) — set via the click-to-configure popup (see
  // buildNodePopupHtml/saveNodePrefs). A node with no entry here just uses
  // defaultPrefs() unchanged.
  let simNodePrefsOverrides = {};

  // The last predictSettings() result, kept around so the per-node config
  // popup can show "predicted: txdelay X, rxdelay Y" for whichever node
  // was clicked without re-running the search — cleared (along with the
  // rest of a run's results) in hideResults().
  let lastTuneResult = null;
  let lastAttrsList = null;

  // The saved setup (see loadAllSetups/saveCurrentSetup below) currently
  // loaded, if any — lets "Save" overwrite the same entry instead of always
  // creating a new one, and lets the select reflect what's actually live.
  let currentSetupId = null;

  // predictSettings() runs MeshSim.suggest in its own Worker (see
  // meshsim-worker.js) rather than on the main thread — a real candidate
  // grid is well over a hundred rules, each several full simulation runs,
  // easily seconds to tens of seconds of CPU work that used to freeze the
  // whole page with zero feedback for its entire duration. generation
  // guards against a stale worker message landing after the panel's been
  // cleared or another search started.
  let predictWorker = null;
  let predictGeneration = 0;

  function ensurePredictWorker() {
    if (!predictWorker) predictWorker = new Worker("meshsim-worker.js");
    return predictWorker;
  }

  function setPredictProgress(done, total) {
    const el = document.getElementById("sim-predict-progress");
    el.classList.remove("hidden");
    document.getElementById("sim-predict-progress-text").textContent = `Searching… ${done}/${total}`;
    document.getElementById("sim-predict-progress-fill").style.width = `${Math.max(2, (done / total) * 100)}%`;
  }

  function hidePredictProgress() {
    document.getElementById("sim-predict-progress").classList.add("hidden");
  }

  // Per-node running tally of whichever dimension simViewMode.growBy is
  // currently tracking (successful receptions, or collisions) — what
  // drives the growing/greening marker (see ensureGrowthMarker/growNode).
  // Reset at the start of every replay, and whenever growBy itself changes
  // (a stale success-based count wouldn't mean anything once switched to
  // counting collisions instead).
  let nodeGrowthCounts = [];
  const growthMarkers = new Map(); // node index -> L.CircleMarker

  // Controls how the *live map view* of a run's results looks — entirely
  // separate from which repeaters/messages/settings are actually
  // simulated. Session-only (not persisted): this is an analysis lens on
  // whatever run just happened, not a durable preference.
  //   keepAllPaths: true = every wave's lines stay on the map all replay
  //     long (a full accumulated trail); false = only the most recent
  //     wave's lines are shown at a time (a "live" view).
  //   filter: "all" | "collisions" | "successes" — which receptions get
  //     drawn/counted at all, in the replay, the final skip-to-end state,
  //     and a selected sent message's own path.
  //   growBy: "success" | "collision" — which of those a growth marker's
  //     size/colour actually tracks.
  const simViewMode = { keepAllPaths: true, filter: "all", growBy: "success" };
  // Polylines drawn for the *current* wave only — cleared before the next
  // wave when !simViewMode.keepAllPaths (see playWave). Pulses aren't
  // tracked here: they already self-remove a fraction of a second after
  // being drawn (see pulseAt), regardless of this setting.
  let currentWaveLines = [];

  // "off" | "companion" — click-to-place mode for a virtual companion
  // radio, scoped to this panel only (reset to "off" whenever the panel
  // closes) — see setSimPanelOpen and the map click handler below. Named
  // distinctly from Plan mode's own, unrelated "📍 Companion pin" feature
  // (a neighbour-preview tool over real repeater data, not a simulation
  // node).
  let placementMode = "off";

  // Monotonic — never derived from the *current* companion count, and
  // never decremented on removal. Counting the current companions and
  // adding 1 (the previous approach) breaks the moment one is removed:
  // add "Companion 1"/"Companion 2", remove "Companion 1", add another —
  // the count is back down to 1, so the new one would also be labelled
  // "Companion 2", colliding with the one still on the map. This can only
  // go up, so a label, once used, is never handed out again this session.
  let companionCounter = 0;

  const simNodesLayer = L.layerGroup().addTo(map);
  const simResultsLayer = L.layerGroup().addTo(map);
  // A selected sent message's own path/collisions (see selectSentMessage)
  // — deliberately separate from simResultsLayer (which the replay/growth
  // markers own) so selecting a message doesn't fight with replay state.
  const simMessagePathLayer = L.layerGroup().addTo(map);
  // The ±30s real-traffic replay animation (see startRealTimelineReplay)
  // draws here — its own layer, separate from simResultsLayer's static
  // proven/predicted overlay (see renderBottleneckAnalysis), so playing
  // the animation doesn't clear or fight with that always-shown context.
  const simRealActivityLayer = L.layerGroup().addTo(map);

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function canRelay(node) {
    if (node.source === "companion") return false; // a handheld companion originates/receives traffic but doesn't relay, same as real MeshCore companion apps
    if (node.role === "listener") return false; // CoreScope-labelled listener — rx only, never retransmits (see replayFromHash)
    return true; // "repeater" or no role at all (most nodes) — assume it repeats
  }

  // MeshCore's own short node address is the first 6 bytes of its public
  // key, shown in hex — real repeaters/companions get theirs from their
  // actual pubkey; planned/companion nodes have no real key yet, so one is
  // generated once at creation time and stored with the node (not
  // recomputed per render, or every hover would show a different value).
  function shortAddressFromPubkey(pubkeyHex) {
    return (pubkeyHex || "").slice(0, 12).toUpperCase();
  }

  function generatedShortAddress() {
    return randomId().toUpperCase();
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
      simNodes.push({ id: randomId(), source: "planned", refId: r.id, label: r.label, lat: r.lat, lon: r.lon, address: generatedShortAddress() });
      added++;
    }
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
    setStatus("sim-status", `Loaded ${added} planned repeater${added === 1 ? "" : "s"}${added < plan.repeaters.length ? " (some already loaded)" : ""}.`);
  }

  // Populated from CoreScope's own scope-stats (see app.js's
  // initScopeFilterControl, same source) — lets "Load real repeaters"
  // pull in only the repeaters believed to be in one region, e.g. loading
  // just #fif's own repeaters to test settings for that region without
  // manually removing every repeater outside it afterward.
  async function initSimScopeFilter() {
    const loadFilter = document.getElementById("sim-scope-filter");
    const messageRegion = document.getElementById("sim-message-region");
    try {
      const resp = await fetch("/corescope-api/api/scope-stats?window=7d");
      if (!resp.ok) return;
      const data = await resp.json();
      const names = (data.byRegion || []).map((r) => r.name).filter(Boolean);
      for (const name of names) {
        const opt1 = document.createElement("option");
        opt1.value = name;
        opt1.textContent = name;
        loadFilter.appendChild(opt1);

        // "Send as" this region — mirrors real `region default <name>`
        // (see docs.meshcore.io/cli_commands): only repeaters that
        // actually hold this region's own transport key will relay a
        // message tagged with it onward (see SimNode.acceptsRegion).
        const opt2 = document.createElement("option");
        opt2.value = name;
        opt2.textContent = `Send as ${name}`;
        messageRegion.appendChild(opt2);
      }
    } catch {
      // CoreScope unreachable — leave both selects at their defaults.
    }
  }

  function loadRealRepeaters() {
    const planner = window.HopReachPlanner;
    if (!planner) return;
    const scope = document.getElementById("sim-scope-filter").value;
    let real = Object.values(planner.getRealRepeaters());
    if (scope) real = real.filter((r) => (r.scopes || []).includes(scope));
    if (real.length === 0) {
      setStatus("sim-status", scope ? `No real repeaters found for ${scope}.` : "No real repeater data loaded yet.");
      return;
    }
    const existing = new Set(simNodes.map((n) => nodeKey(n.source, n.refId)));
    let added = 0;
    for (const r of real) {
      const key = nodeKey("real", r.id);
      if (existing.has(key)) continue;
      simNodes.push({ id: randomId(), source: "real", refId: r.id, label: r.label, lat: r.lat, lon: r.lon, regions: r.scopes || [], hashSize: r.hashSize || null, address: shortAddressFromPubkey(r.id) });
      added++;
    }
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
    setStatus("sim-status", `Loaded ${added} real repeater${added === 1 ? "" : "s"}${added < real.length ? " (some already loaded)" : ""}.`);
  }

  function addCompanionAt(lat, lon) {
    companionCounter++;
    simNodes.push({ id: randomId(), source: "companion", refId: randomId(), label: `Companion ${companionCounter}`, lat, lon, address: generatedShortAddress() });
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
    delete simNodePrefsOverrides[id];
    simNodes = simNodes.filter((n) => n.id !== id);
    simMessageGenerators = simMessageGenerators.filter((g) => simNodes[g.nodeIndex] !== undefined);
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
  }

  function clearNodes() {
    simNodes = [];
    simMessageGenerators = [];
    simNodePrefsOverrides = {};
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

  // --- saved setups -------------------------------------------------------
  //
  // A setup is everything needed to get straight back to "ready to run"
  // without repeating the node-loading/link-building/sender-adding dance:
  // nodes (incl. per-node settings overrides), the built links themselves
  // (not just the node set — rebuilding real/blended links means a fresh
  // CoreScope fetch, so saving them avoids that too), message senders, and
  // the run controls (seed/duration/trials). Stored client-side only, same
  // pattern as planner.js's own plans (see its STORAGE_KEY).
  const SETUP_STORAGE_KEY = "hopreach.simSetups";

  function loadAllSetups() {
    try {
      return JSON.parse(localStorage.getItem(SETUP_STORAGE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveAllSetups(all) {
    localStorage.setItem(SETUP_STORAGE_KEY, JSON.stringify(all));
  }

  function refreshSetupSelect() {
    const sel = document.getElementById("sim-setup-select");
    const all = loadAllSetups();
    const ids = Object.keys(all);
    sel.innerHTML = "";
    if (ids.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "(no saved setups)";
      opt.disabled = true;
      opt.selected = true;
      sel.appendChild(opt);
      return;
    }
    for (const id of ids) {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = all[id].name || "(untitled)";
      if (id === currentSetupId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function saveCurrentSetup() {
    if (simNodes.length === 0) {
      setStatus("sim-status", "Nothing to save — load some nodes first.");
      return;
    }
    const nameInput = document.getElementById("sim-setup-name");
    const name = nameInput.value.trim() || "Untitled setup";
    const all = loadAllSetups();
    const id = currentSetupId || randomId();
    all[id] = {
      id,
      name,
      savedAt: Date.now(),
      nodes: simNodes,
      links: simLinks,
      connectivitySource: document.getElementById("sim-connectivity-source").value,
      messageGenerators: simMessageGenerators,
      nodePrefsOverrides: simNodePrefsOverrides,
      seed: document.getElementById("sim-seed").value,
      maxSimTimeMs: document.getElementById("sim-max-time").value,
      trials: document.getElementById("sim-trials").value,
    };
    saveAllSetups(all);
    currentSetupId = id;
    nameInput.value = name;
    refreshSetupSelect();
    setStatus("sim-status", `Saved setup "${name}".`);
  }

  function deleteCurrentSetup() {
    if (!currentSetupId) return;
    const all = loadAllSetups();
    const name = all[currentSetupId] ? all[currentSetupId].name : "this setup";
    if (!confirm(`Delete saved setup "${name}"? This can't be undone.`)) return;
    delete all[currentSetupId];
    saveAllSetups(all);
    currentSetupId = null;
    document.getElementById("sim-setup-name").value = "";
    refreshSetupSelect();
    setStatus("sim-status", `Deleted "${name}".`);
  }

  function newSetup() {
    currentSetupId = null;
    document.getElementById("sim-setup-name").value = "";
    clearNodes();
    refreshSetupSelect();
    setStatus("sim-status", "Started a new, empty setup.");
  }

  // Restores live state (simNodes, simLinks, senders, overrides, run
  // controls) from a setup-shaped object — shared by loadSetup (from
  // localStorage) and importSetupFromFile (from an uploaded .json), so
  // both end up in exactly the same state regardless of where the data
  // came from.
  function applySetupData(s) {
    simNodes = s.nodes || [];
    simLinks = s.links || [];
    simMessageGenerators = s.messageGenerators || [];
    simNodePrefsOverrides = s.nodePrefsOverrides || {};
    document.getElementById("sim-connectivity-source").value = s.connectivitySource || "model";
    document.getElementById("sim-seed").value = s.seed != null ? s.seed : 1;
    document.getElementById("sim-max-time").value = s.maxSimTimeMs != null ? s.maxSimTimeMs : 60000;
    document.getElementById("sim-trials").value = s.trials != null ? s.trials : 20;
    document.getElementById("sim-setup-name").value = s.name || "";
    cachedGrid = null; // stale for this node set even if links came along

    // Keep the monotonic companion counter ahead of anything just loaded,
    // so a newly-placed companion never collides with a restored one's
    // label (see addCompanionAt/companionCounter's own comment).
    for (const n of simNodes) {
      if (n.source !== "companion") continue;
      const m = /^Companion (\d+)$/.exec(n.label || "");
      if (m) companionCounter = Math.max(companionCounter, parseInt(m[1], 10));
    }

    hideResults(); // any previous report doesn't match the freshly loaded scenario
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
    if (simLinks.length > 0) {
      setStatus(
        "sim-links-status",
        `${simLinks.length} directed link${simLinks.length === 1 ? "" : "s"} restored from "${s.name || "this setup"}" (${s.connectivitySource || "model"}).`
      );
    } else {
      setStatus("sim-links-status", "Connectivity not built yet for the current node set — click \"Build links\".");
    }
  }

  function loadSetup(id) {
    const all = loadAllSetups();
    const s = all[id];
    if (!s) return;
    currentSetupId = id;
    applySetupData(s);
    refreshSetupSelect();
    setStatus("sim-status", `Loaded setup "${s.name}".`);
  }

  // Exports the setup currently loaded in the workspace (not necessarily
  // saved yet) as a standalone .json — every node stores its own
  // lat/lon/label snapshot already (see loadPlannedRepeaters/
  // loadRealRepeaters/addCompanionAt), so this is self-contained: a
  // planned repeater imported elsewhere doesn't need that original plan to
  // still exist, same reasoning as planner.js's own plan export.
  function exportCurrentSetup() {
    if (simNodes.length === 0) {
      setStatus("sim-status", "Nothing to export — load some nodes first.");
      return;
    }
    const name = document.getElementById("sim-setup-name").value.trim() || "Untitled setup";
    const data = {
      name,
      nodes: simNodes,
      links: simLinks,
      connectivitySource: document.getElementById("sim-connectivity-source").value,
      messageGenerators: simMessageGenerators,
      nodePrefsOverrides: simNodePrefsOverrides,
      seed: document.getElementById("sim-seed").value,
      maxSimTimeMs: document.getElementById("sim-max-time").value,
      trials: document.getElementById("sim-trials").value,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^a-z0-9-_ ]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // An imported setup isn't yet one of the saved entries in localStorage —
  // it loads straight into the live workspace, same as loadSetup, but
  // with no currentSetupId until the user explicitly hits Save.
  function importSetupFromFile(s) {
    currentSetupId = null;
    applySetupData(s);
    refreshSetupSelect();
    setStatus("sim-status", `Imported setup "${s.name || "Untitled setup"}" — click Save to keep it.`);
  }

  // --- rendering: node list, message list -----------------------------

  const SOURCE_BADGE = { planned: "sim-badge-planned", real: "sim-badge-real", companion: "sim-badge-companion" };

  // Node management/config used to be two separate UIs (a docked list for
  // remove/rename, a per-marker popup for delay settings) — now one table,
  // in the "Repeaters & settings" modal (see openModal/renderNodesModalTable
  // below), so there's exactly one place to look. renderNodeList's job is
  // now just keeping that modal's own table in sync whenever it's open
  // (dragging a companion, loading more nodes, etc. while the modal is up)
  // plus the toolbar button's node-count badge.
  function renderNodeList() {
    document.getElementById("sim-node-count-badge").textContent = String(simNodes.length);
    if (!document.getElementById("sim-nodes-modal").classList.contains("hidden")) renderNodesModalTable();
  }

  // Sorted by label for display only — simNodes' own array order (and
  // therefore every existing nodeIndex reference: message generators,
  // Reception.node/fromNode, simNodePrefsOverrides lookups by id) stays
  // exactly as-is. Only ever sort a copy of {node, originalIndex} pairs,
  // never simNodes itself.
  function nodesSortedByLabel() {
    return simNodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.label.localeCompare(b.n.label));
  }

  function renderMessageNodeOptions() {
    const sel = document.getElementById("sim-message-node");
    const prevValue = sel.value;
    sel.innerHTML = "";
    nodesSortedByLabel().forEach(({ n, i }) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = n.label;
      sel.appendChild(opt);
    });
    if (prevValue && Number(prevValue) < simNodes.length) sel.value = prevValue;
  }

  // Set while editing an existing sender (see editSender/cancelEditSender)
  // — addMessage() updates this entry in place instead of pushing a new
  // one when set.
  let editingGeneratorId = null;

  function renderMessageList() {
    document.getElementById("sim-message-count-badge").textContent = String(simMessageGenerators.length);
    const list = document.getElementById("sim-message-list");
    list.innerHTML = "";
    if (simMessageGenerators.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — pick a sender above and add one.</div>';
      return;
    }
    for (const g of simMessageGenerators) {
      const node = simNodes[g.nodeIndex];
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(node ? node.label : "?")}${g.region ? ` <span class="sim-node-badge sim-badge-region">${escapeHtml(g.region)}</span>` : ""}</span>
        <span class="plan-item-sub">${g.count} message${g.count === 1 ? "" : "s"} · ${g.minPayload}-${g.maxPayload}B · ${g.minGapMs}-${g.maxGapMs}ms apart</span>
        <span class="plan-item-actions">
          <button data-act="edit" title="Edit">✎</button>
          <button data-act="remove" title="Remove">✕</button>
        </span>
      `;
      row.querySelector('[data-act="edit"]').onclick = () => editSender(g.id);
      row.querySelector('[data-act="remove"]').onclick = () => {
        simMessageGenerators = simMessageGenerators.filter((x) => x.id !== g.id);
        if (editingGeneratorId === g.id) cancelEditSender();
        renderMessageList();
      };
      list.appendChild(row);
    }
  }

  // Loads an existing sender's own values back into the form and switches
  // "+ Add sender" into update-in-place mode — editing a sender's own
  // params (count/payload/gap/region) no longer means removing it and
  // re-adding a fresh one from scratch.
  function editSender(generatorId) {
    const g = simMessageGenerators.find((x) => x.id === generatorId);
    if (!g) return;
    editingGeneratorId = generatorId;
    document.getElementById("sim-message-node").value = String(g.nodeIndex);
    document.getElementById("sim-message-count").value = String(g.count);
    document.getElementById("sim-message-region").value = g.region || "";
    document.getElementById("sim-message-payload-min").value = String(g.minPayload);
    document.getElementById("sim-message-payload-max").value = String(g.maxPayload);
    document.getElementById("sim-message-gap-min").value = String(g.minGapMs);
    document.getElementById("sim-message-gap-max").value = String(g.maxGapMs);
    document.getElementById("sim-message-add").textContent = "Save changes";
    document.getElementById("sim-message-cancel-edit").classList.remove("hidden");
    const hint = document.getElementById("sim-message-editing-hint");
    hint.textContent = `Editing ${simNodes[g.nodeIndex] ? simNodes[g.nodeIndex].label : "this sender"}'s settings.`;
    hint.classList.remove("hidden");
  }

  function cancelEditSender() {
    editingGeneratorId = null;
    document.getElementById("sim-message-add").textContent = "+ Add sender";
    document.getElementById("sim-message-cancel-edit").classList.add("hidden");
    document.getElementById("sim-message-editing-hint").classList.add("hidden");
  }

  function addMessage() {
    const sel = document.getElementById("sim-message-node");
    if (sel.options.length === 0) {
      setStatus("sim-status", "Load at least one node before adding a sender.");
      return;
    }
    const nodeIndex = Number(sel.value);
    const region = document.getElementById("sim-message-region").value;
    const count = Math.min(500, Math.max(1, parseInt(document.getElementById("sim-message-count").value, 10) || 1));
    let minPayload = Math.min(255, Math.max(1, parseInt(document.getElementById("sim-message-payload-min").value, 10) || 1));
    let maxPayload = Math.min(255, Math.max(1, parseInt(document.getElementById("sim-message-payload-max").value, 10) || minPayload));
    if (maxPayload < minPayload) [minPayload, maxPayload] = [maxPayload, minPayload];
    let minGapMs = Math.max(0, parseInt(document.getElementById("sim-message-gap-min").value, 10) || 0);
    let maxGapMs = Math.max(0, parseInt(document.getElementById("sim-message-gap-max").value, 10) || minGapMs);
    if (maxGapMs < minGapMs) [minGapMs, maxGapMs] = [maxGapMs, minGapMs];

    if (editingGeneratorId) {
      const g = simMessageGenerators.find((x) => x.id === editingGeneratorId);
      if (g) Object.assign(g, { nodeIndex, region, count, minPayload, maxPayload, minGapMs, maxGapMs });
      cancelEditSender();
    } else {
      simMessageGenerators.push({ id: randomId(), nodeIndex, region, count, minPayload, maxPayload, minGapMs, maxGapMs });
    }
    renderMessageList();
  }

  // --- map markers -----------------------------------------------------

  function redrawNodeMarkers() {
    simNodesLayer.clearLayers();
    simNodes.forEach((n, nodeIndex) => {
      const iconClass = n.source === "companion" ? "sim-marker-companion" : "sim-marker-icon";
      L.marker([n.lat, n.lon], {
        icon: L.divIcon({ className: iconClass, iconSize: [12, 12] }),
        draggable: n.source === "companion",
      })
        .addTo(simNodesLayer)
        .bindTooltip(`${n.label} (${n.source})${n.address ? ` · ${n.address}` : ""}`)
        // Once a simulation has run, clicking a repeater is much more
        // often "what happened here" than "let me tweak its settings" —
        // show the packet inspector instead. Settings are still reachable
        // via the toolbar's "Repeaters & settings" button (and its own
        // per-row "Packets" action once a report exists, see
        // renderNodesModalTable).
        .on("click", () => (lastReport ? openPacketInspectorForNode(nodeIndex) : openNodesModal(n.id)))
        .on("dragend", (e) => {
          const ll = e.target.getLatLng();
          n.lat = ll.lat;
          n.lon = ll.lng;
          invalidateLinks();
        });
    });
  }

  // --- "Repeaters & settings" modal --------------------------------------
  //
  // One table for everything about a node: which repeaters are actually
  // in the simulation (was the standalone sim-node-list) and the settings
  // that govern each one's own behaviour — internal/meshsim.NodePrefs' own
  // tx/direct-tx/rx delay factors plus tx power, the same fields real
  // MeshCore firmware exposes via `set txdelay`/`set direct.txdelay`/`set
  // rxdelay`/`set tx`. Edits are staged in the table's own inputs and only
  // committed to simNodePrefsOverrides on "Apply" — closing without
  // applying discards them, same as any other settings dialog.
  const LOOP_DETECT_LEVELS = ["off", "minimal", "moderate", "strict"];

  function renderNodesModalTable() {
    const tbody = document.getElementById("sim-nodes-modal-tbody");
    tbody.innerHTML = "";
    if (simNodes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="plan-empty">None yet — load repeaters or place a companion location, then reopen this.</td></tr>';
      return;
    }
    nodesSortedByLabel().forEach(({ n, i: nodeIndex }) => {
      const prefs = effectivePrefsFor(n);
      let predictedTitle = "";
      if (lastTuneResult && lastTuneResult.suggestions.length && lastAttrsList && lastAttrsList[nodeIndex]) {
        const best = lastTuneResult.suggestions[0];
        if (ruleMatchesAttrs(best.rule, lastAttrsList[nodeIndex])) {
          const predicted = applyRule(defaultPrefs(), best.rule);
          predictedTitle = `Predicted (${best.rule.name}): txdelay ${predicted.txDelayFactor.toFixed(2)} · rxdelay ${predicted.rxDelayBase.toFixed(1)}`;
        }
      }
      const loopDetect = effectiveLoopDetect(n);
      const loopDetectOptions = LOOP_DETECT_LEVELS.map((lvl) => `<option value="${lvl}" ${lvl === (loopDetect || "off") ? "selected" : ""}>${lvl}</option>`).join("");
      const tr = document.createElement("tr");
      tr.dataset.nodeId = n.id;
      tr.innerHTML = `
        <td><span class="sim-node-badge ${SOURCE_BADGE[n.source]}">${n.source}</span> <span title="${n.address ? `Address: ${n.address}` : "No address"}">${escapeHtml(n.label)}</span></td>
        <td><input type="number" step="0.05" min="0" max="2" data-field="txDelayFactor" value="${prefs.txDelayFactor}" title="${escapeHtml(predictedTitle)}"></td>
        <td><input type="number" step="0.05" min="0" max="2" data-field="directTxDelayFactor" value="${prefs.directTxDelayFactor}"></td>
        <td><input type="number" step="0.5" min="0" max="20" data-field="rxDelayBase" value="${prefs.rxDelayBase}" title="${escapeHtml(predictedTitle)}"></td>
        <td><input type="number" step="1" min="1" max="22" data-field="txPowerDbm" value="${prefs.txPowerDbm}"></td>
        <td><select data-field="loopDetect" title="Real firmware default is off — see docs.meshcore.io's loop.detect">${loopDetectOptions}</select></td>
        <td><input type="number" step="1" min="1" max="3" data-field="hashSize" value="${effectiveHashSize(n)}" title="Bytes — smaller sizes make loop.detect more prone to false positives from hash collisions between unrelated repeaters"></td>
        <td>
          ${lastReport ? '<button data-act="packets" title="See packets received here">📨</button>' : ""}
          ${n.source === "companion" ? '<button data-act="rename" title="Rename">✎</button>' : ""}
          <button data-act="remove" title="Remove">✕</button>
        </td>
      `;
      if (lastReport) tr.querySelector('[data-act="packets"]').onclick = () => openPacketInspectorForNode(nodeIndex);
      if (n.source === "companion") tr.querySelector('[data-act="rename"]').onclick = () => renameNode(n.id);
      tr.querySelector('[data-act="remove"]').onclick = () => {
        removeNode(n.id);
        renderNodesModalTable();
      };
      tbody.appendChild(tr);
    });
  }

  function applyNodesModalTable() {
    const tbody = document.getElementById("sim-nodes-modal-tbody");
    let applied = 0;
    tbody.querySelectorAll("tr[data-node-id]").forEach((tr) => {
      const n = simNodes.find((x) => x.id === tr.dataset.nodeId);
      if (!n) return;
      const override = {};
      tr.querySelectorAll("[data-field]").forEach((el) => {
        if (el.tagName === "SELECT") {
          override[el.dataset.field] = el.value;
        } else {
          const v = parseFloat(el.value);
          if (!Number.isNaN(v)) override[el.dataset.field] = v;
        }
      });
      simNodePrefsOverrides[n.id] = override;
      applied++;
    });
    setStatus("sim-status", `Applied settings for ${applied} node${applied === 1 ? "" : "s"}.`);
  }

  // Copies whichever bulk-apply fields actually have a value into every
  // row's own inputs — staged only, same as any other edit in this table:
  // still needs the modal's own "Apply" to actually commit. Blank bulk
  // fields are left alone per-row (so e.g. setting only loop.detect for
  // everyone doesn't also clobber each row's own individually-tuned tx
  // delay).
  function fillAllRowsFromBulkApply() {
    const bulkFields = [
      ["sim-bulk-tx-delay", "txDelayFactor"],
      ["sim-bulk-direct-tx-delay", "directTxDelayFactor"],
      ["sim-bulk-rx-delay", "rxDelayBase"],
      ["sim-bulk-tx-power", "txPowerDbm"],
      ["sim-bulk-loop-detect", "loopDetect"],
      ["sim-bulk-hash-size", "hashSize"],
    ];
    let filledFields = 0;
    for (const [bulkId, field] of bulkFields) {
      const bulkEl = document.getElementById(bulkId);
      if (bulkEl.value === "") continue;
      filledFields++;
      document.querySelectorAll(`#sim-nodes-modal-tbody [data-field="${field}"]`).forEach((el) => {
        el.value = bulkEl.value;
      });
    }
    setStatus("sim-status", filledFields > 0 ? `Filled ${filledFields} field${filledFields === 1 ? "" : "s"} across every row — click Apply to commit.` : "Set at least one bulk value first.");
  }

  // Opens the modal and, if highlightNodeId is given (e.g. from clicking a
  // marker), scrolls that row into view and briefly highlights it — so
  // clicking a specific repeater on the map actually takes you to *that*
  // repeater's own row in a table that can otherwise be long.
  function openNodesModal(highlightNodeId) {
    renderNodesModalTable();
    openModal("sim-nodes-modal");
    if (highlightNodeId) {
      const row = document.querySelector(`#sim-nodes-modal-tbody tr[data-node-id="${highlightNodeId}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("sim-row-highlight");
        setTimeout(() => row.classList.remove("sim-row-highlight"), 1500);
      }
    }
  }

  function redrawResultLines(report) {
    simResultsLayer.clearLayers();
    if (!report) return;
    for (const r of report.receptions) {
      if (!matchesViewFilter(r)) continue;
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
    // Every real node's own reach query independently reports both
    // directions of each relationship it knows about — node A's data can
    // say "they_hear" B (A -> B) while node B's own, separately-fetched
    // data says "we_hear" A (also A -> B): the same real-world fact,
    // reported from both sides. Querying every node means that same
    // directed pair lands in the flattened list twice, which the engine
    // would then treat as two distinct links — delivering the same
    // transmission to the same listener twice (visible as an identical
    // reception row appearing more than once for one packet). Dedupe by
    // (from,to), keeping the stronger of the two SNR estimates whenever
    // both sides independently reported the same pair.
    const best = new Map();
    for (const l of perNode.flat()) {
      const key = `${l.from}:${l.to}`;
      const existing = best.get(key);
      if (!existing || l.snrDb > existing.snrDb) best.set(key, l);
    }
    return [...best.values()];
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

  // loopDetect/hashSize aren't part of NodePrefs (unlike tx/rx delay etc)
  // — they're their own SimNode-level fields (see internal/meshsim's own
  // HashSize doc comment) — but share the same simNodePrefsOverrides
  // object per node rather than a separate store, since they're set from
  // the exact same "Repeaters & settings" modal row.
  function effectiveLoopDetect(n) {
    const override = simNodePrefsOverrides[n.id];
    return (override && override.loopDetect) || "";
  }

  function effectiveHashSize(n) {
    const override = simNodePrefsOverrides[n.id];
    if (override && override.hashSize) return override.hashSize;
    return n.hashSize || 1; // 1 = the smallest, most collision-prone size, a safe/conservative default when a real repeater's own hash_size isn't known
  }

  function scenarioFromState() {
    return {
      nodes: simNodes.map((n) => ({
        prefs: effectivePrefsFor(n),
        canRelay: canRelay(n),
        regions: n.regions || [],
        loopDetect: effectiveLoopDetect(n),
        hashSize: effectiveHashSize(n),
      })),
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

  // defaultPrefs() with whatever this specific node's manual override (see
  // simNodePrefsOverrides, set via the click-to-configure popup) replaces
  // — a node with no override just gets the baseline back untouched.
  // radio isn't overridable here (only the delay/power fields the popup
  // exposes), so it always comes from the baseline.
  function effectivePrefsFor(node) {
    const override = simNodePrefsOverrides[node.id];
    if (!override) return defaultPrefs();
    return { ...defaultPrefs(), ...override };
  }

  // A small, seeded PRNG (mulberry32) — deterministic per generator so the
  // same random seed reproduces the same generated message batch (same
  // spirit as internal/meshsim's own seeded RNG determinism), yet
  // independent per generator so two senders don't draw identical
  // sequences just because they share a base seed.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randomInt(rng, min, max) {
    if (max <= min) return min;
    return min + Math.floor(rng() * (max - min + 1));
  }

  // Expands every message generator into its own concrete sends: `count`
  // messages, each with a freshly-drawn random payload length and a
  // freshly-drawn random gap since the *previous* send from this same
  // generator (the first one goes out immediately at t=0) — a real,
  // slightly irregular burst rather than evenly-spaced sends. Seeded from
  // the sim's own run seed (see runSimulation/predictSettings) mixed with
  // the generator's own index, so re-running with the same seed reproduces
  // the same generated batch, but changing the seed reshuffles it, same
  // determinism contract as the engine's own retransmit-delay draws.
  function messagesFromState(seed) {
    const messages = [];
    simMessageGenerators.forEach((g, gi) => {
      const rng = mulberry32((seed >>> 0) ^ ((gi + 1) * 0x9e3779b9));
      let atMs = 0;
      for (let i = 0; i < g.count; i++) {
        if (i > 0) atMs += randomInt(rng, g.minGapMs, g.maxGapMs);
        messages.push({ origin: g.nodeIndex, sendAtMs: atMs, payloadLen: randomInt(rng, g.minPayload, g.maxPayload), region: g.region || "" });
      }
    });
    return messages;
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
    if (simMessageGenerators.length === 0) {
      setStatus("sim-status", "Add at least one message sender first.");
      return;
    }
    await MeshSim.ready;
    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    setStatus("sim-status", "Running…");
    try {
      const messages = messagesFromState(seed);
      const report = MeshSim.run(scenarioFromState(), messages, seed, maxSimTimeMs);
      lastReport = report;
      lastMessages = messages;
      renderResults(report);
      renderSentMessagesList();
      renderRankings(report);
      startReplay();
      setStatus("sim-status", "Done.");
      // Deliberately doesn't open the Results modal automatically — its
      // backdrop covers the whole map (see #sim-modal-backdrop), which
      // would block the map-docked playback control this same run just
      // revealed (see ensureSimPlaybackControl). The "📊 Results" button
      // is there if the bigger modal view is wanted; the map controls
      // handle live replay + the log on their own now.
    } catch (err) {
      setStatus("sim-status", `Simulation failed: ${err.message || err}`);
    }
  }

  // Renders report's reception log into container — used for both the
  // Results modal's own log and the map-docked playback control's live
  // copy (see ensureSimPlaybackControl), so the two never drift out of
  // sync with each other.
  function renderReceptionLogInto(container, report) {
    container.innerHTML = "";
    for (const r of report.receptions) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      const row = document.createElement("div");
      row.className = `plan-list-item sim-list-item ${r.collided ? "sim-collided" : "sim-clean"}`;
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">from ${escapeHtml(from ? from.label : "?")} at ${r.atMs}ms · hop ${r.hopCount}${r.collided ? " · COLLIDED" : r.wasRelayed ? " · relayed" : ""}</span>
      `;
      container.appendChild(row);
    }
  }

  function renderResults(report) {
    document.getElementById("sim-open-results-modal").classList.remove("hidden");
    ensureSimPlaybackControl();
    const total = report.receptions.length;
    const collided = report.receptions.filter((r) => r.collided).length;
    const rate = total > 0 ? ((collided / total) * 100).toFixed(1) : "0.0";
    const summary = `${total} reception${total === 1 ? "" : "s"}, ${collided} collided (${rate}%).`;
    document.getElementById("sim-results-summary").textContent = summary;

    renderReceptionLogInto(document.getElementById("sim-results-log"), report);
    const mapLog = document.getElementById("sim-map-results-log");
    if (mapLog) renderReceptionLogInto(mapLog, report);
  }

  // --- sent messages: list + per-message path/collision view ------------
  //
  // Each entry is one *packet* (one expanded send from a generator, see
  // messagesFromState) — clicking one draws exactly its own propagation:
  // every hop it actually took (green where clean, red where collided),
  // and marks every repeater it reached at all. Answers "did this specific
  // message get through, and to whom" directly, rather than having to
  // reconstruct that from the raw reception log by eye.
  function renderSentMessagesList() {
    const list = document.getElementById("sim-messages-sent-list");
    list.innerHTML = "";
    if (!lastMessages || lastMessages.length === 0) return;
    // packetId is lastMessages' own array index (Reception.packetId refers
    // back to it), which is insertion order — not necessarily time order
    // once multiple generators' sends interleave. Sort a copy for display,
    // keeping each row's real packetId for everything else (selection,
    // report lookups, the map path draw).
    const order = lastMessages.map((m, packetId) => ({ m, packetId })).sort((a, b) => a.m.sendAtMs - b.m.sendAtMs);
    order.forEach(({ m, packetId }) => {
      const origin = simNodes[m.origin];
      const receptions = lastReport ? lastReport.receptions.filter((r) => r.packetId === packetId) : [];
      const reachedNodes = new Set(receptions.filter((r) => !r.collided).map((r) => r.node));
      const collidedNodes = new Set(receptions.filter((r) => r.collided).map((r) => r.node));
      const row = document.createElement("div");
      row.className = `plan-list-item sim-message-row${selectedPacketId === packetId ? " sim-message-row-selected" : ""}`;
      row.dataset.packetId = String(packetId);
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(origin ? origin.label : "?")}${m.region ? ` <span class="sim-node-badge sim-badge-region">${escapeHtml(m.region)}</span>` : ""}</span>
        <span class="plan-item-sub">${m.payloadLen}B at ${m.sendAtMs}ms · reached ${reachedNodes.size}, collided at ${collidedNodes.size}
          <button type="button" class="sim-message-details-btn" data-packet-id="${packetId}">Details</button>
        </span>
      `;
      row.querySelector(".sim-message-details-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        openPacketDetails(packetId);
      });
      row.addEventListener("click", () => selectSentMessage(packetId));
      list.appendChild(row);
    });
  }

  // --- packet inspector: per-repeater and per-packet reception detail ---
  //
  // Answers "what did this repeater actually receive, when, over what
  // path, and why didn't it relay X" — and the mirror question "what
  // happened to this one packet at every repeater it reached." Both views
  // share the same row renderer; only which Receptions get passed in (and
  // which column each row emphasises) differs.
  const DROP_REASON_LABELS = {
    weak_signal: "Signal too weak to decode",
    cannot_relay: "Node can't relay (client only)",
    hop_limit: "Hop limit reached",
    already_relayed: "Already relayed this packet",
    region_mismatch: "Region mismatch — not relayed",
    loop_detect: "Dropped by loop detection",
  };

  // Longer, hover-only explanations for the short DROP_REASON_LABELS —
  // mirrors the doc comments on internal/meshsim.Reception.DropReason.
  const DROP_REASON_DETAILS = {
    weak_signal: "The signal-to-noise ratio at this listener was below the minimum needed to decode a packet sent at this spreading factor.",
    cannot_relay: "This node is a plain client (e.g. a companion app), not a repeater — it never relays packets onward, regardless of its other settings.",
    hop_limit: "The packet had already been relayed the maximum number of times allowed (MaxHopCount) before it reached this node.",
    already_relayed: "This exact node had already relayed this exact packet once before — MeshCore's own dedup rule prevents sending the same packet twice.",
    region_mismatch: "This node's configured region(s) don't include the region this message was tagged with, so it wasn't accepted for relay.",
    loop_detect: "This node's own loop-detect hash collided with a hash already present in the packet's path, so real firmware treats it as a likely loop and drops it — note this can trigger on a false-positive hash collision between two unrelated nodes, not just a real loop, especially at a small hash size.",
  };

  function dropReasonLabel(reason) {
    return DROP_REASON_LABELS[reason] || reason;
  }

  // Everything needed to render the reason column: a short badge label, a
  // CSS class for its colour, and a longer explanation shown on hover.
  function receptionOutcome(r) {
    let label, cls, detail;
    if (r.collided) {
      const withLabels = (r.collidedWith || []).map(nodeLabel).join(", ");
      label = "Collided";
      cls = "sim-reason-collided";
      detail = withLabels
        ? `This reception's airtime window overlapped another transmission audible here (from ${withLabels}), corrupting it.`
        : "This reception's airtime window overlapped another transmission audible here, corrupting it.";
    } else if (r.dropReason === "cannot_relay") {
      // Not relaying is this node's normal, intended behaviour (a
      // companion app, or a CoreScope-labelled listener) — receiving it
      // at all is the actual success condition here, so this reads as a
      // clean "Received", not a failure/drop like the other reasons below.
      label = "Received";
      cls = "sim-reason-received";
      detail = "This node doesn't relay by design (a companion device, or a listener-role repeater) — successfully receiving it is what matters here, not relaying it onward.";
    } else if (r.dropReason) {
      label = dropReasonLabel(r.dropReason);
      cls = "sim-reason-dropped";
      detail = DROP_REASON_DETAILS[r.dropReason] || "";
    } else if (r.wasRelayed) {
      label = "Relayed";
      cls = "sim-reason-relayed";
      detail = "This node went on to relay the packet onward to its own neighbours.";
    } else {
      label = "Received";
      cls = "sim-reason-received";
      detail = "Received cleanly; not eligible or needed to relay further.";
    }
    if (r.senderWasCadDeferred) {
      detail += " The sender detected the channel busy (CAD) and delayed its own transmission by at least one retry before sending this.";
    }
    return { label, cls, detail };
  }

  function nodeLabel(nodeIndex) {
    const n = simNodes[nodeIndex];
    return n ? n.label : `#${nodeIndex}`;
  }

  // "Flood time" — how long after the original send this packet was still
  // producing activity anywhere in the network (last reception's AtMs
  // minus the send time), i.e. how long until it stopped flooding.
  function floodTimeMs(packetId) {
    if (!lastReport || !lastMessages || !lastMessages[packetId]) return null;
    const receptions = lastReport.receptions.filter((r) => r.packetId === packetId);
    if (receptions.length === 0) return 0;
    const lastAtMs = Math.max(...receptions.map((r) => r.atMs));
    return lastAtMs - lastMessages[packetId].sendAtMs;
  }

  // The unified TX+RX activity events currently loaded into the packet
  // modal (unfiltered), and whether each row should name which node it
  // belongs to (needed for the per-packet view, where that varies row to
  // row; not needed for the per-node view, where it's implied by the
  // modal's own title) — set by openPacketInspectorForNode/
  // openPacketDetails, read by applyPacketModalFilters whenever the
  // filter controls change.
  let currentPacketModalEvents = [];
  let currentPacketModalShowOpts = { showAt: false };

  function buildTxEvent(packetId, m) {
    return { kind: "tx", atMs: m.sendAtMs, packetId, node: m.origin, message: m };
  }

  function buildRxEvent(r) {
    return { kind: "rx", atMs: r.atMs, packetId: r.packetId, node: r.node, reception: r };
  }

  // Every packet originated at nodeIndex (TX) plus every reception at
  // nodeIndex (RX), merged into one chronological timeline — see
  // openPacketInspectorForNode.
  function buildNodeActivityEvents(nodeIndex) {
    const events = [];
    if (lastMessages) {
      lastMessages.forEach((m, packetId) => {
        if (m.origin === nodeIndex) events.push(buildTxEvent(packetId, m));
      });
    }
    if (lastReport) {
      for (const r of lastReport.receptions) {
        if (r.node === nodeIndex) events.push(buildRxEvent(r));
      }
    }
    events.sort((a, b) => a.atMs - b.atMs);
    return events;
  }

  // This one packet's own send plus every reception of it anywhere — see
  // openPacketDetails.
  function buildPacketActivityEvents(packetId) {
    const events = [];
    if (lastMessages && lastMessages[packetId]) events.push(buildTxEvent(packetId, lastMessages[packetId]));
    if (lastReport) {
      for (const r of lastReport.receptions) {
        if (r.packetId === packetId) events.push(buildRxEvent(r));
      }
    }
    events.sort((a, b) => a.atMs - b.atMs);
    return events;
  }

  function matchesOutcomeFilter(e, outcomeFilter) {
    if (outcomeFilter === "tx") return e.kind === "tx";
    if (e.kind === "tx") return outcomeFilter === ""; // TX rows only show under "All outcomes"
    const r = e.reception;
    switch (outcomeFilter) {
      case "relayed":
        return !r.collided && r.wasRelayed;
      case "collided":
        return r.collided;
      case "dropped":
        // cannot_relay isn't a real drop — see receptionOutcome's own note.
        return !r.collided && !!r.dropReason && r.dropReason !== "cannot_relay";
      case "received":
        return !r.collided && !r.wasRelayed && (!r.dropReason || r.dropReason === "cannot_relay");
      default:
        return true;
    }
  }

  // Re-applies the outcome/node-name filters to whatever's currently
  // loaded and re-renders — called on open and on every filter change.
  function applyPacketModalFilters() {
    const outcomeFilter = document.getElementById("sim-packet-filter-outcome").value;
    const search = document.getElementById("sim-packet-filter-search").value.trim().toLowerCase();
    let filtered = currentPacketModalEvents.filter((e) => matchesOutcomeFilter(e, outcomeFilter));
    if (search) {
      filtered = filtered.filter((e) => {
        const parts = [`packet #${e.packetId}`, nodeLabel(e.node)];
        if (e.kind === "rx") {
          parts.push(nodeLabel(e.reception.fromNode), ...(e.reception.path || []).map(nodeLabel));
        }
        return parts.join(" ").toLowerCase().includes(search);
      });
    }
    const countEl = document.getElementById("sim-packet-filter-count");
    countEl.textContent = filtered.length === currentPacketModalEvents.length ? "" : `Showing ${filtered.length} of ${currentPacketModalEvents.length}.`;
    renderNodeActivityRows(document.getElementById("sim-packet-modal-list"), filtered, currentPacketModalShowOpts);
  }

  // Renders one unified, timestamp-ordered table of TX (sent) and RX
  // (received) events — a single row shape covers both kinds, with a
  // colour-coded TX/RX badge as the only structural difference. Each row
  // drills into that packet's own full details.
  function renderNodeActivityRows(container, events, { showAt, drillTo }) {
    container.innerHTML = "";
    if (events.length === 0) {
      container.innerHTML = `<div class="plan-hint">Nothing to show.</div>`;
      return;
    }
    for (const e of events) {
      const row = document.createElement("div");
      const atLabel = showAt ? `${escapeHtml(nodeLabel(e.node))} · ` : "";
      if (e.kind === "tx") {
        const m = e.message;
        const own = lastReport ? lastReport.receptions.filter((r) => r.packetId === e.packetId) : [];
        const reachedCount = new Set(own.filter((r) => !r.collided).map((r) => r.node)).size;
        const collidedCount = new Set(own.filter((r) => r.collided).map((r) => r.node)).size;
        row.className = "plan-list-item sim-list-item sim-packet-row sim-clean";
        row.innerHTML = `
          <div class="sim-packet-row-top">
            <span class="sim-txrx-badge sim-txrx-tx">TX</span>
            <span class="plan-item-label">Packet #${e.packetId}</span>
            ${m.region ? `<span class="sim-node-badge sim-badge-region">${escapeHtml(m.region)}</span>` : ""}
          </div>
          <div class="sim-packet-row-bottom">
            <span class="sim-packet-context">${atLabel}${m.payloadLen}B · reached ${reachedCount}, collided at ${collidedCount}</span>
            <span class="sim-packet-time">${e.atMs}ms</span>
          </div>
        `;
      } else {
        const r = e.reception;
        const outcome = receptionOutcome(r);
        const pathLabels = (r.path || []).map(nodeLabel).join(" → ");
        row.className = `plan-list-item sim-list-item sim-packet-row ${r.collided ? "sim-collided" : r.dropReason && r.dropReason !== "cannot_relay" ? "sim-dropped" : "sim-clean"}`;
        row.innerHTML = `
          <div class="sim-packet-row-top">
            <span class="sim-txrx-badge sim-txrx-rx">RX</span>
            <span class="plan-item-label">Packet #${r.packetId}</span>
            ${pathLabels ? `<span class="sim-packet-path">${escapeHtml(pathLabels)}</span>` : ""}
          </div>
          <div class="sim-packet-row-bottom">
            <span class="sim-packet-context">${atLabel}from ${escapeHtml(nodeLabel(r.fromNode))}</span>
            <span class="sim-packet-time">${r.atMs}ms</span>
            <span class="sim-packet-hop">hop ${r.hopCount}</span>
            <span class="sim-packet-reason ${outcome.cls}" title="${escapeHtml(outcome.detail)}">${escapeHtml(outcome.label)}${r.senderWasCadDeferred ? " ⏱" : ""}</span>
          </div>
        `;
      }
      row.addEventListener("click", () => {
        if (drillTo === "node") openPacketInspectorForNode(e.node, "drill");
        else openPacketDetails(e.packetId, "drill");
      });
      container.appendChild(row);
    }
  }

  // One row per node in the current scenario, regardless of whether it
  // ever appears in this packet's own reception log — "did everyone get
  // it" at a glance, rather than having to scan the chronological log for
  // absences. Distinguishes the origin (it doesn't "receive" its own
  // send), a clean receive, every attempt colliding, and never being
  // reached at all (out of range / no link).
  function renderPacketChecklist(container, packetId, originIndex) {
    container.innerHTML = "";
    if (simNodes.length === 0) return;
    const receptions = lastReport ? lastReport.receptions.filter((r) => r.packetId === packetId) : [];
    const byNode = new Map();
    for (const r of receptions) {
      const list = byNode.get(r.node) || [];
      list.push(r);
      byNode.set(r.node, list);
    }
    nodesSortedByLabel().forEach(({ n, i }) => {
      const own = byNode.get(i) || [];
      const received = own.some((r) => !r.collided);
      let statusCls, statusLabel, statusDetail;
      if (i === originIndex) {
        statusCls = "sim-checklist-origin";
        statusLabel = "📤 Origin";
        statusDetail = "This node sent the packet.";
      } else if (received) {
        statusCls = "sim-checklist-yes";
        statusLabel = "✓ Received";
        statusDetail = "Received a clean (non-collided) copy of this packet.";
      } else if (own.length > 0) {
        statusCls = "sim-checklist-no";
        statusLabel = "✗ Collided every time";
        statusDetail = `Heard ${own.length} attempt${own.length === 1 ? "" : "s"} at this packet, but every one collided with another transmission.`;
      } else {
        statusCls = "sim-checklist-no";
        statusLabel = "✗ Never reached";
        statusDetail = "No transmission of this packet was ever audible here — out of range, or no link in the current connectivity.";
      }
      const row = document.createElement("div");
      row.className = `plan-list-item sim-checklist-row ${statusCls}`;
      row.innerHTML = `
        <span class="sim-node-badge ${SOURCE_BADGE[n.source]}">${n.source}</span>
        <span class="plan-item-label">${escapeHtml(n.label)}</span>
        <span class="sim-checklist-status" title="${escapeHtml(statusDetail)}">${statusLabel}</span>
      `;
      row.addEventListener("click", () => openPacketInspectorForNode(i, "drill"));
      container.appendChild(row);
    });
  }

  // Lets "Sent from here" / checklist rows drill from one packet-modal
  // view into another (node <-> packet) without losing where you came
  // from — a "fresh" open (marker click, the 📨 action, a Details button
  // elsewhere) resets the trail; drilling within the modal itself pushes
  // the view being left so "← Back" can return to it.
  let packetModalHistory = [];
  let packetModalCurrent = null;

  // mode: "fresh" (a new entry point — marker click, the 📨 action, a
  // Details button elsewhere — resets the trail), "drill" (navigating to
  // another view from within the modal — pushes the view being left so
  // "← Back" can return to it), or "back" (restoring a popped view —
  // touches neither the stack nor packetModalCurrent's push).
  function enterPacketModalView(mode, next) {
    if (mode === "fresh") {
      packetModalHistory = [];
    } else if (mode === "drill" && packetModalCurrent) {
      packetModalHistory.push(packetModalCurrent);
    }
    packetModalCurrent = next;
    const backBtn = document.getElementById("sim-packet-modal-back");
    backBtn.classList.toggle("hidden", packetModalHistory.length === 0);
  }

  function goBackPacketModal() {
    const prev = packetModalHistory.pop();
    if (!prev) return;
    if (prev.kind === "node") openPacketInspectorForNode(prev.nodeIndex, "back");
    else openPacketDetails(prev.packetId, "back");
  }

  function openPacketInspectorForNode(nodeIndex, mode = "fresh") {
    if (!lastReport) return;
    enterPacketModalView(mode, { kind: "node", nodeIndex });
    const n = simNodes[nodeIndex];
    document.getElementById("sim-packet-modal-title").textContent = `Packets at ${n ? n.label : "this node"}`;
    const events = buildNodeActivityEvents(nodeIndex);
    const txCount = events.filter((e) => e.kind === "tx").length;
    const rxEvents = events.filter((e) => e.kind === "rx").map((e) => e.reception);
    const collided = rxEvents.filter((r) => r.collided).length;
    const dropped = rxEvents.filter((r) => !r.collided && r.dropReason && r.dropReason !== "cannot_relay").length;
    const relayed = rxEvents.filter((r) => r.wasRelayed).length;
    document.getElementById("sim-packet-modal-summary").textContent =
      `${txCount} sent · ${rxEvents.length} received · ${relayed} relayed onward · ${collided} collided · ${dropped} dropped.`;

    // The delivery checklist is a per-packet view (every node's status for
    // ONE packet) — doesn't apply here, where the packet is the varying
    // dimension instead.
    document.getElementById("sim-packet-modal-checklist-section").classList.add("hidden");

    document.getElementById("sim-packet-modal-received-title").textContent = "Activity (TX/RX, time order)";
    resetPacketModalFilters();
    currentPacketModalEvents = events;
    currentPacketModalShowOpts = { showAt: false, drillTo: "packet" };
    applyPacketModalFilters();
    openModal("sim-packet-modal");
  }

  function openPacketDetails(packetId, mode = "fresh") {
    if (!lastMessages || !lastMessages[packetId]) return;
    enterPacketModalView(mode, { kind: "packet", packetId });
    const m = lastMessages[packetId];
    const origin = simNodes[m.origin];
    document.getElementById("sim-packet-modal-title").textContent = `Packet #${packetId} details`;
    const flood = floodTimeMs(packetId);
    document.getElementById("sim-packet-modal-summary").textContent =
      `From ${origin ? origin.label : "?"}${m.region ? ` (region ${m.region})` : ""} · ${m.payloadLen}B · sent at ${m.sendAtMs}ms` +
      (flood != null ? ` · flood time ${flood}ms (last activity at ${m.sendAtMs + flood}ms)` : "");

    document.getElementById("sim-packet-modal-checklist-section").classList.remove("hidden");
    renderPacketChecklist(document.getElementById("sim-packet-modal-checklist"), packetId, m.origin);

    document.getElementById("sim-packet-modal-received-title").textContent = "Activity (TX/RX, time order)";
    resetPacketModalFilters();
    currentPacketModalEvents = buildPacketActivityEvents(packetId);
    currentPacketModalShowOpts = { showAt: true, drillTo: "node" };
    applyPacketModalFilters();
    openModal("sim-packet-modal");
  }

  function resetPacketModalFilters() {
    document.getElementById("sim-packet-filter-outcome").value = "";
    document.getElementById("sim-packet-filter-search").value = "";
  }

  function clearSentMessageSelection() {
    selectedPacketId = null;
    simMessagePathLayer.clearLayers();
    document.querySelectorAll(".sim-message-row-selected").forEach((el) => el.classList.remove("sim-message-row-selected"));
  }

  function selectSentMessage(packetId) {
    if (selectedPacketId === packetId) {
      clearSentMessageSelection();
      return;
    }
    selectedPacketId = packetId;
    document.querySelectorAll("#sim-messages-sent-list .plan-list-item").forEach((el) => {
      el.classList.toggle("sim-message-row-selected", Number(el.dataset.packetId) === packetId);
    });
    drawSelectedMessagePath();
  }

  // Redraws whichever message is currently selected against the current
  // simViewMode.filter — split out from selectSentMessage so changing the
  // view filter can refresh the drawn path without re-triggering
  // selectSentMessage's own toggle-off-if-already-selected behaviour.
  function drawSelectedMessagePath() {
    simMessagePathLayer.clearLayers();
    if (selectedPacketId == null || !lastReport) return;
    for (const r of lastReport.receptions.filter((rec) => rec.packetId === selectedPacketId && matchesViewFilter(rec))) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      if (!from || !to) continue;
      const color = r.collided ? "#f87171" : "#4ade80";
      L.polyline([[from.lat, from.lon], [to.lat, to.lon]], { color, weight: r.collided ? 3 : 2, opacity: 0.85 }).addTo(simMessagePathLayer);
      L.circleMarker([to.lat, to.lon], { radius: 8, color, weight: 2, fillColor: color, fillOpacity: 0.5 }).addTo(simMessagePathLayer);
    }
  }

  // --- per-repeater rankings ----------------------------------------
  //
  // Two distinct "contention" measures, deliberately kept separate rather
  // than folded into one score: collisionCount is how often *this node's
  // own* reception failed because something else overlapped it — a direct
  // measure of how bad conditions are for whatever's trying to reach it.
  // contentionCaused is how often *this node's own transmissions* were
  // one of the overlapping causes behind some collision recorded
  // elsewhere (see engine.go's Reception.CollidedWith) — a node can have
  // a spotless collisionCount of its own while still being a genuine
  // source of contention for its neighbours, and that's exactly the case
  // this second column exists to surface.
  let lastRankings = null;
  let rankingsSortKey = "successCount";
  let rankingsSortDir = "desc";

  function computeRankings(report) {
    const perNode = simNodes.map(() => ({ successCount: 0, collisionCount: 0, contentionCaused: 0 }));
    for (const r of report.receptions) {
      if (!perNode[r.node]) continue;
      if (r.collided) perNode[r.node].collisionCount++;
      else perNode[r.node].successCount++;
      for (const other of r.collidedWith || []) {
        if (perNode[other]) perNode[other].contentionCaused++;
      }
    }
    return simNodes.map((n, i) => {
      const p = perNode[i];
      const total = p.successCount + p.collisionCount;
      return {
        nodeIndex: i,
        label: n.label,
        successCount: p.successCount,
        collisionCount: p.collisionCount,
        contentionCaused: p.contentionCaused,
        successRate: total > 0 ? p.successCount / total : null,
      };
    });
  }

  const RANKING_COLUMNS = [
    { key: "label", label: "Repeater" },
    { key: "successCount", label: "Successful", goodHigh: true },
    { key: "collisionCount", label: "Collisions (own)", badHigh: true },
    { key: "contentionCaused", label: "Contention (caused)", badHigh: true },
    { key: "successRate", label: "Success rate", format: (v) => (v == null ? "—" : `${Math.round(v * 100)}%`) },
  ];

  function renderRankingsTableInto(container) {
    if (!lastRankings) {
      container.innerHTML = "";
      return;
    }
    const rows = [...lastRankings].sort((a, b) => {
      const av = a[rankingsSortKey];
      const bv = b[rankingsSortKey];
      const cmp = typeof av === "string" ? av.localeCompare(bv) : (av ?? -1) - (bv ?? -1);
      return rankingsSortDir === "asc" ? cmp : -cmp;
    });
    const thead = RANKING_COLUMNS.map((c) => {
      const sorted = c.key === rankingsSortKey;
      const arrow = sorted ? (rankingsSortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th data-key="${c.key}" class="${sorted ? "sim-rank-sorted" : ""}">${escapeHtml(c.label)}${arrow}</th>`;
    }).join("");
    const tbody = rows
      .map((r) => {
        const cells = RANKING_COLUMNS.map((c) => {
          const raw = r[c.key];
          const display = c.format ? c.format(raw) : escapeHtml(String(raw));
          let cls = "";
          if (c.goodHigh && raw > 0) cls = "sim-rank-good";
          if (c.badHigh && raw > 0) cls = "sim-rank-bad";
          return `<td class="${cls}">${display}</td>`;
        }).join("");
        return `<tr data-node-index="${r.nodeIndex}">${cells}</tr>`;
      })
      .join("");
    container.innerHTML = `<table class="sim-rankings-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
    container.querySelectorAll("th[data-key]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (rankingsSortKey === key) rankingsSortDir = rankingsSortDir === "asc" ? "desc" : "asc";
        else {
          rankingsSortKey = key;
          rankingsSortDir = key === "label" ? "asc" : "desc";
        }
        renderRankingsTableInto(container);
      });
    });
    // Clicking a row pans the map to that repeater — the ranking table
    // doubles as a way to jump straight to a specific under-performer.
    container.querySelectorAll("tbody tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const n = simNodes[Number(tr.dataset.nodeIndex)];
        if (n) map.panTo([n.lat, n.lon]);
      });
    });
  }

  // Rankings only ever render into the full-window view now (see
  // setRankingsFullWindowOpen) — there's no separate small docked table to
  // keep in sync, so unlike the other results this doesn't need a
  // "render into whichever containers happen to be visible" helper.
  function renderRankings(report) {
    lastRankings = computeRankings(report);
    document.getElementById("sim-rankings-expand").classList.toggle("hidden", lastRankings.length === 0);
    if (!document.getElementById("sim-rankings-fullwindow").classList.contains("hidden")) {
      renderRankingsTableInto(document.getElementById("sim-rankings-fullwindow-body"));
    }
  }

  function setRankingsFullWindowOpen(open) {
    document.getElementById("sim-rankings-fullwindow").classList.toggle("hidden", !open);
    if (open) renderRankingsTableInto(document.getElementById("sim-rankings-fullwindow-body"));
  }

  function hideResults() {
    document.getElementById("sim-open-results-modal").classList.add("hidden");
    document.getElementById("sim-open-predictions-modal").classList.add("hidden");
    document.getElementById("sim-open-bottleneck-modal").classList.add("hidden");
    document.getElementById("sim-rankings-expand").classList.add("hidden");
    closeModals();
    setRankingsFullWindowOpen(false);
    removeSimPlaybackControl();
    lastReport = null;
    lastMessages = null;
    lastTuneResult = null;
    lastAttrsList = null;
    stopReplay();
    simResultsLayer.clearLayers(); // also removes every growth marker, since they live in this layer
    growthMarkers.clear();
    nodeGrowthCounts = [];
    currentWaveLines = [];
    clearSentMessageSelection();
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

  // --- growing/greening success markers -----------------------------
  //
  // A repeater that's actually cleanly receiving traffic should read as
  // "doing well" at a glance without opening the results log — each clean
  // (non-collided) reception at a node grows a ring around it and shifts
  // its colour further toward green, so the map itself ends up showing
  // which repeaters are pulling their weight in this scenario and which
  // barely got anything through.
  const GROWTH_BASE_RADIUS = 5;
  const GROWTH_MAX_RADIUS = 22;
  const GROWTH_SATURATES_AT = 12; // successes at which the ring reaches both its max size and full green

  function growthColorAndRadius(count) {
    const t = Math.min(1, count / GROWTH_SATURATES_AT);
    // Dim slate (barely-there) toward a bright green, matching the
    // collision/clean colour convention used elsewhere in this file.
    const from = [100, 116, 139];
    const to = [74, 222, 128];
    const rgb = from.map((c, i) => Math.round(c + (to[i] - c) * t));
    return { color: `rgb(${rgb.join(",")})`, radius: GROWTH_BASE_RADIUS + t * (GROWTH_MAX_RADIUS - GROWTH_BASE_RADIUS) };
  }

  function ensureGrowthMarker(nodeIndex) {
    let marker = growthMarkers.get(nodeIndex);
    if (!marker) {
      const n = simNodes[nodeIndex];
      if (!n) return null;
      marker = L.circleMarker([n.lat, n.lon], { radius: GROWTH_BASE_RADIUS, color: "rgb(100,116,139)", weight: 2, fillOpacity: 0.15, interactive: false }).addTo(simResultsLayer);
      growthMarkers.set(nodeIndex, marker);
    }
    return marker;
  }

  function growNode(nodeIndex) {
    nodeGrowthCounts[nodeIndex] = (nodeGrowthCounts[nodeIndex] || 0) + 1;
    const marker = ensureGrowthMarker(nodeIndex);
    if (!marker) return;
    const { color, radius } = growthColorAndRadius(nodeGrowthCounts[nodeIndex]);
    marker.setStyle({ color, fillColor: color });
    marker.setRadius(radius);
  }

  // A reception "counts" for growth purposes according to
  // simViewMode.growBy — success-mode counts clean receptions,
  // collision-mode counts collided ones (see growNode's own doc comment).
  function matchesGrowBy(r) {
    return simViewMode.growBy === "collision" ? r.collided : !r.collided;
  }

  // A reception is drawn/counted at all according to simViewMode.filter —
  // "all" never excludes anything, "collisions"/"successes" show only
  // that half of what actually happened. Shared by the live replay, the
  // final skip-to-end state, and a selected sent message's own path, so
  // all three stay consistent with whichever view the user picked.
  function matchesViewFilter(r) {
    if (simViewMode.filter === "collisions") return r.collided;
    if (simViewMode.filter === "successes") return !r.collided;
    return true;
  }

  // Draws every growth marker straight at its final size — used by
  // skipToEnd, which (unlike the step-by-step replay) never calls
  // growNode per-wave.
  function applyFinalGrowth(report) {
    nodeGrowthCounts = [];
    for (const r of report.receptions) {
      if (!matchesGrowBy(r)) continue;
      nodeGrowthCounts[r.node] = (nodeGrowthCounts[r.node] || 0) + 1;
    }
    nodeGrowthCounts.forEach((count, nodeIndex) => {
      if (!count) return;
      const marker = ensureGrowthMarker(nodeIndex);
      if (!marker) return;
      const { color, radius } = growthColorAndRadius(count);
      marker.setStyle({ color, fillColor: color });
      marker.setRadius(radius);
    });
  }

  function playWave(wave) {
    if (!simViewMode.keepAllPaths) {
      currentWaveLines.forEach((line) => simResultsLayer.removeLayer(line));
      currentWaveLines = [];
    }
    const from = simNodes[wave.fromNode];
    if (from) pulseAt([from.lat, from.lon], "#a855f7");
    for (const r of wave.receptions) {
      if (!matchesViewFilter(r)) continue;
      const to = simNodes[r.node];
      if (!from || !to) continue;
      const line = L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
      ).addTo(simResultsLayer);
      currentWaveLines.push(line);
      if (r.collided) pulseAt([to.lat, to.lon], "#f87171");
      if (matchesGrowBy(r)) growNode(r.node);
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
      setReplayStatus(replayWaves.length ? "Replay finished — showing final state." : "");
      return;
    }
    const wave = replayWaves[replayIndex];
    playWave(wave);
    setReplayStatus(`Playing… t=${wave.atMs}ms (${replayIndex + 1}/${replayWaves.length})`);
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
    growthMarkers.clear();
    nodeGrowthCounts = [];
    currentWaveLines = [];
    replayWaves = lastReport ? buildWaves(lastReport) : [];
    replayIndex = 0;
    replayStep();
  }

  function skipToEnd() {
    stopReplay();
    redrawResultLines(lastReport); // clears simResultsLayer, so any growth marker made so far is gone too
    growthMarkers.clear();
    currentWaveLines = []; // the lines redrawResultLines just cleared are gone too — nothing left to track
    if (lastReport) applyFinalGrowth(lastReport);
    replayIndex = replayWaves.length;
    setReplayStatus(replayWaves.length ? "Showing final state." : "");
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
    if (simMessageGenerators.length === 0) {
      setStatus("sim-status", "Add at least one message sender first.");
      return;
    }
    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    const trials = Math.min(100, Math.max(1, parseInt(document.getElementById("sim-trials").value, 10) || 20));
    setStatus("sim-status", "Searching for better settings…");
    setPredictProgress(0, 1);
    document.getElementById("sim-predict").disabled = true;

    // Altitude is a nice-to-have for the search (unlocks altitude-
    // conditional rules), not a hard requirement — a failed terrain fetch
    // shouldn't block prediction, just fall back to neighbour-count-only/
    // global rules (attrsFromState tolerates a null grid).
    const grid = await ensureGrid(simNodes).catch(() => null);
    const attrs = attrsFromState(simNodes, grid);

    const generation = ++predictGeneration;
    const worker = ensurePredictWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.generation !== generation) return;
      if (msg.type === "suggest-progress") {
        setPredictProgress(msg.done, msg.total);
      } else if (msg.type === "suggest-result") {
        worker.removeEventListener("message", onMessage);
        hidePredictProgress();
        document.getElementById("sim-predict").disabled = false;
        lastTuneResult = msg.result;
        lastAttrsList = attrs;
        renderSuggestions(msg.result);
        renderPerNodePredictions(msg.result, attrs);
        setStatus("sim-status", "Done.");
        openModal("sim-predictions-modal");
      } else if (msg.type === "suggest-error") {
        worker.removeEventListener("message", onMessage);
        hidePredictProgress();
        document.getElementById("sim-predict").disabled = false;
        setStatus("sim-status", `Predict settings failed: ${msg.message}`);
      }
    }
    worker.addEventListener("message", onMessage);
    worker.postMessage({
      kind: "suggest",
      generation,
      tuneRequest: {
        scenario: scenarioFromState(),
        messages: messagesFromState(seed),
        attrs,
        maxSimTimeMs,
        trials,
        seed,
      },
    });
  }

  function renderSuggestions(result) {
    document.getElementById("sim-open-predictions-modal").classList.remove("hidden");
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
    const list = document.getElementById("sim-per-node-list");
    list.innerHTML = "";
    if (!result.suggestions.length) return;
    const best = result.suggestions[0];
    nodesSortedByLabel().forEach(({ n, i }) => {
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

  // --- ±30s real-activity replay ("literally play in time what happened")
  //
  // CoreScope's own /api/packets has no server-side time-range filter,
  // only limit/offset over its most-recent-first order — so getting
  // "everything within windowMs of targetMs" means growing the page size
  // until the oldest packet fetched is at or before targetMs - windowMs
  // (or giving up at a sane cap, for a target packet old enough that its
  // window has scrolled well off the recent list — whatever coverage was
  // achieved by then is still shown, just possibly missing the window's
  // oldest edge).
  const REAL_TIMELINE_MAX_LIMIT = 4800;

  async function fetchPacketsAroundTime(targetMs, windowMs) {
    let limit = 300;
    for (;;) {
      const resp = await fetch(`/corescope-api/api/packets?limit=${limit}`);
      if (!resp.ok) throw new Error(`packets fetch failed: HTTP ${resp.status}`);
      const data = await resp.json();
      const packets = data.packets || [];
      if (packets.length === 0) return [];
      const withMs = packets.map((p) => ({ p, tMs: Date.parse(p.timestamp) })).filter((x) => !Number.isNaN(x.tMs));
      const oldestMs = Math.min(...withMs.map((x) => x.tMs));
      const inWindow = withMs.filter((x) => x.tMs >= targetMs - windowMs && x.tMs <= targetMs + windowMs).map((x) => x.p);
      if (oldestMs <= targetMs - windowMs || limit >= REAL_TIMELINE_MAX_LIMIT || packets.length < limit) {
        return inWindow;
      }
      limit *= 2;
    }
  }

  // Every hop of every packet observed in the window, in chronological
  // order — the target packet's own hops are tagged isTarget so playback
  // can highlight them distinctly from the surrounding real traffic.
  function buildRealTimeline(windowPackets, targetHash, pubkeyToIndex) {
    const events = [];
    for (const p of windowPackets) {
      const tMs = Date.parse(p.timestamp);
      if (Number.isNaN(tMs)) continue;
      const rawChain = p.resolved_path || [];
      const isTarget = p.hash === targetHash;
      const hops = [];
      for (let i = 0; i < rawChain.length - 1; i++) {
        if (rawChain[i] && rawChain[i + 1]) hops.push([rawChain[i].toLowerCase(), rawChain[i + 1].toLowerCase()]);
      }
      const observerKey = (p.observer_id || "").toLowerCase();
      const lastResolvedHop = [...rawChain].reverse().find((k) => k);
      if (observerKey && lastResolvedHop) hops.push([lastResolvedHop.toLowerCase(), observerKey]);
      for (const [fromKey, toKey] of hops) {
        const f = pubkeyToIndex.get(fromKey);
        const t = pubkeyToIndex.get(toKey);
        if (f == null || t == null) continue;
        events.push({ tMs, from: f, to: t, isTarget, hash: p.hash });
      }
    }
    events.sort((a, b) => a.tMs - b.tMs);
    return events;
  }

  let realTimelineEvents = [];
  let realTimelineIndex = 0;
  let realTimelineTimer = null;
  let realTimelineWindowStartMs = 0;

  function playRealTimelineEvent(e) {
    const from = simNodes[e.from];
    const to = simNodes[e.to];
    if (!from || !to) return;
    const color = e.isTarget ? "#f472b6" : "#94a3b8";
    L.polyline(
      [
        [from.lat, from.lon],
        [to.lat, to.lon],
      ],
      { color, weight: e.isTarget ? 4 : 2, opacity: e.isTarget ? 0.95 : 0.55 }
    ).addTo(simRealActivityLayer);
    if (e.isTarget) pulseAt([to.lat, to.lon], color);
  }

  function realTimelineStep() {
    if (realTimelineIndex >= realTimelineEvents.length) {
      realTimelineTimer = null;
      setStatus("sim-bottleneck-replay-status", realTimelineEvents.length ? "Replay finished — showing the full ±30s window." : "No other real activity found in this packet's ±30s window.");
      return;
    }
    const e = realTimelineEvents[realTimelineIndex];
    playRealTimelineEvent(e);
    const offsetS = ((e.tMs - realTimelineWindowStartMs) / 1000).toFixed(1);
    setStatus(
      "sim-bottleneck-replay-status",
      `Playing… t=+${offsetS}s (${realTimelineIndex + 1}/${realTimelineEvents.length})${e.isTarget ? " · this is the replayed packet" : ""}`
    );
    const next = realTimelineEvents[realTimelineIndex + 1];
    const deltaMs = next ? next.tMs - e.tMs : 0;
    // Compress up to a minute of real wall-clock time into a watchable
    // playback, same clamping approach as the simulator's own replayStep.
    const waitMs = Math.min(1200, Math.max(150, deltaMs / 20));
    realTimelineIndex++;
    realTimelineTimer = setTimeout(realTimelineStep, waitMs);
  }

  function stopRealTimelineReplay() {
    if (realTimelineTimer) {
      clearTimeout(realTimelineTimer);
      realTimelineTimer = null;
    }
  }

  function startRealTimelineReplay() {
    stopRealTimelineReplay();
    simRealActivityLayer.clearLayers();
    realTimelineIndex = 0;
    if (realTimelineEvents.length > 0) realTimelineWindowStartMs = realTimelineEvents[0].tMs;
    realTimelineStep();
  }

  function skipRealTimelineToEnd() {
    stopRealTimelineReplay();
    simRealActivityLayer.clearLayers();
    for (const e of realTimelineEvents) playRealTimelineEvent(e);
    realTimelineIndex = realTimelineEvents.length;
    setStatus("sim-bottleneck-replay-status", realTimelineEvents.length ? "Showing the full ±30s window." : "No other real activity found in this packet's ±30s window.");
  }

  // A small always-on-top legend explaining the map's line colours while
  // the bottleneck analysis is showing — added because a real replay can
  // put four differently-coloured/styled line types on the map at once
  // (proven+modeled, proven+unmodeled, predicted-unconfirmed, plus the
  // ±30s real-activity replay's own target/context colours), which is
  // genuinely hard to read without a key.
  let bottleneckLegendControl = null;

  function ensureBottleneckLegendControl() {
    if (bottleneckLegendControl) return;
    bottleneckLegendControl = L.control({ position: "bottomleft" });
    bottleneckLegendControl.onAdd = function () {
      const div = L.DomUtil.create("div", "sim-bottleneck-legend");
      div.innerHTML = `
        <div class="map-control-header-static">Map key</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#4ade80"></span>Proven &amp; modeled</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#38bdf8"></span>Proven, outside our model</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:#facc15"></span>Predicted, unconfirmed</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#f472b6"></span>Replayed packet (±30s view)</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#94a3b8"></span>Other real traffic (±30s view)</div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    bottleneckLegendControl.addTo(map);
  }

  function removeBottleneckLegendControl() {
    if (bottleneckLegendControl) {
      map.removeControl(bottleneckLegendControl);
      bottleneckLegendControl = null;
    }
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
      let targetMs = null;
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
        if (targetMs === null || tMs < targetMs) targetMs = tMs; // earliest observation = when this packet actually happened
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

      // Everything else CoreScope observed within ±30s of this packet —
      // the surrounding real activity for the "play in time what
      // happened" replay (see startRealTimelineReplay). Fetched now so
      // any additional node it involves gets placed alongside the target
      // packet's own nodes in one pass, rather than needing a second
      // "load more nodes" round-trip.
      const REAL_TIMELINE_WINDOW_MS = 30_000;
      setStatus("sim-replay-hash-status", "Fetching surrounding real activity (±30s)…");
      const windowPackets = await fetchPacketsAroundTime(targetMs, REAL_TIMELINE_WINDOW_MS);
      for (const p of windowPackets) {
        for (const k of p.resolved_path || []) if (k) allPubkeys.add(k.toLowerCase());
        if (p.observer_id) allPubkeys.add(p.observer_id.toLowerCase());
      }

      clearNodes(); // a replay is a fresh investigation, not additive to whatever was already set up
      const pubkeyToIndex = new Map();
      for (const pk of allPubkeys) {
        const info = nodeDir.get(pk);
        if (!info) continue; // CoreScope knows the key but has no position for it — can't place it
        pubkeyToIndex.set(pk, simNodes.length);
        // role (see ensureNodeDirectory) governs canRelay below — a
        // CoreScope-labelled "listener" only ever receives in real life
        // and should never appear as a predicted relay hop, regardless of
        // whether our model's own connectivity would otherwise allow it.
        simNodes.push({ id: randomId(), source: "real", refId: pk, label: info.name, lat: info.lat, lon: info.lon, role: info.role, address: shortAddressFromPubkey(pk) });
      }
      if (!pubkeyToIndex.has(originPubkey)) {
        throw new Error("The packet's origin has no known position — can't place it on the map.");
      }
      renderNodeList();
      renderMessageNodeOptions();
      redrawNodeMarkers();

      realTimelineEvents = buildRealTimeline(windowPackets, hash, pubkeyToIndex);
      stopRealTimelineReplay();
      simRealActivityLayer.clearLayers();
      document.getElementById("sim-bottleneck-replay-section").classList.toggle("hidden", realTimelineEvents.length === 0);
      setStatus(
        "sim-bottleneck-replay-status",
        realTimelineEvents.length
          ? `${windowPackets.length} real packet${windowPackets.length === 1 ? "" : "s"} observed within ±30s — ready to replay.`
          : ""
      );

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
      ensureBottleneckLegendControl();
      openModal("sim-bottleneck-modal");
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

    document.getElementById("sim-open-bottleneck-modal").classList.remove("hidden");
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

  // Replay status is shown in two places at once — the Results modal and
  // the map-docked playback control (see ensureSimPlaybackControl, only
  // present once a report exists) — kept in sync by always going through
  // this rather than setStatus directly.
  function setReplayStatus(text) {
    setStatus("sim-replay-status", text);
    const mapStatus = document.getElementById("sim-map-replay-status");
    if (mapStatus) mapStatus.textContent = text;
  }

  // --- modal system --------------------------------------------------
  //
  // Every heavier chunk of the simulator's own output (results, bottleneck
  // analysis, predicted settings, repeater config) lives in its own modal
  // rather than a permanently-docked section, so the side panel itself
  // stays a short, fixed list of controls instead of growing a long
  // scrolling stack of mostly-empty sections. Only one modal is open at a
  // time — opening a new one closes whichever was already up.
  function openModal(id) {
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    document.getElementById(id).classList.remove("hidden");
    document.getElementById("sim-modal-backdrop").classList.remove("hidden");
  }

  function closeModals() {
    document.getElementById("sim-modal-backdrop").classList.add("hidden");
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
  }

  // --- "Simulator view" map control --------------------------------------
  //
  // A Map-detail-style control, but only ever present while Simulate mode
  // itself is open (created/destroyed alongside it, see setSimPanelOpen) —
  // it has nothing to say about the base coverage map. Lets the *view* of
  // a run's results be changed without re-running anything: which
  // dimension a growth marker tracks, whether old wave lines stay on the
  // map as a trail or only the latest wave shows, and which half of what
  // happened (successes/collisions) is shown at all.
  let simViewControl = null;

  function ensureSimViewControl() {
    if (simViewControl) return;
    simViewControl = L.control({ position: "topright" });
    simViewControl.onAdd = function () {
      const div = L.DomUtil.create("div", "position-mode-control sim-view-control");
      const body = `
        <label class="plan-checkbox-row"><input type="checkbox" id="sim-view-keep-paths" checked> Keep all paths</label>
        <div class="plan-section-title">Show</div>
        <select id="sim-view-filter">
          <option value="all">All</option>
          <option value="successes">Successes only</option>
          <option value="collisions">Collisions only</option>
        </select>
        <div class="plan-section-title">Grow circles by</div>
        <select id="sim-view-grow-by">
          <option value="success">Successful receptions</option>
          <option value="collision">Collisions (most-collided repeater)</option>
        </select>
      `;
      div.innerHTML = window.HopReachMapControls.collapsibleHtml("Simulator view", body, "sim-view");
      L.DomEvent.disableClickPropagation(div);
      window.HopReachMapControls.wireCollapsible(div);

      div.querySelector("#sim-view-keep-paths").addEventListener("change", (e) => {
        simViewMode.keepAllPaths = e.target.checked;
      });
      div.querySelector("#sim-view-filter").addEventListener("change", (e) => {
        simViewMode.filter = e.target.value;
        // Re-render whatever's currently on screen against the new
        // filter — a live replay in progress just keeps going (its next
        // wave picks the new filter up naturally), but a static
        // skip-to-end view or a selected message's own path needs an
        // explicit refresh to actually reflect the change.
        if (lastReport && replayIndex >= replayWaves.length) {
          redrawResultLines(lastReport);
          applyFinalGrowth(lastReport);
        }
        drawSelectedMessagePath();
      });
      div.querySelector("#sim-view-grow-by").addEventListener("change", (e) => {
        simViewMode.growBy = e.target.value;
        growthMarkers.forEach((marker) => simResultsLayer.removeLayer(marker));
        growthMarkers.clear();
        nodeGrowthCounts = [];
        if (lastReport) applyFinalGrowth(lastReport);
      });
      return div;
    };
    simViewControl.addTo(map);
  }

  function removeSimViewControl() {
    if (simViewControl) {
      map.removeControl(simViewControl);
      simViewControl = null;
    }
  }

  // --- map-docked playback + live reception log --------------------------
  //
  // Watching a replay used to mean either staring at the map with no
  // controls in view (they're all in the Results modal, which sits over
  // the map) or opening/closing the modal to check the log — this puts
  // Replay/Skip-to-end and a live-updating log right on the map itself,
  // bottom-right, appearing only once there's an actual report to show.
  let simPlaybackControl = null;

  function ensureSimPlaybackControl() {
    if (simPlaybackControl) return;
    simPlaybackControl = L.control({ position: "bottomright" });
    simPlaybackControl.onAdd = function () {
      const div = L.DomUtil.create("div", "sim-playback-control");
      const logBody = `<div id="sim-map-results-log" class="plan-list sim-map-results-log"></div>`;
      div.innerHTML = `
        <div class="plan-row sim-playback-buttons">
          <button id="sim-map-replay" title="Watch the flood propagate again from the start">▶ Replay</button>
          <button id="sim-map-skip-to-end" title="Jump straight to the final state">⏭ Skip to end</button>
        </div>
        <div class="plan-hint" id="sim-map-replay-status"></div>
        ${window.HopReachMapControls.collapsibleHtml("Reception log", logBody, "sim-reception-log")}
      `;
      L.DomEvent.disableClickPropagation(div);
      window.HopReachMapControls.wireCollapsible(div);
      div.querySelector("#sim-map-replay").addEventListener("click", startReplay);
      div.querySelector("#sim-map-skip-to-end").addEventListener("click", skipToEnd);
      return div;
    };
    simPlaybackControl.addTo(map);
  }

  function removeSimPlaybackControl() {
    if (simPlaybackControl) {
      map.removeControl(simPlaybackControl);
      simPlaybackControl = null;
    }
  }

  function setSimPanelOpen(open) {
    document.getElementById("sim-panel").classList.toggle("hidden", !open);
    document.getElementById("map-wrap").classList.toggle("sim-open", open);
    if (open) {
      if (window.HopReachPlanner) window.HopReachPlanner.closePanel();
      simNodesLayer.addTo(map);
      simResultsLayer.addTo(map);
      simMessagePathLayer.addTo(map);
      ensureSimViewControl();
      if (lastReport) ensureSimPlaybackControl(); // reopening Simulate mode with a report already computed
    } else {
      setPlacementMode("off");
      stopReplay();
      closeModals();
      setRankingsFullWindowOpen(false);
      map.removeLayer(simNodesLayer);
      map.removeLayer(simResultsLayer);
      map.removeLayer(simMessagePathLayer);
      map.removeLayer(simRealActivityLayer);
      stopRealTimelineReplay();
      removeBottleneckLegendControl();
      removeSimViewControl();
      removeSimPlaybackControl();
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

  document.getElementById("sim-packet-filter-outcome").addEventListener("change", applyPacketModalFilters);
  document.getElementById("sim-packet-filter-search").addEventListener("input", applyPacketModalFilters);

  document.getElementById("sim-setup-select").addEventListener("change", (e) => {
    if (e.target.value) loadSetup(e.target.value);
  });
  document.getElementById("sim-setup-new").addEventListener("click", newSetup);
  document.getElementById("sim-setup-save").addEventListener("click", saveCurrentSetup);
  document.getElementById("sim-setup-delete").addEventListener("click", deleteCurrentSetup);
  document.getElementById("sim-setup-export").addEventListener("click", exportCurrentSetup);
  document.getElementById("sim-setup-import-btn").addEventListener("click", () => document.getElementById("sim-setup-import-file").click());
  document.getElementById("sim-setup-import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported.nodes)) throw new Error("not a valid setup file");
      importSetupFromFile(imported);
    } catch (err) {
      alert(`Could not import setup: ${err.message || err}`);
    }
    e.target.value = "";
  });

  document.getElementById("sim-load-planned").addEventListener("click", loadPlannedRepeaters);
  document.getElementById("sim-load-real").addEventListener("click", loadRealRepeaters);
  document.getElementById("sim-add-companion").addEventListener("click", () => setPlacementMode("companion"));
  document.getElementById("sim-nodes-clear").addEventListener("click", clearNodes);
  document.getElementById("sim-build-links").addEventListener("click", buildLinks);
  document.getElementById("sim-message-add").addEventListener("click", addMessage);
  document.getElementById("sim-message-cancel-edit").addEventListener("click", cancelEditSender);
  document.getElementById("sim-run").addEventListener("click", runSimulation);
  document.getElementById("sim-predict").addEventListener("click", predictSettings);
  document.getElementById("sim-replay").addEventListener("click", startReplay);
  document.getElementById("sim-skip-to-end").addEventListener("click", skipToEnd);
  document.getElementById("sim-replay-hash-go").addEventListener("click", replayFromHash);
  document.getElementById("sim-packet-modal-back").addEventListener("click", goBackPacketModal);
  document.getElementById("sim-bottleneck-replay").addEventListener("click", startRealTimelineReplay);
  document.getElementById("sim-bottleneck-replay-skip").addEventListener("click", skipRealTimelineToEnd);
  document.getElementById("sim-rankings-expand").addEventListener("click", () => setRankingsFullWindowOpen(true));
  document.getElementById("sim-rankings-collapse").addEventListener("click", () => setRankingsFullWindowOpen(false));

  document.getElementById("sim-open-nodes-modal").addEventListener("click", () => openNodesModal());
  document.getElementById("sim-nodes-modal-apply").addEventListener("click", applyNodesModalTable);
  document.getElementById("sim-bulk-apply-fill").addEventListener("click", fillAllRowsFromBulkApply);
  document.getElementById("sim-open-messages-modal").addEventListener("click", () => {
    cancelEditSender(); // always open with a clean "add" form, not mid-edit from a previous visit
    openModal("sim-messages-modal");
  });
  document.getElementById("sim-open-results-modal").addEventListener("click", () => openModal("sim-results-modal"));
  document.getElementById("sim-open-predictions-modal").addEventListener("click", () => openModal("sim-predictions-modal"));
  document.getElementById("sim-open-bottleneck-modal").addEventListener("click", () => openModal("sim-bottleneck-modal"));
  document.getElementById("sim-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "sim-modal-backdrop") closeModals();
  });
  document.querySelectorAll("#sim-modal-backdrop [data-close]").forEach((btn) => btn.addEventListener("click", closeModals));

  initSimScopeFilter();
  renderNodeList();
  renderMessageList();
  refreshSetupSelect();

  // Test-only introspection hook.
  window.__hopreachSimulatorDebug = {
    getNodeCount: () => simNodes.length,
    getLinkCount: () => simLinks.length,
    getMessageCount: () => messagesFromState(parseInt(document.getElementById("sim-seed").value, 10) || 0).length,
    getMessageGeneratorCount: () => simMessageGenerators.length,
    getLastReport: () => lastReport,
    getWaveCount: () => replayWaves.length,
    getNodes: () => simNodes,
    getLinks: () => simLinks,
    panBy: (dx, dy) => map.panBy([dx, dy], { animate: false }),
    getSavedSetups: () => loadAllSetups(),
  };
})();
