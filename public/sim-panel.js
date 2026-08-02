// The simulator panel's own lists and rail: node list, message-sender list, the Basic/Advanced tier switch, and the workflow rail that tracks which step you're on.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimPanel = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { DEFAULT_MESSAGE_HASH_SIZE, SOURCE_BADGE, SIM_TIER_STORAGE_KEY } = window.SimConstants;

  let effectiveNodeType, escapeHtml, invalidateLinks, openNodesModal, openPacketInspectorForNode, randomId, renderNodesModalTable, setStatus, simNodesLayer;

  // --- rendering: node list, message list -----------------------------


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


  function init(context) {
    ({ effectiveNodeType, escapeHtml, invalidateLinks, openNodesModal, openPacketInspectorForNode, randomId, renderNodesModalTable, setStatus, simNodesLayer } = context);
    return api;
  }

  const api = {
    init,
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
  };
  return api;
});
