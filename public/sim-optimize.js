// The adaptive optimizer: running bounded search rounds against the engine, showing per-repeater deviations, and exporting them as settings a human can actually apply.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimOptimize = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let ensurePredictWorker, escapeHtml, messagesFromState, openModal, scenarioFromState, setStatus, workerRequest;

  // --- adaptive optimizer -------------------------------------------------
  //
  // Slowly adjusts from seeing collisions and contention on specific
  // repeaters until they disappear —
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
  // Max rounds / stale-rounds-limit are user-settable
  // (#sim-optimize-max-rounds/#sim-optimize-stale-limit) rather than
  // hardcoded here — see
  // roundBudgetField and runOptimizeAdaptive.
  const OPTIMIZE_MIN_IMPROVEMENT = 0.5;
  const OPTIMIZE_DELIVERY_TOLERANCE = 0.005;
  // How long Cancel waits for the in-flight round to finish gracefully
  // before force-terminating the worker outright: terminate() is the hard
  // stop, graceful-then-forced rather than either/or. This is exactly what
  // makes "unlimited rounds" safe to offer at all — see that
  // field's own doc comment on internal/meshsim.OptimizeRequest.
  const OPTIMIZE_CANCEL_FORCE_TIMEOUT_MS = 8000;

  // Reads a "0/blank means unlimited" round-budget field — deliberately a distinct
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
    if (!S.lastPolicyResult || !S.lastPolicyResult.suggestions || S.lastPolicyResult.suggestions.length === 0) {
      setStatus("sim-status", 'Run "Search policies" first — the optimizer starts from its own best result rather than searching from nothing.');
      return;
    }

    const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
    const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
    const trials = Math.min(100, Math.max(1, parseInt(document.getElementById("sim-trials").value, 10) || 20));
    const maxRoundsField = roundBudgetField("sim-optimize-max-rounds");
    const staleLimitField = roundBudgetField("sim-optimize-stale-limit");
    const allowFloodMax = document.getElementById("sim-optimize-allow-floodmax").checked;
    // Tier 2/3 — each independent, off by
    // default, matching the Go side's own opt-in defaults exactly.
    const adaptiveTrials = document.getElementById("sim-optimize-adaptive-trials").checked;
    const lateAcceptance = document.getElementById("sim-optimize-late-acceptance").checked;
    const spsaWarmStart = document.getElementById("sim-optimize-spsa-warmstart").checked;
    const learnedWeights = document.getElementById("sim-optimize-learned-weights").checked;

    const optimizeRequest = {
      scenario: scenarioFromState(),
      messages: messagesFromState(seed),
      attrs: S.lastPolicyAltitudeAttrs || [],
      basePolicy: S.lastPolicyResult.suggestions[0].policy,
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
      // txdelay/rxdelay are
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

    S.optimizeCancelled = false;
    const generation = ++S.predictGeneration;
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
        if (generation !== S.predictGeneration) return; // superseded by a newer search/optimize run
        setOptimizeProgress(state);
        if (state.done || S.optimizeCancelled) break;
      }

      setStatus("sim-status", S.optimizeCancelled ? "Cancelled — validating the best result found so far…" : "Validating…");
      const holdout = await workerRequest(
        worker,
        generation,
        { kind: "optimize-validate", generation, optimizeRequest, policy: state.currentPolicy },
        "optimize-validate-result",
        "optimize-validate-error"
      );
      if (generation !== S.predictGeneration) return;
      renderOptimizeResult(state, holdout, S.optimizeCancelled, optimizeRequest);
      openModal("sim-optimize-modal");
      setStatus("sim-status", "Done.");
    } catch (err) {
      if (generation === S.predictGeneration) {
        setStatus("sim-status", `Optimization failed: ${err.message || err}`);
      }
    } finally {
      if (generation === S.predictGeneration) {
        clearTimeout(S.optimizeCancelTimeout);
        document.getElementById("sim-optimize-adaptive").disabled = false;
        document.getElementById("sim-optimize-cancel").classList.add("hidden");
        hideOptimizeProgress();
      }
    }
  }

  // Graceful-then-forced cancellation — both, not either/or.
  // Setting optimizeCancelled lets
  // the CURRENT in-flight round finish normally and the loop above exit
  // cleanly next time it checks — the common case, since each round is a
  // small, bounded amount of work. If that doesn't happen within
  // OPTIMIZE_CANCEL_FORCE_TIMEOUT_MS (a round genuinely stuck — an
  // enormous scenario, a runaway trial count), the worker is terminated
  // outright rather than leaving the UI waiting for a reply that may
  // never come; ensurePredictWorker() transparently creates a fresh
  // instance the next time anything needs it.
  function cancelOptimizeAdaptive() {
    if (S.optimizeCancelled) return; // already cancelling — let the force-timeout run its course
    S.optimizeCancelled = true;
    setStatus("sim-status", "Cancelling — finishing the in-flight round…");
    S.optimizeCancelTimeout = setTimeout(() => {
      if (S.predictWorker) {
        S.predictWorker.terminate();
        S.predictWorker = null;
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
  // by side, guarding against overfitting — a long greedy search WILL overfit
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

    // The interaction that otherwise confuses people: a generous max-rounds budget
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

    S.lastOptimizeDeviations = state.deviations;
    const list = document.getElementById("sim-optimize-deviations-list");
    list.innerHTML = "";
    if (state.deviations.length === 0) {
      list.innerHTML = '<div class="plan-hint">No repeater needed a targeted adjustment beyond the policy search result above.</div>';
      return;
    }
    state.deviations.forEach((d) => {
      const n = S.simNodes[d.node];
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

  // The optimizer's move set is wider than a single "back off txdelay"
  // move — these two helpers are the one
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
    S.lastOptimizeSnapshot = snapshot;
    if (snapshot.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="plan-empty">No per-repeater data.</td></tr>';
      return;
    }
    snapshot.forEach((s) => {
      const n = S.simNodes[s.node];
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
    const s = S.lastOptimizeSnapshot.find((x) => x.node === nodeIndex);
    if (!s) return;
    const n = S.simNodes[nodeIndex];
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
  // history table's own "Move" column: seeing what kind of move was tried
  // each round, not just which node, is part of showing improvement over
  // time honestly.
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
      const target = S.simNodes[h.targetNode];
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
    if (S.lastOptimizeDeviations.length === 0) {
      setStatus("sim-status", "Nothing to export — no repeater was adjusted.");
      return;
    }
    const rows = [["Repeater", "Round", "Move kind", "Reason", "Old value", "New value", "CLI command", "Warning"]];
    for (const d of S.lastOptimizeDeviations) {
      const n = S.simNodes[d.node];
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


  function init(context) {
    ({ ensurePredictWorker, escapeHtml, messagesFromState, openModal, scenarioFromState, setStatus, workerRequest } = context);
    return api;
  }

  const api = {
    init,
    cancelOptimizeAdaptive,
    exportOptimizeDeviationsCsv,
    runOptimizeAdaptive,
  };
  return api;
});
