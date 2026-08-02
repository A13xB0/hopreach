// Saved setups: everything needed to get back to 'ready to run' — nodes, their settings overrides, the built links, senders and run controls — stored client-side, plus import/export as a standalone file.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimSetups = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let clearNodes, hideResults, randomId, redrawNodeMarkers, renderMessageList, renderMessageNodeOptions, renderNodeList, setStatus;

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


  function init(context) {
    ({ clearNodes, hideResults, randomId, redrawNodeMarkers, renderMessageList, renderMessageNodeOptions, renderNodeList, setStatus } = context);
    return api;
  }

  const api = {
    init,
    deleteCurrentSetup,
    exportCurrentSetup,
    importSetupFromFile,
    loadAllSetups,
    loadSetup,
    newSetup,
    refreshSetupSelect,
    saveCurrentSetup,
  };
  return api;
});
