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
  // Mirrors internal/meshsim's own defaultMessageHashSize (engine.go) — a
  // sender with no explicit hash size falls back to this. 3 bytes,
  // deliberately diverging from real firmware (which has no built-in
  // default; every real sendFlood caller passes one explicitly) to
  // minimise hash collisions between unrelated repeaters by default — see
  // docs/SIMULATOR_PLAN_PHASE3.md.
  const DEFAULT_MESSAGE_HASH_SIZE = 3;

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
  // A reconstructed CoreScope episode (see reconstructEpisodeFromWindow):
  // provenance plus the real observations needed to compare our simulation
  // against what actually happened. null unless an episode is loaded.
  let lastEpisode = null;
  // A pinned baseline run's problem counts, for the before/after delta (see
  // renderEpisodeAnalysis / setEpisodeBaseline). null until pinned.
  let episodeBaseline = null;
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
  // The last runStressTest() result (item 15b) — kept around purely so
  // reopening #sim-stress-modal doesn't need a fresh sweep.
  let lastStressResult = null;

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

  // Sends one message to worker and resolves with its matching reply's
  // own `result` field — a single request/response round-trip, not a
  // progress-reporting search like suggest/stress/suggestPolicy each
  // have their own bespoke onmessage handler for. Built for the adaptive
  // optimizer (docs/SIMULATOR_PLAN_PHASE4.md work item 4): each ROUND is
  // its own such round-trip, driven by runOptimizeAdaptive's own loop —
  // see that function's own comment on why the loop lives here in JS and
  // not inside the worker.
  function workerRequest(worker, generation, message, resultType, errorType) {
    return new Promise((resolve, reject) => {
      function onMessage(e) {
        const msg = e.data;
        if (msg.generation !== generation) return;
        if (msg.type === resultType) {
          worker.removeEventListener("message", onMessage);
          resolve(msg.result);
        } else if (msg.type === errorType) {
          worker.removeEventListener("message", onMessage);
          reject(new Error(msg.message));
        }
      }
      worker.addEventListener("message", onMessage);
      worker.postMessage(message);
    });
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

  function setStressProgress(done, total) {
    const el = document.getElementById("sim-stress-progress");
    el.classList.remove("hidden");
    document.getElementById("sim-stress-progress-text").textContent = `Sweeping… ${done}/${total} load levels`;
    document.getElementById("sim-stress-progress-fill").style.width = `${Math.max(2, (done / total) * 100)}%`;
  }

  function hideStressProgress() {
    document.getElementById("sim-stress-progress").classList.add("hidden");
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
      // regions: ["*"] — a planned repeater's real region config is
      // unknown, so default to accepting every scope rather than silently
      // dropping all scoped traffic (see SimNode.Regions' own doc comment
      // on the "*" wildcard). Editable afterwards in the nodes modal same
      // as a real repeater's observed scopes.
      // antennaHeightM (mast height above ground) is threaded through from
      // the plan — the model link builder uses it per-node on BOTH ends of
      // a link (see nodeAntennaHeightM/buildLinksFromModel). Previously
      // dropped here, so every repeater was simulated at the global default
      // height regardless of the mast the user configured — badly wrong for
      // the repeater-to-repeater links the flood sim is entirely about.
      simNodes.push({ id: randomId(), source: "planned", refId: r.id, label: r.label, lat: r.lat, lon: r.lon, antennaHeightM: r.antennaHeightM ?? null, regions: ["*"], address: generatedShortAddress() });
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
      // denyUnscoped: !r.observedUnscoped — a real repeater never yet
      // observed relaying a plain flood defaults to unscoped disabled (the
      // user's own rule: absence of evidence over a real, if imperfect,
      // observation window is the best signal available — see
      // corescope.ObservedUnscoped and planner.js's own comment on this
      // field). Shown/editable afterwards as "derived by absence" in the
      // nodes modal, not asserted the way observed scopes are.
      simNodes.push({
        id: randomId(), source: "real", refId: r.id, label: r.label, lat: r.lat, lon: r.lon,
        antennaHeightM: r.antennaHeightM ?? null, // a repositioned real repeater may carry an override mast height; otherwise the default applies
        regions: r.scopes || [], hashSize: r.hashSize || null, denyUnscoped: !r.observedUnscoped,
        address: shortAddressFromPubkey(r.id),
      });
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
    // regions doesn't actually gate anything for a companion (CanRelay is
    // always false for source:"companion", so acceptsRegion is never even
    // consulted for its own relay decision — see canRelay/engine.go's
    // cannot_relay check ordering) — set the same "*" wildcard anyway so
    // the nodes modal's Scopes column doesn't show a misleading empty/deny
    // state for it.
    simNodes.push({ id: randomId(), source: "companion", refId: randomId(), label: `Companion ${companionCounter}`, lat, lon, regions: ["*"], address: generatedShortAddress() });
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
    lastEpisode = null;
    episodeBaseline = null;
    document.getElementById("sim-open-episode-modal").classList.add("hidden");
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
    // currentSetupId is an in-memory JS variable, not persisted — after a
    // page reload (or on first load ever) it's null even though the
    // dropdown's own saved-setup LIST survives in localStorage. Without an
    // explicit placeholder, a plain <select> with no option marked
    // `selected` defaults to visually highlighting the FIRST real entry —
    // which looks exactly like that setup is loaded when in fact nothing
    // is (the live workspace is still empty). That's actively misleading,
    // and because most browsers don't fire a `change` event when a native
    // dropdown click re-picks whatever's already showing, a user in that
    // state clicking the visually-already-selected item does nothing —
    // the setup never actually loads and there's no obvious way to make
    // it load short of picking a different entry and picking back. Adding
    // a real, disabled placeholder here means the browser's own default-
    // select-first-option behaviour lands on that placeholder instead,
    // which is honest ("nothing loaded yet") and is itself a distinct
    // option value, so picking the setup you actually want always fires a
    // real change event.
    const matchesCurrent = ids.includes(currentSetupId);
    if (!matchesCurrent) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a saved setup to load…";
      placeholder.disabled = true;
      placeholder.selected = true;
      sel.appendChild(placeholder);
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
      // A reconstructed CoreScope episode's provenance + real observations,
      // so reloading the setup restores the actual-vs-predicted comparison
      // (docs/SIMULATOR_PLAN_PHASE8.md work item 5). Already plain
      // arrays/objects, so it serialises directly.
      episode: lastEpisode || undefined,
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
    document.getElementById("sim-connectivity-source").value = s.connectivitySource || "blend";
    document.getElementById("sim-seed").value = s.seed != null ? s.seed : 1;
    document.getElementById("sim-max-time").value = s.maxSimTimeMs != null ? s.maxSimTimeMs : 60000;
    document.getElementById("sim-trials").value = s.trials != null ? s.trials : 20;
    document.getElementById("sim-setup-name").value = s.name || "";
    cachedGrid = null; // stale for this node set even if links came along

    // Restore (or clear) the reconstructed-episode analysis for this setup.
    lastEpisode = s.episode || null;
    episodeBaseline = null;
    document.getElementById("sim-open-episode-modal").classList.toggle("hidden", !lastEpisode);

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
      // Phase 3 — path-hash size is a property of the MESSAGE (the
      // originator stamps it onto the packet at send time; real firmware:
      // Mesh::sendFlood(packet, delay, path_hash_size)), not of the
      // repeater sending it — a relay appends its own hash at the
      // packet's own size, never its own configured one, so a single
      // path can never mix hash sizes hop to hop. See
      // docs/SIMULATOR_PLAN_PHASE3.md.
      const hashSizeBadge = ` <span class="sim-node-badge sim-badge-hashsize" title="Path-hash size this sender stamps onto its own packets — one size applies to the whole path">${g.hashSize || DEFAULT_MESSAGE_HASH_SIZE}B</span>`;
      if (g.fixed) {
        // A reconstructed real transmission (see reconstructEpisodeFromWindow)
        // — one packet at an absolute time, not a random generator. Rendered
        // distinctly, and not editable via the random-sender form.
        const kindBadge = g.background
          ? ` <span class="sim-node-badge sim-badge-background" title="Fixed background transmission of real surrounding traffic — occupies the channel but isn't itself simulated as a flood">background</span>`
          : ` <span class="sim-node-badge sim-badge-real" title="Reconstructed real flood sender">real flood</span>`;
        row.innerHTML = `
          <span class="plan-item-label">${escapeHtml(node ? node.label : "?")}${g.background ? "" : hashSizeBadge}${kindBadge}${g.region ? ` <span class="sim-node-badge sim-badge-region">scoped</span>` : ""}</span>
          <span class="plan-item-sub">@ ${((g.atMs || 0) / 1000).toFixed(1)}s · ${g.background ? `${g.frameBytes || 0}B on air` : `${g.payloadLen || 0}B payload`}${g.sourceHash ? ` · ${escapeHtml(g.sourceHash.slice(0, 8))}` : ""}</span>
          <span class="plan-item-actions">
            <button data-act="remove" title="Remove">✕</button>
          </span>
        `;
        row.querySelector('[data-act="remove"]').onclick = () => {
          simMessageGenerators = simMessageGenerators.filter((x) => x.id !== g.id);
          renderMessageList();
        };
        list.appendChild(row);
        continue;
      }
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(node ? node.label : "?")}${hashSizeBadge}${g.region ? ` <span class="sim-node-badge sim-badge-region">${escapeHtml(g.region)}</span>` : ""}${g.direct ? ` <span class="sim-node-badge sim-badge-direct">direct</span>` : ""}</span>
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
    document.getElementById("sim-message-route-type").value = g.direct ? "direct" : "flood";
    document.getElementById("sim-message-hash-size").value = String(g.hashSize || DEFAULT_MESSAGE_HASH_SIZE);
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
    const direct = document.getElementById("sim-message-route-type").value === "direct";
    const hashSizeRaw = parseInt(document.getElementById("sim-message-hash-size").value, 10);
    const hashSize = hashSizeRaw >= 1 && hashSizeRaw <= 3 ? hashSizeRaw : DEFAULT_MESSAGE_HASH_SIZE;
    const count = Math.min(500, Math.max(1, parseInt(document.getElementById("sim-message-count").value, 10) || 1));
    let minPayload = Math.min(255, Math.max(1, parseInt(document.getElementById("sim-message-payload-min").value, 10) || 1));
    let maxPayload = Math.min(255, Math.max(1, parseInt(document.getElementById("sim-message-payload-max").value, 10) || minPayload));
    if (maxPayload < minPayload) [minPayload, maxPayload] = [maxPayload, minPayload];
    let minGapMs = Math.max(0, parseInt(document.getElementById("sim-message-gap-min").value, 10) || 0);
    let maxGapMs = Math.max(0, parseInt(document.getElementById("sim-message-gap-max").value, 10) || minGapMs);
    if (maxGapMs < minGapMs) [minGapMs, maxGapMs] = [maxGapMs, minGapMs];

    if (editingGeneratorId) {
      const g = simMessageGenerators.find((x) => x.id === editingGeneratorId);
      if (g) Object.assign(g, { nodeIndex, region, direct, hashSize, count, minPayload, maxPayload, minGapMs, maxGapMs });
      cancelEditSender();
    } else {
      simMessageGenerators.push({ id: randomId(), nodeIndex, region, direct, hashSize, count, minPayload, maxPayload, minGapMs, maxGapMs });
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
  // Deliberate divergence from real firmware, which defaults loop.detect
  // to off (docs.meshcore.io/cli_commands) — a simulator run with loop
  // detect entirely disabled by default doesn't surface the
  // loop-suppression behaviour most real deployments actually want to
  // reason about. Explicitly selecting "off" in the settings table still
  // means off; this only governs a node with no explicit choice made yet.
  // See docs/SIMULATOR_PLAN_PHASE3.md. internal/meshsim's own
  // loopDetectThreshold is NOT changed to match — an empty LoopDetect
  // there must keep meaning "never triggers" so an explicit "off" set
  // from here is honoured, not silently upgraded.
  const DEFAULT_LOOP_DETECT = "minimal";

  function renderNodesModalTable() {
    const tbody = document.getElementById("sim-nodes-modal-tbody");
    tbody.innerHTML = "";
    document.getElementById("sim-results-col-duty").classList.toggle("hidden", !lastReport);
    document.getElementById("sim-results-col-received").classList.toggle("hidden", !lastReport);
    if (simNodes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="15" class="plan-empty">None yet — load repeaters or place a companion location, then reopen this.</td></tr>';
      return;
    }
    // Read-only result columns (item 16) — computed once for the whole
    // table rather than per row; empty/unused unless a report exists.
    const rankingByNode = lastReport ? computeRankings(lastReport) : null;
    nodesSortedByLabel().forEach(({ n, i: nodeIndex }) => {
      const prefs = effectivePrefsFor(n);
      let predictedTitle = "";
      if (lastTuneResult && lastTuneResult.suggestions.length && lastAttrsList && lastAttrsList[nodeIndex]) {
        const best = lastTuneResult.suggestions[0];
        if (ruleMatchesAttrs(best.rule, lastAttrsList[nodeIndex])) {
          const predicted = applyRule(defaultPrefs(), best.rule, lastAttrsList[nodeIndex]);
          predictedTitle = `Predicted (${best.rule.name}): txdelay ${predicted.txDelayFactor.toFixed(2)} · rxdelay ${predicted.rxDelayBase.toFixed(1)}`;
        }
      }
      const loopDetect = effectiveLoopDetect(n);
      const loopDetectOptions = LOOP_DETECT_LEVELS.map((lvl) => `<option value="${lvl}" ${lvl === loopDetect ? "selected" : ""}>${lvl}</option>`).join("");
      const regions = effectiveRegions(n);
      const denyUnscoped = effectiveDenyUnscoped(n);
      const floodMax = effectiveFloodMax(n);
      const floodMaxUnscoped = effectiveFloodMaxUnscoped(n);
      const presetLabel = radioPresetLabelFor(prefs.radio);
      const radioPresetOptions = RADIO_PRESETS.map((p) => `<option value="${escapeHtml(p.label)}" ${p.label === presetLabel ? "selected" : ""}>${escapeHtml(p.label)}</option>`).join("");
      const ranking = rankingByNode ? rankingByNode[nodeIndex] : null;
      const dutyCell = ranking ? `<td class="sim-results-col">${ranking.dutyCyclePct.toFixed(1)}%</td>` : `<td class="sim-results-col hidden"></td>`;
      const receivedCell = ranking
        ? `<td class="sim-results-col">${ranking.deliveryRatio == null ? "—" : `${ranking.deliveredCount}/${ranking.reachableCount} (${Math.round(ranking.deliveryRatio * 100)}%)`}</td>`
        : `<td class="sim-results-col hidden"></td>`;
      const tr = document.createElement("tr");
      tr.dataset.nodeId = n.id;
      tr.innerHTML = `
        <td class="sim-col-sticky"><span class="sim-node-badge ${SOURCE_BADGE[n.source]}">${n.source}</span> <span title="${n.address ? `Address: ${n.address}` : "No address"}">${escapeHtml(n.label)}</span></td>
        <td><input type="text" data-field="regions" value="${escapeHtml(regionsToDisplayString(regions))}" placeholder="all (*)" title="Comma-delimited region list, no # (e.g. sco, ioi). Blank = holds no region key (still relays unscoped traffic unless Allow unscoped is off). * = accept every region."></td>
        <td class="sim-checkbox-cell"><input type="checkbox" data-field="allowUnscoped" ${denyUnscoped ? "" : "checked"} title="Whether this node relays ordinary unscoped (regionless) flood traffic. For a real repeater, defaults to off unless CoreScope has actually observed it doing so — absence over the observation window isn't proof of denial, just the best signal available."></td>
        <td><input type="number" step="1" min="1" data-field="floodMax" value="${floodMax || ""}" placeholder="64" title="flood.max — blank uses the firmware default (64)"></td>
        <td><input type="number" step="1" min="1" data-field="floodMaxUnscoped" value="${floodMaxUnscoped || ""}" placeholder="64" title="flood.max.unscoped — blank uses the firmware default (64); only gates unscoped traffic, additional to flood.max"></td>
        <td class="sim-radio-cell">
          <select data-field="radioPreset" class="sim-radio-preset-select" title="Radio preset"><option value="">Custom</option>${radioPresetOptions}</select>
          <div class="sim-radio-fields">
            <input type="number" step="0.001" data-field="radioFreqMhz" value="${prefs.radio.freqMhz}" title="Frequency (MHz)">
            <input type="number" step="0.1" data-field="radioBwKhz" value="${prefs.radio.bwKhz}" title="Bandwidth (kHz)">
            <input type="number" step="1" min="5" max="12" data-field="radioSf" value="${prefs.radio.sf}" title="Spreading factor">
            <input type="number" step="1" min="5" max="8" data-field="radioCr" value="${prefs.radio.cr}" title="Coding rate denominator">
          </div>
        </td>
        <td><input type="number" step="0.05" min="0" max="2" data-field="txDelayFactor" value="${prefs.txDelayFactor}" title="${escapeHtml(predictedTitle)}"></td>
        <td><input type="number" step="0.05" min="0" max="2" data-field="directTxDelayFactor" value="${prefs.directTxDelayFactor}"></td>
        <td><input type="number" step="0.5" min="0" max="20" data-field="rxDelayBase" value="${prefs.rxDelayBase}" title="${escapeHtml(predictedTitle)}"></td>
        <td><input type="number" step="1" min="1" max="22" data-field="txPowerDbm" value="${prefs.txPowerDbm}"></td>
        <td><select data-field="loopDetect" title="Real firmware defaults to off (docs.meshcore.io's loop.detect) — this simulator starts new repeaters at minimal instead; pick off explicitly to match firmware">${loopDetectOptions}</select></td>
        <td><input type="number" step="1" min="1" max="3" data-field="hashSize" value="${effectiveHashSize(n)}" title="Bytes — this repeater's own path-hash size for packets IT originates (set hash_size). Seeds the Message senders form's default when this repeater is picked as a sender. Does not affect loop.detect on packets it merely relays; that's governed by each sender's own hash size instead."></td>
        ${dutyCell}
        ${receivedCell}
        <td>
          ${lastReport ? '<button data-act="packets" title="See packets received here">📨</button>' : ""}
          ${n.source === "companion" ? '<button data-act="rename" title="Rename">✎</button>' : ""}
          <button data-act="remove" title="Remove">✕</button>
        </td>
      `;
      const presetSelect = tr.querySelector('[data-field="radioPreset"]');
      const radioInputs = {
        freqMhz: tr.querySelector('[data-field="radioFreqMhz"]'),
        bwKhz: tr.querySelector('[data-field="radioBwKhz"]'),
        sf: tr.querySelector('[data-field="radioSf"]'),
        cr: tr.querySelector('[data-field="radioCr"]'),
      };
      presetSelect.addEventListener("change", () => {
        const preset = RADIO_PRESETS.find((p) => p.label === presetSelect.value);
        if (!preset) return; // "Custom" chosen explicitly — leave the current field values alone
        radioInputs.freqMhz.value = preset.freqMhz;
        radioInputs.bwKhz.value = preset.bwKhz;
        radioInputs.sf.value = preset.sf;
        radioInputs.cr.value = preset.cr;
      });
      Object.values(radioInputs).forEach((el) => el.addEventListener("input", () => { presetSelect.value = ""; }));
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
    let radioChanged = false;
    tbody.querySelectorAll("tr[data-node-id]").forEach((tr) => {
      const n = simNodes.find((x) => x.id === tr.dataset.nodeId);
      if (!n) return;
      const override = {};
      const beforePrefs = effectivePrefsFor(n);
      const beforeRadio = beforePrefs.radio;
      const radio = { ...beforeRadio };
      let radioTouched = false;
      tr.querySelectorAll("[data-field]").forEach((el) => {
        const field = el.dataset.field;
        switch (field) {
          case "regions":
            override.regions = regionsFromDisplayString(el.value);
            break;
          case "allowUnscoped":
            override.denyUnscoped = !el.checked;
            break;
          case "floodMax":
          case "floodMaxUnscoped": {
            const v = parseInt(el.value, 10);
            override[field] = Number.isFinite(v) && v > 0 ? v : 0;
            break;
          }
          case "radioPreset":
            break; // UI-only — the live change listener already updated the 4 fields below
          case "radioFreqMhz":
            radio.freqMhz = parseFloat(el.value) || radio.freqMhz;
            radioTouched = true;
            break;
          case "radioBwKhz":
            radio.bwKhz = parseFloat(el.value) || radio.bwKhz;
            radioTouched = true;
            break;
          case "radioSf": {
            const v = parseInt(el.value, 10);
            if (Number.isFinite(v)) radio.sf = v;
            radioTouched = true;
            break;
          }
          case "radioCr": {
            const v = parseInt(el.value, 10);
            if (Number.isFinite(v)) radio.cr = v;
            radioTouched = true;
            break;
          }
          default:
            if (el.tagName === "SELECT") {
              override[field] = el.value;
            } else {
              const v = parseFloat(el.value);
              if (!Number.isNaN(v)) override[field] = v;
            }
        }
      });
      if (radioTouched) override.radio = radio;
      simNodePrefsOverrides[n.id] = override;
      // A modelled link's baked-in SNR depends on the receiver's SF (see
      // receiverSf) and each node's own tx power (buildLinksFromModel's
      // txPowerDelta) — so those must invalidate the built links. But EVERY
      // row carries radio inputs, so "a radio field was present" is not a
      // change: compare the applied values to what the node already had, and
      // only invalidate on a REAL radio/power difference. Otherwise a
      // flood.max / loop.detect / hash-size edit would wrongly wipe the
      // connectivity (which for a reconstructed episode is precious real
      // proven topology that "Build links" can't recreate).
      const radioReallyChanged =
        radio.freqMhz !== beforeRadio.freqMhz || radio.bwKhz !== beforeRadio.bwKhz || radio.sf !== beforeRadio.sf || radio.cr !== beforeRadio.cr;
      const powerReallyChanged = override.txPowerDbm != null && override.txPowerDbm !== beforePrefs.txPowerDbm;
      if (radioReallyChanged || powerReallyChanged) radioChanged = true;
      applied++;
    });
    if (radioChanged) invalidateLinks();
    // Re-render the Message senders picker/list — they can render
    // node-derived state (e.g. the picker's own option text), which would
    // otherwise stay stale until some unrelated action happened to
    // re-render it. renderMessageNodeOptions preserves the current
    // selection (see its own prevValue handling), so this is safe to call
    // even while a sender is mid-edit.
    renderMessageNodeOptions();
    renderMessageList();
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
      ["sim-bulk-regions", "regions"],
      ["sim-bulk-flood-max", "floodMax"],
      ["sim-bulk-flood-max-unscoped", "floodMaxUnscoped"],
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
    // "Allow unscoped" is a checkbox, not a value-bearing input, so it's
    // handled separately from the generic loop above.
    const bulkAllowUnscoped = document.getElementById("sim-bulk-allow-unscoped").value;
    if (bulkAllowUnscoped) {
      filledFields++;
      document.querySelectorAll('#sim-nodes-modal-tbody [data-field="allowUnscoped"]').forEach((el) => {
        el.checked = bulkAllowUnscoped === "allow";
      });
    }
    // A radio preset fills all 4 underlying fields, via each row's own
    // preset-select change listener (see renderNodesModalTable) — dispatch
    // a real "change" event rather than duplicating that fill logic here.
    const bulkRadioPreset = document.getElementById("sim-bulk-radio-preset").value;
    if (bulkRadioPreset) {
      filledFields++;
      document.querySelectorAll('#sim-nodes-modal-tbody [data-field="radioPreset"]').forEach((el) => {
        el.value = bulkRadioPreset;
        el.dispatchEvent(new Event("change"));
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

  // The spreading factor a directed link's SNR must be anchored to is the
  // RECEIVER's own SF — that's the SF the engine checks this reception
  // against (internal/meshsim/engine.go: snrThresholdForSF(listener SF)),
  // so approxSnrFromMargin/snrFromObservationCount must map "margin 0 /
  // one observation" onto the RECEIVER's threshold or the engine silently
  // rejects the link as weak_signal. Previously hardcoded to 11 (the old
  // default preset's SF); the default is now the EU/UK (Narrow) SF8 preset,
  // and a per-node SF override can differ again — so it must be read
  // per-receiver, not assumed. (This is also why applyNodesModalTable now
  // calls invalidateLinks() when a radio setting changes: the baked-in SNR
  // is receiver-SF-specific and must be rebuilt if that SF changes.)
  function receiverSf(node) {
    return effectivePrefsFor(node).radio.sf;
  }

  // Two nodes can only form a modelled radio link if their radios are
  // actually compatible — a LoRa receiver must match the transmitter's
  // centre frequency, bandwidth, and spreading factor to demodulate at
  // all (CR rides in the explicit header, so it needn't match). Nodes on
  // different frequencies genuinely cannot hear each other, and a SF8
  // receiver cannot decode a SF12 transmission. Every node defaults to the
  // same preset, so this changes nothing for a normal uniform-config mesh
  // (the only kind real MeshCore runs) — it only stops the per-node radio
  // override from silently producing physically-impossible links between
  // mismatched radios, which would otherwise read as connectivity that
  // could never exist. Because interference audibility also flows through
  // links (see engine.go audibleTo), this one gate keeps both decoding and
  // interference consistent: mismatched-radio nodes neither hear nor jam
  // each other.
  function radiosCompatible(a, b) {
    const ra = effectivePrefsFor(a).radio;
    const rb = effectivePrefsFor(b).radio;
    return ra.freqMhz === rb.freqMhz && ra.bwKhz === rb.bwKhz && ra.sf === rb.sf;
  }

  // A node's own antenna height above ground (metres), used on BOTH ends of
  // a modelled link. A planned/real repeater uses its configured mast height
  // (falling back to the global repeater default); a companion is a handheld
  // client device, not a mast, so it uses the receiver/handheld height
  // instead. Getting this per-node right matters most for repeater-to-
  // repeater links — the entire subject of the flood simulation — which were
  // previously all computed at the single global default height.
  function nodeAntennaHeightM(node) {
    if (node.antennaHeightM != null) return node.antennaHeightM;
    if (node.source === "companion") return cfg.propagation.rxHeightM;
    return cfg.propagation.antennaHeightM;
  }

  // The propagation model bakes the receiver height into its Params
  // (RxHeightM), but a modelled link's receiver is itself a repeater with
  // its own mast height — so we hand pathMargin a params variant whose
  // rxHeightM is the RECEIVER node's own height. Cached by height value so a
  // whole mesh of same-height repeaters shares one Wasm params handle rather
  // than marshalling a fresh one per link (see propagation.js handleFor).
  const rxHeightParamsCache = new Map();
  function propagationForRxHeight(rxHeightM) {
    let p = rxHeightParamsCache.get(rxHeightM);
    if (!p) {
      p = { ...cfg.propagation, rxHeightM };
      rxHeightParamsCache.set(rxHeightM, p);
    }
    return p;
  }

  async function buildLinksFromModel(nodes) {
    const grid = await ensureGrid(nodes);
    const links = [];
    const baseTxPowerDbm = cfg.propagation.txPowerDbm;
    for (let i = 0; i < nodes.length; i++) {
      const groundM = grid.at(nodes[i].lat, nodes[i].lon);
      const txHeightASL = groundM + nodeAntennaHeightM(nodes[i]);
      // Received power scales 1:1 with transmit power, and margin is just
      // received power minus a fixed sensitivity/fade — so a node's own
      // `set tx` deviation from the model's baseline power shifts the margin
      // by exactly that difference. This is what finally lets a tx-power
      // change actually affect the simulation (previously it was ignored
      // entirely — the model always used the config's single tx power).
      const txPowerDelta = (effectivePrefsFor(nodes[i]).txPowerDbm ?? baseTxPowerDbm) - baseTxPowerDbm;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        if (!radiosCompatible(nodes[i], nodes[j])) continue; // mismatched radios can't communicate — see radiosCompatible
        const d = Propagation.haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
        if (d > SIM_MAX_RANGE_KM) continue;
        // Receiver is j — anchor the receiver height to j's own antenna.
        const p = propagationForRxHeight(nodeAntennaHeightM(nodes[j]));
        let margin = Propagation.pathMargin(grid, p, nodes[i].lat, nodes[i].lon, txHeightASL, nodes[j].lat, nodes[j].lon, d);
        margin += txPowerDelta;
        if (margin < 0) continue; // below the model's own reception threshold — not a link
        links.push({ from: i, to: j, snrDb: approxSnrFromMargin(margin, receiverSf(nodes[j])) });
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
    const links = [];
    for (const l of data.links || []) {
      const targetIdx = nodes.findIndex((x) => x.source === "real" && x.refId === l.pubkey);
      if (targetIdx === -1) continue;
      // Anchor each direction's SNR to ITS OWN receiver's SF (see
      // receiverSf / buildLinksFromModel). we_hear is neighbour -> this
      // node (receiver = this node); they_hear is this node -> neighbour
      // (receiver = the neighbour).
      if (typeof l.we_hear === "number" && l.we_hear > 0) {
        links.push({ from: targetIdx, to: nodeIndex, snrDb: snrFromObservationCount(l.we_hear, receiverSf(n)) });
      }
      if (typeof l.they_hear === "number" && l.they_hear > 0) {
        links.push({ from: nodeIndex, to: targetIdx, snrDb: snrFromObservationCount(l.they_hear, receiverSf(nodes[targetIdx])) });
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
    return (override && override.loopDetect) || DEFAULT_LOOP_DETECT;
  }

  // This node's own configured path-hash size for packets IT originates
  // (real firmware's `set hash_size`) — NOT what governs loop.detect on
  // packets it merely relays, which is the sending MESSAGE's own hash
  // size instead (see DEFAULT_MESSAGE_HASH_SIZE). Defaults to
  // DEFAULT_MESSAGE_HASH_SIZE, same as a sender's own default, for
  // consistency between the two — a real repeater's actual configured
  // hash_size (from CoreScope) still wins when known. This is what a real
  // device would actually use for every packet it originates, so
  // syncMessageHashSizeToSelectedNode uses it to seed the sender form's
  // own hash-size field when you pick this node as a sender — the one
  // place this value has any effect on a run (see internal/meshsim's own
  // SimNode.HashSize doc comment: it's otherwise inert on the engine
  // side, since loop.detect is evaluated at the packet's own hash size,
  // not any relaying node's).
  function effectiveHashSize(n) {
    const override = simNodePrefsOverrides[n.id];
    if (override && override.hashSize) return override.hashSize;
    return n.hashSize || DEFAULT_MESSAGE_HASH_SIZE;
  }

  // Seeds the Message senders form's own hash-size field from whichever
  // node is currently selected in the picker — a real device sends at its
  // own configured hash_size by default, so picking a sender here should
  // default to reflecting that, not an unrelated constant. Still freely
  // overridable afterward (this only sets a starting value); editSender's
  // own explicit restore of a saved generator's hashSize runs after this
  // and is never affected, since setting .value programmatically doesn't
  // fire the 'change' event this is wired to.
  function syncMessageHashSizeToSelectedNode() {
    const sel = document.getElementById("sim-message-node");
    const node = simNodes[Number(sel.value)];
    if (node) document.getElementById("sim-message-hash-size").value = String(effectiveHashSize(node));
  }

  // regions/denyUnscoped/floodMax/floodMaxUnscoped follow the same
  // override-over-node-default pattern as loopDetect/hashSize above — all
  // editable from the same "Repeaters & settings" modal row (see
  // renderNodesModalTable/applyNodesModalTable).
  function effectiveRegions(n) {
    const override = simNodePrefsOverrides[n.id];
    if (override && override.regions !== undefined) return override.regions;
    return n.regions || [];
  }

  function effectiveDenyUnscoped(n) {
    const override = simNodePrefsOverrides[n.id];
    if (override && override.denyUnscoped !== undefined) return override.denyUnscoped;
    return !!n.denyUnscoped;
  }

  function effectiveFloodMax(n) {
    const override = simNodePrefsOverrides[n.id];
    if (override && override.floodMax) return override.floodMax;
    return n.floodMax || 0;
  }

  function effectiveFloodMaxUnscoped(n) {
    const override = simNodePrefsOverrides[n.id];
    if (override && override.floodMaxUnscoped) return override.floodMaxUnscoped;
    return n.floodMaxUnscoped || 0;
  }

  // Scopes are stored (and sent to the engine) with their real "#" prefix,
  // matching every other region value in this codebase (message region
  // select, corescope's own observed_scopes) — but shown in the modal
  // "without the hash" per the user's own request, since a whole column of
  // repeated "#" is just noise. "*" (the planned-repeater wildcard — see
  // SimNode.Regions' doc comment) displays and round-trips as a literal
  // "*", not a comma list.
  function regionsToDisplayString(regions) {
    if (!regions || regions.length === 0) return "";
    if (regions.includes("*")) return "*";
    return regions.map((r) => r.replace(/^#/, "")).join(", ");
  }

  function regionsFromDisplayString(s) {
    const trimmed = (s || "").trim();
    if (trimmed === "") return [];
    if (trimmed === "*") return ["*"];
    return trimmed
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => (x.startsWith("#") ? x : `#${x}`));
  }

  // Physical-layer reception model (internal/meshsim.ChannelParams). Unlike
  // the Go tests (which construct scenarios with the zero-value, legacy
  // hard-threshold model), the product turns on the more faithful
  // probabilistic model: a logistic packet-error-rate curve near the
  // sensitivity floor instead of a hard step, and a small per-packet fade
  // so a marginal link genuinely varies between Monte-Carlo trials rather
  // than giving an identical (over-confident) result every time. Modest,
  // LoRa-appropriate values — comfortably-strong links stay ~100% reliable
  // (see the Go test TestChannelSigmoidLeavesStrongLinksReliable).
  const CHANNEL_PER_WIDTH_DB = 2.0;
  const CHANNEL_FADING_SIGMA_DB = 2.0;

  function scenarioFromState() {
    return {
      nodes: simNodes.map((n) => ({
        prefs: effectivePrefsFor(n),
        canRelay: canRelay(n),
        regions: effectiveRegions(n),
        loopDetect: effectiveLoopDetect(n),
        hashSize: effectiveHashSize(n),
        denyUnscoped: effectiveDenyUnscoped(n),
        floodMax: effectiveFloodMax(n),
        floodMaxUnscoped: effectiveFloodMaxUnscoped(n),
      })),
      links: simLinks,
      channel: { perWidthDb: CHANNEL_PER_WIDTH_DB, fadingSigmaDb: CHANNEL_FADING_SIGMA_DB },
    };
  }

  // Baked in from https://api.meshcore.nz/api/v1/config
  // (config.suggested_radio_settings.entries) — the live list the official
  // MeshCore app itself offers, also mirrored at
  // https://forum.letsmesh.net/t/meshcore-radio-setting-presets/67. Baked in
  // rather than fetched at runtime so the tool works offline and doesn't
  // depend on a CORS proxy; re-run the same fetch to refresh this list if
  // upstream adds/changes entries. "EU/UK (Narrow)" (index 6) is the
  // simulator's own default — see defaultPrefs().
  const RADIO_PRESETS = [
    { label: 'Australia', freqMhz: 915.8, bwKhz: 250.0, sf: 10, cr: 5 },
    { label: 'Australia (Narrow)', freqMhz: 916.575, bwKhz: 62.5, sf: 7, cr: 8 },
    { label: 'Australia (Mid)', freqMhz: 915.075, bwKhz: 125.0, sf: 9, cr: 5 },
    { label: 'Australia: SA, WA', freqMhz: 923.125, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'Australia: QLD', freqMhz: 923.125, bwKhz: 62.5, sf: 8, cr: 5 },
    { label: 'Brazil', freqMhz: 923.125, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'EU/UK (Narrow)', freqMhz: 869.618, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'EU/UK (Deprecated)', freqMhz: 869.525, bwKhz: 250.0, sf: 11, cr: 5 },
    { label: 'Czech Republic (Narrow)', freqMhz: 869.432, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'EU 433MHz (Long Range)', freqMhz: 433.65, bwKhz: 250.0, sf: 11, cr: 5 },
    { label: 'EU 433MHz (Narrow)', freqMhz: 433.65, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'Netherlands', freqMhz: 869.618, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'New Zealand', freqMhz: 917.375, bwKhz: 250.0, sf: 11, cr: 5 },
    { label: 'New Zealand (Narrow)', freqMhz: 917.375, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'Portugal 433', freqMhz: 433.375, bwKhz: 62.5, sf: 9, cr: 6 },
    { label: 'Portugal 868', freqMhz: 869.618, bwKhz: 62.5, sf: 7, cr: 6 },
    { label: 'Switzerland', freqMhz: 869.618, bwKhz: 62.5, sf: 8, cr: 8 },
    { label: 'USA/Canada (Recommended)', freqMhz: 910.525, bwKhz: 62.5, sf: 7, cr: 5 },
    { label: 'Vietnam (Narrow)', freqMhz: 920.25, bwKhz: 62.5, sf: 8, cr: 5 },
    { label: 'Vietnam (Deprecated)', freqMhz: 920.25, bwKhz: 250.0, sf: 11, cr: 5 },
  ];

  // Which preset (if any) a given radio config exactly matches — drives the
  // dropdown's own selection: "Custom" whenever none of the baked-in
  // presets match every field, e.g. after a manual edit.
  function radioPresetLabelFor(radio) {
    const match = RADIO_PRESETS.find((p) => p.freqMhz === radio.freqMhz && p.bwKhz === radio.bwKhz && p.sf === radio.sf && p.cr === radio.cr);
    return match ? match.label : "";
  }

  function defaultPrefs() {
    // Mirrors internal/meshsim.DefaultNodePrefs — kept in sync manually
    // since this is plain JS, not generated from the Go struct. Radio
    // defaults to the EU/UK (Narrow) preset (see RADIO_PRESETS) — preamble
    // length isn't a field at all: real firmware derives it from SF alone
    // (see preambleSymbolsForSF in Go), so it's never independently
    // configurable here either.
    return {
      txDelayFactor: 0.5,
      directTxDelayFactor: 0.3,
      rxDelayBase: 0,
      txPowerDbm: 22,
      radio: { freqMhz: 869.618, bwKhz: 62.5, sf: 8, cr: 8, explicitHeader: true, crcEnabled: true },
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
      // A "fixed" generator is one reconstructed real transmission at an
      // absolute time (docs/SIMULATOR_PLAN_PHASE8.md) — a real flood sender,
      // or a fixed background transmission of surrounding traffic. It expands
      // to exactly one message, unlike the random count/gap/payload
      // generators below.
      if (g.fixed) {
        messages.push({
          origin: g.nodeIndex,
          sendAtMs: g.atMs || 0,
          payloadLen: g.payloadLen || 20,
          region: g.region || "",
          direct: !!g.direct,
          hashSize: g.hashSize || DEFAULT_MESSAGE_HASH_SIZE,
          background: !!g.background,
          frameBytes: g.frameBytes || 0,
        });
        return;
      }
      const rng = mulberry32((seed >>> 0) ^ ((gi + 1) * 0x9e3779b9));
      let atMs = 0;
      for (let i = 0; i < g.count; i++) {
        if (i > 0) atMs += randomInt(rng, g.minGapMs, g.maxGapMs);
        messages.push({ origin: g.nodeIndex, sendAtMs: atMs, payloadLen: randomInt(rng, g.minPayload, g.maxPayload), region: g.region || "", direct: !!g.direct, hashSize: g.hashSize || DEFAULT_MESSAGE_HASH_SIZE });
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
      rebuildLinkIndexes(report);
      renderResults(report);
      renderSentMessagesList();
      renderRankings(report);
      if (lastEpisode) renderEpisodeAnalysis(); // refresh actual-vs-predicted / before-after against this run
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

  // A run can produce thousands of receptions (5,256 measured on a dense
  // 73-node scenario) — rendering every row up front is what made the
  // reception log and the packet inspector's activity list slow to scroll
  // and hard to scan. Both cap their initial render to this many rows and
  // offer a "Show all N" control instead (item 10E).
  const LONG_LIST_ROW_CAP = 200;

  function appendShowAllButton(container, totalCount, onShowAll) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sim-show-all-btn";
    btn.textContent = `Show all ${totalCount}`;
    btn.addEventListener("click", onShowAll);
    container.appendChild(btn);
  }

  // Renders report's reception log into container — used for both the
  // Results modal's own log and the map-docked playback control's live
  // copy (see ensureSimPlaybackControl), so the two never drift out of
  // sync with each other.
  function renderReceptionLogInto(container, report, showAll) {
    container.innerHTML = "";
    const all = report.receptions;
    const capped = !showAll && all.length > LONG_LIST_ROW_CAP;
    const toRender = capped ? all.slice(0, LONG_LIST_ROW_CAP) : all;
    for (const r of toRender) {
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
    if (capped) appendShowAllButton(container, all.length, () => renderReceptionLogInto(container, report, true));
  }

  // item 10C — a stat strip of discrete labelled figures instead of a
  // run-on sentence ("0 sent · 30 received · 1 relayed onward · 27
  // collided · 2 dropped."), so the number that actually matters doesn't
  // read with the same visual weight as everything around it. `stats` is
  // [{label, value, tone}], tone one of "" (default) | "bad" — a bad tone
  // is only worth calling out past a real threshold, decided by the
  // caller, not by this shared renderer.
  function renderStatStrip(container, stats) {
    container.innerHTML = "";
    container.className = "sim-stat-strip";
    for (const s of stats) {
      const el = document.createElement("div");
      el.className = `sim-stat${s.tone ? ` sim-stat-${s.tone}` : ""}`;
      el.innerHTML = `<span class="sim-stat-value">${escapeHtml(String(s.value))}</span><span class="sim-stat-label">${escapeHtml(s.label)}</span>`;
      container.appendChild(el);
    }
  }

  function renderResults(report) {
    document.getElementById("sim-open-results-modal").classList.remove("hidden");
    ensureSimPlaybackControl();
    const total = report.receptions.length;
    const collided = report.receptions.filter((r) => r.collided).length;
    // Item 13 — break collided into its distinct physical causes rather
    // than one undifferentiated figure, so the dominant one is obvious at
    // a glance instead of needing a trip into the packet inspector first.
    const noLock = report.receptions.filter((r) => r.collisionKind === "no_lock").length;
    const corrupted = report.receptions.filter((r) => r.collisionKind === "corrupted").length;
    const txBusy = report.receptions.filter((r) => r.dropReason === "tx_busy").length;
    const rate = total > 0 ? (collided / total) * 100 : 0;
    renderStatStrip(document.getElementById("sim-results-summary"), [
      { label: "receptions", value: total },
      { label: `collided (${rate.toFixed(1)}%)`, value: collided, tone: rate >= 30 ? "bad" : "" },
      { label: "— no lock", value: noLock },
      { label: "— corrupted", value: corrupted },
      { label: "missed (tx busy)", value: txBusy },
    ]);

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
      const flood = floodTimeMs(packetId);
      const floodLabel = flood != null ? ` · flooding for ${flood}ms` : "";
      const row = document.createElement("div");
      row.className = `plan-list-item sim-message-row${selectedPacketId === packetId ? " sim-message-row-selected" : ""}`;
      row.dataset.packetId = String(packetId);
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(origin ? origin.label : "?")}${m.region ? ` <span class="sim-node-badge sim-badge-region">${escapeHtml(m.region)}</span>` : ""}${m.direct ? ` <span class="sim-node-badge sim-badge-direct">direct</span>` : ""}</span>
        <span class="plan-item-sub">${m.payloadLen}B at ${m.sendAtMs}ms · reached ${reachedNodes.size}, collided at ${collidedNodes.size}${floodLabel}
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
    hop_limit_unscoped: "Unscoped hop limit reached",
    already_seen: "Already seen this packet",
    region_mismatch: "Region mismatch — not relayed",
    loop_detect: "Dropped by loop detection",
    tx_busy: "Missed (was transmitting)",
  };

  // Longer, hover-only explanations for the short DROP_REASON_LABELS —
  // mirrors the doc comments on internal/meshsim.Reception.DropReason.
  const DROP_REASON_DETAILS = {
    weak_signal: "The signal-to-noise ratio at this listener was below the minimum needed to decode a packet sent at this spreading factor.",
    cannot_relay: "This node is a plain client (e.g. a companion app), not a repeater — it never relays packets onward, regardless of its other settings.",
    hop_limit: "The packet had already been relayed this node's Flood max (flood.max) number of times before it reached this node — applies to every packet.",
    hop_limit_unscoped: "This is an unscoped (regionless) packet, and it had already been relayed this node's Unscoped max (flood.max.unscoped) number of times — a separate, additional limit that only gates traffic with no region tag.",
    already_seen: "This exact node had already decoded this exact packet once before (whether or not it went on to relay it) — MeshCore's own dedup rule (SimpleMeshTables::hasSeen) prevents ever processing the same packet twice, by any path.",
    region_mismatch: "This node's configured region(s) don't include the region this message was tagged with, so it wasn't accepted for relay — or, for an unscoped message, this node has \"Allow unscoped\" turned off.",
    loop_detect: "This node's own loop-detect hash collided with a hash already present in the packet's path, so real firmware treats it as a likely loop and drops it — note this can trigger on a false-positive hash collision between two unrelated nodes, not just a real loop, especially at a small hash size.",
    tx_busy: "This node's own transmitter was keyed while this packet was on the air. LoRa radios are half-duplex — they cannot receive while transmitting — so the packet was never heard at all, rather than being heard and corrupted.",
  };

  // Longer, hover-only explanations for a collision's own CollisionKind —
  // mirrors the doc comment on internal/meshsim.Reception.CollisionKind.
  const COLLISION_KIND_DETAILS = {
    no_lock: "Another transmission was already on the air during this packet's own preamble/sync-word acquisition window, so the receiver's demodulator never locked onto it at all — no partial packet, no CRC failure, nothing decoded.",
    corrupted: "This node's demodulator did lock onto the packet, but another transmission overlapping the payload wasn't beaten by the capture margin, so symbols were corrupted and the CRC failed.",
  };

  function dropReasonLabel(reason) {
    return DROP_REASON_LABELS[reason] || reason;
  }

  // Everything needed to render the reason column: a short badge label, a
  // CSS class for its colour, and a longer explanation shown on hover.
  function receptionOutcome(r) {
    let label, cls, detail, relayTx = null;
    if (r.collided) {
      // Item 13: break "Collided" into its distinct physical causes rather
      // than one undifferentiated bucket — collisionKind is "no_lock"
      // (demodulator never locked at all — nothing decoded) or "corrupted"
      // (locked, but the payload was corrupted by an interferer beating
      // the capture margin). See CollisionKind's own Go doc comment; empty
      // only if the engine somehow didn't report a kind for a collision,
      // which shouldn't happen, but reads as plain "Collided" rather than
      // hiding the row if it does.
      const withLabels = (r.collidedWith || []).map(nodeLabel).join(", ");
      const kindSuffix = r.collisionKind === "no_lock" ? " (no lock)" : r.collisionKind === "corrupted" ? " (corrupted)" : "";
      label = `Collided${kindSuffix}`;
      cls = "sim-reason-collided";
      const kindDetail = COLLISION_KIND_DETAILS[r.collisionKind] || "";
      detail = withLabels
        ? `${kindDetail || "This reception's airtime window overlapped another transmission audible here, corrupting it."} (from ${withLabels})`
        : kindDetail || "This reception's airtime window overlapped another transmission audible here, corrupting it.";
    } else if (r.dropReason === "cannot_relay") {
      // Not relaying is this node's normal, intended behaviour (a
      // companion app, or a CoreScope-labelled listener) — receiving it
      // at all is the actual success condition here, so this reads as a
      // clean "Received", not a failure/drop like the other reasons below.
      label = "Received";
      cls = "sim-reason-received";
      detail = "This node doesn't relay by design (a companion device, or a listener-role repeater) — successfully receiving it is what matters here, not relaying it onward.";
    } else if (r.dropReason === "tx_busy") {
      // A miss, not a collision or an active drop decision — real firmware
      // never even knew this packet existed (half-duplex: its own
      // transmitter was keyed) — kept visually distinct from both.
      label = dropReasonLabel("tx_busy");
      cls = "sim-reason-missed";
      detail = DROP_REASON_DETAILS.tx_busy;
    } else if (r.dropReason) {
      label = dropReasonLabel(r.dropReason);
      cls = "sim-reason-dropped";
      detail = DROP_REASON_DETAILS[r.dropReason] || "";
    } else if (r.wasRelayed) {
      cls = "sim-reason-relayed";
      // The relay CAN be scheduled and never actually air, if the
      // scheduled instant lands past the sim's own end (see
      // docs/SIMULATOR_PLAN_PHASE2.md item 12, finding 2) — WasRelayed
      // means "was eligible to relay," not "a transmission exists." Look
      // the real Transmission up rather than assume one.
      relayTx = transmissionIndex.get(linkKey(r.packetId, r.node)) || null;
      if (relayTx) {
        const delayMs = relayTx.atMs - r.atMs;
        label = `Relayed ⤵ +${delayMs}ms`;
        detail = `This node went on to relay the packet onward to its own neighbours, ${delayMs}ms after receiving it (that gap is the sender's own RxDelay/TxDelay settings at work — click the ⤵ to jump to the actual transmission).`;
      } else {
        label = "Relayed (never aired)";
        detail = "This node was scheduled to relay the packet onward, but the scheduled instant fell after the simulation's own end (Sim duration), so it never actually went out.";
      }
    } else if (r.survivedCapture) {
      // Real LoRa's capture effect: a stronger overlapping transmission
      // was still decoded despite the interference, rather than a clean
      // reception with nothing else audible at the time (see loraCaptured
      // in internal/meshsim/engine.go) — distinct enough to call out, not
      // just "Received".
      label = "Captured";
      cls = "sim-reason-captured";
      detail = "Another transmission overlapped this reception's airtime window and was audible here too, but this signal was strong enough (real LoRa's capture effect) to still be decoded cleanly.";
    } else {
      label = "Received";
      cls = "sim-reason-received";
      detail = "Received cleanly; not eligible or needed to relay further.";
    }
    if (r.senderWasCadDeferred) {
      detail += " The sender detected the channel busy (CAD) and delayed its own transmission by at least one retry before sending this.";
    }
    if (r.senderWasBudgetDeferred) {
      detail += " The sender's own duty-cycle airtime budget (real firmware caps every node to roughly a 50% duty cycle) was too low, so it had to wait before this transmission could go out.";
    }
    return { label, cls, detail, relayTx };
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

  // linkKey is the shared identity a reception and the transmission it
  // caused — or a relay transmission and the reception it triggered —
  // render with as data-link-key, so hovering/clicking one can find its
  // partner. Real firmware's hasSeen dedup guarantees a node transmits any
  // given packet at most once (see Transmission's own Go doc comment), so
  // (packetId, node) is a safe, unambiguous pairing key — no heuristics
  // needed.
  function linkKey(packetId, node) {
    return `${packetId}:${node}`;
  }

  // packetId:node -> Transmission, rebuilt whenever a fresh report loads
  // (see runSimulation/hideResults) — every RX row's "was this relayed, and
  // when" lookup goes through this rather than a linear scan of
  // lastReport.transmissions per row.
  let transmissionIndex = new Map();
  // packetId:node -> the Reception that triggered this node's relay of
  // that packet — the mirror of transmissionIndex, letting a relay TX row
  // show "relaying what arrived at Xms" without a linear scan. Only ever
  // has one entry per key: a node relays a packet based on exactly one
  // decoded reception of it (hasSeen dedup — see Transmission's own Go doc
  // comment), so wasRelayed is true on at most one Reception per
  // (packetId, node).
  let relayCauseIndex = new Map();

  function rebuildLinkIndexes(report) {
    transmissionIndex = new Map();
    relayCauseIndex = new Map();
    for (const tx of (report && report.transmissions) || []) {
      transmissionIndex.set(linkKey(tx.packetId, tx.node), tx);
    }
    for (const r of (report && report.receptions) || []) {
      if (r.wasRelayed) relayCauseIndex.set(linkKey(r.packetId, r.node), r);
    }
  }

  function buildTxEvent(tx) {
    return { kind: "tx", atMs: tx.atMs, packetId: tx.packetId, node: tx.node, transmission: tx };
  }

  function buildRxEvent(r) {
    return { kind: "rx", atMs: r.atMs, packetId: r.packetId, node: r.node, reception: r };
  }

  // Every transmission FROM nodeIndex (TX — the origin's own first send, or
  // any relay) plus every reception AT nodeIndex (RX), merged into one
  // chronological timeline — see openPacketInspectorForNode. Sourced from
  // lastReport.transmissions (real air time, after any CAD/budget
  // deferral), not lastMessages (only the origin's own scheduled send) —
  // see docs/SIMULATOR_PLAN_PHASE2.md item 12's own "scheduled ≠ actual"
  // finding.
  function buildNodeActivityEvents(nodeIndex) {
    const events = [];
    if (lastReport) {
      for (const tx of lastReport.transmissions) {
        if (tx.node === nodeIndex) events.push(buildTxEvent(tx));
      }
      for (const r of lastReport.receptions) {
        if (r.node === nodeIndex) events.push(buildRxEvent(r));
      }
    }
    events.sort((a, b) => a.atMs - b.atMs);
    return events;
  }

  // This one packet's own transmissions (the origin's send, plus every
  // node that went on to relay it) plus every reception of it anywhere —
  // see openPacketDetails.
  function buildPacketActivityEvents(packetId) {
    const events = [];
    if (lastReport) {
      for (const tx of lastReport.transmissions) {
        if (tx.packetId === packetId) events.push(buildTxEvent(tx));
      }
      for (const r of lastReport.receptions) {
        if (r.packetId === packetId) events.push(buildRxEvent(r));
      }
    }
    events.sort((a, b) => a.atMs - b.atMs);
    return events;
  }

  function matchesOutcomeFilter(e, outcomeFilter) {
    if (e.kind === "tx") {
      switch (outcomeFilter) {
        case "tx":
          return true; // every TX row — original sends and relays alike
        case "tx_origin":
          return !e.transmission.isRelay;
        case "tx_relay":
        case "relayed":
          // A relay's own TX row belongs under "Relayed" too — see the RX
          // row's matching case below — so filtering by "relayed" surfaces
          // both halves of the pair, not just the RX side.
          return e.transmission.isRelay;
        case "":
          return true; // TX rows only show under "All outcomes" and the explicit TX filters above
        default:
          return false;
      }
    }
    const r = e.reception;
    switch (outcomeFilter) {
      case "relayed":
        return !r.collided && r.wasRelayed;
      case "collided":
        return r.collided;
      case "collided_no_lock":
        return r.collided && r.collisionKind === "no_lock";
      case "collided_corrupted":
        return r.collided && r.collisionKind === "corrupted";
      case "tx_busy":
        return !r.collided && r.dropReason === "tx_busy";
      case "dropped":
        // cannot_relay isn't a real drop — see receptionOutcome's own note.
        // tx_busy IS a genuine delivery failure (see item 13), so it
        // belongs here alongside the other drop reasons.
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
  function renderNodeActivityRows(container, events, { showAt, drillTo, showAll }) {
    container.innerHTML = "";
    if (events.length === 0) {
      container.innerHTML = `<div class="plan-hint">Nothing to show.</div>`;
      return;
    }
    const capped = !showAll && events.length > LONG_LIST_ROW_CAP;
    const toRender = capped ? events.slice(0, LONG_LIST_ROW_CAP) : events;

    // Only worth wiring up hover/click linking for a key whose BOTH halves
    // are actually present in this rendered list — a relay whose RX row got
    // filtered out (e.g. by the outcome filter) has no partner to jump to
    // here. Counted over the full events set, not just toRender, so "Show
    // all" doesn't change which rows are linkable out from under a user
    // mid-hover.
    const keyCounts = new Map();
    for (const e of events) {
      const key = linkKey(e.packetId, e.node);
      keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    }

    for (const e of toRender) {
      const row = document.createElement("div");
      const atLabel = showAt ? `${escapeHtml(nodeLabel(e.node))} · ` : "";
      const key = linkKey(e.packetId, e.node);
      const hasLinkPartner = (keyCounts.get(key) || 0) > 1;
      row.dataset.linkKey = key;

      if (e.kind === "tx") {
        const tx = e.transmission;
        const own = lastReport ? lastReport.receptions.filter((r) => r.packetId === e.packetId) : [];
        const reachedCount = new Set(own.filter((r) => !r.collided).map((r) => r.node)).size;
        const collidedCount = new Set(own.filter((r) => r.collided).map((r) => r.node)).size;
        // Every relay's own Reception (the one it decided to relay based
        // on) is looked up here rather than re-derived — see
        // relayCauseIndex's own doc comment.
        const cause = tx.isRelay ? relayCauseIndex.get(key) : null;
        const relayInfo = !tx.isRelay
          ? ""
          : cause
            ? ` · <span class="sim-packet-relay-link" data-jump="1" title="Jump to the reception that triggered this relay">⤴ relaying what arrived at ${cause.atMs}ms</span>`
            : ` · <span class="sim-packet-relay-link">⤴ relay</span>`;
        row.className = "plan-list-item sim-list-item sim-packet-row sim-clean";
        row.innerHTML = `
          <div class="sim-packet-row-top">
            <span class="sim-txrx-badge ${tx.isRelay ? "sim-txrx-relay" : "sim-txrx-tx"}">${tx.isRelay ? "RELAY" : "TX"}</span>
            <span class="plan-item-label">Packet #${e.packetId}</span>
            ${tx.region ? `<span class="sim-node-badge sim-badge-region">${escapeHtml(tx.region)}</span>` : ""}
            ${tx.direct ? `<span class="sim-node-badge sim-badge-direct">direct</span>` : ""}
          </div>
          <div class="sim-packet-row-bottom">
            <span class="sim-packet-context">${atLabel}${tx.payloadLen}B · ${tx.hashSize || DEFAULT_MESSAGE_HASH_SIZE}B hops · reached ${reachedCount}, collided at ${collidedCount}${relayInfo}</span>
            <span class="sim-packet-time">${e.atMs}ms</span>
          </div>
        `;
      } else {
        const r = e.reception;
        const outcome = receptionOutcome(r);
        // Phase 3 — a packet's path can never mix hash sizes hop to hop
        // (see the badge in renderMessageList's own doc comment), so this
        // is plain node labels, not per-hop annotated ones.
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
            <span class="sim-packet-reason ${outcome.cls}" data-jump="${outcome.relayTx ? "1" : ""}" title="${escapeHtml(outcome.detail)}">${escapeHtml(outcome.label)}${r.senderWasCadDeferred ? " ⏱" : ""}${r.senderWasBudgetDeferred ? " 🔋" : ""}</span>
          </div>
        `;
      }

      if (hasLinkPartner) {
        row.classList.add("sim-linkable-row");
        row.addEventListener("mouseenter", () => {
          container.querySelectorAll(`[data-link-key="${key}"]`).forEach((el) => el.classList.add("sim-row-linked"));
        });
        row.addEventListener("mouseleave", () => {
          container.querySelectorAll(`[data-link-key="${key}"]`).forEach((el) => el.classList.remove("sim-row-linked"));
        });
        const jumpEl = row.querySelector('[data-jump="1"]');
        if (jumpEl) {
          jumpEl.classList.add("sim-jump-link");
          jumpEl.addEventListener("click", (evt) => {
            evt.stopPropagation(); // don't also trigger the row's own drill-down click below
            container.querySelectorAll(`[data-link-key="${key}"]`).forEach((el) => {
              if (el === row) return;
              el.scrollIntoView({ block: "center", behavior: "smooth" });
              el.classList.add("sim-row-highlight");
              setTimeout(() => el.classList.remove("sim-row-highlight"), 1500);
            });
          });
        }
      }

      row.addEventListener("click", () => {
        if (drillTo === "node") openPacketInspectorForNode(e.node, "drill");
        else openPacketDetails(e.packetId, "drill");
      });
      container.appendChild(row);
    }
    if (capped) appendShowAllButton(container, events.length, () => renderNodeActivityRows(container, events, { showAt, drillTo, showAll: true }));
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
      // "Received" must mean genuinely DECODED, not merely "not collided" —
      // weak_signal and tx_busy both leave Collided false but were never
      // decoded at all (see their own Go doc comments: neither marks the
      // packet seen), so excluding them here fixes a real pre-existing
      // false-positive this checklist would otherwise show for either.
      const received = own.some((r) => !r.collided && r.dropReason !== "weak_signal" && r.dropReason !== "tx_busy");
      const collidedCount = own.filter((r) => r.collided).length;
      const missedCount = own.filter((r) => !r.collided && (r.dropReason === "weak_signal" || r.dropReason === "tx_busy")).length;
      let statusCls, statusLabel, statusDetail;
      if (i === originIndex) {
        statusCls = "sim-checklist-origin";
        statusLabel = "📤 Origin";
        statusDetail = "This node sent the packet.";
      } else if (received) {
        statusCls = "sim-checklist-yes";
        statusLabel = "✓ Received";
        statusDetail = "Received a clean (non-collided) copy of this packet.";
      } else if (own.length > 0 && missedCount > 0 && collidedCount > 0) {
        statusCls = "sim-checklist-no";
        statusLabel = "✗ Never decoded";
        statusDetail = `Heard ${own.length} attempts at this packet — ${collidedCount} collided, ${missedCount} never decoded (too weak, or this node's own transmitter was busy) — none successful.`;
      } else if (own.length > 0 && missedCount > 0) {
        statusCls = "sim-checklist-no";
        statusLabel = "✗ Missed every attempt";
        statusDetail = `Heard ${own.length} attempt${own.length === 1 ? "" : "s"} at this packet, but never decoded any of them (too weak to decode, or this node's own transmitter was keyed at the time).`;
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
    const txEvents = events.filter((e) => e.kind === "tx").map((e) => e.transmission);
    const originSends = txEvents.filter((tx) => !tx.isRelay).length;
    const relayTxCount = txEvents.filter((tx) => tx.isRelay).length;
    const rxEvents = events.filter((e) => e.kind === "rx").map((e) => e.reception);
    const collided = rxEvents.filter((r) => r.collided).length;
    // tx_busy is a miss (this node's own transmitter was keyed), not a
    // collision and not an active drop decision — broken out from
    // "dropped" the same way item 13's results-modal summary does, so it
    // isn't double-counted between the two figures.
    const txBusy = rxEvents.filter((r) => r.dropReason === "tx_busy").length;
    const dropped = rxEvents.filter((r) => !r.collided && r.dropReason && r.dropReason !== "cannot_relay" && r.dropReason !== "tx_busy").length;
    const scheduledRelays = rxEvents.filter((r) => r.wasRelayed).length;
    // A relay CAN be scheduled and never actually air, if the scheduled
    // instant lands past the sim's own end (see
    // docs/SIMULATOR_PLAN_PHASE2.md item 12, finding 2) — every such case
    // shows up here as a gap between what was scheduled and what actually
    // transmitted, rather than silently vanishing.
    const neverAired = scheduledRelays - relayTxCount;
    const rxTotal = rxEvents.length;
    const stats = [
      { label: "sent (origin)", value: originSends },
      { label: "received", value: rxTotal },
      { label: "relayed (sent)", value: relayTxCount },
      { label: "collided", value: collided, tone: rxTotal > 0 && collided / rxTotal >= 0.3 ? "bad" : "" },
      { label: "missed (tx busy)", value: txBusy },
      { label: "dropped", value: dropped },
    ];
    if (neverAired > 0) {
      stats.push({ label: "scheduled, never aired", value: neverAired, tone: "bad" });
    }
    renderStatStrip(document.getElementById("sim-packet-modal-summary"), stats);

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
    const summaryEl = document.getElementById("sim-packet-modal-summary");
    summaryEl.className = "plan-hint"; // this view uses a plain sentence, not the stat strip openPacketInspectorForNode leaves behind
    summaryEl.textContent =
      `From ${origin ? origin.label : "?"}${m.region ? ` (region ${m.region})` : ""}${m.direct ? " (direct)" : ""} · ${m.payloadLen}B · ${m.hashSize || DEFAULT_MESSAGE_HASH_SIZE}B hops · sent at ${m.sendAtMs}ms` +
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

  // A reception that never actually got decoded at all (weak_signal,
  // tx_busy) or was a genuine duplicate of an already-processed copy
  // (already_seen) isn't a "delivery" in any sense worth counting — mirrors
  // the exact same filter internal/meshsim.Report.DeliveryRatio applies on
  // the Go side (see docs/SIMULATOR_PLAN_PHASE2.md item 15a), kept in sync
  // manually since this is plain JS, not generated from the Go source.
  function isCanonicalDelivery(r) {
    return !r.collided && r.dropReason !== "weak_signal" && r.dropReason !== "tx_busy" && r.dropReason !== "already_seen";
  }

  // JS mirror of internal/meshsim.reachableFrom — a node this message could
  // possibly ever reach, given the CURRENT scenario's own topology and
  // per-node settings, regardless of what any specific simulated run's
  // random draws happened to produce. Used as computeRankings' own
  // "received x/y" denominator so an isolated/out-of-range node doesn't
  // silently make every repeater's delivery figure look worse than it is.
  // Gated exactly like the Go BFS: a node that can't relay or wouldn't
  // accept this region is included itself (reachable on this hop) but
  // doesn't extend the search past itself; the origin is exempt from both
  // gates (it always "sends," regardless of its own relay/region config).
  function computeReachableSet(originIndex, region) {
    const adj = new Map();
    for (const l of simLinks) {
      if (!adj.has(l.from)) adj.set(l.from, []);
      adj.get(l.from).push(l.to);
    }
    const reachable = new Set([originIndex]);
    const queue = [originIndex];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current !== originIndex) {
        const node = simNodes[current];
        if (!node) continue;
        const regions = effectiveRegions(node);
        const accepts = region === "" ? !effectiveDenyUnscoped(node) : regions.includes("*") || regions.includes(region);
        if (!canRelay(node) || !accepts) continue; // leaf: reachable itself, but doesn't relay onward
      }
      for (const to of adj.get(current) || []) {
        if (!reachable.has(to)) {
          reachable.add(to);
          queue.push(to);
        }
      }
    }
    return reachable;
  }

  // Item 16 — a per-repeater run scoreboard: is this repeater earning its
  // own airtime? successCount/collisionCount/contentionCaused are the
  // pre-existing columns; everything else here is new. dutyCyclePct and
  // relay/deferral figures come from report.transmissions (item 12) —
  // uniqueDeliveries/redundantRelays from attributing each canonical
  // delivery to whichever transmission actually caused it.
  function computeRankings(report) {
    const perNode = simNodes.map(() => ({
      successCount: 0,
      collisionCount: 0,
      contentionCaused: 0,
      txBusyCount: 0,
      dutyAirtimeMs: 0,
      relayedCount: 0,
      deliveredCount: 0,
      reachableCount: 0,
      uniqueDeliveries: 0,
      redundantRelays: 0,
      relayDelaySumMs: 0,
      relayDelayCount: 0,
      deferrals: 0,
    }));

    for (const r of report.receptions) {
      if (!perNode[r.node]) continue;
      if (r.collided) perNode[r.node].collisionCount++;
      else perNode[r.node].successCount++;
      if (r.dropReason === "tx_busy") perNode[r.node].txBusyCount++;
      for (const other of r.collidedWith || []) {
        if (perNode[other]) perNode[other].contentionCaused++;
      }
    }

    // deliveringPairs: "packetId:fromNode" — this sender's transmission of
    // this packet is the one that actually delivered it to at least one
    // listener (as opposed to arriving at a listener who'd already decoded
    // it from someone else, or arriving nowhere useful at all) — the input
    // "redundant relay" attribution below needs, at the per-packet level.
    const deliveringPairs = new Set();
    for (const r of report.receptions) {
      if (!isCanonicalDelivery(r)) continue;
      if (perNode[r.fromNode]) perNode[r.fromNode].uniqueDeliveries++;
      if (perNode[r.node]) perNode[r.node].deliveredCount++;
      deliveringPairs.add(`${r.packetId}:${r.fromNode}`);
    }

    for (const tx of report.transmissions || []) {
      if (!perNode[tx.node]) continue;
      perNode[tx.node].dutyAirtimeMs += tx.airtimeMs;
      if (tx.cadDeferred) perNode[tx.node].deferrals++;
      if (tx.budgetDeferred) perNode[tx.node].deferrals++;
      if (tx.isRelay) {
        perNode[tx.node].relayedCount++;
        // Every one of this node's own listeners already had a canonical
        // delivery attributed to a DIFFERENT sender for this exact packet
        // (or never got it via any path at all) — this relay's own
        // airtime produced zero unique deliveries, i.e. it was spent
        // without adding coverage. Feeds item 15c's redundancy-suppress
        // model.
        if (!deliveringPairs.has(`${tx.packetId}:${tx.node}`)) {
          perNode[tx.node].redundantRelays++;
        }
      }
    }

    for (const [key, tx] of transmissionIndex) {
      if (!tx.isRelay) continue;
      const cause = relayCauseIndex.get(key);
      if (cause && perNode[tx.node]) {
        perNode[tx.node].relayDelaySumMs += tx.atMs - cause.atMs;
        perNode[tx.node].relayDelayCount++;
      }
    }

    if (lastMessages) {
      lastMessages.forEach((m) => {
        const reachable = computeReachableSet(m.origin, m.region || "");
        reachable.delete(m.origin);
        for (const nodeIndex of reachable) {
          if (perNode[nodeIndex]) perNode[nodeIndex].reachableCount++;
        }
      });
    }

    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
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
        txBusyCount: p.txBusyCount,
        // Airtime ÷ the configured sim duration, not the run's own busy
        // span — a candidate that merely finishes early shouldn't read as
        // lower duty cycle than one that runs the full window (see
        // docs/SIMULATOR_PLAN_PHASE2.md item 16's own note on this).
        dutyCyclePct: maxSimTimeMs > 0 ? (p.dutyAirtimeMs / maxSimTimeMs) * 100 : 0,
        relayedCount: p.relayedCount,
        deliveryRatio: p.reachableCount > 0 ? p.deliveredCount / p.reachableCount : null,
        deliveredCount: p.deliveredCount,
        reachableCount: p.reachableCount,
        uniqueDeliveries: p.uniqueDeliveries,
        redundantRelays: p.redundantRelays,
        avgRelayDelayMs: p.relayDelayCount > 0 ? Math.round(p.relayDelaySumMs / p.relayDelayCount) : null,
        deferrals: p.deferrals,
      };
    });
  }

  const RANKING_COLUMNS = [
    { key: "label", label: "Repeater" },
    { key: "dutyCyclePct", label: "Duty cycle", format: (v) => `${v.toFixed(1)}%` },
    {
      key: "deliveryRatio",
      label: "Received",
      format: (v, r) => (v == null ? "—" : `${r.deliveredCount}/${r.reachableCount} (${Math.round(v * 100)}%)`),
    },
    { key: "uniqueDeliveries", label: "Unique deliveries", goodHigh: true },
    { key: "redundantRelays", label: "Redundant relays", badHigh: true },
    { key: "relayedCount", label: "Relayed" },
    { key: "successCount", label: "Successful", goodHigh: true },
    { key: "collisionCount", label: "Collisions (own)", badHigh: true },
    { key: "txBusyCount", label: "Missed (tx busy)", badHigh: true },
    { key: "contentionCaused", label: "Contention (caused)", badHigh: true },
    { key: "avgRelayDelayMs", label: "Avg relay delay", format: (v) => (v == null ? "—" : `${v}ms`) },
    { key: "deferrals", label: "Deferrals (CAD+budget)" },
    { key: "successRate", label: "Decode rate", format: (v) => (v == null ? "—" : `${Math.round(v * 100)}%`) },
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
          const display = c.format ? c.format(raw, r) : escapeHtml(String(raw));
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
    document.getElementById("sim-open-stress-modal").classList.add("hidden");
    document.getElementById("sim-rankings-expand").classList.add("hidden");
    closeModals();
    setRankingsFullWindowOpen(false);
    removeSimPlaybackControl();
    // The transport is scrubbing a report that's about to stop existing, so
    // it has to go too — otherwise the bar stays up driving stale waves.
    clearTransportSource();
    replayWaves = [];
    replayIndex = 0;
    lastReport = null;
    lastMessages = null;
    lastTuneResult = null;
    lastAttrsList = null;
    lastStressResult = null;
    lastPolicyResult = null;
    lastPolicyAltitudeAttrs = null;
    lastPolicyActions = [];
    lastPolicyProfiles = null;
    lastOptimizeDeviations = [];
    optimizeCancelled = true; // stop any in-flight optimize loop from rendering stale results
    clearTimeout(optimizeCancelTimeout);
    lastOptimizeSnapshot = [];
    document.getElementById("sim-policy-profile-detail").classList.add("hidden");
    document.getElementById("sim-policy-section").classList.add("hidden");
    document.getElementById("sim-optimize-section").classList.add("hidden");
    document.getElementById("sim-optimize-node-detail").classList.add("hidden");
    document.getElementById("sim-open-optimize-modal").classList.add("hidden");
    rebuildLinkIndexes(null);
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

  // --- shared replay transport -------------------------------------------
  //
  // One play/pause/seek bar drives BOTH replays (the simulated flood and the
  // real-packet window), because they're the same interaction: step a clock
  // through a sorted list of timestamped events and draw the world as it was
  // at that instant. They used to be two separate fire-and-forget setTimeout
  // chains with no way to pause, rewind, or scrub — you got one pass at
  // whatever speed the code chose, and if you blinked you re-ran it.
  //
  // Time is warped, not linear. Real mesh traffic is mostly dead air (a ±60s
  // CoreScope window can hold three packets), and a simulated flood is the
  // opposite — bursts of near-simultaneous waves separated by relay delays.
  // Playing either at 1:1 wall-clock is unwatchable in different directions.
  // buildTimeWarp maps *source* time (real ms, what the readout shows, what
  // renderers get) onto *play* time (what the scrubber moves through, gaps
  // clamped into a watchable range). Seeking stays correct in both
  // directions because the mapping is a proper invertible piecewise-linear
  // function rather than an ad-hoc per-step delay.
  const TRANSPORT_GAP_CAP_MS = 1500; // longest stretch of dead air we'll actually sit through
  const TRANSPORT_MIN_STEP_MS = 120; // shortest, so a burst doesn't flash past unwatchably

  function buildTimeWarp(times) {
    const uniq = [];
    for (const t of times) {
      if (!Number.isFinite(t)) continue;
      if (!uniq.length || t !== uniq[uniq.length - 1]) uniq.push(t);
    }
    const segs = [];
    let play = 0;
    for (let i = 1; i < uniq.length; i++) {
      const gap = uniq[i] - uniq[i - 1];
      const played = Math.min(TRANSPORT_GAP_CAP_MS, Math.max(TRANSPORT_MIN_STEP_MS, gap));
      segs.push({ srcStart: uniq[i - 1], srcEnd: uniq[i], playStart: play, playEnd: play + played });
      play += played;
    }
    return {
      segs,
      durationPlayMs: play,
      srcFirst: uniq.length ? uniq[0] : 0,
      srcLast: uniq.length ? uniq[uniq.length - 1] : 0,
    };
  }

  // Play time -> source time. Binary search rather than a scan: a dense run
  // produces thousands of segments and this runs every animation frame.
  function playToSrc(warp, playMs) {
    if (!warp || warp.segs.length === 0) return warp ? warp.srcFirst : 0;
    if (playMs <= 0) return warp.srcFirst;
    if (playMs >= warp.durationPlayMs) return warp.srcLast;
    let lo = 0;
    let hi = warp.segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (warp.segs[mid].playEnd < playMs) lo = mid + 1;
      else hi = mid;
    }
    const s = warp.segs[lo];
    const span = s.playEnd - s.playStart;
    const f = span > 0 ? (playMs - s.playStart) / span : 0;
    return s.srcStart + f * (s.srcEnd - s.srcStart);
  }

  // A transport source is whatever is being scrubbed. `times` seeds the warp;
  // `render(srcMs, prevSrcMs)` draws the world at srcMs (prevSrcMs null means
  // "rebuild from scratch" — a seek or a backwards jump); `format(srcMs)`
  // renders the readout; `label` names it in the bar.
  let transportSource = null;
  let transportWarp = null;
  let transportPlayMs = 0;
  let transportPlaying = false;
  let transportRate = 1;
  let transportRaf = null;
  let transportLastFrameTs = 0;
  let transportLastSrcMs = null;

  function transportEl(id) {
    return document.getElementById(id);
  }

  // app.js owns the bottom-of-map stacking (it measures every docked
  // element into CSS variables); showing/hiding the transport bar changes
  // that stack, so nudge it. Guarded because the observer in app.js already
  // covers the normal case — this is just belt and braces for the frame the
  // class flips on.
  function syncBottomClearances() {
    if (typeof window.HopReachSyncBottomClearances === "function") window.HopReachSyncBottomClearances();
  }

  function setTransportSource(source) {
    transportPause();
    transportSource = source;
    transportWarp = source ? buildTimeWarp(source.times) : null;
    transportPlayMs = 0;
    transportLastSrcMs = null;
    const bar = transportEl("sim-transport");
    const hasTimeline = !!(source && transportWarp && source.times.length > 0);
    bar.classList.toggle("hidden", !hasTimeline);
    if (!hasTimeline) {
      syncBottomClearances();
      return;
    }
    const seek = transportEl("sim-transport-seek");
    seek.min = "0";
    // A single-instant timeline (every event at the same ms) has zero play
    // duration; give the scrubber a nonzero range so it isn't a dead control.
    seek.max = String(Math.max(1, Math.round(transportWarp.durationPlayMs)));
    seek.value = "0";
    transportEl("sim-transport-label").textContent = source.label || "";
    transportRender(false);
    syncBottomClearances();
  }

  function clearTransportSource() {
    transportPause();
    transportSource = null;
    transportWarp = null;
    transportLastSrcMs = null;
    transportEl("sim-transport").classList.add("hidden");
    syncBottomClearances();
  }

  // Draws the world at the current play position. `animate` is passed to the
  // source so it can pulse newly-crossed events while playing but stay silent
  // while scrubbing — dragging the bar across a hundred hops shouldn't fire a
  // hundred overlapping pulse animations.
  function transportRender(animate) {
    if (!transportSource || !transportWarp) return;
    const srcMs = playToSrc(transportWarp, transportPlayMs);
    const prev = animate && transportLastSrcMs != null && srcMs >= transportLastSrcMs ? transportLastSrcMs : null;
    transportSource.render(srcMs, prev);
    transportLastSrcMs = srcMs;
    const seek = transportEl("sim-transport-seek");
    if (document.activeElement !== seek) seek.value = String(Math.round(transportPlayMs));
    transportEl("sim-transport-time").textContent = transportSource.format(srcMs);
  }

  function transportFrame(ts) {
    if (!transportPlaying) return;
    const dt = transportLastFrameTs ? ts - transportLastFrameTs : 0;
    transportLastFrameTs = ts;
    // Clamp the frame delta so a backgrounded tab (which stops firing rAF)
    // doesn't resume by jumping the whole elapsed wall-clock at once.
    transportPlayMs += Math.min(250, dt) * transportRate;
    if (transportPlayMs >= transportWarp.durationPlayMs) {
      transportPlayMs = transportWarp.durationPlayMs;
      transportRender(true);
      transportPause();
      return;
    }
    transportRender(true);
    transportRaf = requestAnimationFrame(transportFrame);
  }

  function transportPlay() {
    if (!transportSource || !transportWarp) return;
    // Playing from the very end restarts, rather than sitting there doing
    // nothing — the common case after watching one through.
    if (transportPlayMs >= transportWarp.durationPlayMs) {
      transportPlayMs = 0;
      transportLastSrcMs = null;
      transportRender(false);
    }
    transportPlaying = true;
    transportLastFrameTs = 0;
    transportEl("sim-transport-play").textContent = "⏸";
    transportEl("sim-transport-play").setAttribute("aria-label", "Pause");
    transportRaf = requestAnimationFrame(transportFrame);
  }

  function transportPause() {
    transportPlaying = false;
    if (transportRaf) cancelAnimationFrame(transportRaf);
    transportRaf = null;
    const btn = transportEl("sim-transport-play");
    if (btn) {
      btn.textContent = "▶";
      btn.setAttribute("aria-label", "Play");
    }
  }

  function transportSeekTo(playMs) {
    if (!transportWarp) return;
    transportPlayMs = Math.max(0, Math.min(transportWarp.durationPlayMs, playMs));
    transportLastSrcMs = null; // a seek can go backwards, so always rebuild
    transportRender(false);
  }

  function transportToEnd() {
    if (!transportWarp) return;
    transportPause();
    transportSeekTo(transportWarp.durationPlayMs);
  }

  function transportRestart() {
    if (!transportWarp) return;
    transportSeekTo(0);
    transportPlay();
  }

  let replayWaves = [];
  let replayIndex = 0;

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

  // Re-renders whatever's currently on screen for the CURRENT
  // simViewMode.keepAllPaths setting, so the toggle is a live analysis
  // lens rather than something that only takes effect on the next run.
  // playWave alone can't do this: it only ever acts on the next wave
  // tick, which means toggling in a finished/static view (the common
  // case — you've just watched a replay and want to look again) did
  // nothing visible at all.
  //
  // "Which lines belong on screen" depends on how far through the replay
  // we are, hence the two branches. Growth markers have to be rebuilt
  // either way, since simResultsLayer.clearLayers() drops them alongside
  // the lines (see skipToEnd's own note on this).
  function redrawPathsForKeepAllPaths() {
    if (!lastReport) return;
    // No waves built yet (a report exists but Replay was never started —
    // startReplay is what populates replayWaves) means there's no "most
    // recent wave" to narrow down to, so the accumulated view is the only
    // meaningful one regardless of the toggle. Without this, unticking
    // Keep all paths in that state would blank the map entirely.
    if (replayWaves.length === 0) {
      redrawResultLines(lastReport);
      currentWaveLines = [];
      growthMarkers.clear();
      applyFinalGrowth(lastReport);
      return;
    }
    const finished = replayIndex >= replayWaves.length;

    if (simViewMode.keepAllPaths) {
      if (finished) {
        redrawResultLines(lastReport);
        currentWaveLines = [];
        growthMarkers.clear();
        applyFinalGrowth(lastReport);
        return;
      }
      // Mid-replay: accumulate everything played SO FAR (waves
      // 0..replayIndex-1), not the whole report — the run hasn't got to
      // the rest yet, and showing it would be a different view than the
      // one being watched.
      renderWaveRange(0, replayIndex);
      return;
    }

    // !keepAllPaths — only the most recently played wave stays on screen.
    // Nothing has played yet (replayIndex 0, replay not started) means
    // there's no "most recent wave"; a finished replay's most recent one
    // is the last.
    const lastPlayed = finished ? replayWaves.length - 1 : replayIndex - 1;
    if (lastPlayed < 0) {
      simResultsLayer.clearLayers();
      currentWaveLines = [];
      growthMarkers.clear();
      nodeGrowthCounts = [];
      return;
    }
    renderWaveRange(lastPlayed, lastPlayed + 1);
  }

  // Draws waves [startIndex, endIndex) fresh, replacing whatever's on the
  // results layer, and rebuilds growth markers to match exactly those
  // waves — so growth always reflects the same subset of the run the
  // lines do, rather than drifting out of step with it.
  function renderWaveRange(startIndex, endIndex) {
    simResultsLayer.clearLayers();
    currentWaveLines = [];
    growthMarkers.clear();
    nodeGrowthCounts = [];
    for (let i = startIndex; i < endIndex; i++) {
      const wave = replayWaves[i];
      if (!wave) continue;
      const from = simNodes[wave.fromNode];
      if (!from) continue;
      for (const r of wave.receptions) {
        if (!matchesViewFilter(r)) continue;
        const to = simNodes[r.node];
        if (!to) continue;
        const line = L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
        ).addTo(simResultsLayer);
        currentWaveLines.push(line);
        if (matchesGrowBy(r)) growNode(r.node);
      }
    }
  }

  // How many waves have happened by srcMs. replayWaves is sorted by atMs,
  // so this is a binary search — it runs on every animation frame.
  function countWavesUpTo(srcMs) {
    let lo = 0;
    let hi = replayWaves.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (replayWaves[mid].atMs <= srcMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // The simulated flood as a transport source. Rendering is incremental
  // while playing forward (append only the waves just crossed, pulses and
  // all) and a full rebuild on any seek — with an early-out when the play
  // head hasn't crossed a wave boundary at all, which is most frames.
  function simTransportSource() {
    return {
      kind: "sim",
      label: "Simulated flood",
      times: replayWaves.map((w) => w.atMs),
      format: (srcMs) => {
        const k = countWavesUpTo(srcMs);
        return `t=${Math.round(srcMs)}ms · ${k}/${replayWaves.length}`;
      },
      render: (srcMs, prevSrcMs) => {
        const k = countWavesUpTo(srcMs);
        if (prevSrcMs != null) {
          const prevK = countWavesUpTo(prevSrcMs);
          if (k === prevK) return; // nothing new happened this frame
          // playWave already honours keepAllPaths (clearing the previous
          // wave's lines when it's off), so this one path covers both views.
          for (let i = prevK; i < k; i++) playWave(replayWaves[i]);
          replayIndex = k;
          setReplayStatus(k >= replayWaves.length ? "Replay finished — showing final state." : `Playing… t=${replayWaves[k - 1].atMs}ms (${k}/${replayWaves.length})`);
          return;
        }
        // Seek (or first render): rebuild from scratch. redrawPathsForKeep-
        // AllPaths reads replayIndex to decide what "now" means, so set it
        // first — it's the same function the Keep-all-paths toggle uses, which
        // keeps scrubbing and toggling in perfect agreement about what should
        // be on screen.
        replayIndex = k;
        if (lastReport) redrawPathsForKeepAllPaths();
        else {
          simResultsLayer.clearLayers();
          growthMarkers.clear();
          currentWaveLines = [];
          nodeGrowthCounts = [];
        }
        setReplayStatus(
          replayWaves.length === 0 ? "" : k >= replayWaves.length ? "Showing final state." : `t=${Math.round(srcMs)}ms (${k}/${replayWaves.length})`
        );
      },
    };
  }

  function stopReplay() {
    transportPause();
  }

  function startReplay() {
    replayWaves = lastReport ? buildWaves(lastReport) : [];
    replayIndex = 0;
    simResultsLayer.clearLayers();
    growthMarkers.clear();
    nodeGrowthCounts = [];
    currentWaveLines = [];
    if (replayWaves.length === 0) {
      clearTransportSource();
      setReplayStatus("");
      return;
    }
    setTransportSource(simTransportSource());
    transportPlay();
  }

  function skipToEnd() {
    // Skipping to the end before ever pressing play still needs the waves
    // built and the transport pointed at them.
    if (replayWaves.length === 0 && lastReport) {
      replayWaves = buildWaves(lastReport);
      if (replayWaves.length > 0) setTransportSource(simTransportSource());
    }
    if (!transportSource || transportSource.kind !== "sim") {
      if (replayWaves.length > 0) setTransportSource(simTransportSource());
    }
    if (replayWaves.length === 0) {
      simResultsLayer.clearLayers();
      growthMarkers.clear();
      currentWaveLines = [];
      nodeGrowthCounts = [];
      setReplayStatus("");
      return;
    }
    transportToEnd();
    setReplayStatus("Showing final state.");
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
  // sync manually, same as defaultPrefs() mirroring DefaultNodePrefs. The
  // last three cases (item 15c) are additive — the older single-rule
  // "Predict settings" feature never produces a rule using them, so this
  // extension doesn't change its own existing behaviour at all.
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
      case "neighbors_at_most":
        return attrs.neighborCount <= c.threshold;
      case "is_articulation":
        return !!attrs.isArticulation;
      case "marginal_coverage_at_least":
        return attrs.marginalCoverage >= c.threshold;
      default:
        return false;
    }
  }

  // Mirrors internal/meshsim/rules.go's ConfigRule.Apply.
  // Mirrors internal/meshsim/rules.go's RuleScale.valueAt exactly — linear
  // interpolation between (atMin, valueAtMin) and (atMax, valueAtMax),
  // clamped outside that range, atMin==atMax returns valueAtMin rather
  // than dividing by zero.
  function ruleScaleValueAt(scale, x) {
    if (scale.atMax === scale.atMin) return scale.valueAtMin;
    let t = (x - scale.atMin) / (scale.atMax - scale.atMin);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return scale.valueAtMin + t * (scale.valueAtMax - scale.valueAtMin);
  }

  // Mirrors internal/meshsim/rules.go's ConfigRule.ApplyWithAttrs
  // (attrs is required, not optional, unlike Go's plain Apply — every JS
  // caller already has NodeAttrs on hand, see applyPolicyToNodeState).
  // Phase 4 (docs/SIMULATOR_PLAN_PHASE4.md work item 1): a rule's own
  // Scale, when set, computes txDelayFactor from a node attribute instead
  // of the constant txDelayFactor field — same Scale-wins tie-break as
  // the Go side if a rule somehow sets both.
  function applyRule(basePrefs, rule, attrs) {
    const out = { ...basePrefs };
    if (rule.txDelayFactor != null) out.txDelayFactor = rule.txDelayFactor;
    if (rule.directTxDelayFactor != null) out.directTxDelayFactor = rule.directTxDelayFactor;
    if (rule.rxDelayBase != null) out.rxDelayBase = rule.rxDelayBase;
    if (rule.scale) {
      const attrValue =
        rule.scale.attr === "neighbor_count" ? attrs.neighborCount :
        rule.scale.attr === "altitude_m" ? attrs.altitudeM :
        rule.scale.attr === "marginal_coverage" ? attrs.marginalCoverage :
        null;
      if (attrValue != null) out.txDelayFactor = ruleScaleValueAt(rule.scale, attrValue);
    }
    return out;
  }

  // --- item 15c: JS mirrors of the Go-side topology attributes -----------
  //
  // internal/meshsim.SuggestPolicy computes IsArticulation/MarginalCoverage
  // itself and never returns them — only the winning ConfigPolicy comes
  // back. To show which specific repeaters that policy actually changes
  // (the action list below), this needs to re-derive the same per-node
  // attributes client-side, from the same simLinks topology, using the
  // same algorithms as internal/meshsim/topology.go.

  function computeNeighborSets() {
    const neighbors = simNodes.map(() => new Set());
    for (const l of simLinks) {
      if (neighbors[l.from]) neighbors[l.from].add(l.to);
      if (neighbors[l.to]) neighbors[l.to].add(l.from);
    }
    return neighbors;
  }

  // Mirrors internal/meshsim/topology.go's findArticulationPoints (Tarjan's
  // low-link DFS).
  function findArticulationPointsJs(neighbors) {
    const n = neighbors.length;
    const disc = new Array(n).fill(0);
    const low = new Array(n).fill(0);
    const visited = new Array(n).fill(false);
    const isArt = new Array(n).fill(false);
    let timer = 0;
    function dfs(u, parent) {
      visited[u] = true;
      timer++;
      disc[u] = timer;
      low[u] = timer;
      let children = 0;
      for (const v of neighbors[u]) {
        if (v === parent) continue;
        if (visited[v]) {
          if (disc[v] < low[u]) low[u] = disc[v];
          continue;
        }
        children++;
        dfs(v, u);
        if (low[v] < low[u]) low[u] = low[v];
        if (parent !== -1 && low[v] >= disc[u]) isArt[u] = true;
      }
      if (parent === -1 && children > 1) isArt[u] = true;
    }
    for (let i = 0; i < n; i++) {
      if (!visited[i]) dfs(i, -1);
    }
    return isArt;
  }

  // Mirrors internal/meshsim/topology.go's marginalCoverageFor.
  function marginalCoverageForJs(u, neighbors) {
    let unique = 0;
    for (const v of neighbors[u]) {
      let coveredByOther = false;
      for (const w of neighbors[u]) {
        if (w === v) continue;
        if (neighbors[w].has(v)) {
          coveredByOther = true;
          break;
        }
      }
      if (!coveredByOther) unique++;
    }
    return unique;
  }

  // Mirrors internal/meshsim/topology.go's computeTopologyAttrs — the
  // JS-side counterpart used purely for rendering the action list, never
  // sent to the engine (the WASM/Go side always recomputes these itself).
  function computeTopologyAttrsJs() {
    const neighbors = computeNeighborSets();
    const isArt = findArticulationPointsJs(neighbors);
    return simNodes.map((n, i) => ({
      neighborCount: neighbors[i].size,
      isArticulation: isArt[i],
      marginalCoverage: marginalCoverageForJs(i, neighbors),
    }));
  }

  // Applies every rule in a ConfigPolicy (item 15c) to one node's baseline
  // prefs/floodMax, in order — later rules override earlier ones per-field,
  // mirroring internal/meshsim.applyPolicyToScenario exactly.
  function applyPolicyToNodeState(basePrefs, baseFloodMax, policy, attrs) {
    let prefs = basePrefs;
    let floodMax = baseFloodMax;
    for (const rule of policy) {
      if (!ruleMatchesAttrs(rule, attrs)) continue;
      prefs = applyRule(prefs, rule, attrs);
      if (rule.floodMax != null) floodMax = rule.floodMax;
    }
    return { prefs, floodMax };
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

  // --- item 15b: stress test / offered-load sweep ------------------------
  //
  // Deliberately synthetic traffic, not the user's own message senders
  // above (see internal/meshsim.generateStressMessages) — the whole point
  // is finding the network's own ceiling, not replaying one specific
  // scenario at increasing multiples of itself.
  async function runStressTest() {
    if (simNodes.length === 0) {
      setStatus("sim-status", "Load some nodes first.");
      return;
    }
    if (simLinks.length === 0) {
      setStatus("sim-status", 'No connectivity built yet — click "Build links" first.');
      return;
    }
    const loadLevels = document
      .getElementById("sim-stress-levels")
      .value.split(",")
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b); // computeKnee (Go side) assumes ascending order
    if (loadLevels.length === 0) {
      setStatus("sim-status", "Enter at least one positive load level (msgs/min).");
      return;
    }
    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    const trials = Math.min(100, Math.max(1, parseInt(document.getElementById("sim-trials").value, 10) || 20));
    setStatus("sim-status", "Running stress sweep…");
    setStressProgress(0, loadLevels.length);
    document.getElementById("sim-stress-run").disabled = true;

    const generation = ++predictGeneration; // shares the worker + its generation guard with predictSettings — only one search of either kind is ever live at once
    const worker = ensurePredictWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.generation !== generation) return;
      if (msg.type === "stress-progress") {
        setStressProgress(msg.done, msg.total);
      } else if (msg.type === "stress-result") {
        worker.removeEventListener("message", onMessage);
        hideStressProgress();
        document.getElementById("sim-stress-run").disabled = false;
        lastStressResult = msg.result;
        renderStressResult(msg.result);
        setStatus("sim-status", "Done.");
        openModal("sim-stress-modal");
      } else if (msg.type === "stress-error") {
        worker.removeEventListener("message", onMessage);
        hideStressProgress();
        document.getElementById("sim-stress-run").disabled = false;
        setStatus("sim-status", `Stress test failed: ${msg.message}`);
      }
    }
    worker.addEventListener("message", onMessage);
    worker.postMessage({
      kind: "stress",
      generation,
      stressRequest: {
        scenario: scenarioFromState(),
        maxSimTimeMs,
        trials,
        seed,
        loadLevels,
      },
    });
  }

  function renderStressResult(result) {
    document.getElementById("sim-open-stress-modal").classList.remove("hidden");
    const knee = result.kneeMessagesPerMinute;
    document.getElementById("sim-stress-summary").textContent =
      knee > 0
        ? `This network handles up to ~${knee} messages/minute before delivery drops below 95% of its best-case level.`
        : "Delivery never held above 95% of its best-case level at any swept load — try lower load levels.";
    const tbody = document.getElementById("sim-stress-tbody");
    tbody.innerHTML = "";
    for (const level of result.levels) {
      const tr = document.createElement("tr");
      const isKnee = level.messagesPerMinute === knee;
      if (isKnee) tr.className = "sim-knee-row";
      tr.innerHTML = `
        <td>${level.messagesPerMinute}${isKnee ? " ⭐" : ""}</td>
        <td>${(level.deliveryRatio * 100).toFixed(1)}%</td>
        <td>${(level.collisionRate * 100).toFixed(1)}%</td>
      `;
      tbody.appendChild(tr);
    }
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
      const prefs = matches ? applyRule(defaultPrefs(), best.rule, attrsList[i]) : defaultPrefs();
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(n.label)}</span>
        <span class="plan-item-sub">txdelay ${prefs.txDelayFactor.toFixed(2)} · rxdelay ${prefs.rxDelayBase.toFixed(1)}${matches ? "" : " (baseline — best rule doesn't apply here)"}</span>
      `;
      list.appendChild(row);
    });
  }

  // --- item 15c/15d: composite policy search + action list ---------------

  let lastPolicyResult = null;
  let lastPolicyAltitudeAttrs = null; // AltitudeM per node, as sent to SuggestPolicy — merged with computeTopologyAttrsJs() when rendering the action list
  let lastPolicyActions = []; // for CSV export — see exportPolicyActionsCsv
  let lastPolicyProfiles = null; // Map<label, [{nodeIndex, others}]> for the currently-displayed policy — see renderPolicyProfileSummary/openPolicyProfileDetail

  async function runSuggestPolicy() {
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
    setStatus("sim-status", "Searching policies (topology + delay models)…");
    setPredictProgress(0, 1);
    document.getElementById("sim-suggest-policy").disabled = true;

    const grid = await ensureGrid(simNodes).catch(() => null);
    const attrs = attrsFromState(simNodes, grid); // only altitudeM is actually read server-side — see PolicyTuneRequest's own doc comment
    lastPolicyAltitudeAttrs = attrs;

    const generation = ++predictGeneration; // shares the same worker + generation guard as predictSettings/runStressTest
    const worker = ensurePredictWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.generation !== generation) return;
      if (msg.type === "suggest-policy-progress") {
        setPredictProgress(msg.done, msg.total);
      } else if (msg.type === "suggest-policy-result") {
        worker.removeEventListener("message", onMessage);
        hidePredictProgress();
        document.getElementById("sim-suggest-policy").disabled = false;
        lastPolicyResult = msg.result;
        renderPolicyResult(msg.result);
        setStatus("sim-status", "Done.");
        openModal("sim-predictions-modal");
      } else if (msg.type === "suggest-policy-error") {
        worker.removeEventListener("message", onMessage);
        hidePredictProgress();
        document.getElementById("sim-suggest-policy").disabled = false;
        setStatus("sim-status", `Policy search failed: ${msg.message}`);
      }
    }
    worker.addEventListener("message", onMessage);
    worker.postMessage({
      kind: "suggest-policy",
      generation,
      policyTuneRequest: {
        scenario: scenarioFromState(),
        messages: messagesFromState(seed),
        attrs,
        maxSimTimeMs,
        trials,
        seed,
      },
    });
  }

  function renderPolicyResult(result) {
    const section = document.getElementById("sim-policy-section");
    // A fresh policy search invalidates any prior optimizer result — it
    // was built on top of the OLD best policy, which this search may just
    // have replaced (see runOptimizeAdaptive's own use of
    // lastPolicyResult.suggestions[0].policy as its starting point).
    document.getElementById("sim-optimize-section").classList.add("hidden");
    document.getElementById("sim-open-optimize-modal").classList.add("hidden");
    lastOptimizeDeviations = [];
    lastOptimizeSnapshot = [];
    if (!result.suggestions || result.suggestions.length === 0) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    const best = result.suggestions[0];
    document.getElementById("sim-policy-summary").textContent =
      `Baseline: ${(result.baselineDelivery * 100).toFixed(1)}% delivery, ${(result.baselineCollision * 100).toFixed(1)}% collisions ` +
      `→ best policy "${best.name}": ${(best.deliveryRatio * 100).toFixed(1)}% delivery, ${(best.collisionRate * 100).toFixed(1)}% collisions ` +
      `(seed ${document.getElementById("sim-seed").value}, ${document.getElementById("sim-trials").value} trials — reproducible).`;

    const suggList = document.getElementById("sim-policy-suggestions-list");
    suggList.innerHTML = "";
    result.suggestions.slice(0, 10).forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      const better = s.deliveryRatio > result.baselineDelivery;
      row.innerHTML = `
        <span class="sim-suggestion-rank">#${i + 1}</span>
        <span class="plan-item-label">${escapeHtml(s.name)}</span>
        <span class="sim-suggestion-rate ${better ? "sim-rate-better" : ""}">${(s.deliveryRatio * 100).toFixed(1)}% delivery (baseline ${(result.baselineDelivery * 100).toFixed(1)}%) · ${(s.collisionRate * 100).toFixed(1)}% collisions</span>
      `;
      suggList.appendChild(row);
    });

    renderPolicyActionList(best);
    renderPolicySourceNote(best);
    renderPolicyProfileSummary(result, best); // async, fire-and-forget — see its own doc comment
  }

  // Cached across calls — the built-in method catalogue is static for the
  // lifetime of the page (see internal/meshsim.BuiltinMeshMethods), so
  // there's no reason to re-cross the WASM boundary for it every time a
  // search result renders.
  let meshMethodsCache = null;
  async function meshMethodByName(name) {
    if (!meshMethodsCache) {
      await MeshSim.ready;
      meshMethodsCache = MeshSim.meshMethods();
    }
    return meshMethodsCache.find((m) => m.name === name) || null;
  }

  // A community-method suggestion's name is prefixed "community: " by
  // internal/meshsim's own communityMethodCandidates — the marker this
  // function uses to decide whether to show a Source line at all. Every
  // MeshMethod.Source is non-empty by construction (enforced by a Go
  // test), so this is never left dangling once a match is found — see
  // MeshMethod's own doc comment on why this must never render with the
  // same authority as a firmware-verified fact.
  async function renderPolicySourceNote(best) {
    const el = document.getElementById("sim-policy-source-note");
    const prefix = "community: ";
    if (!best.name.startsWith(prefix)) {
      el.classList.add("hidden");
      return;
    }
    const method = await meshMethodByName(best.name.slice(prefix.length));
    if (!method) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.innerHTML =
      `📋 Community-reported convention, not a firmware-verified fact — ` +
      `<a href="${escapeHtml(method.source)}" target="_blank" rel="noopener">${escapeHtml(method.source)}</a> ` +
      `(as of ${escapeHtml(method.asOf)}).${method.note ? ` ${escapeHtml(method.note)}` : ""}`;
  }

  // Phase 4 work item 6 — shows which of the winning policy's own NAMED
  // rules labelled each repeater, and how many repeaters landed in each.
  // Word labels only — no colour coding for profile identity, since a
  // colour needs a legend to decode and doesn't survive being read aloud
  // or pasted into a message (the community guides this feature is built
  // from DO assign a colour per profile; deliberately not carried over).
  //
  // Async because MeshSim.assignPolicy needs `await MeshSim.ready` first
  // — called fire-and-forget from renderPolicyResult (itself synchronous,
  // driven by a worker message), so the profile section fills in a moment
  // after the rest of the results do rather than blocking them.
  //
  // Convention for a node matching MULTIPLE named rules: show the LAST
  // one applied (ConfigPolicy's own later-overrides-earlier contract
  // means it's the one that actually won any field it set), with earlier
  // named matches listed in the detail view rather than hidden — see
  // AssignPolicy's own doc comment on why this is a display convention,
  // not something baked into the engine.
  async function renderPolicyProfileSummary(result, best) {
    const summaryEl = document.getElementById("sim-policy-profile-summary");
    const detailEl = document.getElementById("sim-policy-profile-detail");
    detailEl.classList.add("hidden");
    summaryEl.innerHTML = "";
    lastPolicyProfiles = null;
    if (simNodes.length === 0) return;

    await MeshSim.ready;
    const scenario = scenarioFromState();
    const attrsArray = attrsArrayForPolicy();
    const assignments = MeshSim.assignPolicy(scenario, attrsArray, best.policy);

    const groups = new Map();
    assignments.forEach((a) => {
      let label = null;
      const others = [];
      for (const idx of a.matchedRules) {
        const rule = best.policy[idx];
        if (rule && rule.name) {
          if (label != null) others.push(label);
          label = rule.name;
        }
      }
      const key = label || "No profile";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ nodeIndex: a.node, others });
    });
    lastPolicyProfiles = groups;

    // "Nothing silently dropped" check (docs/SIMULATOR_PLAN_PHASE4.md work
    // item 6) — every loaded repeater must land in exactly one group,
    // including "No profile."
    const totalGrouped = Array.from(groups.values()).reduce((sum, arr) => sum + arr.length, 0);
    if (totalGrouped !== simNodes.length) {
      console.error(`Policy profile breakdown: grouped ${totalGrouped} of ${simNodes.length} loaded repeaters — some were dropped. This is a bug.`);
    }

    // "No profile" last; everything else in the order it first appears
    // among the assignments, which follows the policy's own rule order —
    // reads the way the policy itself was written, not alphabetically.
    const orderedLabels = Array.from(groups.keys()).sort((a, b) => (a === "No profile" ? 1 : b === "No profile" ? -1 : 0));

    orderedLabels.forEach((label) => {
      const nodes = groups.get(label);
      const sampleAttrs = attrsArray[nodes[0].nodeIndex];
      const { prefs } = applyPolicyToNodeState(defaultPrefs(), 0, best.policy, sampleAttrs);
      const row = document.createElement("div");
      row.className = "plan-list-item sim-policy-profile-row";
      const settingsLabel = label === "No profile" ? "kept at baseline settings" : `txdelay ${prefs.txDelayFactor}`;
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(label)}</span>
        <span class="plan-item-sub">${settingsLabel} · ${nodes.length} repeater${nodes.length === 1 ? "" : "s"}</span>
        <span class="sim-policy-profile-chevron">›</span>
      `;
      row.addEventListener("click", () => openPolicyProfileDetail(label));
      summaryEl.appendChild(row);
    });
  }

  // Drills into one profile's own repeater list — each row shows the
  // specific measured criteria (altitude/neighbour count/articulation)
  // that actually caused the match, so a mis-tiered repeater is
  // immediately explainable, not just visible.
  function openPolicyProfileDetail(label) {
    if (!lastPolicyProfiles || !lastPolicyProfiles.has(label)) return;
    const nodes = lastPolicyProfiles.get(label);
    const attrsArray = attrsArrayForPolicy();

    document.getElementById("sim-policy-profile-detail").classList.remove("hidden");
    document.getElementById("sim-policy-profile-detail-title").textContent = `${label} — ${nodes.length} repeater${nodes.length === 1 ? "" : "s"}`;

    const list = document.getElementById("sim-policy-profile-detail-list");
    list.innerHTML = "";
    nodes.forEach(({ nodeIndex, others }) => {
      const n = simNodes[nodeIndex];
      const attrs = attrsArray[nodeIndex] || {};
      const criteria = [`${attrs.neighborCount || 0} neighbour${attrs.neighborCount === 1 ? "" : "s"}`];
      if (attrs.altitudeM) criteria.push(`altitude ${Math.round(attrs.altitudeM)}m`);
      if (attrs.isArticulation) criteria.push("articulation point");
      const otherNote = others.length ? ` <span class="sim-policy-profile-detail-approx">(also matched: ${others.map(escapeHtml).join(", ")})</span>` : "";
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(n ? n.label : `#${nodeIndex}`)}</span>
        <span class="plan-item-sub">${criteria.join(" · ")}${otherNote}</span>
      `;
      list.appendChild(row);
    });
  }

  // Builds the full NodeAttrs array, parallel to simNodes, that a policy
  // needs to be matched/applied against — altitudeM from the last search's
  // own supplied attrs (SuggestPolicy never recomputes this; it's real
  // terrain data, not derivable from the graph) merged with topology
  // attrs recomputed fresh from the CURRENT simLinks (neighborCount/
  // isArticulation/marginalCoverage — always safe to recompute, see
  // computeTopologyAttrsJs's own doc comment). Shared by
  // renderPolicyActionList and the profile breakdown
  // (renderPolicyProfileSummary) so the two can't disagree about which
  // attrs a node has.
  function attrsArrayForPolicy() {
    const topologyAttrs = computeTopologyAttrsJs();
    return simNodes.map((n, i) => ({
      altitudeM: (lastPolicyAltitudeAttrs && lastPolicyAltitudeAttrs[i] && lastPolicyAltitudeAttrs[i].altitudeM) || 0,
      ...(topologyAttrs[i] || { neighborCount: 0, isArticulation: false, marginalCoverage: 0 }),
    }));
  }

  // The per-repeater "what actually needs to change" list (item 15d) — only
  // nodes where the winning policy's own recommendation genuinely differs
  // from what's currently set, each with a copy-pasteable MeshCore CLI
  // line. Recommendations are computed from defaultPrefs() (a clean
  // baseline), the same convention the older single-rule
  // renderPerNodePredictions already uses, not from "current + delta" —
  // this is "what should this repeater's setting BE," not a diff of
  // arbitrary prior manual tweaks.
  function renderPolicyActionList(best) {
    const attrsArray = attrsArrayForPolicy();
    const actions = [];
    simNodes.forEach((n, i) => {
      const attrs = attrsArray[i];
      const { prefs: recPrefs, floodMax: recFloodMax } = applyPolicyToNodeState(defaultPrefs(), 0, best.policy, attrs);
      const curPrefs = effectivePrefsFor(n);
      const curFloodMax = effectiveFloodMax(n);

      const changed = [];
      const EPS = 1e-9;
      if (Math.abs(recPrefs.txDelayFactor - curPrefs.txDelayFactor) > EPS) {
        changed.push({ cli: `set txdelay ${recPrefs.txDelayFactor}`, label: `txdelay ${curPrefs.txDelayFactor} → ${recPrefs.txDelayFactor}` });
      }
      if (Math.abs(recPrefs.rxDelayBase - curPrefs.rxDelayBase) > EPS) {
        changed.push({ cli: `set rxdelay ${recPrefs.rxDelayBase}`, label: `rxdelay ${curPrefs.rxDelayBase} → ${recPrefs.rxDelayBase}` });
      }
      if (Math.abs(recPrefs.directTxDelayFactor - curPrefs.directTxDelayFactor) > EPS) {
        changed.push({ cli: `set direct.txdelay ${recPrefs.directTxDelayFactor}`, label: `direct.txdelay ${curPrefs.directTxDelayFactor} → ${recPrefs.directTxDelayFactor}` });
      }
      if (recFloodMax && recFloodMax !== (curFloodMax || 0)) {
        changed.push({ cli: `set flood.max ${recFloodMax}`, label: `flood.max ${curFloodMax || "64 (default)"} → ${recFloodMax}` });
      }
      if (changed.length > 0) actions.push({ label: n.label, changed });
    });

    lastPolicyActions = actions;
    const actionsList = document.getElementById("sim-policy-actions-list");
    actionsList.innerHTML = "";
    if (actions.length === 0) {
      actionsList.innerHTML = `<div class="plan-hint">No changes — every repeater the policy covers is already at the recommended settings; ${simNodes.length} repeater${simNodes.length === 1 ? "" : "s"} left untouched.</div>`;
      return;
    }
    const untouched = simNodes.length - actions.length;
    const headerHint = document.createElement("div");
    headerHint.className = "plan-hint";
    headerHint.textContent = `${actions.length} repeater${actions.length === 1 ? "" : "s"} need a change${untouched > 0 ? ` — ${untouched} left at defaults` : ""}.`;
    actionsList.appendChild(headerHint);
    actions.forEach(({ label, changed }) => {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(label)}</span>
        <span class="plan-item-sub">${changed.map((c) => `<code>${escapeHtml(c.cli)}</code>`).join(" &nbsp;·&nbsp; ")}</span>
      `;
      actionsList.appendChild(row);
    });
  }

  function exportPolicyActionsCsv() {
    if (lastPolicyActions.length === 0) {
      setStatus("sim-status", "Nothing to export — no repeater needs a change under the current best policy.");
      return;
    }
    const rows = [["Repeater", "Change", "CLI command"]];
    for (const { label, changed } of lastPolicyActions) {
      for (const c of changed) rows.push([label, c.label, c.cli]);
    }
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "policy-actions.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- phase 4 work item 4: adaptive optimizer ----------------------------
  //
  // "slowly adjusts from seeing collisions etc and contention on specific
  // repeaters etc until it disappears" (docs/SIMULATOR_PLAN_PHASE4.md) —
  // a closed loop: measure -> find the worst offender -> back it off ->
  // re-measure -> keep or revert -> repeat, starting from Search policies'
  // own winning result rather than from nothing (see internal/meshsim.
  // OptimizeRequest.BasePolicy's own doc comment on why the search itself
  // isn't re-run inside the optimizer).
  //
  // The round-by-round loop lives HERE, in the main thread, not inside the
  // worker — deliberately. internal/meshsim.OptimizeStep does exactly ONE
  // bounded round per call; if this loop instead lived inside the
  // worker's own onmessage handler (calling OptimizeStep repeatedly
  // before ever posting a message back), the worker's event loop would
  // stay blocked for the ENTIRE optimization, unable to notice a cancel
  // message for the same reason "suggest"/"suggest-policy" can't be
  // cancelled mid-search today (see meshsim-worker.js's own comment on
  // this). Driving it from here means every single round is its own
  // postMessage round-trip, so control genuinely returns to this loop
  // (and Cancel can actually take effect) between every round.
  let optimizeCancelled = false;
  let optimizeCancelTimeout = null;
  let lastOptimizeDeviations = []; // for CSV export — see exportOptimizeDeviationsCsv
  let lastOptimizeSnapshot = []; // per-repeater table rows — see renderOptimizeNodesTable/openOptimizeNodeDetail

  // MIN_IMPROVEMENT is in contention-SCORE units (see
  // internal/meshsim.nodeContentionScore), not a percentage.
  //
  // DELIVERY_TOLERANCE is how much delivery a single move may give up
  // while still counting as "delivery held" — deliberately NOT zero.
  // Zero was the original default and made the optimizer completely
  // inert on any real-sized network: backing a node off essentially
  // always costs a hair of delivery while reducing contention, so a
  // zero-tolerance gate rejected literally every move (measured on a
  // 30-node mesh: 0 accepted moves in 8 rounds, including one costing
  // 0.0004 delivery for a 25-point contention win). The hard floor
  // against cumulative drift is maxDeliveryRegression, enforced Go-side
  // against the run's own baseline — see OptimizeRequest's own docs.
  //
  // Max rounds / stale-rounds-limit are now user-settable
  // (docs/SIMULATOR_PLAN_PHASE6.md work item G, #sim-optimize-max-rounds/
  // #sim-optimize-stale-limit) rather than hardcoded here — see
  // roundBudgetField and runOptimizeAdaptive.
  const OPTIMIZE_MIN_IMPROVEMENT = 0.5;
  const OPTIMIZE_DELIVERY_TOLERANCE = 0.005;
  // How long Cancel waits for the in-flight round to finish gracefully
  // before force-terminating the worker outright (docs/SIMULATOR_PLAN_
  // PHASE4.md work item 4's own "terminate() as the hard stop" —
  // graceful-then-forced, not either/or). This is exactly what makes
  // "unlimited rounds" (work item G) safe to offer at all — see that
  // field's own doc comment on internal/meshsim.OptimizeRequest.
  const OPTIMIZE_CANCEL_FORCE_TIMEOUT_MS = 8000;

  // Reads a "0/blank means unlimited" round-budget field
  // (docs/SIMULATOR_PLAN_PHASE6.md work item G) — deliberately a distinct
  // {value, unlimited} pair rather than overloading 0, mirroring
  // internal/meshsim.OptimizeRequest's own Unlimited* bools: a blank or
  // non-positive field is a real, explicit "run without this limit"
  // request, not silently coerced into some default the user didn't ask
  // for.
  function roundBudgetField(id) {
    const raw = document.getElementById(id).value.trim();
    const n = parseInt(raw, 10);
    if (raw === "" || !Number.isFinite(n) || n <= 0) return { value: 0, unlimited: true };
    return { value: n, unlimited: false };
  }

  async function runOptimizeAdaptive() {
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
    if (!lastPolicyResult || !lastPolicyResult.suggestions || lastPolicyResult.suggestions.length === 0) {
      setStatus("sim-status", 'Run "Search policies" first — the optimizer starts from its own best result rather than searching from nothing.');
      return;
    }

    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    const trials = Math.min(100, Math.max(1, parseInt(document.getElementById("sim-trials").value, 10) || 20));
    const maxRoundsField = roundBudgetField("sim-optimize-max-rounds");
    const staleLimitField = roundBudgetField("sim-optimize-stale-limit");
    const allowFloodMax = document.getElementById("sim-optimize-allow-floodmax").checked;
    // Tier 2/3 (docs/SIMULATOR_PLAN_PHASE6.md) — each independent, off by
    // default, matching the Go side's own opt-in defaults exactly.
    const adaptiveTrials = document.getElementById("sim-optimize-adaptive-trials").checked;
    const lateAcceptance = document.getElementById("sim-optimize-late-acceptance").checked;
    const spsaWarmStart = document.getElementById("sim-optimize-spsa-warmstart").checked;
    const learnedWeights = document.getElementById("sim-optimize-learned-weights").checked;

    const optimizeRequest = {
      scenario: scenarioFromState(),
      messages: messagesFromState(seed),
      attrs: lastPolicyAltitudeAttrs || [],
      basePolicy: lastPolicyResult.suggestions[0].policy,
      maxSimTimeMs,
      trials,
      // ConfirmTrials deliberately larger than the screening pass's own
      // Trials — see internal/meshsim.OptimizeRequest's own doc comment
      // on why a cheap screen + a more-trials confirmation guards against
      // accepting a move whose apparent benefit was just noise.
      confirmTrials: trials * 2,
      seed,
      deliveryTolerance: OPTIMIZE_DELIVERY_TOLERANCE,
      minImprovement: OPTIMIZE_MIN_IMPROVEMENT,
      maxRounds: maxRoundsField.value,
      unlimitedRounds: maxRoundsField.unlimited,
      staleRoundsLimit: staleLimitField.value,
      unlimitedStaleRounds: staleLimitField.unlimited,
      // docs/SIMULATOR_PLAN_PHASE6.md work item C/H: txdelay/rxdelay are
      // always on (the Go side's own default), floodMax is the one knob
      // with its own explicit, default-off UI checkbox — see that field's
      // own tooltip on why it's categorically riskier than the delay
      // knobs.
      moveSet: { txDelay: true, rxDelay: true, floodMax: allowFloodMax },
      // Tier 2/3 — see #sim-optimize-advanced's own tooltips for what
      // each of these actually does; all default false when unchecked,
      // matching internal/meshsim.OptimizeRequest's own opt-in defaults.
      adaptiveTrials,
      lateAcceptance,
      spsaWarmStart,
      learnedWeights,
      // A seed range the search itself never draws from (search rounds
      // use `seed` and `seed + round*1_000_003`, see internal/meshsim.
      // OptimizeStep) — hold-out validation only means something if it's
      // genuinely independent of every seed the search already saw.
      holdoutSeed: seed + 0x5eed0000,
      holdoutTrials: trials * 2,
    };

    optimizeCancelled = false;
    const generation = ++predictGeneration;
    const worker = ensurePredictWorker();

    document.getElementById("sim-optimize-adaptive").disabled = true;
    document.getElementById("sim-optimize-cancel").classList.remove("hidden");
    document.getElementById("sim-optimize-section").classList.add("hidden");
    setStatus("sim-status", "Optimizing…");
    // Deliberately NOT opening the results modal here — this run can take
    // a long time, and popping a modal open over the map at the start
    // would just be in the way while it works. Progress shows in the
    // panel (#sim-optimize-progress); the modal opens once there's
    // actually something to look at (see renderOptimizeResult).

    let state = {};
    try {
      while (true) {
        state = await workerRequest(
          worker,
          generation,
          { kind: "optimize-step", generation, optimizeRequest, state },
          "optimize-step-result",
          "optimize-step-error"
        );
        if (generation !== predictGeneration) return; // superseded by a newer search/optimize run
        setOptimizeProgress(state);
        if (state.done || optimizeCancelled) break;
      }

      setStatus("sim-status", optimizeCancelled ? "Cancelled — validating the best result found so far…" : "Validating…");
      const holdout = await workerRequest(
        worker,
        generation,
        { kind: "optimize-validate", generation, optimizeRequest, policy: state.currentPolicy },
        "optimize-validate-result",
        "optimize-validate-error"
      );
      if (generation !== predictGeneration) return;
      renderOptimizeResult(state, holdout, optimizeCancelled, optimizeRequest);
      openModal("sim-optimize-modal");
      setStatus("sim-status", "Done.");
    } catch (err) {
      if (generation === predictGeneration) {
        setStatus("sim-status", `Optimization failed: ${err.message || err}`);
      }
    } finally {
      if (generation === predictGeneration) {
        clearTimeout(optimizeCancelTimeout);
        document.getElementById("sim-optimize-adaptive").disabled = false;
        document.getElementById("sim-optimize-cancel").classList.add("hidden");
        hideOptimizeProgress();
      }
    }
  }

  // Graceful-then-forced cancellation (docs/SIMULATOR_PLAN_PHASE4.md work
  // item 4's own "do both" instruction). Setting optimizeCancelled lets
  // the CURRENT in-flight round finish normally and the loop above exit
  // cleanly next time it checks — the common case, since each round is a
  // small, bounded amount of work. If that doesn't happen within
  // OPTIMIZE_CANCEL_FORCE_TIMEOUT_MS (a round genuinely stuck — an
  // enormous scenario, a runaway trial count), the worker is terminated
  // outright rather than leaving the UI waiting for a reply that may
  // never come; ensurePredictWorker() transparently creates a fresh
  // instance the next time anything needs it.
  function cancelOptimizeAdaptive() {
    if (optimizeCancelled) return; // already cancelling — let the force-timeout run its course
    optimizeCancelled = true;
    setStatus("sim-status", "Cancelling — finishing the in-flight round…");
    optimizeCancelTimeout = setTimeout(() => {
      if (predictWorker) {
        predictWorker.terminate();
        predictWorker = null;
      }
      document.getElementById("sim-optimize-adaptive").disabled = false;
      document.getElementById("sim-optimize-cancel").classList.add("hidden");
      hideOptimizeProgress();
      setStatus("sim-status", "Cancelled (the search worker didn't respond in time and was reset).");
    }, OPTIMIZE_CANCEL_FORCE_TIMEOUT_MS);
  }

  function setOptimizeProgress(state) {
    const el = document.getElementById("sim-optimize-progress");
    el.classList.remove("hidden");
    el.textContent =
      `Round ${state.round} · delivery ${(state.currentDelivery * 100).toFixed(1)}% · ` +
      `contention score ${state.currentContention.toFixed(1)} · ${state.deviations.length} change${state.deviations.length === 1 ? "" : "s"} so far` +
      (state.done ? ` — stopped: ${state.doneReason}` : "");
  }

  function hideOptimizeProgress() {
    document.getElementById("sim-optimize-progress").classList.add("hidden");
  }

  // Renders the final optimizer result: search-vs-hold-out delivery side
  // by side (docs/SIMULATOR_PLAN_PHASE4.md work item 4's own "guarding
  // against overfitting" requirement — a long greedy search WILL overfit
  // to its own specific random draws, and the output here is CLI commands
  // someone pastes into real radios), plus the per-repeater "what changed
  // and why" list.
  function renderOptimizeResult(state, holdout, wasCancelled, optimizeRequest) {
    const section = document.getElementById("sim-optimize-section");
    section.classList.remove("hidden");
    document.getElementById("sim-open-optimize-modal").classList.remove("hidden");
    // Show movement against the run's OWN starting point, not just the
    // final figures — "31.4% delivery" alone can't tell you whether the
    // optimizer helped, which is exactly the complaint that motivated
    // this. Baselines come from the Go side (OptimizeState.Baseline*),
    // measured before any adjustment.
    const deliveryDelta = state.currentDelivery - state.baselineDelivery;
    const contentionDelta = state.currentContention - state.baselineContention;
    const sign = (v) => (v >= 0 ? "+" : "");

    // docs/SIMULATOR_PLAN_PHASE6.md work item G's own "the interaction
    // that will otherwise confuse people": a generous max-rounds budget
    // does nothing if the stale-rounds limit trips first, and that looks
    // exactly like "the setting was ignored" unless the summary says so
    // explicitly.
    let doneReasonText = state.doneReason || "";
    if (!wasCancelled && state.done && optimizeRequest && /no accepted improvement/.test(state.doneReason || "")) {
      const roundsBudgetHigher = optimizeRequest.unlimitedRounds || optimizeRequest.maxRounds > state.round;
      if (roundsBudgetHigher) {
        const budgetText = optimizeRequest.unlimitedRounds ? "an unlimited round budget" : `a round budget of ${optimizeRequest.maxRounds}`;
        doneReasonText = `${state.doneReason} — stopped early on staleness, not the round budget (you set ${budgetText}). Raise "give up after N stale rounds" to keep searching.`;
      }
    }
    document.getElementById("sim-optimize-summary").textContent =
      `${wasCancelled ? "Cancelled after" : "Finished after"} ${state.round} round${state.round === 1 ? "" : "s"}` +
      `${doneReasonText ? ` (${doneReasonText})` : ""} · ${state.deviations.length} repeater${state.deviations.length === 1 ? "" : "s"} adjusted. ` +
      `Delivery ${(state.baselineDelivery * 100).toFixed(1)}% → ${(state.currentDelivery * 100).toFixed(1)}% ` +
      `(${sign(deliveryDelta)}${(deliveryDelta * 100).toFixed(1)} points) · ` +
      `contention ${state.baselineContention.toFixed(1)} → ${state.currentContention.toFixed(1)} ` +
      `(${sign(contentionDelta)}${contentionDelta.toFixed(1)}).`;

    const holdoutEl = document.getElementById("sim-optimize-holdout-note");
    const deliveryGap = state.currentDelivery - holdout.delivery;
    const overfitWarning = deliveryGap > 0.05; // 5 points — a documented, deliberate threshold, not a precise statistical test
    holdoutEl.classList.remove("hidden");
    holdoutEl.classList.toggle("sim-holdout-warning", overfitWarning);
    holdoutEl.textContent =
      `Hold-out validation (seeds the search never used): ${(holdout.delivery * 100).toFixed(1)}% delivery, ${(holdout.collision * 100).toFixed(1)}% collisions.` +
      (overfitWarning
        ? ` That's meaningfully lower than the search's own ${(state.currentDelivery * 100).toFixed(1)}% — this policy may have overfit to its own random draws. Treat it as a starting point to field-test, not a final answer.`
        : "");

    renderOptimizeNodesTable(state);
    renderOptimizeHistory(state);

    lastOptimizeDeviations = state.deviations;
    const list = document.getElementById("sim-optimize-deviations-list");
    list.innerHTML = "";
    if (state.deviations.length === 0) {
      list.innerHTML = '<div class="plan-hint">No repeater needed a targeted adjustment beyond the policy search result above.</div>';
      return;
    }
    state.deviations.forEach((d) => {
      const n = simNodes[d.node];
      const row = document.createElement("div");
      row.className = "plan-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(n ? n.label : `#${d.node}`)}</span>
        <span class="plan-item-sub">round ${d.round} · ${escapeHtml(d.reason)} · <code>${escapeHtml(deviationCliCommand(d))}</code> (was ${formatDeviationValue(d, d.oldValue)})</span>
        ${d.warning ? `<span class="plan-item-sub sim-optimize-deviation-warning">⚠ ${escapeHtml(d.warning)}</span>` : ""}
      `;
      list.appendChild(row);
    });
  }

  // docs/SIMULATOR_PLAN_PHASE6.md work item C widened the optimizer past
  // a single "back off txdelay" move — these two helpers are the one
  // place that knows how each move Kind maps to a real firmware CLI
  // command and a display value, so the deviations list and the CSV
  // export (exportOptimizeDeviationsCsv) can't drift apart on it.
  function deviationCliCommand(d) {
    switch (d.kind) {
      case "tx_delay_backoff":
      case "tx_delay_speedup":
        return `set txdelay ${formatDeviationValue(d, d.newValue)}`;
      case "rx_delay_backoff":
        return `set rxdelay ${formatDeviationValue(d, d.newValue)}`;
      case "flood_max_reduce":
        return `set flood.max ${formatDeviationValue(d, d.newValue)}`;
      default:
        return `# unrecognized move kind "${d.kind}"`;
    }
  }

  function formatDeviationValue(d, v) {
    // flood.max is an integer hop count; the delay knobs are fractional
    // factors — matching real firmware's own `set` command conventions
    // rather than always showing decimals on an integer setting.
    return d.kind === "flood_max_reduce" ? String(Math.round(v)) : Number(v).toFixed(2);
  }

  // The full per-repeater table — EVERY loaded repeater, worst-contention
  // first, so "which ones are causing the most contention" is answerable
  // at a glance rather than only visible for the handful the optimizer
  // happened to adjust. Sourced from the Go side's own NodeSnapshot (see
  // internal/meshsim.buildNodeSnapshot), never recomputed here, so the
  // numbers shown are exactly the ones the optimizer ranked on.
  function renderOptimizeNodesTable(state) {
    const tbody = document.getElementById("sim-optimize-nodes-tbody");
    tbody.innerHTML = "";
    document.getElementById("sim-optimize-node-detail").classList.add("hidden");
    const snapshot = (state.nodeSnapshot || []).slice().sort((a, b) => b.contentionScore - a.contentionScore);
    lastOptimizeSnapshot = snapshot;
    if (snapshot.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="plan-empty">No per-repeater data.</td></tr>';
      return;
    }
    snapshot.forEach((s) => {
      const n = simNodes[s.node];
      const st = s.stats || {};
      const tr = document.createElement("tr");
      tr.className = "sim-optimize-node-row";
      tr.innerHTML = `
        <td class="sim-col-sticky">${escapeHtml(n ? n.label : `#${s.node}`)}${s.adjusted ? " ✎ adjusted" : ""}${s.tabooed ? " 🚫 tabu" : ""}</td>
        <td>${s.contentionScore.toFixed(1)}</td>
        <td>${s.txDelay.toFixed(2)}</td>
        <td>${st.contentionCaused || 0}</td>
        <td>${st.collisionCount || 0}</td>
        <td>${st.redundantRelays || 0}</td>
        <td>${st.relayedCount || 0}</td>
        <td>${escapeHtml((s.diagnosis && s.diagnosis.headline) || "")}</td>
      `;
      tr.addEventListener("click", () => openOptimizeNodeDetail(s.node));
      tbody.appendChild(tr);
    });
  }

  function openOptimizeNodeDetail(nodeIndex) {
    const s = lastOptimizeSnapshot.find((x) => x.node === nodeIndex);
    if (!s) return;
    const n = simNodes[nodeIndex];
    document.getElementById("sim-optimize-node-detail").classList.remove("hidden");
    document.getElementById("sim-optimize-node-detail-title").textContent = `${n ? n.label : `#${nodeIndex}`} — ${(s.diagnosis && s.diagnosis.headline) || ""}`;
    const list = document.getElementById("sim-optimize-node-detail-list");
    list.innerHTML = "";
    const findings = (s.diagnosis && s.diagnosis.findings) || [];
    if (findings.length === 0) {
      list.innerHTML = '<div class="plan-hint">Nothing notable — this repeater is behaving normally.</div>';
      return;
    }
    findings.forEach((f) => {
      const row = document.createElement("div");
      row.className = "plan-list-item";
      // Some findings deliberately carry no suggestion (see
      // internal/meshsim.DiagnoseNode's own doc comment on why inventing
      // one would be worse than staying quiet) — render the observation
      // alone rather than an empty arrow.
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(f.detail)}</span>
        ${f.suggestion ? `<span class="plan-item-sub">→ ${escapeHtml(f.suggestion)}</span>` : ""}
      `;
      list.appendChild(row);
    });
  }

  // Human-readable labels for the move-kind slugs Go sends — used in the
  // history table's own "Move" column (docs/SIMULATOR_PLAN_PHASE6.md work
  // item B: seeing what kind of move was tried each round, not just
  // which node, is part of "showing improvement over time" honestly).
  const MOVE_KIND_LABELS = {
    tx_delay_backoff: "back off txdelay",
    tx_delay_speedup: "speed up txdelay",
    rx_delay_backoff: "raise rxdelay",
    flood_max_reduce: "trim flood.max",
    // Tier 3 work item F — see internal/meshsim.spsaWarmStart's own doc
    // comment on why this one row touches every node at once rather than
    // naming a single one.
    spsa_warm_start: "SPSA warm start (all repeaters)",
  };

  function renderOptimizeHistory(state) {
    const tbody = document.getElementById("sim-optimize-history-tbody");
    tbody.innerHTML = "";
    const history = state.history || [];
    if (history.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="plan-empty">No rounds completed.</td></tr>';
      return;
    }
    history.forEach((h) => {
      const target = simNodes[h.targetNode];
      const targetLabel = h.moveKind === "spsa_warm_start" ? "(every repeater)" : target ? target.label : h.targetNode >= 0 ? `#${h.targetNode}` : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${h.round}</td>
        <td class="${h.accepted ? "sim-optimize-round-kept" : ""}">${h.accepted ? "✓ kept" : "—"}</td>
        <td>${escapeHtml(targetLabel)}</td>
        <td>${escapeHtml(MOVE_KIND_LABELS[h.moveKind] || h.moveKind || "—")}</td>
        <td>${h.candidatesTried || 0}</td>
        <td>${(h.delivery * 100).toFixed(1)}%</td>
        <td>${(h.collision * 100).toFixed(1)}%</td>
        <td>${h.contention.toFixed(1)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function exportOptimizeDeviationsCsv() {
    if (lastOptimizeDeviations.length === 0) {
      setStatus("sim-status", "Nothing to export — no repeater was adjusted.");
      return;
    }
    const rows = [["Repeater", "Round", "Move kind", "Reason", "Old value", "New value", "CLI command", "Warning"]];
    for (const d of lastOptimizeDeviations) {
      const n = simNodes[d.node];
      rows.push([
        n ? n.label : `#${d.node}`,
        d.round,
        d.kind,
        d.reason,
        formatDeviationValue(d, d.oldValue),
        formatDeviationValue(d, d.newValue),
        deviationCliCommand(d),
        d.warning || "",
      ]);
    }
    const csv = rows.map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "optimize-deviations.csv";
    a.click();
    URL.revokeObjectURL(a.href);
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

  // Parses a MeshCore on-air frame (CoreScope's raw_hex) into its
  // components — a direct port of Packet::readFrom (src/Packet.cpp),
  // validated against 400 real frames: header, then 4 transport-code bytes
  // when the route type is TRANSPORT_FLOOD (0) or TRANSPORT_DIRECT (3),
  // then the path_len byte (hashCount = low 6 bits, hashSize = (high 2 bits)
  // + 1), then hashCount*hashSize path bytes, then the application payload.
  // Returns null for anything too short to be a valid frame.
  function parseMeshFrame(rawHex) {
    if (!rawHex || typeof rawHex !== "string") return null;
    const bytes = [];
    for (let i = 0; i + 1 < rawHex.length; i += 2) bytes.push(parseInt(rawHex.substr(i, 2), 16));
    if (bytes.length < 2) return null;
    const routeType = bytes[0] & 0x03;
    let i = 1;
    const hasTransport = routeType === 0 || routeType === 3;
    if (hasTransport) i += 4;
    if (i >= bytes.length) return null;
    const pathLen = bytes[i];
    i += 1;
    const hashCount = pathLen & 0x3f;
    const hashSize = (pathLen >> 6) + 1;
    const pathBytes = hashCount * hashSize;
    const payloadLen = bytes.length - i - pathBytes;
    if (payloadLen < 0) return null;
    return { routeType, hasTransport, hashCount, hashSize, pathBytes, payloadLen: Math.max(1, payloadLen) };
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

  // Returns {packets, hitCap}: hitCap is true when REAL_TIMELINE_MAX_LIMIT
  // was reached before the window's oldest edge was actually covered — a
  // wide window (see the "Surrounding activity window" control) on a busy
  // mesh can hit this, and the caller should surface that as partial
  // coverage rather than silently presenting it as the whole window (item
  // 8's own requirement).
  async function fetchPacketsAroundTime(targetMs, windowMs) {
    let limit = 300;
    for (;;) {
      const resp = await fetch(`/corescope-api/api/packets?limit=${limit}`);
      if (!resp.ok) throw new Error(`packets fetch failed: HTTP ${resp.status}`);
      const data = await resp.json();
      const packets = data.packets || [];
      if (packets.length === 0) return { packets: [], hitCap: false };
      const withMs = packets.map((p) => ({ p, tMs: Date.parse(p.timestamp) })).filter((x) => !Number.isNaN(x.tMs));
      const oldestMs = Math.min(...withMs.map((x) => x.tMs));
      const inWindow = withMs.filter((x) => x.tMs >= targetMs - windowMs && x.tMs <= targetMs + windowMs).map((x) => x.p);
      const coveredOldestEdge = oldestMs <= targetMs - windowMs;
      if (coveredOldestEdge || limit >= REAL_TIMELINE_MAX_LIMIT || packets.length < limit) {
        return { packets: inWindow, hitCap: !coveredOldestEdge && limit >= REAL_TIMELINE_MAX_LIMIT };
      }
      limit *= 2;
    }
  }

  // The origin (true sender) of a real packet, lowercased, if identifiable —
  // only ADVERTs self-identify (their decoded pubKey). Everything else's true
  // origin is one hop upstream of the first observed relay and not in the
  // data (see docs/SIMULATOR_PLAN_PHASE8.md's origin-identification table),
  // so callers fall back to the first observed relay.
  function originPubkeyOfPacket(p) {
    try {
      const dec = JSON.parse(p.decoded_json || "{}");
      if (dec.pubKey) return String(dec.pubKey).toLowerCase();
    } catch {
      /* not decodable — fall through */
    }
    return null;
  }

  // Reconstructs the real CoreScope time window around the packet in the
  // replay input as a fully editable simulator setup (docs/SIMULATOR_PLAN_
  // PHASE8.md): real repeaters at their real positions, connectivity from the
  // real proven relay edges observed in the window, and every real packet as
  // either a flood sender (real payload/hash size) or — for direct/channel/
  // anon traffic we don't route — a fixed background transmission that still
  // loads the channel. After this, the user tweaks settings or runs the
  // optimizer and re-runs to see whether the real problems shrink.
  async function reconstructEpisodeFromWindow() {
    const hash = extractPacketHash(document.getElementById("sim-replay-hash-input").value);
    if (!hash) {
      setStatus("sim-replay-hash-status", "Couldn't find a packet hash (16 hex characters) in that input.");
      return;
    }
    const btn = document.getElementById("sim-reconstruct-episode");
    btn.disabled = true;
    try {
      setStatus("sim-replay-hash-status", "Reconstructing — fetching the target packet…");
      // The window is centred on the target packet's own time.
      const detailResp = await fetch(`/corescope-api/api/packets/${encodeURIComponent(hash)}`);
      if (!detailResp.ok) throw new Error(`packet ${hash} not found (HTTP ${detailResp.status})`);
      const detail = await detailResp.json();
      const targetMs = Date.parse((detail.packet && detail.packet.timestamp) || (detail.observations && detail.observations[0] && detail.observations[0].timestamp));
      if (Number.isNaN(targetMs)) throw new Error("target packet has no usable timestamp");

      const windowSecs = Math.min(120, Math.max(1, parseInt(document.getElementById("sim-replay-window-secs").value, 10) || 30));
      const windowMs = windowSecs * 1000;
      const windowStartMs = targetMs - windowMs;
      setStatus("sim-replay-hash-status", `Fetching real activity within ±${windowSecs}s…`);
      const { packets, hitCap } = await fetchPacketsAroundTime(targetMs, windowMs);
      if (packets.length === 0) throw new Error("no real activity found in that window");

      const dir = await ensureNodeDirectory();

      // "Path records" the topology is built from: every window packet (the
      // list gives one representative observation each), PLUS the target
      // packet's OWN full set of observations (from its detail) — the latter
      // is essential, because the window list carries only one path per
      // packet, so the target's other real paths to the very observers we
      // compare against would otherwise be missing from the graph (and our
      // sim would spuriously "fail" to deliver to them).
      const targetOrigin = originPubkeyOfPacket(detail.packet || {});
      const pathRecords = packets.map((p) => ({ path: (p.resolved_path || []).map((x) => (x || "").toLowerCase()), observer: (p.observer_id || "").toLowerCase(), origin: originPubkeyOfPacket(p) }));
      for (const o of detail.observations || []) {
        pathRecords.push({ path: (o.resolved_path || []).map((x) => (x || "").toLowerCase()), observer: (o.observer_id || "").toLowerCase(), origin: targetOrigin });
      }

      // Collect every node that appears in the window (relay, observer, or
      // advert origin) and has a known position — those become the sim nodes.
      const involved = new Set();
      for (const r of pathRecords) {
        for (const k of r.path) if (k) involved.add(k);
        if (r.observer) involved.add(r.observer);
        if (r.origin) involved.add(r.origin);
      }
      const pubkeys = [...involved].filter((k) => dir.has(k));
      if (pubkeys.length < 2) throw new Error("fewer than 2 positioned nodes in the window — nothing to reconstruct");
      const indexByPubkey = new Map(pubkeys.map((k, i) => [k, i]));

      const nodes = pubkeys.map((k) => {
        const info = dir.get(k);
        return { id: randomId(), source: "real", refId: k, label: info.name, lat: info.lat, lon: info.lon, role: info.role, regions: ["*"], address: shortAddressFromPubkey(k) };
      });

      // Connectivity: the real proven directed edges observed in the window
      // (origin→relay0, relay_i→relay_{i+1}, last_relay→observer), each a
      // "this really decoded that" fact, so assigned a strong SNR. This is the
      // topology phase 7 validated at 100% delivery recall.
      const edgeMap = new Map();
      const addEdge = (fromK, toK) => {
        if (!fromK || !toK) return;
        const fi = indexByPubkey.get(fromK);
        const ti = indexByPubkey.get(toK);
        if (fi == null || ti == null || fi === ti) return;
        edgeMap.set(`${fi}:${ti}`, { from: fi, to: ti, snrDb: 20 });
      };
      for (const r of pathRecords) {
        if (r.origin && r.path[0]) addEdge(r.origin, r.path[0]);
        for (let i = 0; i + 1 < r.path.length; i++) addEdge(r.path[i], r.path[i + 1]);
        if (r.path.length && r.observer) addEdge(r.path[r.path.length - 1], r.observer);
      }

      // Blend in the propagation model to fill the gaps a single sparse
      // window's proven edges miss. Real ScotMesh traffic is low-rate, so the
      // proven edges alone form a thin tree — but the nodes that COULD hear
      // each other (whether or not they relayed in this window) are exactly
      // what makes a flood's own relays contend, which is the thing worth
      // tuning. Proven edges (real) always win over a modelled one for the
      // same pair. Terrain can legitimately fail for nodes spread too far for
      // one grid fetch — fall back to proven-only rather than aborting.
      let modelAdded = 0;
      try {
        setStatus("sim-replay-hash-status", "Filling connectivity gaps with the terrain model…");
        // Race the terrain fetch against a timeout — real repeaters can be
        // spread across the whole region, and a large or slow DEM fetch must
        // never hang the reconstruction. Proven edges alone are a complete,
        // validated fallback.
        const modelLinks = await Promise.race([
          buildLinksFromModel(nodes),
          new Promise((_, reject) => setTimeout(() => reject(new Error("terrain fetch timed out")), 15000)),
        ]);
        for (const l of modelLinks) {
          const key = `${l.from}:${l.to}`;
          if (!edgeMap.has(key)) {
            edgeMap.set(key, l);
            modelAdded++;
          }
        }
      } catch {
        /* terrain unavailable / too large / too slow — proven edges alone still work */
      }
      const links = [...edgeMap.values()];

      // Senders + background: each real packet becomes a fixed transmission at
      // its observed second (offset from the window start). Flood traffic
      // (route 0/1) → tunable flood senders injected at their origin (advert
      // pubkey, else the first observed relay). Everything else → a fixed
      // background transmission at its first observed hop, loading the channel
      // without being routed.
      const generators = [];
      let targetGen = null;
      let floodCount = 0;
      let bgCount = 0;
      let skipped = 0;
      for (const p of packets) {
        const tMs = Date.parse(p.timestamp);
        if (Number.isNaN(tMs)) {
          skipped++;
          continue;
        }
        const atMs = Math.max(0, tMs - windowStartMs);
        const frame = parseMeshFrame(p.raw_hex);
        const path = (p.resolved_path || []).map((x) => (x || "").toLowerCase());
        const isFlood = p.route_type === 0 || p.route_type === 1;
        if (isFlood) {
          const originKey = originPubkeyOfPacket(p) || path[0];
          const oi = indexByPubkey.get(originKey);
          if (oi == null) {
            skipped++;
            continue;
          }
          const gen = {
            id: randomId(),
            fixed: true,
            nodeIndex: oi,
            atMs,
            payloadLen: frame ? frame.payloadLen : 20,
            hashSize: frame ? frame.hashSize : DEFAULT_MESSAGE_HASH_SIZE,
            // A non-empty region marks the packet as transport-coded (route 0)
            // for the +4-byte airtime; the reconstructed nodes all hold the
            // "*" wildcard so this never gates relaying, only sizes airtime.
            region: frame && frame.hasTransport ? "scoped" : "",
            background: false,
            sourceHash: p.hash,
            isTarget: p.hash === hash,
          };
          generators.push(gen);
          if (gen.isTarget) targetGen = gen;
          floodCount++;
        } else {
          const firstHop = path[0];
          const bi = indexByPubkey.get(firstHop);
          if (bi == null) {
            skipped++;
            continue;
          }
          generators.push({
            id: randomId(),
            fixed: true,
            background: true,
            nodeIndex: bi,
            atMs,
            frameBytes: p.raw_hex ? Math.floor(p.raw_hex.length / 2) : 24,
            payloadLen: frame ? frame.payloadLen : 20,
            hashSize: frame ? frame.hashSize : DEFAULT_MESSAGE_HASH_SIZE,
            region: frame && frame.hasTransport ? "scoped" : "",
            sourceHash: p.hash,
          });
          bgCount++;
        }
      }

      // The target packet's real observers (those our reconstructed node set
      // actually contains), and every observer seen anywhere in the window
      // (for the observer-deafness check) — the ground truth the episode
      // analysis compares our simulation against.
      // Deduped by node — the SAME observer often appears in several
      // observations (different relay paths / times); it's still one repeater
      // that heard the packet once, so it counts once toward recall.
      const targetObsMap = new Map();
      for (const o of detail.observations || []) {
        const k = (o.observer_id || "").toLowerCase();
        if (indexByPubkey.has(k) && !targetObsMap.has(k)) targetObsMap.set(k, { pubkey: k, name: o.observer_name || k.slice(0, 8), index: indexByPubkey.get(k) });
      }
      const targetObservers = [...targetObsMap.values()];
      const allObserversMap = new Map(); // pubkey -> {pubkey, name, index}
      for (const p of packets) {
        const k = (p.observer_id || "").toLowerCase();
        if (indexByPubkey.has(k) && !allObserversMap.has(k)) allObserversMap.set(k, { pubkey: k, name: p.observer_name || k.slice(0, 8), index: indexByPubkey.get(k) });
      }
      const allObservers = [...allObserversMap.values()]; // plain array so lastEpisode serialises into a saved setup
      const targetMsRounded = Math.floor(targetMs / 1000);
      // Which observers were themselves transmitting (a relay of ANY window
      // packet) in the same second as the target — those were plausibly deaf
      // (half-duplex) and their NOT hearing the target isn't a prediction
      // failure. Second-resolution timing is all we have, so "same second".
      const deafSet = new Set();
      for (const p of packets) {
        if (p.hash === hash) continue; // the target's own relays carry the target — not "busy with other traffic"
        const pSec = Math.floor((Date.parse(p.timestamp) || 0) / 1000);
        if (Math.abs(pSec - targetMsRounded) > 1) continue;
        for (const relay of p.resolved_path || []) {
          const rk = (relay || "").toLowerCase();
          if (allObserversMap.has(rk)) deafSet.add(rk);
        }
      }

      // If the target itself couldn't be placed as a flood sender, say why —
      // the surrounding traffic is still reconstructed and tunable, but there's
      // no actual-vs-predicted to show for the target.
      let targetNote = "";
      if (!targetGen) {
        const trt = detail.packet && detail.packet.route_type;
        targetNote =
          trt === 2 || trt === 3
            ? "The target packet used direct (addressed) routing, which this tool reproduces as background traffic rather than a flood — so there's no flood delivery to compare. The surrounding traffic is still reconstructed; pick a flood packet to compare actual vs predicted."
            : "The target packet couldn't be placed as a flood sender (its origin isn't a positioned repeater, or it fell just outside the fetched window). The surrounding traffic is still reconstructed and tunable.";
      }

      lastEpisode = {
        hash,
        windowSecs,
        fetchedAt: new Date().toISOString(),
        target: targetGen ? { nodeIndex: targetGen.nodeIndex, atMs: targetGen.atMs } : null,
        targetNote,
        targetObservers,
        allObservers,
        deafObservers: [...deafSet],
      };
      episodeBaseline = null;

      // Commit to the workspace (same shape applySetupData leaves it in).
      simNodes = nodes;
      simLinks = links;
      simMessageGenerators = generators;
      simNodePrefsOverrides = {};
      currentSetupId = null;
      document.getElementById("sim-setup-name").value = `CoreScope ${hash.slice(0, 8)} ±${windowSecs}s`;
      // A sim window that comfortably covers the whole reconstructed span.
      document.getElementById("sim-max-time").value = String(2 * windowMs + 5000);
      cachedGrid = null;

      hideResults();
      renderNodeList();
      renderMessageNodeOptions();
      renderMessageList();
      redrawNodeMarkers();
      setStatus("sim-links-status", `${links.length} links (${links.length - modelAdded} real proven + ${modelAdded} terrain-model fill) reconstructed from the window.`);
      setStatus(
        "sim-status",
        `Reconstructed ${nodes.length} repeaters, ${floodCount} flood sender${floodCount === 1 ? "" : "s"}, ${bgCount} background transmission${bgCount === 1 ? "" : "s"} from ±${windowSecs}s around ${hash.slice(0, 8)}.` +
          (skipped ? ` ${skipped} packet(s) skipped (unpositioned nodes).` : "") +
          (hitCap ? " Window hit the fetch cap — partial coverage of the oldest edge." : "") +
          " Now run the simulation, or tweak settings / run the optimizer and re-run to see if the problems shrink."
      );
      // Fit the map to the reconstructed nodes so the user sees the episode.
      if (nodes.length > 0) {
        const lats = nodes.map((n) => n.lat);
        const lons = nodes.map((n) => n.lon);
        map.fitBounds([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]], { padding: [40, 40], maxZoom: 12 });
      }
      // Surface the episode-analysis entry point now that an episode is
      // loaded; a normal run below fills it in.
      document.getElementById("sim-open-episode-modal").classList.remove("hidden");
    } catch (err) {
      setStatus("sim-replay-hash-status", `Reconstruction failed: ${err.message || err}`);
    } finally {
      btn.disabled = false;
    }
  }

  // Computes the episode's own actual-vs-predicted figures for the target
  // packet plus the run's problem counts — the raw material both the observer
  // table and the before/after delta render from. Returns null unless an
  // episode is loaded and its target flood is present in this run.
  function computeEpisodeStats(report, messages) {
    if (!lastEpisode || !lastEpisode.target) return null;
    const t = lastEpisode.target;
    let targetPid = -1;
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].background && messages[i].origin === t.nodeIndex && messages[i].sendAtMs === t.atMs) {
        targetPid = i;
        break;
      }
    }
    if (targetPid < 0) return null;

    const delivered = new Set();
    for (const r of report.receptions || []) {
      if (r.packetId === targetPid && isCanonicalDelivery(r)) delivered.add(r.node);
    }
    // Re-resolve each observer's node index from its pubkey against the
    // CURRENT node set rather than trusting the index captured at
    // reconstruction — nodes may have been reordered or removed since (or the
    // episode restored from a saved setup), which would otherwise silently
    // compare against the wrong node. An observer whose node no longer exists
    // is dropped from the comparison.
    const indexByRefId = new Map(simNodes.map((n, i) => [n.refId, i]));
    const curIdx = (o) => (indexByRefId.has(o.pubkey) ? indexByRefId.get(o.pubkey) : -1);

    const realObservers = (lastEpisode.targetObservers || []).filter((o) => curIdx(o) >= 0);
    const realHeard = new Set(realObservers.map((o) => curIdx(o)));
    const observerRows = realObservers.map((o) => ({ name: o.name, simDelivered: delivered.has(curIdx(o)) }));
    const reached = observerRows.filter((o) => o.simDelivered).length;
    const recall = observerRows.length ? reached / observerRows.length : 1;

    // Observers our sim delivered the target to, that reality's observation
    // list does NOT include — either an over-prediction, or the observer was
    // itself transmitting (deaf) at the time, which our differently-timed sim
    // didn't reproduce (phase 5's observer-deafness point).
    const deafSet = new Set(lastEpisode.deafObservers || []);
    const overPredicted = [];
    for (const info of lastEpisode.allObservers || []) {
      const idx = curIdx(info);
      if (idx < 0 || realHeard.has(idx) || !delivered.has(idx)) continue;
      overPredicted.push({ name: info.name, deaf: deafSet.has(info.pubkey) });
    }

    const collisions = (report.receptions || []).filter((r) => r.collided).length;
    return {
      observerRows,
      overPredicted,
      recall,
      reached,
      realCount: observerRows.length,
      problems: {
        "Real deliveries our sim missed": observerRows.length - reached,
        "Collisions across the run": collisions,
        "Reception delivery recall": Math.round(recall * 100),
      },
      recallIsPercent: true,
    };
  }

  function renderEpisodeAnalysis() {
    if (!lastEpisode) return;
    document.getElementById("sim-episode-provenance").innerHTML =
      `Reconstructed from packet <code>${escapeHtml(lastEpisode.hash)}</code> · ±${lastEpisode.windowSecs}s window · fetched ${escapeHtml(new Date(lastEpisode.fetchedAt).toLocaleString())}.`;

    const stats = lastReport ? computeEpisodeStats(lastReport, lastMessages || []) : null;
    const recallEl = document.getElementById("sim-episode-recall");
    const obsBody = document.getElementById("sim-episode-observers-tbody");
    const probBody = document.getElementById("sim-episode-problems-tbody");
    obsBody.innerHTML = "";
    probBody.innerHTML = "";

    if (!stats) {
      recallEl.textContent = lastEpisode.target
        ? "Run the simulation to compare it against what really happened."
        : lastEpisode.targetNote || "No target packet to compare — the surrounding traffic is still reconstructed and tunable.";
      return;
    }

    recallEl.innerHTML =
      `Our simulation delivered this packet to <strong>${stats.reached} of ${stats.realCount}</strong> repeaters that really heard it (${Math.round(stats.recall * 100)}% recall).` +
      (stats.overPredicted.length
        ? ` It also delivered to ${stats.overPredicted.length} observer(s) reality didn't record — ${stats.overPredicted.filter((o) => o.deaf).length} of them were transmitting (deaf) at the time, so that's expected, not a miss.`
        : "");

    if (stats.observerRows.length === 0) {
      obsBody.innerHTML = '<tr><td colspan="4" class="plan-empty">None of this packet\'s real observers are in the reconstructed node set.</td></tr>';
    } else {
      for (const o of stats.observerRows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="sim-col-sticky">${escapeHtml(o.name)}</td>
          <td>✓ yes</td>
          <td class="${o.simDelivered ? "sim-optimize-round-kept" : ""}">${o.simDelivered ? "✓ yes" : "✕ no"}</td>
          <td>${o.simDelivered ? "match" : "our sim missed a real delivery"}</td>
        `;
        obsBody.appendChild(tr);
      }
      for (const o of stats.overPredicted) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="sim-col-sticky">${escapeHtml(o.name)}</td>
          <td>${o.deaf ? "— (was transmitting)" : "✕ no"}</td>
          <td>✓ yes</td>
          <td>${o.deaf ? "observer was deaf (half-duplex) — expected" : "our sim over-predicted, or a real miss we can't explain"}</td>
        `;
        obsBody.appendChild(tr);
      }
    }

    // Before/after problem delta.
    const now = stats.problems;
    const base = episodeBaseline;
    const keys = Object.keys(now);
    for (const k of keys) {
      const nowVal = now[k];
      const baseVal = base ? base[k] : null;
      const isRecall = k.includes("recall");
      let deltaText = "—";
      if (base != null && baseVal != null) {
        const d = nowVal - baseVal;
        const good = isRecall ? d > 0 : d < 0;
        const bad = isRecall ? d < 0 : d > 0;
        deltaText = d === 0 ? "no change" : `<span class="${good ? "sim-optimize-round-kept" : bad ? "sim-episode-worse" : ""}">${d > 0 ? "+" : ""}${d}${isRecall ? " pts" : ""}</span>`;
      }
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="sim-col-sticky">${escapeHtml(k)}${isRecall ? " %" : ""}</td>
        <td>${base ? baseVal : "—"}</td>
        <td>${nowVal}</td>
        <td>${deltaText}</td>
      `;
      probBody.appendChild(tr);
    }
  }

  function setEpisodeBaseline() {
    if (!lastEpisode || !lastReport) return;
    const stats = computeEpisodeStats(lastReport, lastMessages || []);
    if (!stats) return;
    episodeBaseline = { ...stats.problems };
    renderEpisodeAnalysis();
    setStatus("sim-status", "Pinned the current run as the before/after baseline.");
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
  let realTimelineWindowStartMs = 0;
  // The actual ± window (seconds) used for the most recent replay — read
  // from the "Surrounding activity window" control in replayFromHash, kept
  // here so the status strings below can report the real figure used
  // rather than a stale hardcoded "±30s" (item 8).
  let lastRealTimelineWindowSecs = 30;

  // The real-activity replay's status shows in two places at once — the
  // bottleneck modal and the map-docked control (see
  // ensureBottleneckLegendControl) — so everything goes through here rather
  // than setStatus directly, same pattern as setReplayStatus.
  let lastRealReplayStatusText = "";

  function setRealReplayStatus(text) {
    lastRealReplayStatusText = text;
    setStatus("sim-bottleneck-replay-status", text);
    const mapStatus = document.getElementById("sim-map-real-replay-status");
    if (mapStatus) mapStatus.textContent = text;
  }

  // The packet being investigated is drawn hot pink and heavy; everything
  // else CoreScope saw in the same window is thin, dim slate. The whole
  // point of the window view is "what else was on the air while my packet
  // was travelling", so the two have to be separable at a glance without
  // reading a key — hence a difference in colour AND weight AND opacity
  // rather than just hue (which alone is easy to lose against a busy
  // basemap, and unreadable for anyone with a red/green deficiency).
  const REAL_TARGET_COLOR = "#f472b6";
  const REAL_CONTEXT_COLOR = "#64748b";

  function playRealTimelineEvent(e, animate) {
    const from = simNodes[e.from];
    const to = simNodes[e.to];
    if (!from || !to) return;
    const color = e.isTarget ? REAL_TARGET_COLOR : REAL_CONTEXT_COLOR;
    L.polyline(
      [
        [from.lat, from.lon],
        [to.lat, to.lon],
      ],
      { color, weight: e.isTarget ? 5 : 2, opacity: e.isTarget ? 1 : 0.45 }
    ).addTo(simRealActivityLayer);
    if (animate) pulseAt([to.lat, to.lon], color);
  }

  // How many real hops have happened by srcMs (realTimelineEvents is sorted
  // by tMs) — the real replay's equivalent of countWavesUpTo.
  function countRealEventsUpTo(srcMs) {
    let lo = 0;
    let hi = realTimelineEvents.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (realTimelineEvents[mid].tMs <= srcMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function realTransportSource() {
    return {
      kind: "real",
      label: `Real traffic ±${lastRealTimelineWindowSecs}s`,
      times: realTimelineEvents.map((e) => e.tMs),
      // The readout stays in real seconds relative to the window's start,
      // even though the scrubber moves through compressed play time — the
      // offset into the real window is the number that actually means
      // something when comparing against CoreScope.
      format: (srcMs) => {
        const offsetS = (srcMs - realTimelineWindowStartMs) / 1000;
        const k = countRealEventsUpTo(srcMs);
        return `+${offsetS.toFixed(1)}s · ${k}/${realTimelineEvents.length}`;
      },
      render: (srcMs, prevSrcMs) => {
        const k = countRealEventsUpTo(srcMs);
        if (prevSrcMs != null) {
          const prevK = countRealEventsUpTo(prevSrcMs);
          if (k === prevK) return;
          for (let i = prevK; i < k; i++) playRealTimelineEvent(realTimelineEvents[i], realTimelineEvents[i].isTarget);
          realTimelineIndex = k;
          const e = realTimelineEvents[k - 1];
          const offsetS = ((e.tMs - realTimelineWindowStartMs) / 1000).toFixed(1);
          setRealReplayStatus(
            k >= realTimelineEvents.length
              ? `Replay finished — showing the full ±${lastRealTimelineWindowSecs}s window.`
              : `Playing… t=+${offsetS}s (${k}/${realTimelineEvents.length})${e.isTarget ? " · this is the replayed packet" : ""}`
          );
          return;
        }
        // Seek: rebuild the window's state at this instant from scratch.
        simRealActivityLayer.clearLayers();
        for (let i = 0; i < k; i++) playRealTimelineEvent(realTimelineEvents[i], false);
        realTimelineIndex = k;
        const offsetS = ((srcMs - realTimelineWindowStartMs) / 1000).toFixed(1);
        setRealReplayStatus(
          realTimelineEvents.length === 0
            ? `No other real activity found in this packet's ±${lastRealTimelineWindowSecs}s window.`
            : k >= realTimelineEvents.length
              ? `Showing the full ±${lastRealTimelineWindowSecs}s window.`
              : `t=+${offsetS}s (${k}/${realTimelineEvents.length})`
        );
      },
    };
  }

  function stopRealTimelineReplay() {
    if (transportSource && transportSource.kind === "real") transportPause();
  }

  function startRealTimelineReplay() {
    if (realTimelineEvents.length === 0) {
      setRealReplayStatus(`No other real activity found in this packet's ±${lastRealTimelineWindowSecs}s window.`);
      return;
    }
    realTimelineWindowStartMs = realTimelineEvents[0].tMs;
    simRealActivityLayer.clearLayers();
    realTimelineIndex = 0;
    setTransportSource(realTransportSource());
    transportPlay();
  }

  function skipRealTimelineToEnd() {
    if (realTimelineEvents.length === 0) {
      setRealReplayStatus(`No other real activity found in this packet's ±${lastRealTimelineWindowSecs}s window.`);
      return;
    }
    realTimelineWindowStartMs = realTimelineEvents[0].tMs;
    if (!transportSource || transportSource.kind !== "real") setTransportSource(realTransportSource());
    transportToEnd();
  }

  // The map-docked home for everything you need while *watching* a real
  // packet replay: the transport controls, the live status line, and a key
  // explaining the line colours (a replay can put five differently
  // coloured/styled line types on the map at once — proven+modeled,
  // proven+unmodeled, predicted-unconfirmed, plus the real-activity
  // replay's own target/context colours — which is genuinely hard to read
  // without one).
  //
  // The transport controls are duplicated here rather than living only in
  // the bottleneck modal because that modal covers the map: driving the
  // replay from it meant never being able to see the replay it was
  // driving. Both copies call the same functions and share one status
  // string (setRealReplayStatus), so they can't drift.
  let bottleneckLegendControl = null;

  function ensureBottleneckLegendControl() {
    if (bottleneckLegendControl) return;
    bottleneckLegendControl = L.control({ position: "bottomleft" });
    bottleneckLegendControl.onAdd = function () {
      const div = L.DomUtil.create("div", "sim-bottleneck-legend");
      // Item 14 — a real collapsible header, replacing the old static one.
      // Kept expanded by default (the shared helper's own normal default)
      // rather than collapsed: tests/simulator.spec.js asserts this key's
      // own row text is present right after a replay, with no prior
      // interaction with this control itself.
      const rows = `
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#4ade80"></span>Proven &amp; modeled</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#38bdf8"></span>Proven, outside our model</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:#facc15"></span>Predicted, unconfirmed</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch sim-legend-dashed" style="border-color:#64748b"></span>Predicted, no evidence either way</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#f472b6"></span>Replayed packet (window view)</div>
        <div class="sim-legend-row"><span class="sim-legend-swatch" style="background:#94a3b8"></span>Other real traffic (window view)</div>
      `;
      div.innerHTML = `
        <div id="sim-map-real-replay-controls" class="sim-real-replay-controls hidden">
          <div class="plan-row sim-playback-buttons">
            <button id="sim-map-real-replay" title="Watch the real traffic in this packet's window play out on the map, in the order it actually happened">▶ Play real traffic</button>
            <button id="sim-map-real-replay-skip" title="Jump straight to the whole window drawn at once">⏭ Skip to end</button>
          </div>
          <div class="plan-hint" id="sim-map-real-replay-status"></div>
        </div>
        ${window.HopReachMapControls.collapsibleHtml("Map key", rows, "sim-bottleneck-legend")}
        <button id="sim-map-open-bottleneck" class="sim-map-open-analysis" title="Open the full proven-vs-predicted breakdown (covers the map while it's open)">🔍 Bottleneck analysis</button>
      `;
      L.DomEvent.disableClickPropagation(div);
      window.HopReachMapControls.wireCollapsible(div);
      div.querySelector("#sim-map-real-replay").addEventListener("click", startRealTimelineReplay);
      div.querySelector("#sim-map-real-replay-skip").addEventListener("click", skipRealTimelineToEnd);
      div.querySelector("#sim-map-open-bottleneck").addEventListener("click", () => openModal("sim-bottleneck-modal"));
      return div;
    };
    bottleneckLegendControl.addTo(map);
  }

  // Shows/hides the map-docked transport controls and labels them with the
  // window actually in use, so "±20s" on the panel control and what the map
  // offers to play can never disagree.
  function syncRealReplayControls() {
    const wrap = document.getElementById("sim-map-real-replay-controls");
    if (!wrap) return;
    wrap.classList.toggle("hidden", realTimelineEvents.length === 0);
    const btn = document.getElementById("sim-map-real-replay");
    if (btn) btn.textContent = `▶ Play real ±${lastRealTimelineWindowSecs}s`;
    // Also called after the control is rebuilt from scratch (reopening the
    // simulator panel tears it down), so the status has to be restored onto
    // the fresh DOM rather than left blank.
    const mapStatus = document.getElementById("sim-map-real-replay-status");
    if (mapStatus) mapStatus.textContent = lastRealReplayStatusText;
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

      // Everything else CoreScope observed within the configured window of
      // this packet (see "Surrounding activity window", up to ±120s) — the
      // surrounding real activity for the "play in time what happened"
      // replay (see startRealTimelineReplay). Fetched now so any
      // additional node it involves gets placed alongside the target
      // packet's own nodes in one pass, rather than needing a second
      // "load more nodes" round-trip.
      const windowSecs = Math.min(120, Math.max(1, parseInt(document.getElementById("sim-replay-window-secs").value, 10) || 30));
      lastRealTimelineWindowSecs = windowSecs;
      const REAL_TIMELINE_WINDOW_MS = windowSecs * 1000;
      setStatus("sim-replay-hash-status", `Fetching surrounding real activity (±${windowSecs}s)…`);
      const { packets: windowPackets, hitCap } = await fetchPacketsAroundTime(targetMs, REAL_TIMELINE_WINDOW_MS);
      for (const p of windowPackets) {
        for (const k of p.resolved_path || []) if (k) allPubkeys.add(k.toLowerCase());
        if (p.observer_id) allPubkeys.add(p.observer_id.toLowerCase());
      }

      // Keep every repeater already on the map and ADD the ones this
      // packet's observations mention. This used to clearNodes() first —
      // "a replay is a fresh investigation" — which quietly rigged the whole
      // comparison: the only repeaters left standing were the ones CoreScope
      // had already proved heard something, so the "predicted" flood had
      // nowhere to spread that reality hadn't already confirmed, and any
      // repeater that exists but simply wasn't heard was deleted before the
      // model got a chance to predict a hop into it. Those are exactly the
      // interesting ones. They stay, the model predicts into them, and
      // renderBottleneckAnalysis reports the result honestly (it can't be
      // confirmed OR refuted from this packet's observations — see its
      // unconfirmable split).
      const pubkeyToIndex = new Map();
      simNodes.forEach((n, i) => {
        // Real repeaters carry their pubkey as refId, but the node directory
        // and CoreScope's path data are lowercased — match case-insensitively
        // or an already-loaded repeater gets silently duplicated.
        if (n.source === "real" && n.refId) pubkeyToIndex.set(String(n.refId).toLowerCase(), i);
      });
      const alreadyLoaded = pubkeyToIndex.size;
      let placedForReplay = 0;
      for (const pk of allPubkeys) {
        if (pubkeyToIndex.has(pk)) continue; // already on the map
        const info = nodeDir.get(pk);
        if (!info) continue; // CoreScope knows the key but has no position for it — can't place it
        pubkeyToIndex.set(pk, simNodes.length);
        // role (see ensureNodeDirectory) governs canRelay below — a
        // CoreScope-labelled "listener" only ever receives in real life
        // and should never appear as a predicted relay hop, regardless of
        // whether our model's own connectivity would otherwise allow it.
        simNodes.push({ id: randomId(), source: "real", refId: pk, label: info.name, lat: info.lat, lon: info.lon, role: info.role, address: shortAddressFromPubkey(pk) });
        placedForReplay++;
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
      document.getElementById("sim-bottleneck-replay-title").textContent = `Replay real activity (±${windowSecs}s)`;
      const capNote = hitCap ? ` — CoreScope's recent-packet cap was reached before the window's oldest edge, so this may be partial` : "";
      setRealReplayStatus(
        realTimelineEvents.length
          ? `${windowPackets.length} real packet${windowPackets.length === 1 ? "" : "s"} observed within ±${windowSecs}s${capNote} — ready to replay.`
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
      // Parse the real frame precisely (validated against 400 real frames):
      // header, [4 transport bytes if route 0/3], path_len, path, payload.
      // The APPLICATION payload length is what the engine's own airtime model
      // (onAirLen) then re-derives the full on-air size from — so passing the
      // whole frame length here (as this once did) would double-count the
      // framing/path bytes. Use the packet's own hash size too, recovered
      // from the path_len byte, so the replay reproduces the real packet's
      // airtime rather than an approximation.
      const frame = parseMeshFrame(packetData.packet ? packetData.packet.raw_hex : null);
      const payloadLen = frame ? frame.payloadLen : 20;
      const originIndex = pubkeyToIndex.get(originPubkey);
      const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
      const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
      const predictedMessages = [{ origin: originIndex, sendAtMs: 0, payloadLen, hashSize: frame ? frame.hashSize : DEFAULT_MESSAGE_HASH_SIZE }];
      const predictedReport = MeshSim.run(scenarioFromState(), predictedMessages, seed, maxSimTimeMs);

      const routeType = packetData.packet ? packetData.packet.route_type : null;
      renderBottleneckAnalysis({ pubkeyToIndex, provenEdges, predictedReport });
      ensureBottleneckLegendControl();
      syncRealReplayControls();

      // A replay's predicted run is a real report and belongs in the same
      // places every other run's does — the reception log, the packet
      // inspector, the per-repeater breakdown. It used to be computed,
      // diffed against reality, and then thrown away: clearNodes() above
      // has already nulled lastReport and torn down the playback control,
      // so the map's reception log sat empty for the whole replay even
      // though a full set of predicted receptions existed. Rendering it
      // (deliberately without startReplay, which would clear the
      // proven/predicted overlay renderBottleneckAnalysis just drew) means
      // the log fills in and "▶ Replay" is there to animate the predicted
      // flood whenever you want it.
      lastReport = predictedReport;
      lastMessages = predictedMessages;
      rebuildLinkIndexes(predictedReport);
      renderResults(predictedReport);
      renderSentMessagesList();

      // Flood route types are TRANSPORT_FLOOD (0) and FLOOD (1); direct are
      // DIRECT (2) and TRANSPORT_DIRECT (3). Our model only predicts flood
      // relaying, so warn only for the DIRECT types — the previous check
      // (routeType !== 0) wrongly warned on plain floods and stayed silent
      // on transport-floods.
      const isDirect = routeType === 2 || routeType === 3;
      // Deliberately doesn't open the bottleneck modal automatically. It
      // covers the whole map (see #sim-modal-backdrop), which is precisely
      // what you need to see while a replay plays — the transport controls
      // and the map key are docked on the map itself now, and the
      // "🔍 Bottleneck analysis" button opens the full breakdown on demand.
      setStatus(
        "sim-replay-hash-status",
        `Loaded ${observations.length} real observation${observations.length === 1 ? "" : "s"} of packet ${hash}. ` +
          `Predicting over ${simNodes.length} repeaters (${alreadyLoaded} already loaded, ${placedForReplay} added from this packet's observations). ` +
          `Press "▶ Play real ±${windowSecs}s" on the map to watch it, or open the bottleneck analysis for the full breakdown.` +
          (isDirect ? " Note: our model only predicts flood relaying, but this packet used direct (addressed) routing — the prediction side won't be meaningful." : "")
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
    // observation ever confirmed it.
    //
    // "Unconfirmed" on its own badly overstates the case, and it's why this
    // list looks alarmingly long: the node set on the map is every repeater
    // seen anywhere in the whole ±window of surrounding traffic, while
    // provenEdges only ever covers THIS packet's own observations. A
    // predicted hop into a repeater that never appears anywhere in this
    // packet's real path data can't be confirmed or refuted — CoreScope
    // simply has no evidence either way (it only ever learns a hop happened
    // when some observer reported a path through it). Absence of evidence
    // there isn't evidence of absence, so those are split out as
    // "unconfirmable" and are NOT bottleneck candidates.
    //
    // What's left — a predicted hop into a repeater that DOES appear in
    // this packet's real path data, reached some other way but not this one
    // — is the genuinely interesting set: reality had visibility of that
    // node and still didn't record this hop.
    const observedNodeIndices = new Set();
    for (const e of provenEdges.values()) {
      const f = pubkeyToIndex.get(e.from);
      const t = pubkeyToIndex.get(e.to);
      if (f != null) observedNodeIndices.add(f);
      if (t != null) observedNodeIndices.add(t);
    }
    const allUnconfirmed = Array.from(predictedPairs.entries())
      .filter(([key]) => !provenPairIndices.has(key))
      .map(([, r]) => r)
      .sort((a, b) => a.atMs - b.atMs);
    const unconfirmed = allUnconfirmed.filter((r) => observedNodeIndices.has(r.node));
    const unconfirmable = allUnconfirmed.filter((r) => !observedNodeIndices.has(r.node));

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
      `${unconfirmable.length} predicted into repeaters this packet's observations say nothing about (can't be judged either way), ` +
      `${unmodeled.length} proven but not even predicted possible.`;
    document.getElementById("sim-bottleneck-unconfirmable-note").textContent = unconfirmable.length
      ? `${unconfirmable.length} further predicted hop${unconfirmable.length === 1 ? "" : "s"} went into repeaters that never appear in this packet's real path data at all — CoreScope only learns a hop happened when one of its observers reports a path through it, so it has no evidence either way about those. They're excluded from the list below rather than counted as misses.`
      : "";

    const list = document.getElementById("sim-bottleneck-list");
    list.innerHTML = "";
    if (unconfirmed.length === 0) {
      list.innerHTML = `<div class="plan-empty">Every predicted relay into a repeater this packet's observations cover was confirmed by a real observation.</div>`;
    }
    for (const r of unconfirmed) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      const row = document.createElement("div");
      row.className = "plan-list-item sim-list-item sim-collided";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(from ? from.label : "?")} → ${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">predicted at ~${r.atMs}ms, hop ${r.hopCount}${r.collided ? " · our model also predicts a collision here" : " · this repeater does appear in the packet's real path data, just never via this hop"}</span>
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
    // predicted-but-unconfirmed (the bottleneck candidates), and faint
    // dashed slate for predicted-but-unjudgeable — drawn, because they're
    // still what the model thinks happened and hiding them would misrepresent
    // the predicted flood, but visually demoted so they don't read as
    // failures the way a wall of amber did.
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
    for (const r of unconfirmable) {
      const from = simNodes[r.fromNode];
      const to = simNodes[r.node];
      if (!from || !to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: "#64748b", weight: 2, opacity: 0.5, dashArray: "3 7" }
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
  // Where focus was before a modal opened — restored on close so keyboard/
  // screen-reader users land back where they were, not at the top of the
  // document (see openModal/closeModals).
  let modalReturnFocusEl = null;

  const MODAL_FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function openModal(id) {
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    const modal = document.getElementById(id);
    modal.classList.remove("hidden");
    document.getElementById("sim-modal-backdrop").classList.remove("hidden");
    modalReturnFocusEl = document.activeElement;
    const firstFocusable = modal.querySelector(MODAL_FOCUSABLE_SELECTOR);
    (firstFocusable || modal).focus({ preventScroll: true });
  }

  function closeModals() {
    document.getElementById("sim-modal-backdrop").classList.add("hidden");
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    if (modalReturnFocusEl && document.body.contains(modalReturnFocusEl)) modalReturnFocusEl.focus({ preventScroll: true });
    modalReturnFocusEl = null;
  }

  // Escape either pops one level of the packet inspector's own node<->packet
  // drill history (mirroring "← Back", since that history exists precisely
  // so a user can back out of a detour without losing their place) or, with
  // nothing to pop, closes the modal outright.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.getElementById("sim-modal-backdrop").classList.contains("hidden")) return;
    if (packetModalHistory.length > 0) goBackPacketModal();
    else closeModals();
  });

  // A simple focus trap: Tab/Shift+Tab wrap within whichever modal is open
  // rather than escaping to the page underneath (which the backdrop hides
  // visually but doesn't otherwise block from keyboard focus).
  document.getElementById("sim-modal-backdrop").addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const modal = document.querySelector(".sim-modal:not(.hidden)");
    if (!modal) return;
    const focusable = Array.from(modal.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

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
        // Apply immediately to what's already on screen — same idea as
        // the filter control below, and the reason this is a live lens
        // rather than a pre-run setting. A replay still in flight keeps
        // playing; its next wave picks the new mode up naturally.
        // (A selected message's own path lives on its own layer and is
        // filter-driven, not keepAllPaths-driven, so it's untouched here.)
        redrawPathsForKeepAllPaths();
      });
      div.querySelector("#sim-view-filter").addEventListener("change", (e) => {
        simViewMode.filter = e.target.value;
        // Re-render whatever's currently on screen against the new
        // filter — a live replay in progress just keeps going (its next
        // wave picks the new filter up naturally), but a static
        // skip-to-end view or a selected message's own path needs an
        // explicit refresh to actually reflect the change. Routed through
        // redrawPathsForKeepAllPaths rather than redrawResultLines so a
        // filter change can't silently resurrect every path while
        // "Keep all paths" is unticked.
        if (lastReport && replayIndex >= replayWaves.length) {
          redrawPathsForKeepAllPaths();
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
    simPlaybackControl = L.control({ position: "bottomleft" });
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
      // Must be re-added alongside the other three: closing the panel
      // removes it, and it used to be the one layer the open path never put
      // back — so after a close/reopen the real-activity replay drew every
      // hop into a detached layer group and nothing at all showed on the
      // map, looking exactly like a replay that had found no traffic.
      simRealActivityLayer.addTo(map);
      ensureSimViewControl();
      if (lastReport) ensureSimPlaybackControl(); // reopening Simulate mode with a report already computed
      // Same for a replay already loaded: closing the panel tears the
      // control down, and the replay's own state (realTimelineEvents, the
      // drawn overlay) survives, so reopening has to put the transport
      // controls and the map key back rather than leaving a loaded replay
      // with no way to play it.
      if (realTimelineEvents.length > 0) {
        ensureBottleneckLegendControl();
        syncRealReplayControls();
      }
    } else {
      setPlacementMode("off");
      stopReplay();
      clearTransportSource(); // the bar belongs to the simulator, not the map
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
  document.getElementById("sim-suggest-policy").addEventListener("click", runSuggestPolicy);
  document.getElementById("sim-optimize-adaptive").addEventListener("click", runOptimizeAdaptive);
  document.getElementById("sim-optimize-cancel").addEventListener("click", cancelOptimizeAdaptive);
  document.getElementById("sim-optimize-export-csv").addEventListener("click", exportOptimizeDeviationsCsv);
  document.getElementById("sim-open-optimize-modal").addEventListener("click", () => openModal("sim-optimize-modal"));
  document.getElementById("sim-optimize-node-detail-close").addEventListener("click", () => {
    document.getElementById("sim-optimize-node-detail").classList.add("hidden");
  });
  document.getElementById("sim-stress-run").addEventListener("click", runStressTest);
  document.getElementById("sim-policy-export-csv").addEventListener("click", exportPolicyActionsCsv);
  document.getElementById("sim-policy-profile-back").addEventListener("click", () => {
    document.getElementById("sim-policy-profile-detail").classList.add("hidden");
  });
  document.getElementById("sim-replay").addEventListener("click", startReplay);
  document.getElementById("sim-skip-to-end").addEventListener("click", skipToEnd);

  // --- transport wiring ---
  document.getElementById("sim-transport-play").addEventListener("click", () => {
    if (transportPlaying) transportPause();
    else transportPlay();
  });
  document.getElementById("sim-transport-seek").addEventListener("input", (e) => {
    transportPause(); // grabbing the scrubber takes over from playback
    transportSeekTo(parseInt(e.target.value, 10) || 0);
  });
  document.getElementById("sim-transport-speed").addEventListener("change", (e) => {
    transportRate = parseFloat(e.target.value) || 1;
  });
  // Space toggles play/pause while the simulator is open, the way every
  // other media transport does — but not while typing in a field, and not
  // when a button has focus (space is that button's own activation key).
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !transportSource) return;
    if (document.getElementById("sim-transport").classList.contains("hidden")) return;
    const el = document.activeElement;
    const tag = el ? el.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || (el && el.isContentEditable)) return;
    e.preventDefault();
    if (transportPlaying) transportPause();
    else transportPlay();
  });
  document.getElementById("sim-replay-hash-go").addEventListener("click", replayFromHash);
  document.getElementById("sim-reconstruct-episode").addEventListener("click", reconstructEpisodeFromWindow);
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
    syncMessageHashSizeToSelectedNode(); // seed hash size from whichever node the picker already has selected
    openModal("sim-messages-modal");
  });
  document.getElementById("sim-message-node").addEventListener("change", syncMessageHashSizeToSelectedNode);
  document.getElementById("sim-open-results-modal").addEventListener("click", () => openModal("sim-results-modal"));
  document.getElementById("sim-open-predictions-modal").addEventListener("click", () => openModal("sim-predictions-modal"));
  document.getElementById("sim-open-stress-modal").addEventListener("click", () => openModal("sim-stress-modal"));
  document.getElementById("sim-open-bottleneck-modal").addEventListener("click", () => openModal("sim-bottleneck-modal"));
  document.getElementById("sim-open-episode-modal").addEventListener("click", () => {
    renderEpisodeAnalysis();
    openModal("sim-episode-modal");
  });
  document.getElementById("sim-episode-set-baseline").addEventListener("click", setEpisodeBaseline);
  document.getElementById("sim-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "sim-modal-backdrop") closeModals();
  });
  document.querySelectorAll("#sim-modal-backdrop [data-close]").forEach((btn) => btn.addEventListener("click", closeModals));

  function populateBulkRadioPresetSelect() {
    const sel = document.getElementById("sim-bulk-radio-preset");
    for (const p of RADIO_PRESETS) {
      const opt = document.createElement("option");
      opt.value = p.label;
      opt.textContent = p.label;
      sel.appendChild(opt);
    }
  }

  initSimScopeFilter();
  populateBulkRadioPresetSelect();
  renderNodeList();
  renderMessageList();
  refreshSetupSelect();

  // Test-only introspection hook.
  window.__hopreachSimulatorDebug = {
    getNodeCount: () => simNodes.length,
    getLinkCount: () => simLinks.length,
    // The directed link between two node indices (or undefined) — lets a
    // test confirm a built link's SNR actually responds to per-node
    // antenna height / tx power (see buildLinksFromModel).
    getLink: (from, to) => simLinks.find((l) => l.from === from && l.to === to),
    getEpisode: () => lastEpisode,
    getMessageCount: () => messagesFromState(parseInt(document.getElementById("sim-seed").value, 10) || 0).length,
    getMessageGeneratorCount: () => simMessageGenerators.length,
    getLastReport: () => lastReport,
    getWaveCount: () => replayWaves.length,
    // Polylines currently drawn on the results layer — how many paths are
    // actually visible on the map right now, as opposed to how many the
    // report contains. Lets a test tell the "Keep all paths" accumulated
    // view apart from the single-wave live view.
    getResultLineCount: () => {
      let n = 0;
      simResultsLayer.eachLayer((l) => {
        if (l instanceof L.Polyline) n++;
      });
      return n;
    },
    // Lines drawn by the real-activity replay, and whether the layer they
    // go into is actually attached to the map — the two together are what a
    // test needs to catch the replay drawing into a detached layer group
    // (which looks identical to "found no traffic" from the outside).
    getRealActivityLineCount: () => {
      let n = 0;
      simRealActivityLayer.eachLayer((l) => {
        if (l instanceof L.Polyline) n++;
      });
      return n;
    },
    isRealActivityLayerOnMap: () => map.hasLayer(simRealActivityLayer),
    // Stroke colour of every real-activity line — lets a test assert the
    // replayed packet is actually drawn distinctly from the surrounding
    // traffic, rather than just that some lines exist.
    getRealActivityColors: () => {
      const out = [];
      simRealActivityLayer.eachLayer((l) => {
        if (l instanceof L.Polyline) out.push(l.options.color);
      });
      return out;
    },
    getNodes: () => simNodes,
    getLinks: () => simLinks,
    panBy: (dx, dy) => map.panBy([dx, dy], { animate: false }),
    getSavedSetups: () => loadAllSetups(),
  };
})();
