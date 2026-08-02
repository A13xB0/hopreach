// Getting nodes into the workspace: loading planned repeaters or real observed ones, placing companions and repeaters by hand, and renaming/removing/clearing them.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimNodes = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let generatedShortAddress, hideResults, map, randomId, redrawNodeMarkers, renderMessageList, renderMessageNodeOptions, renderNodeList, setStatus, shortAddressFromPubkey, updateWorkflowState;

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


  // Click-to-place. Bound here rather than at module load: `map` arrives with
  // the context, so at load time there is nothing to bind to.
  function bindPlacement() {
    map.on("click", (e) => {
      if (S.placementMode === "companion") {
        addCompanionAt(e.latlng.lat, e.latlng.lng);
      } else if (S.placementMode === "repeater") {
        addPlacedRepeaterAt(e.latlng.lat, e.latlng.lng);
      }
    });
  }

  function init(context) {
    ({ generatedShortAddress, hideResults, map, randomId, redrawNodeMarkers, renderMessageList, renderMessageNodeOptions, renderNodeList, setStatus, shortAddressFromPubkey, updateWorkflowState } = context);
    bindPlacement();
    return api;
  }

  const api = {
    init,
    clearNodes,
    filterRepeatersAliveAt,
    initSimScopeFilter,
    invalidateLinks,
    loadPlannedRepeaters,
    loadRealRepeaters,
    removeNode,
    renameNode,
    setPlacementMode,
  };
  return api;
});
