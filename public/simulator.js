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

  const cfg = window.HOPREACH_CONFIG;
  const { map } = window.MCCoverageMap;

  // Parsing a packet's own bytes is the backend's job (internal/corescope);
  // /mesh-api/ hands us the decoded scope, hash size and frame length. All
  // that is left here is pulling a hash out of whatever the user pasted.
  const { extractPacketHash } = window.MeshFrame;

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
    canRelay, effectiveRegions, effectiveDenyUnscoped, escapeHtml, map,
  });

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

  const SIM_MAX_RANGE_KM = 35; // same rationale as planner.js's PREVIEW_MAX_RANGE_KM
  const SIM_ZOOM_CAP = 11;
  const CORESCOPE_REACH_DAYS = 7; // fixed window — simulator.js has no window-selector UI of its own (see planner.js's for the map's own hover tooltips)
  // Shared with the planner's connect-repeaters route check, which builds
  // scenarios for the same engine — see meshsim-scenario.js.
  const SF_THRESHOLDS_DB = self.HopReachMeshModel.SF_THRESHOLDS_DB;
  // Mirrors internal/meshsim's own defaultMessageHashSize (engine.go) — a
  // sender with no explicit hash size falls back to this. 3 bytes,
  // deliberately diverging from real firmware (which has no built-in
  // default; every real sendFlood caller passes one explicitly) to
  // minimise hash collisions between unrelated repeaters by default.
  const DEFAULT_MESSAGE_HASH_SIZE = 3;

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
    const existing = new Set(S.simNodes.map((n) => nodeKey(n.source, n.refId)));
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
      S.simNodes.push({ id: randomId(), source: "planned", refId: r.id, label: r.label, lat: r.lat, lon: r.lon, antennaHeightM: r.antennaHeightM ?? null, regions: ["*"], address: generatedShortAddress() });
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
      let names = [];
      try {
        names = await MeshApi.scopes();
      } catch {
        return;
      }
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

  // Repeaters plausibly ALIVE at refMs: first heard before it (small slop
  // for clock skew) and last heard no more than 25h before it. Works for
  // "now" and equally for a historical packet's own timestamp — replaying
  // last month's packet over today's survivors would be just as wrong as
  // replaying it over the long-dead.
  function filterRepeatersAliveAt(repeaters, refMs) {
    const AGE_MS = 25 * 60 * 60 * 1000;
    const SLOP_MS = 60 * 60 * 1000;
    return repeaters.filter((r) => {
      const last = r.lastHeard ? Date.parse(r.lastHeard) : NaN;
      if (Number.isNaN(last) || last < refMs - AGE_MS) return false;
      const first = r.firstSeen ? Date.parse(r.firstSeen) : NaN;
      if (!Number.isNaN(first) && first > refMs + SLOP_MS) return false; // didn't exist yet
      return true;
    });
  }

  function loadRealRepeaters() {
    const planner = window.HopReachPlanner;
    if (!planner) return;
    const scope = document.getElementById("sim-scope-filter").value;
    let real = Object.values(planner.getRealRepeaters());
    if (scope) real = real.filter((r) => (r.scopes || []).includes(scope));
    // "Heard ≤25h": a repeater CoreScope hasn't heard in over a day is very
    // likely off-air (on the network this was built for, 448 of 660 were) —
    // leaving it on the map has the model predicting hops through a corpse,
    // which is a big source of over-predicted reach.
    let staleSkipped = 0;
    if (document.getElementById("sim-load-real-freshness").value !== "all") {
      const before = real.length;
      real = filterRepeatersAliveAt(real, Date.now());
      staleSkipped = before - real.length;
    }
    if (real.length === 0) {
      setStatus("sim-status", scope ? `No real repeaters found for ${scope}.` : staleSkipped ? `All ${staleSkipped} matching repeaters are stale (nothing heard in 25h) — switch the freshness selector to "All known" to load them anyway.` : "No real repeater data loaded yet.");
      return;
    }
    const existing = new Set(S.simNodes.map((n) => nodeKey(n.source, n.refId)));
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
      S.simNodes.push({
        id: randomId(), source: "real", refId: r.id, label: r.label, lat: r.lat, lon: r.lon,
        antennaHeightM: r.antennaHeightM ?? null, // a repositioned real repeater may carry an override mast height; otherwise the default applies
        regions: r.scopes || [], hashSize: r.hashSize || null, denyUnscoped: r.observedUnscopedKnown ? !r.observedUnscoped : false,
        address: shortAddressFromPubkey(r.id),
      });
      added++;
    }
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
    setStatus("sim-status", `Loaded ${added} real repeater${added === 1 ? "" : "s"}${added < real.length ? " (some already loaded)" : ""}${staleSkipped ? ` — ${staleSkipped} skipped as stale (nothing heard in 25h)` : ""}.`);
  }

  function addCompanionAt(lat, lon) {
    S.companionCounter++;
    // regions doesn't actually gate anything for a companion (CanRelay is
    // always false for source:"companion", so acceptsRegion is never even
    // consulted for its own relay decision — see canRelay/engine.go's
    // cannot_relay check ordering) — set the same "*" wildcard anyway so
    // the nodes modal's Scopes column doesn't show a misleading empty/deny
    // state for it.
    S.simNodes.push({ id: randomId(), source: "companion", refId: randomId(), label: `Companion ${S.companionCounter}`, lat, lon, regions: ["*"], address: generatedShortAddress() });
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
  }

  // Same idea as addCompanionAt, but a node that actually relays. Recorded
  // as source "planned" because that's exactly what it is — a hypothetical
  // site that isn't in CoreScope — so it picks up the existing badge,
  // rename and remove affordances rather than needing a fourth source kind.
  function addPlacedRepeaterAt(lat, lon) {
    S.placedRepeaterCounter++;
    S.simNodes.push({
      id: randomId(),
      source: "planned",
      refId: randomId(),
      label: `Repeater ${S.placedRepeaterCounter}`,
      lat,
      lon,
      regions: ["*"],
      address: generatedShortAddress(),
    });
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    redrawNodeMarkers();
  }

  function setPlacementMode(next) {
    S.placementMode = S.placementMode === next ? "off" : next;
    document.getElementById("sim-add-companion").classList.toggle("active", S.placementMode === "companion");
    document.getElementById("sim-companion-hint").classList.toggle("hidden", S.placementMode !== "companion");
    document.getElementById("sim-add-repeater").classList.toggle("active", S.placementMode === "repeater");
    document.getElementById("sim-repeater-hint").classList.toggle("hidden", S.placementMode !== "repeater");
  }

  map.on("click", (e) => {
    if (S.placementMode === "companion") {
      addCompanionAt(e.latlng.lat, e.latlng.lng);
    } else if (S.placementMode === "repeater") {
      addPlacedRepeaterAt(e.latlng.lat, e.latlng.lng);
    }
  });

  function renameNode(id) {
    const n = S.simNodes.find((x) => x.id === id);
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
    delete S.simNodePrefsOverrides[id];
    // Deleting a mid-list node shifts every later index — remap generators
    // and the episode target, and drop anything pointing at the removed
    // node. The old filter only dropped generators falling off the END of
    // the array, silently moving every later sender onto the wrong node
    // (SIMULATION_REVIEW.md B1).
    const removedIdx = S.simNodes.findIndex((n) => n.id === id);
    S.simNodes = S.simNodes.filter((n) => n.id !== id);
    if (removedIdx >= 0) {
      const remap = (i) => (i === removedIdx ? -1 : i > removedIdx ? i - 1 : i);
      S.simMessageGenerators = S.simMessageGenerators
        .map((g) => ({ ...g, nodeIndex: remap(g.nodeIndex) }))
        .filter((g) => g.nodeIndex >= 0);
      if (S.lastEpisode && S.lastEpisode.target) {
        const t = remap(S.lastEpisode.target.nodeIndex);
        if (t < 0) S.lastEpisode = null; // target removed — episode meaningless
        else S.lastEpisode.target.nodeIndex = t;
        document.getElementById("sim-open-episode-modal").classList.toggle("hidden", !S.lastEpisode);
      }
      // The last report indexes the OLD node list — every downstream reader
      // (rankings, episode stats, replay) would mislabel rows.
      S.lastReport = null;
      S.lastMessages = null;
      S.lastEpisodeMessages = null;
      hideResults();
    }
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
  }

  function clearNodes() {
    S.simNodes = [];
    S.simMessageGenerators = [];
    S.simNodePrefsOverrides = {};
    // Restart the auto-labels too, so a cleared workspace doesn't carry on
    // at "Repeater 7" / "Companion 4".
    S.companionCounter = 0;
    S.placedRepeaterCounter = 0;
    S.lastEpisode = null;
    S.episodeBaseline = null;
    document.getElementById("sim-open-episode-modal").classList.add("hidden");
    invalidateLinks();
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
    hideResults();
  }

  function invalidateLinks() {
    S.simLinks = [];
    S.cachedGrid = null;
    S.linksGeneration++;
    setStatus("sim-links-status", "Connectivity not built yet for the current node set — click \"Build links\".");
    updateWorkflowState();
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
    const matchesCurrent = ids.includes(S.currentSetupId);
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
      if (id === S.currentSetupId) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function saveCurrentSetup() {
    if (S.simNodes.length === 0) {
      setStatus("sim-status", "Nothing to save — load some nodes first.");
      return;
    }
    const nameInput = document.getElementById("sim-setup-name");
    const name = nameInput.value.trim() || "Untitled setup";
    const all = loadAllSetups();
    const id = S.currentSetupId || randomId();
    all[id] = {
      id,
      name,
      savedAt: Date.now(),
      nodes: S.simNodes,
      links: S.simLinks,
      connectivitySource: document.getElementById("sim-connectivity-source").value,
      messageGenerators: S.simMessageGenerators,
      nodePrefsOverrides: S.simNodePrefsOverrides,
      seed: document.getElementById("sim-seed").value,
      maxSimTimeMs: document.getElementById("sim-max-time").value,
      trials: document.getElementById("sim-trials").value,
      // A reconstructed CoreScope episode's provenance + real observations,
      // so reloading the setup restores the actual-vs-predicted comparison.
      // Already plain arrays/objects, so it serialises directly.
      episode: S.lastEpisode || undefined,
    };
    saveAllSetups(all);
    S.currentSetupId = id;
    nameInput.value = name;
    refreshSetupSelect();
    setStatus("sim-status", `Saved setup "${name}".`);
  }

  function deleteCurrentSetup() {
    if (!S.currentSetupId) return;
    const all = loadAllSetups();
    const name = all[S.currentSetupId] ? all[S.currentSetupId].name : "this setup";
    if (!confirm(`Delete saved setup "${name}"? This can't be undone.`)) return;
    delete all[S.currentSetupId];
    saveAllSetups(all);
    S.currentSetupId = null;
    document.getElementById("sim-setup-name").value = "";
    refreshSetupSelect();
    setStatus("sim-status", `Deleted "${name}".`);
  }

  function newSetup() {
    S.currentSetupId = null;
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
    S.simNodes = s.nodes || [];
    S.simLinks = s.links || [];
    S.simMessageGenerators = s.messageGenerators || [];
    S.simNodePrefsOverrides = s.nodePrefsOverrides || {};
    document.getElementById("sim-connectivity-source").value = s.connectivitySource || "blend";
    document.getElementById("sim-seed").value = s.seed != null ? s.seed : 1;
    document.getElementById("sim-max-time").value = s.maxSimTimeMs != null ? s.maxSimTimeMs : 60000;
    document.getElementById("sim-trials").value = s.trials != null ? s.trials : 20;
    document.getElementById("sim-setup-name").value = s.name || "";
    S.cachedGrid = null; // stale for this node set even if links came along

    // Restore (or clear) the reconstructed-episode analysis for this setup.
    S.lastEpisode = s.episode || null;
    S.episodeBaseline = null;
    document.getElementById("sim-open-episode-modal").classList.toggle("hidden", !S.lastEpisode);

    // Keep the monotonic companion counter ahead of anything just loaded,
    // so a newly-placed companion never collides with a restored one's
    // label (see addCompanionAt/companionCounter's own comment).
    for (const n of S.simNodes) {
      if (n.source !== "companion") continue;
      const m = /^Companion (\d+)$/.exec(n.label || "");
      if (m) S.companionCounter = Math.max(S.companionCounter, parseInt(m[1], 10));
    }

    hideResults(); // any previous report doesn't match the freshly loaded scenario
    renderNodeList();
    renderMessageNodeOptions();
    renderMessageList();
    redrawNodeMarkers();
    if (S.simLinks.length > 0) {
      setStatus(
        "sim-links-status",
        `${S.simLinks.length} directed link${S.simLinks.length === 1 ? "" : "s"} restored from "${s.name || "this setup"}" (${s.connectivitySource || "model"}).`
      );
    } else {
      setStatus("sim-links-status", "Connectivity not built yet for the current node set — click \"Build links\".");
    }
  }

  function loadSetup(id) {
    const all = loadAllSetups();
    const s = all[id];
    if (!s) return;
    S.currentSetupId = id;
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
    if (S.simNodes.length === 0) {
      setStatus("sim-status", "Nothing to export — load some nodes first.");
      return;
    }
    const name = document.getElementById("sim-setup-name").value.trim() || "Untitled setup";
    const data = {
      name,
      nodes: S.simNodes,
      links: S.simLinks,
      connectivitySource: document.getElementById("sim-connectivity-source").value,
      messageGenerators: S.simMessageGenerators,
      nodePrefsOverrides: S.simNodePrefsOverrides,
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
    S.currentSetupId = null;
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
    document.getElementById("sim-node-count-badge").textContent = String(S.simNodes.length);
    if (!document.getElementById("sim-nodes-modal").classList.contains("hidden")) renderNodesModalTable();
    updateWorkflowState();
  }

  // Sorted by label for display only — simNodes' own array order (and
  // therefore every existing nodeIndex reference: message generators,
  // Reception.node/fromNode, simNodePrefsOverrides lookups by id) stays
  // exactly as-is. Only ever sort a copy of {node, originalIndex} pairs,
  // never simNodes itself.
  function nodesSortedByLabel() {
    return S.simNodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.label.localeCompare(b.n.label));
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
    if (prevValue && Number(prevValue) < S.simNodes.length) sel.value = prevValue;
  }

  // Set while editing an existing sender (see editSender/cancelEditSender)
  // — addMessage() updates this entry in place instead of pushing a new
  // one when set.
  
  function renderMessageList() {
    document.getElementById("sim-message-count-badge").textContent = String(S.simMessageGenerators.length);
    updateWorkflowState(); // ahead of the early return below — 0 senders is itself real state the rail needs
    const list = document.getElementById("sim-message-list");
    list.innerHTML = "";
    if (S.simMessageGenerators.length === 0) {
      list.innerHTML = '<div class="plan-empty">None yet — pick a sender above and add one.</div>';
      return;
    }
    for (const g of S.simMessageGenerators) {
      const node = S.simNodes[g.nodeIndex];
      const row = document.createElement("div");
      row.className = "plan-list-item";
      // Phase 3 — path-hash size is a property of the MESSAGE (the
      // originator stamps it onto the packet at send time; real firmware:
      // Mesh::sendFlood(packet, delay, path_hash_size)), not of the
      // repeater sending it — a relay appends its own hash at the
      // packet's own size, never its own configured one, so a single
      // path can never mix hash sizes hop to hop.
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
          S.simMessageGenerators = S.simMessageGenerators.filter((x) => x.id !== g.id);
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
        S.simMessageGenerators = S.simMessageGenerators.filter((x) => x.id !== g.id);
        if (S.editingGeneratorId === g.id) cancelEditSender();
        renderMessageList();
      };
      list.appendChild(row);
    }
  }

  // --- workflow rail, Basic/Advanced tier ---------------------------------
  //
  // Load nodes → build connectivity → add senders → run is the real
  // required sequence (nothing runs without links, links need nodes
  // first), previously expressed only by vertical position in one long
  // scroll. This reads the same state every render already depends on —
  // simNodes/simLinks/simMessageGenerators/lastReport — so it can never
  // drift from what the panel actually shows; there is no separate
  // "workflow progress" variable to keep in sync by hand.
  //
  // Called from a small, deliberately chosen set of hook points rather
  // than after every individual mutation: renderNodeList/renderMessageList
  // (already the single place each of those arrays' own UI refreshes),
  // buildLinks/invalidateLinks (the two places simLinks actually changes),
  // and the three lastReport assignment sites. A composite action like
  // clearNodes() already calls several of these in turn, so it updates
  // correctly without needing its own explicit call.
  const WORKFLOW_STEPS = [
    { id: "sim-acc-nodes", done: () => S.simNodes.length > 0 },
    { id: "sim-acc-links", done: () => S.simLinks.length > 0 },
    { id: "sim-acc-senders", done: () => S.simMessageGenerators.length > 0 },
    { id: "sim-acc-run", done: () => !!S.lastReport },
  ];

  function updateWorkflowState() {
    const rail = document.getElementById("sim-rail");
    if (!rail) return; // guards test/import contexts that don't mount the panel
    let currentAssigned = false;
    WORKFLOW_STEPS.forEach((step, i) => {
      const done = step.done();
      const isCurrent = !currentAssigned && !done;
      if (isCurrent) currentAssigned = true;
      const el = rail.querySelector(`[data-rail-target="${step.id}"]`);
      if (el) {
        el.classList.toggle("done", done);
        el.classList.toggle("now", isCurrent);
      }
    });

    const badgeNodes = document.getElementById("sim-acc-badge-nodes");
    if (badgeNodes) badgeNodes.textContent = S.simNodes.length === 0 ? "None loaded" : `${S.simNodes.length} loaded`;
    const badgeLinks = document.getElementById("sim-acc-badge-links");
    if (badgeLinks) badgeLinks.textContent = S.simLinks.length === 0 ? "Not built" : `${S.simLinks.length} link${S.simLinks.length === 1 ? "" : "s"}`;
    const badgeSenders = document.getElementById("sim-acc-badge-senders");
    if (badgeSenders) badgeSenders.textContent = String(S.simMessageGenerators.length);
    const badgeRun = document.getElementById("sim-acc-badge-run");
    if (badgeRun) badgeRun.textContent = S.lastReport ? "Done" : "Not run yet";
  }

  // Clicking a rail step opens (without closing any sibling — several are
  // often meaningfully open together, e.g. checking Connectivity while
  // Senders is still being set up) and scrolls to its accordion. Doesn't
  // force a tier switch: a step that lives under Advanced isn't one of
  // these four, so this never needs to.
  function jumpToAccordion(id) {
    const acc = document.getElementById(id);
    if (!acc) return;
    acc.classList.add("open");
    const head = acc.querySelector(".sim-acc-head");
    if (head) head.setAttribute("aria-expanded", "true");
    acc.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  const SIM_TIER_STORAGE_KEY = "hopreach.simTier";

  // Basic/Advanced is a shared primitive, not a per-section setting — one
  // flag, persisted per browser (same pattern as the saved basemap choice
  // in app.js), so a technical user who switches to Advanced once doesn't
  // have to repeat that every session, while a first-time basic visitor
  // never sees it unless they ask.
  function setSimTier(tier) {
    const advanced = tier === "advanced";
    document.getElementById("sim-tier-basic").classList.toggle("on", !advanced);
    document.getElementById("sim-tier-advanced").classList.toggle("on", advanced);
    document.querySelector(".sim-workspace").classList.toggle("tier-advanced", advanced);
    localStorage.setItem(SIM_TIER_STORAGE_KEY, tier);
  }

  // Loads an existing sender's own values back into the form and switches
  // "+ Add sender" into update-in-place mode — editing a sender's own
  // params (count/payload/gap/region) no longer means removing it and
  // re-adding a fresh one from scratch.
  function editSender(generatorId) {
    const g = S.simMessageGenerators.find((x) => x.id === generatorId);
    if (!g) return;
    S.editingGeneratorId = generatorId;
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
    hint.textContent = `Editing ${S.simNodes[g.nodeIndex] ? S.simNodes[g.nodeIndex].label : "this sender"}'s settings.`;
    hint.classList.remove("hidden");
  }

  function cancelEditSender() {
    S.editingGeneratorId = null;
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

    if (S.editingGeneratorId) {
      const g = S.simMessageGenerators.find((x) => x.id === S.editingGeneratorId);
      if (g) Object.assign(g, { nodeIndex, region, direct, hashSize, count, minPayload, maxPayload, minGapMs, maxGapMs });
      cancelEditSender();
    } else {
      S.simMessageGenerators.push({ id: randomId(), nodeIndex, region, direct, hashSize, count, minPayload, maxPayload, minGapMs, maxGapMs });
    }
    renderMessageList();
  }

  // --- map markers -----------------------------------------------------

  function redrawNodeMarkers() {
    simNodesLayer.clearLayers();
    S.simNodes.forEach((n, nodeIndex) => {
      // Icon follows the behavioural type, not the provenance: a node
      // switched to companion should look like one. Anything not sourced
      // from CoreScope was positioned by hand, so it stays draggable —
      // that now includes hand-placed repeaters, not just companions.
      const nodeType = effectiveNodeType(n);
      const iconClass = nodeType === "companion" ? "sim-marker-companion" : "sim-marker-icon";
      const typeSuffix = nodeType === n.source || (nodeType === "repeater" && n.source !== "companion") ? "" : ` · as ${nodeType}`;
      L.marker([n.lat, n.lon], {
        icon: L.divIcon({ className: iconClass, iconSize: [12, 12] }),
        draggable: n.source !== "real",
        pane: "simNodesPane",
      })
        .addTo(simNodesLayer)
        .bindTooltip(`${n.label} (${n.source})${typeSuffix}${n.address ? ` · ${n.address}` : ""}`)
        // Once a simulation has run, clicking a repeater is much more
        // often "what happened here" than "let me tweak its settings" —
        // show the packet inspector instead. Settings are still reachable
        // via the toolbar's "Repeaters & settings" button (and its own
        // per-row "Packets" action once a report exists, see
        // renderNodesModalTable).
        .on("click", () => (S.lastReport ? openPacketInspectorForNode(nodeIndex) : openNodesModal(n.id)))
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
  // internal/meshsim's own
  // loopDetectThreshold is NOT changed to match — an empty LoopDetect
  // there must keep meaning "never triggers" so an explicit "off" set
  // from here is honoured, not silently upgraded.
  const DEFAULT_LOOP_DETECT = "minimal";

  function renderNodesModalTable() {
    const tbody = document.getElementById("sim-nodes-modal-tbody");
    tbody.innerHTML = "";
    document.getElementById("sim-results-col-duty").classList.toggle("hidden", !S.lastReport);
    document.getElementById("sim-results-col-received").classList.toggle("hidden", !S.lastReport);
    if (S.simNodes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="16" class="plan-empty">None yet — load or place some repeaters (or a companion location), then reopen this.</td></tr>';
      return;
    }
    // Read-only result columns (item 16) — computed once for the whole
    // table rather than per row; empty/unused unless a report exists.
    const rankingByNode = S.lastReport ? computeRankings(S.lastReport) : null;
    nodesSortedByLabel().forEach(({ n, i: nodeIndex }) => {
      const prefs = effectivePrefsFor(n);
      let predictedTitle = "";
      if (S.lastTuneResult && S.lastTuneResult.suggestions.length && S.lastAttrsList && S.lastAttrsList[nodeIndex]) {
        const best = S.lastTuneResult.suggestions[0];
        if (ruleMatchesAttrs(best.rule, S.lastAttrsList[nodeIndex], nodeIndex)) {
          const predicted = applyRule(defaultPrefs(), best.rule, S.lastAttrsList[nodeIndex]);
          predictedTitle = `Predicted (${best.rule.name}): txdelay ${predicted.txDelayFactor.toFixed(2)} · rxdelay ${predicted.rxDelayBase.toFixed(1)}`;
        }
      }
      const loopDetect = effectiveLoopDetect(n);
      const loopDetectOptions = LOOP_DETECT_LEVELS.map((lvl) => `<option value="${lvl}" ${lvl === loopDetect ? "selected" : ""}>${lvl}</option>`).join("");
      const regions = effectiveRegions(n);
      const denyUnscoped = effectiveDenyUnscoped(n);
      const floodMax = effectiveFloodMax(n);
      const floodMaxUnscoped = effectiveFloodMaxUnscoped(n);
      const nodeType = effectiveNodeType(n);
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
        <td>${
          nodeType === "listener"
            ? '<span class="sim-node-badge sim-badge-background" title="CoreScope labelled this a listener — receive-only, never relays. Not changeable here.">listener</span>'
            : `<select data-field="nodeType" title="Repeaters relay traffic onward; companions only originate and receive. A what-if switch — it never changes the underlying CoreScope data.">
                 <option value="repeater" ${nodeType === "repeater" ? "selected" : ""}>repeater</option>
                 <option value="companion" ${nodeType === "companion" ? "selected" : ""}>companion</option>
               </select>`
        }</td>
        <td><input type="text" data-field="regions" value="${escapeHtml(regionsToDisplayString(regions))}" placeholder="none" title="Which region (scope) keys this repeater holds — comma-delimited, no # (e.g. sco, ioi), or * for every region. Blank means it holds none, so it relays no scoped traffic at all. Independent of Allow unscoped, exactly as in MeshCore: scoped traffic is gated purely on this list, unscoped traffic purely on that checkbox."></td>
        <td class="sim-checkbox-cell"><input type="checkbox" data-field="allowUnscoped" ${denyUnscoped ? "" : "checked"} title="Whether this node relays ordinary unscoped (regionless) flood traffic. Independent of the Scopes list — this gates only regionless traffic, and turning it off never stops the node relaying a region it holds a key for. For a real repeater, defaults to off unless CoreScope has actually observed it relaying unscoped traffic; absence over the observation window isn't proof of denial, just the best signal available."></td>
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
          ${S.lastReport ? '<button data-act="packets" title="See packets received here">📨</button>' : ""}
          ${n.source !== "real" ? '<button data-act="rename" title="Rename">✎</button>' : ""}
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
      if (S.lastReport) tr.querySelector('[data-act="packets"]').onclick = () => openPacketInspectorForNode(nodeIndex);
      if (n.source !== "real") tr.querySelector('[data-act="rename"]').onclick = () => renameNode(n.id);
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
      const n = S.simNodes.find((x) => x.id === tr.dataset.nodeId);
      if (!n) return;
      const override = {};
      const beforePrefs = effectivePrefsFor(n);
      const beforeRadio = beforePrefs.radio;
      const beforeType = effectiveNodeType(n);
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
      S.simNodePrefsOverrides[n.id] = override;
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
      // Same reasoning, one step removed: a repeater/companion switch moves
      // the node between mast height and handheld height (see
      // nodeAntennaHeightM), which changes every modelled link it's part
      // of. Compared before/after rather than "the field was present",
      // because every row carries this select.
      const typeReallyChanged = effectiveNodeType(n) !== beforeType;
      if (radioReallyChanged || powerReallyChanged || typeReallyChanged) radioChanged = true;
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
    // A type switch changes a node's marker icon and whether it can be
    // dragged, so the map has to be redrawn too — not just the panel.
    redrawNodeMarkers();
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
      const from = S.simNodes[r.fromNode];
      const to = S.simNodes[r.node];
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

  // --- run / predict -----------------------------------------------------

  // loopDetect/hashSize aren't part of NodePrefs (unlike tx/rx delay etc)
  // — they're their own SimNode-level fields (see internal/meshsim's own
  // HashSize doc comment) — but share the same simNodePrefsOverrides
  // object per node rather than a separate store, since they're set from
  // the exact same "Repeaters & settings" modal row.
  function effectiveLoopDetect(n) {
    const override = S.simNodePrefsOverrides[n.id];
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
    const override = S.simNodePrefsOverrides[n.id];
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
    const node = S.simNodes[Number(sel.value)];
    if (node) document.getElementById("sim-message-hash-size").value = String(effectiveHashSize(node));
  }

  // regions/denyUnscoped/floodMax/floodMaxUnscoped follow the same
  // override-over-node-default pattern as loopDetect/hashSize above — all
  // editable from the same "Repeaters & settings" modal row (see
  // renderNodesModalTable/applyNodesModalTable).
  function effectiveRegions(n) {
    const override = S.simNodePrefsOverrides[n.id];
    if (override && override.regions !== undefined) return override.regions;
    return n.regions || [];
  }

  function effectiveDenyUnscoped(n) {
    const override = S.simNodePrefsOverrides[n.id];
    if (override && override.denyUnscoped !== undefined) return override.denyUnscoped;
    return !!n.denyUnscoped;
  }

  function effectiveFloodMax(n) {
    const override = S.simNodePrefsOverrides[n.id];
    if (override && override.floodMax) return override.floodMax;
    return n.floodMax || 0;
  }

  function effectiveFloodMaxUnscoped(n) {
    const override = S.simNodePrefsOverrides[n.id];
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
  const CHANNEL_PER_WIDTH_DB = self.HopReachMeshModel.CHANNEL_PER_WIDTH_DB;
  const CHANNEL_FADING_SIGMA_DB = self.HopReachMeshModel.CHANNEL_FADING_SIGMA_DB;

  function scenarioFromState() {
    return {
      nodes: S.simNodes.map((n) => ({
        prefs: effectivePrefsFor(n),
        canRelay: canRelay(n),
        regions: effectiveRegions(n),
        loopDetect: effectiveLoopDetect(n),
        hashSize: effectiveHashSize(n),
        denyUnscoped: effectiveDenyUnscoped(n),
        floodMax: effectiveFloodMax(n),
        floodMaxUnscoped: effectiveFloodMaxUnscoped(n),
      })),
      links: S.simLinks,
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

  // See meshsim-scenario.js — shared with the planner's route check so a
  // node's starting settings can't drift between the two.
  function defaultPrefs() {
    return self.HopReachMeshModel.defaultPrefs();
  }

  // defaultPrefs() with whatever this specific node's manual override (see
  // simNodePrefsOverrides, set via the click-to-configure popup) replaces
  // — a node with no override just gets the baseline back untouched.
  // radio isn't overridable here (only the delay/power fields the popup
  // exposes), so it always comes from the baseline.
  function effectivePrefsFor(node) {
    const override = S.simNodePrefsOverrides[node.id];
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
    S.simMessageGenerators.forEach((g, gi) => {
      // A "fixed" generator is one reconstructed real transmission at an
      // absolute time — a real flood sender,
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
          // Identity for episode analysis: matching the target by
          // (origin, sendAtMs) confuses same-second re-sends
          // (SIMULATION_REVIEW.md M5). The engine ignores unknown fields.
          sourceHash: g.sourceHash || undefined,
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

  // The sim duration the CURRENT lastReport was produced with — rankings
  // duty% must divide by this, not by whatever the input now says.
  
  async function runSimulation() {
    if (S.simNodes.length === 0) {
      setStatus("sim-status", "Load some nodes first.");
      return;
    }
    if (S.simLinks.length === 0) {
      setStatus("sim-status", 'No connectivity built yet — click "Build links" first.');
      return;
    }
    if (S.simMessageGenerators.length === 0) {
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
      S.lastReport = report;
      S.lastRunMaxTimeMs = maxSimTimeMs;
      S.lastMessages = messages;
      rebuildLinkIndexes(report);
      renderResults(report);
      renderSentMessagesList();
      renderRankings(report);
      if (S.lastEpisode) renderEpisodeAnalysis(); // refresh actual-vs-predicted / before-after against this run
      startReplay();
      updateWorkflowState();
      setStatus("sim-status", "Done.");
      // Deliberately doesn't open the Results modal automatically — its
      // backdrop covers the whole map (see #sim-modal-backdrop), which
      // would block watching the flood propagate. The shared transport bar
      // plays it live either way; the "📊 Results" button is there
      // whenever the bigger modal view (full reception log, sent-messages
      // list) is actually wanted.
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

  // Renders report's reception log into container — used for the Results
  // modal's own log (the map-docked control used to carry a live copy of
  // this too; it shows running stats instead now, see
  // ensureSimPlaybackControl).
  function renderReceptionLogInto(container, report, showAll) {
    container.innerHTML = "";
    const all = report.receptions;
    const capped = !showAll && all.length > LONG_LIST_ROW_CAP;
    const toRender = capped ? all.slice(0, LONG_LIST_ROW_CAP) : all;
    for (const r of toRender) {
      const from = S.simNodes[r.fromNode];
      const to = S.simNodes[r.node];
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
    if (!S.lastMessages || S.lastMessages.length === 0) return;
    // packetId is lastMessages' own array index (Reception.packetId refers
    // back to it), which is insertion order — not necessarily time order
    // once multiple generators' sends interleave. Sort a copy for display,
    // keeping each row's real packetId for everything else (selection,
    // report lookups, the map path draw).
    const order = S.lastMessages.map((m, packetId) => ({ m, packetId })).sort((a, b) => a.m.sendAtMs - b.m.sendAtMs);
    order.forEach(({ m, packetId }) => {
      const origin = S.simNodes[m.origin];
      const receptions = S.lastReport ? S.lastReport.receptions.filter((r) => r.packetId === packetId) : [];
      const reachedNodes = new Set(receptions.filter((r) => !r.collided).map((r) => r.node));
      const collidedNodes = new Set(receptions.filter((r) => r.collided).map((r) => r.node));
      const flood = floodTimeMs(packetId);
      const floodLabel = flood != null ? ` · flooding for ${flood}ms` : "";
      const row = document.createElement("div");
      row.className = `plan-list-item sim-message-row${S.selectedPacketId === packetId ? " sim-message-row-selected" : ""}`;
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
      // scheduled instant lands past the sim's own end — WasRelayed
      // means "was eligible to relay," not "a transmission exists." Look
      // the real Transmission up rather than assume one.
      relayTx = S.transmissionIndex.get(linkKey(r.packetId, r.node)) || null;
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
    const n = S.simNodes[nodeIndex];
    return n ? n.label : `#${nodeIndex}`;
  }

  // "Flood time" — how long after the original send this packet was still
  // producing activity anywhere in the network (last reception's AtMs
  // minus the send time), i.e. how long until it stopped flooding.
  function floodTimeMs(packetId) {
    if (!S.lastReport || !S.lastMessages || !S.lastMessages[packetId]) return null;
    const receptions = S.lastReport.receptions.filter((r) => r.packetId === packetId);
    if (receptions.length === 0) return 0;
    const lastAtMs = Math.max(...receptions.map((r) => r.atMs));
    return lastAtMs - S.lastMessages[packetId].sendAtMs;
  }

  // The unified TX+RX activity events currently loaded into the packet
  // modal (unfiltered), and whether each row should name which node it
  // belongs to (needed for the per-packet view, where that varies row to
  // row; not needed for the per-node view, where it's implied by the
  // modal's own title) — set by openPacketInspectorForNode/
  // openPacketDetails, read by applyPacketModalFilters whenever the
  // filter controls change.
    
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
    // packetId:node -> the Reception that triggered this node's relay of
  // that packet — the mirror of transmissionIndex, letting a relay TX row
  // show "relaying what arrived at Xms" without a linear scan. Only ever
  // has one entry per key: a node relays a packet based on exactly one
  // decoded reception of it (hasSeen dedup — see Transmission's own Go doc
  // comment), so wasRelayed is true on at most one Reception per
  // (packetId, node).
  
  function rebuildLinkIndexes(report) {
    S.transmissionIndex = new Map();
    S.relayCauseIndex = new Map();
    for (const tx of (report && report.transmissions) || []) {
      S.transmissionIndex.set(linkKey(tx.packetId, tx.node), tx);
    }
    for (const r of (report && report.receptions) || []) {
      if (r.wasRelayed) S.relayCauseIndex.set(linkKey(r.packetId, r.node), r);
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
  // deferral), not lastMessages (only the origin's own scheduled send):
  // scheduled is not the same as actual.
  function buildNodeActivityEvents(nodeIndex) {
    const events = [];
    if (S.lastReport) {
      for (const tx of S.lastReport.transmissions) {
        if (tx.node === nodeIndex) events.push(buildTxEvent(tx));
      }
      for (const r of S.lastReport.receptions) {
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
    if (S.lastReport) {
      for (const tx of S.lastReport.transmissions) {
        if (tx.packetId === packetId) events.push(buildTxEvent(tx));
      }
      for (const r of S.lastReport.receptions) {
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
    let filtered = S.currentPacketModalEvents.filter((e) => matchesOutcomeFilter(e, outcomeFilter));
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
    countEl.textContent = filtered.length === S.currentPacketModalEvents.length ? "" : `Showing ${filtered.length} of ${S.currentPacketModalEvents.length}.`;
    renderNodeActivityRows(document.getElementById("sim-packet-modal-list"), filtered, S.currentPacketModalShowOpts);
  }

  // Renders one unified, timestamp-ordered table of TX (sent) and RX
  // (received) events — a single row shape covers both kinds, with a
  // colour-coded TX/RX badge as the only structural difference. Each row
  // drills into that packet's own full details.
  function renderNodeActivityRows(container, events, { showAt, drillTo, showAll, emptyHtml }) {
    container.innerHTML = "";
    if (events.length === 0) {
      container.innerHTML = `<div class="plan-hint">${emptyHtml || "Nothing to show."}</div>`;
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
        const own = S.lastReport ? S.lastReport.receptions.filter((r) => r.packetId === e.packetId) : [];
        const reachedCount = new Set(own.filter((r) => !r.collided).map((r) => r.node)).size;
        const collidedCount = new Set(own.filter((r) => r.collided).map((r) => r.node)).size;
        // Every relay's own Reception (the one it decided to relay based
        // on) is looked up here rather than re-derived — see
        // relayCauseIndex's own doc comment.
        const cause = tx.isRelay ? S.relayCauseIndex.get(key) : null;
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
    if (S.simNodes.length === 0) return;
    const receptions = S.lastReport ? S.lastReport.receptions.filter((r) => r.packetId === packetId) : [];
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
    
  // mode: "fresh" (a new entry point — marker click, the 📨 action, a
  // Details button elsewhere — resets the trail), "drill" (navigating to
  // another view from within the modal — pushes the view being left so
  // "← Back" can return to it), or "back" (restoring a popped view —
  // touches neither the stack nor packetModalCurrent's push).
  function enterPacketModalView(mode, next) {
    if (mode === "fresh") {
      S.packetModalHistory = [];
    } else if (mode === "drill" && S.packetModalCurrent) {
      S.packetModalHistory.push(S.packetModalCurrent);
    }
    S.packetModalCurrent = next;
    const backBtn = document.getElementById("sim-packet-modal-back");
    backBtn.classList.toggle("hidden", S.packetModalHistory.length === 0);
  }

  function goBackPacketModal() {
    const prev = S.packetModalHistory.pop();
    if (!prev) return;
    if (prev.kind === "node") openPacketInspectorForNode(prev.nodeIndex, "back");
    else openPacketDetails(prev.packetId, "back");
  }

  // The observed half of the inspector — hidden entirely outside a replay,
  // where there's nothing real to compare against and the section would just
  // be an empty box.
  function renderObservedSection(nodeIndex, obs) {
    const section = document.getElementById("sim-packet-modal-observed-section");
    if (S.replayObservations.size === 0) {
      section.classList.add("hidden");
      return;
    }
    section.classList.remove("hidden");
    const hint = document.getElementById("sim-packet-modal-observed-hint");
    const list = document.getElementById("sim-packet-modal-observed-list");
    list.innerHTML = "";

    const rows = [];
    if (obs) {
      for (const s of obs.sent) rows.push({ ...s, kind: "sent" });
      for (const h of obs.heard) rows.push({ ...h, kind: "heard" });
      rows.sort((a, b) => a.tMs - b.tMs);
    }

    if (rows.length === 0) {
      hint.textContent =
        "CoreScope never reported this repeater relaying or hearing anything in this window. That isn't the same as it being deaf — a hop is only recorded when some observer reconstructs a path through it, so a working repeater nobody was watching looks exactly like this. Whatever our model predicts below is unconfirmed here, not contradicted.";
      list.innerHTML = '<div class="plan-empty">No observations of this repeater in the window.</div>';
      return;
    }
    hint.textContent = `${rows.length} real CoreScope observation${rows.length === 1 ? "" : "s"}, timed from the start of the window. These are measurements; everything below is our model's own simulation of the same window.`;
    for (const r of rows) {
      const offsetS = ((r.tMs - S.replayWindowStartMs) / 1000).toFixed(1);
      const row = document.createElement("div");
      row.className = "plan-list-item sim-list-item sim-packet-row sim-clean";
      const label = r.kind === "sent" ? "SENT" : "HEARD";
      const detail =
        r.kind === "sent"
          ? `relayed onward — ${r.count} confirmed recipient${r.count === 1 ? "" : "s"}`
          : `from ${escapeHtml(nodeLabel(r.from))}`;
      row.innerHTML = `
        <div class="sim-packet-row-top">
          <span class="sim-txrx-badge ${r.kind === "sent" ? "sim-txrx-relay" : "sim-txrx-rx"}">${label}</span>
          <span class="sim-node-badge sim-badge-observed">observed</span>
          <span class="plan-item-label">${escapeHtml(r.hash === S.replayTargetHash ? "the replayed packet" : `packet ${String(r.hash).slice(0, 8)}`)}</span>
        </div>
        <div class="sim-packet-row-bottom">
          <span class="sim-packet-context">${detail}</span>
          <span class="sim-packet-time">+${offsetS}s</span>
        </div>
      `;
      list.appendChild(row);
    }
  }

  function openPacketInspectorForNode(nodeIndex, mode = "fresh") {
    if (!S.lastReport) return;
    enterPacketModalView(mode, { kind: "node", nodeIndex });
    const n = S.simNodes[nodeIndex];
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
    // instant lands past the sim's own end — every such case
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
    // With a replay loaded, every figure above is a *prediction* — so put
    // what was actually observed at this repeater right beside it rather
    // than leaving the reader to assume the model's numbers are measurements.
    const obs = S.replayObservations.get(nodeIndex);
    if (S.replayObservations.size > 0) {
      stats.push({ label: "observed sending", value: obs ? obs.sent.length : 0 });
      stats.push({ label: "observed receiving", value: obs ? obs.heard.length : 0 });
    }
    renderStatStrip(document.getElementById("sim-packet-modal-summary"), stats);
    renderObservedSection(nodeIndex, obs);

    // The delivery checklist is a per-packet view (every node's status for
    // ONE packet) — doesn't apply here, where the packet is the varying
    // dimension instead.
    document.getElementById("sim-packet-modal-checklist-section").classList.add("hidden");

    document.getElementById("sim-packet-modal-received-title").textContent =
      S.replayObservations.size > 0 ? "Predicted activity — our model (TX/RX, time order)" : "Activity (TX/RX, time order)";
    resetPacketModalFilters();
    S.currentPacketModalEvents = events;
    S.currentPacketModalShowOpts = { showAt: false, drillTo: "packet", emptyHtml: nodeActivityEmptyExplanation(nodeIndex) };
    applyPacketModalFilters();
    openModal("sim-packet-modal");
  }

  // "Nothing to show." is a dead end when what you actually want to know is
  // *why* a repeater sat out the run — especially on a replay, where the
  // node set is now the whole loaded mesh rather than only the repeaters
  // reality already confirmed, so plenty of them legitimately have no
  // predicted activity at all. Answer the question in place instead.
  function nodeActivityEmptyExplanation(nodeIndex) {
    if (S.simLinks.length === 0) {
      return "No connectivity has been built for this node set yet, so nothing could propagate anywhere — build links, then run again.";
    }
    const inbound = S.simLinks.filter((l) => l.to === nodeIndex).length;
    const outbound = S.simLinks.filter((l) => l.from === nodeIndex).length;
    if (inbound === 0) {
      return outbound === 0
        ? "Our model gives this repeater no links at all — nothing else is within decodable range of it under the current propagation assumptions, so no flood could ever reach it. That's a statement about the model's assumptions (range, antenna heights, terrain), not proof the real repeater is isolated."
        : `Our model gives this repeater ${outbound} outgoing link${outbound === 1 ? "" : "s"} but no incoming ones, so nothing could arrive here to relay.`;
    }
    return `Our model puts this repeater within range of ${inbound} sender${inbound === 1 ? "" : "s"}, but no flood in this run actually reached it — it was either too many hops away, or every packet that could have arrived was stopped before it got here.`;
  }

  function openPacketDetails(packetId, mode = "fresh") {
    if (!S.lastMessages || !S.lastMessages[packetId]) return;
    enterPacketModalView(mode, { kind: "packet", packetId });
    const m = S.lastMessages[packetId];
    const origin = S.simNodes[m.origin];
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
    S.currentPacketModalEvents = buildPacketActivityEvents(packetId);
    S.currentPacketModalShowOpts = { showAt: true, drillTo: "node" };
    applyPacketModalFilters();
    openModal("sim-packet-modal");
  }

  function resetPacketModalFilters() {
    document.getElementById("sim-packet-filter-outcome").value = "";
    document.getElementById("sim-packet-filter-search").value = "";
  }

  function clearSentMessageSelection() {
    S.selectedPacketId = null;
    simMessagePathLayer.clearLayers();
    document.querySelectorAll(".sim-message-row-selected").forEach((el) => el.classList.remove("sim-message-row-selected"));
  }

  function selectSentMessage(packetId) {
    if (S.selectedPacketId === packetId) {
      clearSentMessageSelection();
      return;
    }
    S.selectedPacketId = packetId;
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
    if (S.selectedPacketId == null || !S.lastReport) return;
    for (const r of S.lastReport.receptions.filter((rec) => rec.packetId === S.selectedPacketId && matchesViewFilter(rec))) {
      const from = S.simNodes[r.fromNode];
      const to = S.simNodes[r.node];
      if (!from || !to) continue;
      const color = r.collided ? "#f87171" : "#4ade80";
      L.polyline([[from.lat, from.lon], [to.lat, to.lon]], { color, weight: r.collided ? 3 : 2, opacity: 0.85 }).addTo(simMessagePathLayer);
      L.circleMarker([to.lat, to.lon], { radius: 8, color, weight: 2, fillColor: color, fillOpacity: 0.5 }).addTo(simMessagePathLayer);
    }
  }

  // Tears a loaded packet replay all the way down. Everything a replay puts
  // on screen outlives the nodes it was built from otherwise: "Clear all"
  // used to leave the replay control docked on the map showing a frozen
  // "Playing… t=+6.0s (16/63)", its flood lines still drawn over an empty
  // map, and a Play button that would happily bring the seek bar back to
  // scrub a window whose repeaters no longer existed.
  //
  // Deliberately NOT what closing the simulator panel does — that keeps
  // realTimelineEvents so reopening restores the replay you were watching
  // (see setSimPanelOpen). This is for the paths that genuinely discard the
  // work: clearing the nodes, or loading a different setup over the top.
  function clearReplayState() {
    stopRealTimelineReplay();
    S.realTimelineEvents = [];
    S.replayObservations = new Map();
    S.replayWindowStartMs = 0;
    S.replayTargetHash = "";
    S.lastRealReplayStatusText = "";
    simRealActivityLayer.clearLayers();
    simProvenLayer.clearLayers();
    removeBottleneckLegendControl();
    const section = document.getElementById("sim-bottleneck-replay-section");
    if (section) section.classList.add("hidden");
    setStatus("sim-bottleneck-replay-status", "");
    setStatus("sim-replay-hash-status", "");
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
    episodeEvidenceLayer.clearLayers();
    S.replayWaves = [];
    S.replayIndex = 0;
    clearReplayState();
    S.lastReport = null;
    S.lastMessages = null;
    S.lastTuneResult = null;
    S.lastAttrsList = null;
    S.lastStressResult = null;
    S.lastPolicyResult = null;
    S.lastPolicyAltitudeAttrs = null;
    S.lastPolicyActions = [];
    S.lastPolicyProfiles = null;
    S.lastOptimizeDeviations = [];
    S.optimizeCancelled = true; // stop any in-flight optimize loop from rendering stale results
    clearTimeout(S.optimizeCancelTimeout);
    S.lastOptimizeSnapshot = [];
    document.getElementById("sim-policy-profile-detail").classList.add("hidden");
    document.getElementById("sim-policy-section").classList.add("hidden");
    document.getElementById("sim-optimize-section").classList.add("hidden");
    document.getElementById("sim-optimize-node-detail").classList.add("hidden");
    document.getElementById("sim-open-optimize-modal").classList.add("hidden");
    rebuildLinkIndexes(null);
    stopReplay();
    simResultsLayer.clearLayers(); // also removes every growth marker, since they live in this layer
    growthMarkers.clear();
    S.nodeGrowthCounts = [];
    S.currentWaveLines = [];
    clearSentMessageSelection();
    updateWorkflowState();
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
    // A lead-in instant one millisecond before the first event, so play
    // position 0 means "nothing has happened yet" and the replay starts from
    // an empty map. Without it the scrubber's zero sat exactly ON the first
    // event, and since CoreScope timestamps a whole observation to the
    // second, that could be a dozen hops already drawn before you'd pressed
    // play — which reads as the replay being broken rather than as a
    // simultaneous burst.
    if (uniq.length > 0) uniq.unshift(uniq[0] - 1);
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
    S.transportSource = source;
    S.transportWarp = source ? buildTimeWarp(source.times) : null;
    S.transportPlayMs = 0;
    S.transportLastSrcMs = null;
    const bar = transportEl("sim-transport");
    const hasTimeline = !!(source && S.transportWarp && source.times.length > 0);
    bar.classList.toggle("hidden", !hasTimeline);
    if (!hasTimeline) {
      syncBottomClearances();
      return;
    }
    const seek = transportEl("sim-transport-seek");
    seek.min = "0";
    // A single-instant timeline (every event at the same ms) has zero play
    // duration; give the scrubber a nonzero range so it isn't a dead control.
    seek.max = String(Math.max(1, Math.round(S.transportWarp.durationPlayMs)));
    seek.value = "0";
    transportEl("sim-transport-label").textContent = source.label || "";
    transportRender(false);
    syncBottomClearances();
  }

  function clearTransportSource() {
    transportPause();
    S.transportSource = null;
    S.transportWarp = null;
    S.transportLastSrcMs = null;
    transportEl("sim-transport").classList.add("hidden");
    syncBottomClearances();
  }

  // Draws the world at the current play position. `animate` is passed to the
  // source so it can pulse newly-crossed events while playing but stay silent
  // while scrubbing — dragging the bar across a hundred hops shouldn't fire a
  // hundred overlapping pulse animations.
  function transportRender(animate) {
    if (!S.transportSource || !S.transportWarp) return;
    const srcMs = playToSrc(S.transportWarp, S.transportPlayMs);
    const prev = animate && S.transportLastSrcMs != null && srcMs >= S.transportLastSrcMs ? S.transportLastSrcMs : null;
    S.transportSource.render(srcMs, prev);
    S.transportLastSrcMs = srcMs;
    const seek = transportEl("sim-transport-seek");
    if (document.activeElement !== seek) seek.value = String(Math.round(S.transportPlayMs));
    transportEl("sim-transport-time").textContent = S.transportSource.format(srcMs);
  }

  function transportFrame(ts) {
    if (!S.transportPlaying) return;
    const dt = S.transportLastFrameTs ? ts - S.transportLastFrameTs : 0;
    S.transportLastFrameTs = ts;
    // Clamp the frame delta so a backgrounded tab (which stops firing rAF)
    // doesn't resume by jumping the whole elapsed wall-clock at once.
    S.transportPlayMs += Math.min(250, dt) * S.transportRate;
    if (S.transportPlayMs >= S.transportWarp.durationPlayMs) {
      S.transportPlayMs = S.transportWarp.durationPlayMs;
      transportRender(true);
      transportPause();
      return;
    }
    transportRender(true);
    S.transportRaf = requestAnimationFrame(transportFrame);
  }

  function transportPlay() {
    if (!S.transportSource || !S.transportWarp) return;
    // Playing from the very end restarts, rather than sitting there doing
    // nothing — the common case after watching one through.
    if (S.transportPlayMs >= S.transportWarp.durationPlayMs) {
      S.transportPlayMs = 0;
      S.transportLastSrcMs = null;
      transportRender(false);
    }
    S.transportPlaying = true;
    S.transportLastFrameTs = 0;
    transportEl("sim-transport-play").textContent = "⏸";
    transportEl("sim-transport-play").setAttribute("aria-label", "Pause");
    S.transportRaf = requestAnimationFrame(transportFrame);
  }

  function transportPause() {
    S.transportPlaying = false;
    if (S.transportRaf) cancelAnimationFrame(S.transportRaf);
    S.transportRaf = null;
    const btn = transportEl("sim-transport-play");
    if (btn) {
      btn.textContent = "▶";
      btn.setAttribute("aria-label", "Play");
    }
  }

  function transportSeekTo(playMs) {
    if (!S.transportWarp) return;
    S.transportPlayMs = Math.max(0, Math.min(S.transportWarp.durationPlayMs, playMs));
    S.transportLastSrcMs = null; // a seek can go backwards, so always rebuild
    transportRender(false);
  }

  function transportToEnd() {
    if (!S.transportWarp) return;
    transportPause();
    transportSeekTo(S.transportWarp.durationPlayMs);
  }

  function transportRestart() {
    if (!S.transportWarp) return;
    transportSeekTo(0);
    transportPlay();
  }

    
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
      const n = S.simNodes[nodeIndex];
      if (!n) return null;
      marker = L.circleMarker([n.lat, n.lon], { radius: GROWTH_BASE_RADIUS, color: "rgb(100,116,139)", weight: 2, fillOpacity: 0.15, interactive: false }).addTo(simResultsLayer);
      growthMarkers.set(nodeIndex, marker);
    }
    return marker;
  }

  function growNode(nodeIndex) {
    S.nodeGrowthCounts[nodeIndex] = (S.nodeGrowthCounts[nodeIndex] || 0) + 1;
    const marker = ensureGrowthMarker(nodeIndex);
    if (!marker) return;
    const { color, radius } = growthColorAndRadius(S.nodeGrowthCounts[nodeIndex]);
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
    S.nodeGrowthCounts = [];
    for (const r of report.receptions) {
      if (!matchesGrowBy(r)) continue;
      S.nodeGrowthCounts[r.node] = (S.nodeGrowthCounts[r.node] || 0) + 1;
    }
    S.nodeGrowthCounts.forEach((count, nodeIndex) => {
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
      S.currentWaveLines.forEach((line) => simResultsLayer.removeLayer(line));
      S.currentWaveLines = [];
    }
    const from = S.simNodes[wave.fromNode];
    if (from) pulseAt([from.lat, from.lon], "#a855f7");
    for (const r of wave.receptions) {
      if (!matchesViewFilter(r)) continue;
      const to = S.simNodes[r.node];
      if (!from || !to) continue;
      const line = L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
      ).addTo(simResultsLayer);
      S.currentWaveLines.push(line);
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
    if (!S.lastReport) return;
    // No waves built yet (a report exists but Replay was never started —
    // startReplay is what populates replayWaves) means there's no "most
    // recent wave" to narrow down to, so the accumulated view is the only
    // meaningful one regardless of the toggle. Without this, unticking
    // Keep all paths in that state would blank the map entirely.
    if (S.replayWaves.length === 0) {
      redrawResultLines(S.lastReport);
      S.currentWaveLines = [];
      growthMarkers.clear();
      applyFinalGrowth(S.lastReport);
      return;
    }
    const finished = S.replayIndex >= S.replayWaves.length;

    if (simViewMode.keepAllPaths) {
      if (finished) {
        redrawResultLines(S.lastReport);
        S.currentWaveLines = [];
        growthMarkers.clear();
        applyFinalGrowth(S.lastReport);
        return;
      }
      // Mid-replay: accumulate everything played SO FAR (waves
      // 0..replayIndex-1), not the whole report — the run hasn't got to
      // the rest yet, and showing it would be a different view than the
      // one being watched.
      renderWaveRange(0, S.replayIndex);
      return;
    }

    // !keepAllPaths — only the most recently played wave stays on screen.
    // Nothing has played yet (replayIndex 0, replay not started) means
    // there's no "most recent wave"; a finished replay's most recent one
    // is the last.
    const lastPlayed = finished ? S.replayWaves.length - 1 : S.replayIndex - 1;
    if (lastPlayed < 0) {
      simResultsLayer.clearLayers();
      S.currentWaveLines = [];
      growthMarkers.clear();
      S.nodeGrowthCounts = [];
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
    S.currentWaveLines = [];
    growthMarkers.clear();
    S.nodeGrowthCounts = [];
    for (let i = startIndex; i < endIndex; i++) {
      const wave = S.replayWaves[i];
      if (!wave) continue;
      const from = S.simNodes[wave.fromNode];
      if (!from) continue;
      for (const r of wave.receptions) {
        if (!matchesViewFilter(r)) continue;
        const to = S.simNodes[r.node];
        if (!to) continue;
        const line = L.polyline(
          [
            [from.lat, from.lon],
            [to.lat, to.lon],
          ],
          { color: r.collided ? "#f87171" : "#4ade80", weight: r.collided ? 3 : 2, opacity: 0.85 }
        ).addTo(simResultsLayer);
        S.currentWaveLines.push(line);
        if (matchesGrowBy(r)) growNode(r.node);
      }
    }
  }

  // How many waves have happened by srcMs. replayWaves is sorted by atMs,
  // so this is a binary search — it runs on every animation frame.
  function countWavesUpTo(srcMs) {
    let lo = 0;
    let hi = S.replayWaves.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (S.replayWaves[mid].atMs <= srcMs) lo = mid + 1;
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
      times: S.replayWaves.map((w) => w.atMs),
      format: (srcMs) => {
        const k = countWavesUpTo(srcMs);
        return `t=${Math.max(0, Math.round(srcMs))}ms · ${k}/${S.replayWaves.length}`;
      },
      render: (srcMs, prevSrcMs) => {
        const k = countWavesUpTo(srcMs);
        if (prevSrcMs != null) {
          const prevK = countWavesUpTo(prevSrcMs);
          if (k === prevK) return; // nothing new happened this frame
          // playWave already honours keepAllPaths (clearing the previous
          // wave's lines when it's off), so this one path covers both views.
          for (let i = prevK; i < k; i++) playWave(S.replayWaves[i]);
          S.replayIndex = k;
          setReplayStatus(k >= S.replayWaves.length ? "Replay finished — showing final state." : `Playing… t=${S.replayWaves[k - 1].atMs}ms (${k}/${S.replayWaves.length})`);
          updateMapLiveStats(k);
          return;
        }
        // Seek (or first render): rebuild from scratch. redrawPathsForKeep-
        // AllPaths reads replayIndex to decide what "now" means, so set it
        // first — it's the same function the Keep-all-paths toggle uses, which
        // keeps scrubbing and toggling in perfect agreement about what should
        // be on screen.
        S.replayIndex = k;
        if (S.lastReport) redrawPathsForKeepAllPaths();
        else {
          simResultsLayer.clearLayers();
          growthMarkers.clear();
          S.currentWaveLines = [];
          S.nodeGrowthCounts = [];
        }
        setReplayStatus(
          S.replayWaves.length === 0 ? "" : k >= S.replayWaves.length ? "Showing final state." : `t=${Math.round(srcMs)}ms (${k}/${S.replayWaves.length})`
        );
        updateMapLiveStats(k);
      },
    };
  }

  function stopReplay() {
    transportPause();
  }

  function startReplay() {
    S.replayWaves = S.lastReport ? buildWaves(S.lastReport) : [];
    S.replayIndex = 0;
    simResultsLayer.clearLayers();
    growthMarkers.clear();
    S.nodeGrowthCounts = [];
    S.currentWaveLines = [];
    if (S.replayWaves.length === 0) {
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
    if (S.replayWaves.length === 0 && S.lastReport) {
      S.replayWaves = buildWaves(S.lastReport);
      if (S.replayWaves.length > 0) setTransportSource(simTransportSource());
    }
    if (!S.transportSource || S.transportSource.kind !== "sim") {
      if (S.replayWaves.length > 0) setTransportSource(simTransportSource());
    }
    if (S.replayWaves.length === 0) {
      simResultsLayer.clearLayers();
      growthMarkers.clear();
      S.currentWaveLines = [];
      S.nodeGrowthCounts = [];
      setReplayStatus("");
      return;
    }
    transportToEnd();
    setReplayStatus("Showing final state.");
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

  
  async function ensureNodeDirectory() {
    if (S.nodeDirectoryCache) return S.nodeDirectoryCache;
    const resp = await fetch(`${MeshApi.BASE}/nodes?limit=5000`);
    if (!resp.ok) throw new Error(`CoreScope node directory fetch failed: HTTP ${resp.status}`);
    const data = await resp.json();
    S.nodeDirectoryCache = new Map();
    for (const n of data.nodes || []) {
      if (n.lat == null || n.lon == null || !n.public_key) continue; // can't place a node with no known position
      S.nodeDirectoryCache.set(n.public_key.toLowerCase(), { name: n.name || n.public_key.slice(0, 8), lat: n.lat, lon: n.lon, role: n.role });
    }
    return S.nodeDirectoryCache;
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
  // Shared by both replay entry points ("🔗 Replay" onto the current
  // workspace and "🏗️ Reconstruct window"): classifies every observer's
  // state at the target's transit from the ±liveness activity span.
  // See public/evidence.js and docs/REPLAY_NEGATIVE_EVIDENCE_PLAN.md.
  function buildObserverEvidence({ detail, targetMs, hash, liveness }) {
    const radioDefaults = self.HopReachMeshModel.defaultPrefs().radio;
    // frame_bytes is the whole on-air frame as the backend measured it.
    // A backend that can't say omits it, hence the fallback — a zero here
    // would mean "instantaneous transmission", which is worse than a guess.
    const airOf = (frameBytes, fallbackBytes) =>
      HopReachEvidence.loraAirtimeMs(frameBytes || fallbackBytes || 24, radioDefaults.sf, radioDefaults.bwKhz, radioDefaults.cr);
    const observerNames = new Map();
    for (const lp of liveness) {
      const oid = (lp.observer_id || "").toLowerCase();
      if (oid && !observerNames.has(oid)) observerNames.set(oid, lp.observer_name || oid.slice(0, 8));
    }
    for (const o of detail.observations || []) {
      const oid = (o.observer_id || "").toLowerCase();
      if (oid && !observerNames.has(oid)) observerNames.set(oid, o.observer_name || oid.slice(0, 8));
    }
    const evidenceEvents = [];
    for (const lp of liveness) {
      const tMs = Date.parse(lp.timestamp);
      if (Number.isNaN(tMs)) continue;
      const air = airOf(lp.frame_bytes);
      const oid = (lp.observer_id || "").toLowerCase();
      if (oid) evidenceEvents.push({ observerId: oid, tMs, airtimeMs: air, hash: lp.hash, kind: "rx" });
      for (const relay of lp.resolved_path || []) {
        const rk = (relay || "").toLowerCase();
        if (rk && observerNames.has(rk)) evidenceEvents.push({ observerId: rk, tMs, airtimeMs: air, hash: lp.hash, kind: "relay" });
      }
    }
    const heardIds = new Set((detail.observations || []).map((o) => (o.observer_id || "").toLowerCase()).filter(Boolean));
    const evidenceMap = HopReachEvidence.classifyObservers({
      targetMs,
      targetAirtimeMs: airOf(detail.packet && detail.packet.frame_bytes, 105),
      targetHash: hash,
      heardObserverIds: heardIds,
      events: evidenceEvents,
    });
    return {
      observerNames,
      observerEvidence: [...evidenceMap.entries()].map(([pubkey, v]) => ({ pubkey, name: observerNames.get(pubkey) || pubkey.slice(0, 8), state: v.state, reason: v.reason })),
    };
  }

  // Locates any historical time window with an offset binary search over the
  // timestamp-sorted list (about twenty 1-row probes), then pages the window
  // out — bounded cost for ANY packet age, unlike the old newest-first
  // limit-doubling which silently truncated at REAL_TIMELINE_MAX_LIMIT for
  // packets deep in the history. livenessMs additionally returns the wider
  // span the observer-evidence classification needs (who was provably alive
  // around the target), without making the reconstruction window itself any
  // bigger.
  // Packets around a moment, plus a wider slice for observer liveness.
  //
  // Was ~80 lines of backwards `offset` binary search with a legacy fallback,
  // because CoreScope has no time filter. The mesh API takes a time range, so
  // this is now two straight requests — and on a backend that filters
  // server-side (Beacon) they are genuinely cheap.
  async function fetchPacketsAroundTime(targetMs, windowMs, livenessMs) {
    const liveHalf = Math.max(windowMs, livenessMs || 0);
    const liveness = await MeshApi.packetsBetween(
      targetMs - liveHalf, targetMs + liveHalf, REAL_TIMELINE_MAX_LIMIT);
    const inWindow = liveness.filter((p) => {
      const t = Date.parse(p.timestamp);
      return !Number.isNaN(t) && t >= targetMs - windowMs && t <= targetMs + windowMs;
    });
    // hitCap: the backend returned exactly as many rows as we allowed, so the
    // oldest edge of the window may be truncated. Callers surface this rather
    // than presenting partial coverage as complete.
    return {
      packets: inWindow,
      liveness,
      hitCap: liveness.length >= REAL_TIMELINE_MAX_LIMIT,
    };
  }

  // The origin (true sender) of a real packet, lowercased, if identifiable —
  // only ADVERTs self-identify (their decoded pubKey). Everything else's true
  // origin is one hop upstream of the first observed relay and not in the
  // data, so callers fall back to the first observed relay.
  function originPubkeyOfPacket(p) {
    try {
      const dec = JSON.parse(p.decoded_json || "{}");
      if (dec.pubKey) return String(dec.pubKey).toLowerCase();
    } catch {
      /* not decodable — fall through */
    }
    return null;
  }

  // Region decoding is the backend's job now (internal/corescope's
  // RegionOfPacket, or a backend like Beacon that simply reports the scope).
  // The browser used to do it itself, which meant a hand-rolled SHA-256 here
  // because SubtleCrypto is undefined off a secure context. These two read
  // what the API already decoded.

  // carriesTransportCode reports whether a packet has a transport code at
  // all — route types 0/3. A plain flood is genuinely unscoped, which is a
  // different fact from "scoped, but we couldn't name the region".
  function carriesTransportCode(p) {
    return p && (p.route_type === 0 || p.route_type === 3);
  }

  // regionOfPacket prefers the real decoded region name. A transport-coded
  // packet whose region we can't name still needs a non-empty marker so the
  // engine adds its 4 transport-code bytes to the airtime; the reconstructed
  // nodes all hold the "*" wildcard, so this never gates relaying.
  function regionOfPacket(p) {
    if (p && p.scope) return p.scope;
    return carriesTransportCode(p) ? "scoped" : "";
  }

  // Every real flood in the window, as simulator messages — real origin,
  // real payload/hash size, and its real time offset from the start of the
  // window as its send time.
  //
  // This is what makes the replay's predicted side a genuine simulation
  // rather than a geometric guess. It used to run one packet from one
  // origin, and "predicted" elsewhere meant a raw fan of every link out of a
  // real sender — which can say "in earshot" but can't say received,
  // relayed, collided, or dropped, because nothing was actually simulated.
  // Feeding the whole window through the engine means the predicted half of
  // the replay is the same thing a normal run produces, with the same
  // outcomes and the same vocabulary.
  //
  // Sim time lines up with real time by construction (sendAtMs is the offset
  // from the window's start), so predicted events and real observations are
  // directly comparable rather than living on two unrelated clocks.
  //
  // Only route types 0/1 — our model relays floods, not addressed traffic
  // (see the isDirect note in replayFromHash).
  async function buildWindowFloodMessages(windowPackets, pubkeyToIndex, windowStartMs) {
    // The live API returns one row per packet (verified); dedupe by hash
    // anyway so a per-observation-row instance can't multiply sends.
    const byHash = new Map();
    for (const p of windowPackets) {
      if (p.route_type !== 0 && p.route_type !== 1) continue;
      const tMs = Date.parse(p.timestamp);
      if (Number.isNaN(tMs)) continue;
      const prev = byHash.get(p.hash);
      if (!prev || tMs < prev.tMs) byHash.set(p.hash, { p, tMs });
    }
    const msgs = [];
    for (const { p, tMs } of byHash.values()) {
      // Only an advert self-identifies its true origin; for everything else
      // the first resolved hop is the earliest point in the path we can
      // actually place on the map.
      const chain = (p.resolved_path || []).filter(Boolean);
      const originKey = originPubkeyOfPacket(p) || (chain.length ? chain[0].toLowerCase() : null);
      if (!originKey) continue;
      const origin = pubkeyToIndex.get(originKey);
      if (origin == null) continue;
      msgs.push({
        origin,
        sendAtMs: Math.max(0, tMs - windowStartMs),
        payloadLen: p.payload_len || 20,
        hashSize: p.hash_size || DEFAULT_MESSAGE_HASH_SIZE,
        // Real ScotMesh traffic is overwhelmingly scoped (TRANSPORT_FLOOD).
        // Replaying it untagged made every repeater that doesn't relay
        // unscoped traffic refuse the lot — a whole window of "Region
        // mismatch — not relayed" that says nothing about the real network,
        // only about our having thrown the region away.
        region: p.scope || "",
        sourceHash: p.hash,
      });
    }
    msgs.sort((a, b) => a.sendAtMs - b.sendAtMs);
    return msgs;
  }

  // Reconstructs the real CoreScope time window around the packet in the
  // replay input as a fully editable simulator setup: real repeaters at
  // their real positions, connectivity from the
  // real proven relay edges observed in the window, and every real packet as
  // either a flood sender (real payload/hash size) or — for direct/channel/
  // anon traffic we don't route — a fixed background transmission that still
  // loads the channel. After this, the user tweaks settings or runs the
  // optimizer and re-runs to see whether the real problems shrink.
  // the rest of the model's predicted reach out from the same sender.


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
  
  const MODAL_FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

  function openModal(id) {
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    const modal = document.getElementById(id);
    modal.classList.remove("hidden");
    document.getElementById("sim-modal-backdrop").classList.remove("hidden");
    S.modalReturnFocusEl = document.activeElement;
    const firstFocusable = modal.querySelector(MODAL_FOCUSABLE_SELECTOR);
    (firstFocusable || modal).focus({ preventScroll: true });
  }

  function closeModals() {
    document.getElementById("sim-modal-backdrop").classList.add("hidden");
    document.querySelectorAll(".sim-modal").forEach((m) => m.classList.add("hidden"));
    if (S.modalReturnFocusEl && document.body.contains(S.modalReturnFocusEl)) S.modalReturnFocusEl.focus({ preventScroll: true });
    S.modalReturnFocusEl = null;
  }

  // Escape either pops one level of the packet inspector's own node<->packet
  // drill history (mirroring "← Back", since that history exists precisely
  // so a user can back out of a detour without losing their place) or, with
  // nothing to pop, closes the modal outright.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.getElementById("sim-modal-backdrop").classList.contains("hidden")) return;
    if (S.packetModalHistory.length > 0) goBackPacketModal();
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
  
  function ensureSimViewControl() {
    if (S.simViewControl) return;
    S.simViewControl = L.control({ position: "topright" });
    S.simViewControl.onAdd = function () {
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
        // Leaves a loaded packet replay alone: it accumulates its window by
        // design, and this used to wipe the analysis overlay it had drawn.
        if (S.transportSource && S.transportSource.kind === "real") return;
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
        // Whichever replay the transport is actually driving is the one that
        // has to re-render — filtering only ever touched the simulation's
        // layer, so changing it while watching a packet replay appeared to
        // do nothing at all.
        if (S.transportSource && S.transportSource.kind === "real") {
          transportSeekTo(S.transportPlayMs);
        } else if (S.lastReport && S.replayIndex >= S.replayWaves.length) {
          redrawPathsForKeepAllPaths();
        }
        drawSelectedMessagePath();
      });
      div.querySelector("#sim-view-grow-by").addEventListener("change", (e) => {
        simViewMode.growBy = e.target.value;
        growthMarkers.forEach((marker) => simResultsLayer.removeLayer(marker));
        growthMarkers.clear();
        S.nodeGrowthCounts = [];
        if (S.lastReport) applyFinalGrowth(S.lastReport);
      });
      return div;
    };
    S.simViewControl.addTo(map);
  }

  function removeSimViewControl() {
    if (S.simViewControl) {
      map.removeControl(S.simViewControl);
      S.simViewControl = null;
    }
  }

  // --- map-docked live run stats -------------------------------------
  //
  // Used to be Replay/Skip-to-end buttons plus a full reception-log copy —
  // both fully superseded once the shared scrub/play/pause transport
  // (setTransportSource) landed: that bar already plays, pauses and seeks
  // (dragging to the end IS "skip to end"), the Results modal has its own
  // Replay/Skip-to-end buttons for driving it from there, and the modal's
  // own reception log already shows the same rows this used to duplicate.
  // Found still sitting on the map doing nothing anyone was using — see
  // the git history for this comment.
  //
  // Repurposed into something the transport bar doesn't cover: a live
  // running tally (received/collided/delivery so far) that advances in
  // step with the scrubber, so watching a replay answers "is this actually
  // going well" without opening the modal that would cover the map you're
  // watching it play out on.
  
  function ensureSimPlaybackControl() {
    if (S.simPlaybackControl) return;
    S.simPlaybackControl = L.control({ position: "bottomleft" });
    S.simPlaybackControl.onAdd = function () {
      const div = L.DomUtil.create("div", "sim-playback-control");
      div.innerHTML = `
        <div class="map-control-header-static">Run so far</div>
        <div id="sim-map-live-stats" class="sim-stat-strip sim-stat-strip-compact"></div>
      `;
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    S.simPlaybackControl.addTo(map);
    updateMapLiveStats(0);
  }

  function removeSimPlaybackControl() {
    if (S.simPlaybackControl) {
      map.removeControl(S.simPlaybackControl);
      S.simPlaybackControl = null;
    }
  }

  // wavesPlayed is how many waves the transport has revealed so far (see
  // simTransportSource's own countWavesUpTo) — flattening exactly those
  // waves' own receptions, rather than reading the full report, is what
  // makes this track the scrubber instead of jumping straight to the final
  // tally the instant a run finishes.
  function updateMapLiveStats(wavesPlayed) {
    const el = document.getElementById("sim-map-live-stats");
    if (!el) return;
    const receptions = S.replayWaves.slice(0, wavesPlayed).flatMap((w) => w.receptions);
    const collided = receptions.filter((r) => r.collided).length;
    const total = receptions.length;
    const rate = total > 0 ? (collided / total) * 100 : 0;
    renderStatStrip(el, [
      // "receptions" (not "received") — same word the Results modal's own
      // stat strip uses for this exact total-including-collided count, see
      // renderResults, so the two never imply different things for the
      // same number.
      { label: "receptions", value: total },
      { label: "collided", value: collided, tone: rate >= 30 ? "bad" : "" },
    ]);
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

  // --- module wiring ---
  //
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
    DEFAULT_MESSAGE_HASH_SIZE, episodeEvidenceLayer, map,
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
    DEFAULT_MESSAGE_HASH_SIZE, isCanonicalDelivery, simProvenLayer, simRealActivityLayer,
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
    CORESCOPE_REACH_DAYS, SF_THRESHOLDS_DB, SIM_MAX_RANGE_KM, SIM_ZOOM_CAP, cfg,
  });

  // Every extracted feature module is initialised here, after the top-level
  // consts exist. Helpers are passed as arrow wrappers so they resolve at
  // call time, which keeps the order of these calls irrelevant even between
  // modules that call into each other.

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
