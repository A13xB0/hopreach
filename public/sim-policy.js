// Settings prediction: the single-rule 'predict settings' search, the offered-load stress sweep, and the composite policy search with its per-repeater action list.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimPolicy = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let applyPolicyToNodeState, applyRule, attrsFromState, computeTopologyAttrsJs, defaultPrefs, effectiveFloodMax, effectivePrefsFor, ensureGrid, ensurePredictWorker, escapeHtml, hidePredictProgress, hideStressProgress, messagesFromState, nodesSortedByLabel, openModal, ruleMatchesAttrs, scenarioFromState, setPredictProgress, setStatus, setStressProgress;

  async function predictSettings() {
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
    const grid = await ensureGrid(S.simNodes).catch(() => null);
    const attrs = attrsFromState(S.simNodes, grid);

    const generation = ++S.predictGeneration;
    const worker = ensurePredictWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.generation !== generation) return;
      if (generation !== S.predictGeneration) {
        // A newer search superseded this one — detach silently instead of
        // re-enabling buttons / popping stale results over the live search
        // (SIMULATION_REVIEW.md B5).
        worker.removeEventListener("message", onMessage);
        return;
      }
      if (msg.type === "suggest-progress") {
        setPredictProgress(msg.done, msg.total);
      } else if (msg.type === "suggest-result") {
        worker.removeEventListener("message", onMessage);
        hidePredictProgress();
        document.getElementById("sim-predict").disabled = false;
        S.lastTuneResult = msg.result;
        S.lastAttrsList = attrs;
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
    if (S.simNodes.length === 0) {
      setStatus("sim-status", "Load some nodes first.");
      return;
    }
    if (S.simLinks.length === 0) {
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

    const generation = ++S.predictGeneration; // shares the worker + its generation guard with predictSettings — only one search of either kind is ever live at once
    const worker = ensurePredictWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.generation !== generation) return;
      if (generation !== S.predictGeneration) {
        // A newer search superseded this one — detach silently instead of
        // re-enabling buttons / popping stale results over the live search
        // (SIMULATION_REVIEW.md B5).
        worker.removeEventListener("message", onMessage);
        return;
      }
      if (msg.type === "stress-progress") {
        setStressProgress(msg.done, msg.total);
      } else if (msg.type === "stress-result") {
        worker.removeEventListener("message", onMessage);
        hideStressProgress();
        document.getElementById("sim-stress-run").disabled = false;
        S.lastStressResult = msg.result;
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
      const matches = ruleMatchesAttrs(best.rule, attrsList[i], i);
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

        
  async function runSuggestPolicy() {
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
    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    const trials = Math.min(100, Math.max(1, parseInt(document.getElementById("sim-trials").value, 10) || 20));
    setStatus("sim-status", "Searching policies (topology + delay models)…");
    setPredictProgress(0, 1);
    document.getElementById("sim-suggest-policy").disabled = true;

    const grid = await ensureGrid(S.simNodes).catch(() => null);
    const attrs = attrsFromState(S.simNodes, grid); // only altitudeM is actually read server-side — see PolicyTuneRequest's own doc comment
    S.lastPolicyAltitudeAttrs = attrs;

    const generation = ++S.predictGeneration; // shares the same worker + generation guard as predictSettings/runStressTest
    const worker = ensurePredictWorker();

    function onMessage(e) {
      const msg = e.data;
      if (msg.generation !== generation) return;
      if (generation !== S.predictGeneration) {
        // A newer search superseded this one — detach silently instead of
        // re-enabling buttons / popping stale results over the live search
        // (SIMULATION_REVIEW.md B5).
        worker.removeEventListener("message", onMessage);
        return;
      }
      if (msg.type === "suggest-policy-progress") {
        setPredictProgress(msg.done, msg.total);
      } else if (msg.type === "suggest-policy-result") {
        worker.removeEventListener("message", onMessage);
        hidePredictProgress();
        document.getElementById("sim-suggest-policy").disabled = false;
        S.lastPolicyResult = msg.result;
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
    S.lastOptimizeDeviations = [];
    S.lastOptimizeSnapshot = [];
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
    async function meshMethodByName(name) {
    if (!S.meshMethodsCache) {
      await MeshSim.ready;
      S.meshMethodsCache = MeshSim.meshMethods();
    }
    return S.meshMethodsCache.find((m) => m.name === name) || null;
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
    S.lastPolicyProfiles = null;
    if (S.simNodes.length === 0) return;

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
    S.lastPolicyProfiles = groups;

    // "Nothing silently dropped" check — every loaded repeater must land
    // in exactly one group,
    // including "No profile."
    const totalGrouped = Array.from(groups.values()).reduce((sum, arr) => sum + arr.length, 0);
    if (totalGrouped !== S.simNodes.length) {
      console.error(`Policy profile breakdown: grouped ${totalGrouped} of ${S.simNodes.length} loaded repeaters — some were dropped. This is a bug.`);
    }

    // "No profile" last; everything else in the order it first appears
    // among the assignments, which follows the policy's own rule order —
    // reads the way the policy itself was written, not alphabetically.
    const orderedLabels = Array.from(groups.keys()).sort((a, b) => (a === "No profile" ? 1 : b === "No profile" ? -1 : 0));

    orderedLabels.forEach((label) => {
      const nodes = groups.get(label);
      const sampleAttrs = attrsArray[nodes[0].nodeIndex];
      const { prefs } = applyPolicyToNodeState(defaultPrefs(), 0, best.policy, sampleAttrs, nodes[0].nodeIndex);
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
    if (!S.lastPolicyProfiles || !S.lastPolicyProfiles.has(label)) return;
    const nodes = S.lastPolicyProfiles.get(label);
    const attrsArray = attrsArrayForPolicy();

    document.getElementById("sim-policy-profile-detail").classList.remove("hidden");
    document.getElementById("sim-policy-profile-detail-title").textContent = `${label} — ${nodes.length} repeater${nodes.length === 1 ? "" : "s"}`;

    const list = document.getElementById("sim-policy-profile-detail-list");
    list.innerHTML = "";
    nodes.forEach(({ nodeIndex, others }) => {
      const n = S.simNodes[nodeIndex];
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
    return S.simNodes.map((n, i) => ({
      altitudeM: (S.lastPolicyAltitudeAttrs && S.lastPolicyAltitudeAttrs[i] && S.lastPolicyAltitudeAttrs[i].altitudeM) || 0,
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
    S.simNodes.forEach((n, i) => {
      const attrs = attrsArray[i];
      const { prefs: recPrefs, floodMax: recFloodMax } = applyPolicyToNodeState(defaultPrefs(), 0, best.policy, attrs, i);
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

    S.lastPolicyActions = actions;
    const actionsList = document.getElementById("sim-policy-actions-list");
    actionsList.innerHTML = "";
    if (actions.length === 0) {
      actionsList.innerHTML = `<div class="plan-hint">No changes — every repeater the policy covers is already at the recommended settings; ${S.simNodes.length} repeater${S.simNodes.length === 1 ? "" : "s"} left untouched.</div>`;
      return;
    }
    const untouched = S.simNodes.length - actions.length;
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
    if (S.lastPolicyActions.length === 0) {
      setStatus("sim-status", "Nothing to export — no repeater needs a change under the current best policy.");
      return;
    }
    const rows = [["Repeater", "Change", "CLI command"]];
    for (const { label, changed } of S.lastPolicyActions) {
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

  function init(context) {
    ({ applyPolicyToNodeState, applyRule, attrsFromState, computeTopologyAttrsJs, defaultPrefs, effectiveFloodMax, effectivePrefsFor, ensureGrid, ensurePredictWorker, escapeHtml, hidePredictProgress, hideStressProgress, messagesFromState, nodesSortedByLabel, openModal, ruleMatchesAttrs, scenarioFromState, setPredictProgress, setStatus, setStressProgress } = context);
    return api;
  }

  const api = {
    init,
    exportPolicyActionsCsv,
    predictSettings,
    runStressTest,
    runSuggestPolicy,
  };
  return api;
});
