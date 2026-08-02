// The 'Repeaters & settings' modal: one editable table of every node's radio, delay and flood settings, plus the bulk-apply row that fills them all at once.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimNodesModal = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { SOURCE_BADGE, DEFAULT_LOOP_DETECT, RADIO_PRESETS } = window.SimConstants;

  let applyRule, computeRankings, defaultPrefs, effectiveDenyUnscoped, effectiveFloodMax, effectiveFloodMaxUnscoped, effectiveHashSize, effectiveLoopDetect, effectiveNodeType, effectivePrefsFor, effectiveRegions, escapeHtml, invalidateLinks, matchesViewFilter, nodesSortedByLabel, openModal, openPacketInspectorForNode, radioPresetLabelFor, redrawNodeMarkers, regionsFromDisplayString, regionsToDisplayString, removeNode, renameNode, renderMessageList, renderMessageNodeOptions, ruleMatchesAttrs, setStatus, simResultsLayer;

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


  function init(context) {
    ({ applyRule, computeRankings, defaultPrefs, effectiveDenyUnscoped, effectiveFloodMax, effectiveFloodMaxUnscoped, effectiveHashSize, effectiveLoopDetect, effectiveNodeType, effectivePrefsFor, effectiveRegions, escapeHtml, invalidateLinks, matchesViewFilter, nodesSortedByLabel, openModal, openPacketInspectorForNode, radioPresetLabelFor, redrawNodeMarkers, regionsFromDisplayString, regionsToDisplayString, removeNode, renameNode, renderMessageList, renderMessageNodeOptions, ruleMatchesAttrs, setStatus, simResultsLayer } = context);
    return api;
  }

  const api = {
    init,
    applyNodesModalTable,
    fillAllRowsFromBulkApply,
    openNodesModal,
    redrawResultLines,
    renderNodesModalTable,
  };
  return api;
});
