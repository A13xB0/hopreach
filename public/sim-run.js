// Turning the workspace into a scenario the engine can run: resolving each node's effective settings, building the message set, running a simulation, and rendering its results.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimRun = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { DEFAULT_MESSAGE_HASH_SIZE, DEFAULT_LOOP_DETECT, RADIO_PRESETS, LONG_LIST_ROW_CAP } = window.SimConstants;

  let canRelay, ensureSimPlaybackControl, escapeHtml, rebuildLinkIndexes, renderEpisodeAnalysis, renderRankings, renderSentMessagesList, setStatus, startReplay, updateWorkflowState;

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


  function init(context) {
    ({ canRelay, ensureSimPlaybackControl, escapeHtml, rebuildLinkIndexes, renderEpisodeAnalysis, renderRankings, renderSentMessagesList, setStatus, startReplay, updateWorkflowState } = context);
    return api;
  }

  const api = {
    init,
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
  };
  return api;
});
