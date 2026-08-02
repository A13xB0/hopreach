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
  // Shared mutable state lives in sim-state.js so the feature modules below
  // can reach it without simulator.js handing each of them 64 getters.
  const S = window.SimState;
  const { SIM_MAX_RANGE_KM, SIM_ZOOM_CAP, CORESCOPE_REACH_DAYS, DEFAULT_MESSAGE_HASH_SIZE, SOURCE_BADGE, SIM_TIER_STORAGE_KEY, DEFAULT_LOOP_DETECT, RADIO_PRESETS, LONG_LIST_ROW_CAP } = window.SimConstants;

  const cfg = window.HOPREACH_CONFIG;
  const { map } = window.MCCoverageMap;

  // Parsing a packet's own bytes is the backend's job (internal/corescope);
  // /mesh-api/ hands us the decoded scope, hash size and frame length. All
  // that is left here is pulling a hash out of whatever the user pasted.
  const { extractPacketHash } = window.MeshFrame;

  // The config-rule and topology-attribute mirrors of internal/meshsim live
  // in sim-topology.js, which takes nodes and links as arguments so it can be
  // tested. These wrappers feed it this module's own simNodes/simLinks, so
  // the call sites below read exactly as they did in-file.
  const { ruleMatchesAttrs, applyRule, applyPolicyToNodeState } = window.SimTopology;
  const attrsFromState = (nodes, grid) => window.SimTopology.nodeAttrs(nodes, S.simLinks, grid);
  const computeTopologyAttrsJs = () => window.SimTopology.topologyAttrs(S.simNodes, S.simLinks);

  // The "Replay a real CoreScope packet" card's own description links out
  // to the actual CoreScope instance this deployment reads from — set from
  // config rather than hardcoded, since a different deployment can point
  // at a different CoreScope instance entirely (see prepare.go's own
  // corescopeUrl). Left pointing at the project repo in the static HTML as
  // a safe fallback if config is ever missing this field.
  if (cfg.corescopeUrl) {
    const link = document.getElementById("sim-corescope-link");
    if (link) link.href = cfg.corescopeUrl;
  }

  // Shared with the planner's connect-repeaters route check, which builds
  // scenarios for the same engine — see meshsim-scenario.js.
  const SF_THRESHOLDS_DB = self.HopReachMeshModel.SF_THRESHOLDS_DB;

  // Each entry: {id, source: 'planned'|'real'|'companion', refId, label, lat, lon}.
  // Only 'companion' nodes are user-renameable/movable-by-nature — a
  // planned/real repeater's identity comes from its source of truth (the
  // active plan / the live map), not this tool.
    // {from: nodeIndex, to: nodeIndex, snrDb} — directed, built by
  // buildLinks() below, cleared whenever the node list changes so a stale
  // link referencing a removed/renumbered node can never linger.
    // Message *generators*, not individual sends — {id, nodeIndex, count,
  // minPayload, maxPayload, minGapMs, maxGapMs}. Each one expands into
  // `count` concrete sends (see messagesFromState) with a random payload
  // length and a random gap since the previous send, both freshly drawn
  // per message rather than fixed — "10 messages, 1-5s apart, 10-50B
  // each" reads as one real batch instead of ten manual rows to fill in.
      // The exact expanded {origin, sendAtMs, payloadLen, region} array passed
  // to MeshSim.run — index-aligned with each Reception's own packetId, so
  // the "Sent messages" list (see renderSentMessagesList/selectSentMessage)
  // can show each one's own origin/region without re-deriving it from the
  // generators (which don't map 1:1 to packetIds once expanded).
      // A reconstructed CoreScope episode (see reconstructEpisodeFromWindow):
  // provenance plus the real observations needed to compare our simulation
  // against what actually happened. null unless an episode is loaded.
    // The exact engine messages (and target pid) the episode's own run used —
  // set by replayFromHash, which builds messages ad hoc rather than from
  // simMessageGenerators; the 10× probability analysis re-runs THESE.
      // A pinned baseline run's problem counts, for the before/after delta (see
  // renderEpisodeAnalysis / setEpisodeBaseline). null until pinned.
      // Terrain grid from the last "model"/"blend" link build, reused so
  // predictSettings() can look up each node's altitude without a second
  // DEM fetch — cleared in invalidateLinks() since moving a node (or
  // changing the node set) invalidates it exactly the same way it
  // invalidates links.
  
  // Per-node manual overrides on top of defaultPrefs() — keyed by the
  // node's own stable `id` (not array index, which shifts as nodes are
  // added/removed) — set via the click-to-configure popup (see
  // buildNodePopupHtml/saveNodePrefs). A node with no entry here just uses
  // defaultPrefs() unchanged.
  
  // The last predictSettings() result, kept around so the per-node config
  // popup can show "predicted: txdelay X, rxdelay Y" for whichever node
  // was clicked without re-running the search — cleared (along with the
  // rest of a run's results) in hideResults().
      // The last runStressTest() result (item 15b) — kept around purely so
  // reopening #sim-stress-modal doesn't need a fresh sweep.
  
  // The saved setup (see loadAllSetups/saveCurrentSetup below) currently
  // loaded, if any — lets "Save" overwrite the same entry instead of always
  // creating a new one, and lets the select reflect what's actually live.
  
  // predictSettings() runs MeshSim.suggest in its own Worker (see
  // meshsim-worker.js) rather than on the main thread — a real candidate
  // grid is well over a hundred rules, each several full simulation runs,
  // easily seconds to tens of seconds of CPU work that used to freeze the
  // whole page with zero feedback for its entire duration. generation
  // guards against a stale worker message landing after the panel's been
  // cleared or another search started.
    
  function ensurePredictWorker() {
    if (!S.predictWorker) S.predictWorker = new Worker("meshsim-worker.js");
    return S.predictWorker;
  }

  // Sends one message to worker and resolves with its matching reply's
  // own `result` field — a single request/response round-trip, not a
  // progress-reporting search like suggest/stress/suggestPolicy each
  // have their own bespoke onmessage handler for. Built for the adaptive
  // optimizer: each ROUND is
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
  
  // "off" | "companion" — click-to-place mode for a virtual companion
  // radio, scoped to this panel only (reset to "off" whenever the panel
  // closes) — see setSimPanelOpen and the map click handler below. Named
  // distinctly from Plan mode's own, unrelated "📍 Companion pin" feature
  // (a neighbour-preview tool over real repeater data, not a simulation
  // node).
  
  // Monotonic — never derived from the *current* companion count, and
  // never decremented on removal. Counting the current companions and
  // adding 1 (the previous approach) breaks the moment one is removed:
  // add "Companion 1"/"Companion 2", remove "Companion 1", add another —
  // the count is back down to 1, so the new one would also be labelled
  // "Companion 2", colliding with the one still on the map. This can only
  // go up, so a label, once used, is never handed out again this session.
    
  // The simulator's own repeater markers live in a pane above Leaflet's
  // default markerPane (z-index 600). Without this they share that pane with
  // the base map's clustered real-repeater markers and lose to them on DOM
  // order: a cluster icon drawn over a simulated repeater swallows the click
  // entirely, so clicking the repeater you can plainly see does nothing at
  // all. Simulate mode is fundamentally about these markers, so they win.
  map.createPane("simNodesPane");
  map.getPane("simNodesPane").style.zIndex = 650;

  const simNodesLayer = L.layerGroup().addTo(map);
  const simResultsLayer = L.layerGroup().addTo(map);
  // ✕-rings over nodes whose simulated delivery is contradicted by healthy
  // silent observers (episode evidence-constrained reach) — its own layer so
  // replay/growth redraws never clobber it.
  const episodeEvidenceLayer = L.layerGroup().addTo(map);
  // A selected sent message's own path/collisions (see selectSentMessage)
  // — deliberately separate from simResultsLayer (which the replay/growth
  // markers own) so selecting a message doesn't fight with replay state.
  const simMessagePathLayer = L.layerGroup().addTo(map);
  // The ±30s real-traffic replay animation (see startRealTimelineReplay)
  // draws here — its own layer, separate from simResultsLayer's static
  // proven/predicted overlay (see renderBottleneckAnalysis), so playing
  // the animation doesn't clear or fight with that always-shown context.
  const simRealActivityLayer = L.layerGroup().addTo(map);
  // The replay's static proven-vs-predicted overlay (see
  // renderBottleneckAnalysis). Its own layer because simResultsLayer belongs
  // to the simulation replay, which clears it wholesale on every wave and
  // every view-option change — so touching any Simulator-view control used
  // to silently destroy the analysis a replay had just drawn, with no way to
  // get it back short of replaying the packet.
  // Starts detached: it's opt-in via the replay control's own checkbox.
  const simProvenLayer = L.layerGroup();

  function randomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(6)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // A node's behavioural type, which is not the same thing as where it
  // came from (n.source, shown as the provenance badge). The type can be
  // changed per node in the Repeaters & settings table — flipping a real
  // repeater to a companion to ask "what if this stopped relaying" is a
  // legitimate what-if, and it never touches the underlying CoreScope
  // data. Stored alongside the other per-node overrides so it saves,
  // exports and imports with everything else.
  function effectiveNodeType(node) {
    if (node.role === "listener") return "listener"; // CoreScope-labelled listener — rx only, never retransmits (see replayFromHash); not user-overridable
    const override = S.simNodePrefsOverrides[node.id];
    if (override && (override.nodeType === "companion" || override.nodeType === "repeater")) return override.nodeType;
    return node.source === "companion" ? "companion" : "repeater";
  }

  function canRelay(node) {
    // Only a repeater relays: a handheld companion originates/receives
    // traffic but never retransmits, same as real MeshCore companion apps,
    // and a listener is rx-only.
    return effectiveNodeType(node) === "repeater";
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



  // --- status hints, panel open/close --------------------------------

  function setStatus(elId, text) {
    const el = document.getElementById(elId);
    el.textContent = text;
    el.classList.toggle("hidden", !text);
  }

  // The map-docked control shows live stats now, not a mirrored status
  // string (see ensureSimPlaybackControl) — this only writes the Results
  // modal's own copy, but keeps its name/call sites unchanged since every
  // caller just wants "tell the user what the replay is doing" regardless
  // of where that ends up landing.
  function setReplayStatus(text) {
    setStatus("sim-replay-status", text);
  }


  function setSimPanelOpen(open) {
    document.getElementById("sim-panel").classList.toggle("hidden", !open);
    document.getElementById("map-wrap").classList.toggle("sim-open", open);
    // Clear the coverage raster and un-cluster the markers while simulating,
    // and put both back on the way out — see applySimulateDeclutter.
    if (window.MCCoverageMap && window.MCCoverageMap.applySimulateDeclutter) {
      window.MCCoverageMap.applySimulateDeclutter(open);
    }
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
      if (S.lastReport) ensureSimPlaybackControl(); // reopening Simulate mode with a report already computed
      // Same for a replay already loaded: closing the panel tears the
      // control down, and the replay's own state (realTimelineEvents, the
      // drawn overlay) survives, so reopening has to put the transport
      // controls and the map key back rather than leaving a loaded replay
      // with no way to play it.
      if (S.realTimelineEvents.length > 0) {
        ensureBottleneckLegendControl();
        syncRealReplayControls();
      }
      updateWorkflowState(); // state can change while the panel is closed (e.g. loading a saved setup)
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
      map.removeLayer(simProvenLayer);
      stopRealTimelineReplay();
      removeBottleneckLegendControl();
      removeSimViewControl();
      removeSimPlaybackControl();
    }
    map.invalidateSize();
  }

  // --- module wiring ---
  //
  // The simulator's modal system: opening and closing the stacked detail dialogs, and keeping keyboard focus trapped inside the top one.
  const {
    closeModals,
    openModal,
  } = window.SimModals.init({
    goBackPacketModal: (...a) => goBackPacketModal(...a),
  });

  // Per-repeater rankings live in sim-rankings.js. Shared state it reads
  // straight from SimState; what it takes here is the handful of simulator
  // helpers it calls.
  const {
    isCanonicalDelivery,
    computeRankings,
    renderRankings,
    renderRankingsTableInto,
    setRankingsFullWindowOpen,
  } = window.SimRankings.init({
    canRelay: (...a) => canRelay(...a),
    effectiveRegions: (...a) => effectiveRegions(...a),
    effectiveDenyUnscoped: (...a) => effectiveDenyUnscoped(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    map,
  });

  // Fetching and interpreting a real packet's surrounding activity: the node directory, the observer-liveness evidence, the time window itself, and turning those packets into engine messages.
  const {
    addProvenEdge,
    buildObserverEvidence,
    buildWindowFloodMessages,
    carriesTransportCode,
    ensureNodeDirectory,
    fetchPacketsAroundTime,
    originPubkeyOfPacket,
    regionOfPacket,
  } = window.SimWindow.init({
  });

  // Getting nodes into the workspace: loading planned repeaters or real observed ones, placing companions and repeaters by hand, and renaming/removing/clearing them.
  const {
    clearNodes,
    filterRepeatersAliveAt,
    initSimScopeFilter,
    invalidateLinks,
    loadPlannedRepeaters,
    loadRealRepeaters,
    removeNode,
    renameNode,
    setPlacementMode,
  } = window.SimNodes.init({
    generatedShortAddress: (...a) => generatedShortAddress(...a),
    hideResults: (...a) => hideResults(...a),
    randomId: (...a) => randomId(...a),
    redrawNodeMarkers: (...a) => redrawNodeMarkers(...a),
    renderMessageList: (...a) => renderMessageList(...a),
    renderMessageNodeOptions: (...a) => renderMessageNodeOptions(...a),
    renderNodeList: (...a) => renderNodeList(...a),
    setStatus: (...a) => setStatus(...a),
    shortAddressFromPubkey: (...a) => shortAddressFromPubkey(...a),
    updateWorkflowState: (...a) => updateWorkflowState(...a),
    map,
  });

  // Saved setups: everything needed to get back to 'ready to run' — nodes, their settings overrides, the built links, senders and run controls — stored client-side, plus import/export as a standalone file.
  const {
    deleteCurrentSetup,
    exportCurrentSetup,
    importSetupFromFile,
    loadAllSetups,
    loadSetup,
    newSetup,
    refreshSetupSelect,
    saveCurrentSetup,
  } = window.SimSetups.init({
    clearNodes: (...a) => clearNodes(...a),
    hideResults: (...a) => hideResults(...a),
    randomId: (...a) => randomId(...a),
    redrawNodeMarkers: (...a) => redrawNodeMarkers(...a),
    renderMessageList: (...a) => renderMessageList(...a),
    renderMessageNodeOptions: (...a) => renderMessageNodeOptions(...a),
    renderNodeList: (...a) => renderNodeList(...a),
    setStatus: (...a) => setStatus(...a),
  });

  // The simulator panel's own lists and rail: node list, message-sender list, the Basic/Advanced tier switch, and the workflow rail that tracks which step you're on.
  const {
    addMessage,
    cancelEditSender,
    jumpToAccordion,
    nodesSortedByLabel,
    redrawNodeMarkers,
    renderMessageList,
    renderMessageNodeOptions,
    renderNodeList,
    setSimTier,
    updateWorkflowState,
  } = window.SimPanel.init({
    effectiveNodeType: (...a) => effectiveNodeType(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    invalidateLinks: (...a) => invalidateLinks(...a),
    openNodesModal: (...a) => openNodesModal(...a),
    openPacketInspectorForNode: (...a) => openPacketInspectorForNode(...a),
    randomId: (...a) => randomId(...a),
    renderNodesModalTable: (...a) => renderNodesModalTable(...a),
    setStatus: (...a) => setStatus(...a),
    simNodesLayer,
  });

  // The 'Repeaters & settings' modal: one editable table of every node's radio, delay and flood settings, plus the bulk-apply row that fills them all at once.
  const {
    applyNodesModalTable,
    fillAllRowsFromBulkApply,
    openNodesModal,
    redrawResultLines,
    renderNodesModalTable,
  } = window.SimNodesModal.init({
    applyRule: (...a) => applyRule(...a),
    computeRankings: (...a) => computeRankings(...a),
    defaultPrefs: (...a) => defaultPrefs(...a),
    effectiveDenyUnscoped: (...a) => effectiveDenyUnscoped(...a),
    effectiveFloodMax: (...a) => effectiveFloodMax(...a),
    effectiveFloodMaxUnscoped: (...a) => effectiveFloodMaxUnscoped(...a),
    effectiveHashSize: (...a) => effectiveHashSize(...a),
    effectiveLoopDetect: (...a) => effectiveLoopDetect(...a),
    effectiveNodeType: (...a) => effectiveNodeType(...a),
    effectivePrefsFor: (...a) => effectivePrefsFor(...a),
    effectiveRegions: (...a) => effectiveRegions(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    invalidateLinks: (...a) => invalidateLinks(...a),
    matchesViewFilter: (...a) => matchesViewFilter(...a),
    nodesSortedByLabel: (...a) => nodesSortedByLabel(...a),
    openModal: (...a) => openModal(...a),
    openPacketInspectorForNode: (...a) => openPacketInspectorForNode(...a),
    radioPresetLabelFor: (...a) => radioPresetLabelFor(...a),
    redrawNodeMarkers: (...a) => redrawNodeMarkers(...a),
    regionsFromDisplayString: (...a) => regionsFromDisplayString(...a),
    regionsToDisplayString: (...a) => regionsToDisplayString(...a),
    removeNode: (...a) => removeNode(...a),
    renameNode: (...a) => renameNode(...a),
    renderMessageList: (...a) => renderMessageList(...a),
    renderMessageNodeOptions: (...a) => renderMessageNodeOptions(...a),
    ruleMatchesAttrs: (...a) => ruleMatchesAttrs(...a),
    setStatus: (...a) => setStatus(...a),
    simResultsLayer,
  });

  // Turning the workspace into a scenario the engine can run: resolving each node's effective settings, building the message set, running a simulation, and rendering its results.
  const {
    appendShowAllButton,
    defaultPrefs,
    effectiveDenyUnscoped,
    effectiveFloodMax,
    effectiveFloodMaxUnscoped,
    effectiveHashSize,
    effectiveLoopDetect,
    effectivePrefsFor,
    effectiveRegions,
    messagesFromState,
    mulberry32,
    radioPresetLabelFor,
    regionsFromDisplayString,
    regionsToDisplayString,
    renderResults,
    renderStatStrip,
    runSimulation,
    scenarioFromState,
    syncMessageHashSizeToSelectedNode,
  } = window.SimRun.init({
    canRelay: (...a) => canRelay(...a),
    ensureSimPlaybackControl: (...a) => ensureSimPlaybackControl(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    rebuildLinkIndexes: (...a) => rebuildLinkIndexes(...a),
    renderEpisodeAnalysis: (...a) => renderEpisodeAnalysis(...a),
    renderRankings: (...a) => renderRankings(...a),
    renderSentMessagesList: (...a) => renderSentMessagesList(...a),
    setStatus: (...a) => setStatus(...a),
    startReplay: (...a) => startReplay(...a),
    updateWorkflowState: (...a) => updateWorkflowState(...a),
  });

  // The packet inspector: the sent-messages list, and the per-repeater / per-packet reception detail that answers 'what happened here' for one node or one flood.
  const {
    applyPacketModalFilters,
    drawSelectedMessagePath,
    goBackPacketModal,
    hideResults,
    openPacketInspectorForNode,
    rebuildLinkIndexes,
    renderSentMessagesList,
  } = window.SimInspector.init({
    appendShowAllButton: (...a) => appendShowAllButton(...a),
    clearTransportSource: (...a) => clearTransportSource(...a),
    closeModals: (...a) => closeModals(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    matchesViewFilter: (...a) => matchesViewFilter(...a),
    nodesSortedByLabel: (...a) => nodesSortedByLabel(...a),
    openModal: (...a) => openModal(...a),
    removeBottleneckLegendControl: (...a) => removeBottleneckLegendControl(...a),
    removeSimPlaybackControl: (...a) => removeSimPlaybackControl(...a),
    renderStatStrip: (...a) => renderStatStrip(...a),
    setRankingsFullWindowOpen: (...a) => setRankingsFullWindowOpen(...a),
    setStatus: (...a) => setStatus(...a),
    stopRealTimelineReplay: (...a) => stopRealTimelineReplay(...a),
    stopReplay: (...a) => stopReplay(...a),
    updateWorkflowState: (...a) => updateWorkflowState(...a),
    episodeEvidenceLayer, growthMarkers, simMessagePathLayer, simProvenLayer, simRealActivityLayer, simResultsLayer,
  });

  // The shared replay transport: one play/seek/scrub bar driving both the simulated flood and the real-packet replay, plus the wave animation and the growing success markers it drives.
  const {
    applyFinalGrowth,
    clearTransportSource,
    matchesViewFilter,
    pulseAt,
    redrawPathsForKeepAllPaths,
    setTransportSource,
    skipToEnd,
    startReplay,
    stopReplay,
    transportPause,
    transportPlay,
    transportSeekTo,
    transportToEnd,
  } = window.SimTransport.init({
    redrawResultLines: (...a) => redrawResultLines(...a),
    setReplayStatus: (...a) => setReplayStatus(...a),
    updateMapLiveStats: (...a) => updateMapLiveStats(...a),
    growthMarkers, simResultsLayer, simViewMode,
  });

  // The map-docked simulator controls: the view-mode switcher that filters what the map draws, and the live run-stats readout beside it.
  const {
    ensureSimPlaybackControl,
    ensureSimViewControl,
    removeSimPlaybackControl,
    removeSimViewControl,
    updateMapLiveStats,
  } = window.SimMapControls.init({
    applyFinalGrowth: (...a) => applyFinalGrowth(...a),
    drawSelectedMessagePath: (...a) => drawSelectedMessagePath(...a),
    redrawPathsForKeepAllPaths: (...a) => redrawPathsForKeepAllPaths(...a),
    renderStatStrip: (...a) => renderStatStrip(...a),
    transportSeekTo: (...a) => transportSeekTo(...a),
    growthMarkers, map, simResultsLayer, simViewMode,
  });

  // Settings prediction: the single-rule 'predict settings' search, the offered-load stress sweep, and the composite policy search with its per-repeater action list.
  const {
    exportPolicyActionsCsv,
    predictSettings,
    runStressTest,
    runSuggestPolicy,
  } = window.SimPolicy.init({
    applyPolicyToNodeState: (...a) => applyPolicyToNodeState(...a),
    applyRule: (...a) => applyRule(...a),
    attrsFromState: (...a) => attrsFromState(...a),
    computeTopologyAttrsJs: (...a) => computeTopologyAttrsJs(...a),
    defaultPrefs: (...a) => defaultPrefs(...a),
    effectiveFloodMax: (...a) => effectiveFloodMax(...a),
    effectivePrefsFor: (...a) => effectivePrefsFor(...a),
    ensureGrid: (...a) => ensureGrid(...a),
    ensurePredictWorker: (...a) => ensurePredictWorker(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    hidePredictProgress: (...a) => hidePredictProgress(...a),
    hideStressProgress: (...a) => hideStressProgress(...a),
    messagesFromState: (...a) => messagesFromState(...a),
    nodesSortedByLabel: (...a) => nodesSortedByLabel(...a),
    openModal: (...a) => openModal(...a),
    ruleMatchesAttrs: (...a) => ruleMatchesAttrs(...a),
    scenarioFromState: (...a) => scenarioFromState(...a),
    setPredictProgress: (...a) => setPredictProgress(...a),
    setStatus: (...a) => setStatus(...a),
    setStressProgress: (...a) => setStressProgress(...a),
  });

  // The adaptive optimizer: running bounded search rounds against the engine, showing per-repeater deviations, and exporting them as settings a human can actually apply.
  const {
    cancelOptimizeAdaptive,
    exportOptimizeDeviationsCsv,
    runOptimizeAdaptive,
  } = window.SimOptimize.init({
    ensurePredictWorker: (...a) => ensurePredictWorker(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    messagesFromState: (...a) => messagesFromState(...a),
    openModal: (...a) => openModal(...a),
    scenarioFromState: (...a) => scenarioFromState(...a),
    setStatus: (...a) => setStatus(...a),
    workerRequest: (...a) => workerRequest(...a),
  });

  // Episode reconstruction: rebuilding what actually happened in a packet's window as a runnable scenario, then the analysis and probability verdict comparing prediction against evidence.
  const {
    reconstructEpisodeFromWindow,
    renderEpisodeAnalysis,
    runEpisodeProbability,
    setEpisodeBaseline,
  } = window.SimEpisode.init({
    buildLinksFromModel: (...a) => buildLinksFromModel(...a),
    buildObserverEvidence: (...a) => buildObserverEvidence(...a),
    ensureNodeDirectory: (...a) => ensureNodeDirectory(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    extractPacketHash: (...a) => extractPacketHash(...a),
    fetchPacketsAroundTime: (...a) => fetchPacketsAroundTime(...a),
    hideResults: (...a) => hideResults(...a),
    isCanonicalDelivery: (...a) => isCanonicalDelivery(...a),
    messagesFromState: (...a) => messagesFromState(...a),
    mulberry32: (...a) => mulberry32(...a),
    originPubkeyOfPacket: (...a) => originPubkeyOfPacket(...a),
    randomId: (...a) => randomId(...a),
    redrawNodeMarkers: (...a) => redrawNodeMarkers(...a),
    regionOfPacket: (...a) => regionOfPacket(...a),
    renderMessageList: (...a) => renderMessageList(...a),
    renderMessageNodeOptions: (...a) => renderMessageNodeOptions(...a),
    renderNodeList: (...a) => renderNodeList(...a),
    scenarioFromState: (...a) => scenarioFromState(...a),
    setStatus: (...a) => setStatus(...a),
    shortAddressFromPubkey: (...a) => shortAddressFromPubkey(...a),
    episodeEvidenceLayer, map,
  });

  // Real-packet timeline playback: turning observed transmissions into a scrubbable timeline, drawing it on the map, and the legend control that explains the colours.
  const {
    buildRealTimeline,
    buildReplayObservations,
    buildReplayTimeline,
    ensureBottleneckLegendControl,
    removeBottleneckLegendControl,
    setRealReplayStatus,
    skipRealTimelineToEnd,
    startRealTimelineReplay,
    stopRealTimelineReplay,
    syncRealReplayControls,
  } = window.SimRealtime.init({
    matchesViewFilter: (...a) => matchesViewFilter(...a),
    openModal: (...a) => openModal(...a),
    pulseAt: (...a) => pulseAt(...a),
    setStatus: (...a) => setStatus(...a),
    setTransportSource: (...a) => setTransportSource(...a),
    transportPause: (...a) => transportPause(...a),
    transportPlay: (...a) => transportPlay(...a),
    transportSeekTo: (...a) => transportSeekTo(...a),
    transportToEnd: (...a) => transportToEnd(...a),
    map, simProvenLayer, simRealActivityLayer, simViewMode,
  });

  // Replaying one real packet: fetching its window, reconstructing the topology it travelled through, and the bottleneck analysis comparing what was proven against what the model predicts.
  const {
    replayFromHash,
  } = window.SimReplay.init({
    addProvenEdge: (...a) => addProvenEdge(...a),
    buildLinksFromCorescope: (...a) => buildLinksFromCorescope(...a),
    buildLinksFromModel: (...a) => buildLinksFromModel(...a),
    buildObserverEvidence: (...a) => buildObserverEvidence(...a),
    buildRealTimeline: (...a) => buildRealTimeline(...a),
    buildReplayObservations: (...a) => buildReplayObservations(...a),
    buildReplayTimeline: (...a) => buildReplayTimeline(...a),
    buildWindowFloodMessages: (...a) => buildWindowFloodMessages(...a),
    carriesTransportCode: (...a) => carriesTransportCode(...a),
    ensureBottleneckLegendControl: (...a) => ensureBottleneckLegendControl(...a),
    ensureNodeDirectory: (...a) => ensureNodeDirectory(...a),
    escapeHtml: (...a) => escapeHtml(...a),
    extractPacketHash: (...a) => extractPacketHash(...a),
    fetchPacketsAroundTime: (...a) => fetchPacketsAroundTime(...a),
    filterRepeatersAliveAt: (...a) => filterRepeatersAliveAt(...a),
    isolatedNodeHint: (...a) => isolatedNodeHint(...a),
    randomId: (...a) => randomId(...a),
    rebuildLinkIndexes: (...a) => rebuildLinkIndexes(...a),
    redrawNodeMarkers: (...a) => redrawNodeMarkers(...a),
    regionOfPacket: (...a) => regionOfPacket(...a),
    renderEpisodeAnalysis: (...a) => renderEpisodeAnalysis(...a),
    renderMessageNodeOptions: (...a) => renderMessageNodeOptions(...a),
    renderNodeList: (...a) => renderNodeList(...a),
    renderResults: (...a) => renderResults(...a),
    renderSentMessagesList: (...a) => renderSentMessagesList(...a),
    scenarioFromState: (...a) => scenarioFromState(...a),
    setRealReplayStatus: (...a) => setRealReplayStatus(...a),
    setStatus: (...a) => setStatus(...a),
    shortAddressFromPubkey: (...a) => shortAddressFromPubkey(...a),
    stopRealTimelineReplay: (...a) => stopRealTimelineReplay(...a),
    syncRealReplayControls: (...a) => syncRealReplayControls(...a),
    updateWorkflowState: (...a) => updateWorkflowState(...a),
    isCanonicalDelivery, simProvenLayer, simRealActivityLayer,
  });

  // Connectivity building: turning a node set into the directed, SNR-valued link graph the engine runs on — from the propagation model, from observed CoreScope reach, or a blend of both.
  const {
    buildLinks,
    buildLinksFromCorescope,
    buildLinksFromModel,
    ensureGrid,
    isolatedNodeHint,
  } = window.SimLinks.init({
    effectiveNodeType: (...a) => effectiveNodeType(...a),
    effectivePrefsFor: (...a) => effectivePrefsFor(...a),
    setStatus: (...a) => setStatus(...a),
    updateWorkflowState: (...a) => updateWorkflowState(...a),
    SF_THRESHOLDS_DB, cfg,
  });

  // Every extracted feature module is initialised here, after the top-level
  // consts exist. Helpers are passed as arrow wrappers so they resolve at
  // call time, which keeps the order of these calls irrelevant even between
  // modules that call into each other.

  document.getElementById("sim-toggle").addEventListener("click", () => {
    setSimPanelOpen(document.getElementById("sim-panel").classList.contains("hidden"));
  });
  document.getElementById("sim-panel-close").addEventListener("click", () => setSimPanelOpen(false));
  // Clicking into Plan mode should always leave Simulate closed — see
  // HopReachPlanner.closePanel's own comment for why this is one-directional
  // rather than a shared toggle-coordinator module.
  document.getElementById("plan-toggle").addEventListener("click", () => setSimPanelOpen(false));

  // Every accordion (Saved setups, the four workflow sections, and the
  // three Advanced-only ones) shares one open/close handler — each toggles
  // independently, several are often meaningfully open together.
  document.querySelectorAll(".sim-acc-head").forEach((head) => {
    head.addEventListener("click", () => {
      const acc = head.closest(".sim-acc");
      const open = acc.classList.toggle("open");
      head.setAttribute("aria-expanded", String(open));
    });
  });
  document.querySelectorAll(".sim-rail-step").forEach((step) => {
    step.addEventListener("click", () => jumpToAccordion(step.dataset.railTarget));
  });
  document.getElementById("sim-tier-basic").addEventListener("click", () => setSimTier("basic"));
  document.getElementById("sim-tier-advanced").addEventListener("click", () => setSimTier("advanced"));
  // Restored per browser, same pattern as the saved basemap choice —
  // falls back to Basic (the safer, less overwhelming default) for
  // anyone who's never chosen.
  setSimTier(localStorage.getItem(SIM_TIER_STORAGE_KEY) === "advanced" ? "advanced" : "basic");
  updateWorkflowState();

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
  document.getElementById("sim-add-repeater").addEventListener("click", () => setPlacementMode("repeater"));
  document.getElementById("sim-nodes-clear").addEventListener("click", clearNodes);
  document.getElementById("sim-build-links").addEventListener("click", buildLinks);
  document.getElementById("sim-message-add").addEventListener("click", addMessage);
  document.getElementById("sim-message-cancel-edit").addEventListener("click", cancelEditSender);
  document.getElementById("sim-run").addEventListener("click", runSimulation);
  document.getElementById("sim-episode-probability").addEventListener("click", runEpisodeProbability);
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
    if (S.transportPlaying) transportPause();
    else transportPlay();
  });
  document.getElementById("sim-transport-seek").addEventListener("input", (e) => {
    transportPause(); // grabbing the scrubber takes over from playback
    transportSeekTo(parseInt(e.target.value, 10) || 0);
  });
  document.getElementById("sim-transport-speed").addEventListener("change", (e) => {
    S.transportRate = parseFloat(e.target.value) || 1;
  });
  // Space toggles play/pause while the simulator is open, the way every
  // other media transport does — but not while typing in a field, and not
  // when a button has focus (space is that button's own activation key).
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !S.transportSource) return;
    if (document.getElementById("sim-transport").classList.contains("hidden")) return;
    const el = document.activeElement;
    const tag = el ? el.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON" || (el && el.isContentEditable)) return;
    e.preventDefault();
    if (S.transportPlaying) transportPause();
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
    getNodeCount: () => S.simNodes.length,
    // Opens a node's inspector without needing to hit its map marker —
    // markers overlap heavily on a real mesh, which makes a click-based test
    // flaky for reasons that have nothing to do with what it's asserting.
    openNodeInspector: (i) => openPacketInspectorForNode(i),
    getLinkCount: () => S.simLinks.length,
    // The directed link between two node indices (or undefined) — lets a
    // test confirm a built link's SNR actually responds to per-node
    // antenna height / tx power (see buildLinksFromModel).
    getLink: (from, to) => S.simLinks.find((l) => l.from === from && l.to === to),
    getEpisode: () => S.lastEpisode,
    getMessageCount: () => messagesFromState(parseInt(document.getElementById("sim-seed").value, 10) || 0).length,
    getMessageGeneratorCount: () => S.simMessageGenerators.length,
    getLastReport: () => S.lastReport,
    getLastMessages: () => S.lastMessages,
    getWaveCount: () => S.replayWaves.length,
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
    // Lines on the static proven/predicted overlay that are actually on the
    // map — zero when the overlay is switched off, however much it holds.
    getProvenLineCount: () => {
      if (!map.hasLayer(simProvenLayer)) return 0;
      let n = 0;
      simProvenLayer.eachLayer((l) => {
        if (l instanceof L.Polyline) n++;
      });
      return n;
    },
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
    getNodes: () => S.simNodes,
    // The scenario exactly as handed to the engine — the only way to check
    // what a node's settings actually resolved to, rather than what the
    // node object happens to carry before overrides are applied.
    getScenario: () => scenarioFromState(),
    // How this build reads a packet's region. Decoding itself is the
    // backend's now, so a test cross-checks /mesh-api/'s answer rather than
    // a second implementation living here.
    regionOfPacket: (packet) => regionOfPacket(packet),
    getLinks: () => S.simLinks,
    panBy: (dx, dy) => map.panBy([dx, dy], { animate: false }),
    getSavedSetups: () => loadAllSetups(),
  };
})();
