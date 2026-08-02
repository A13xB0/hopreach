// The packet inspector: the sent-messages list, and the per-repeater / per-packet reception detail that answers 'what happened here' for one node or one flood.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimInspector = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { DEFAULT_MESSAGE_HASH_SIZE, SOURCE_BADGE, LONG_LIST_ROW_CAP } = window.SimConstants;

  let appendShowAllButton, clearTransportSource, closeModals, episodeEvidenceLayer, escapeHtml, growthMarkers, matchesViewFilter, nodesSortedByLabel, openModal, removeBottleneckLegendControl, removeSimPlaybackControl, renderStatStrip, setRankingsFullWindowOpen, setStatus, simMessagePathLayer, simProvenLayer, simRealActivityLayer, simResultsLayer, stopRealTimelineReplay, stopReplay, updateWorkflowState;

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

  function init(context) {
    ({ appendShowAllButton, clearTransportSource, closeModals, episodeEvidenceLayer, escapeHtml, growthMarkers, matchesViewFilter, nodesSortedByLabel, openModal, removeBottleneckLegendControl, removeSimPlaybackControl, renderStatStrip, setRankingsFullWindowOpen, setStatus, simMessagePathLayer, simProvenLayer, simRealActivityLayer, simResultsLayer, stopRealTimelineReplay, stopReplay, updateWorkflowState } = context);
    return api;
  }

  const api = {
    init,
    applyPacketModalFilters,
    drawSelectedMessagePath,
    goBackPacketModal,
    hideResults,
    openPacketInspectorForNode,
    rebuildLinkIndexes,
    renderSentMessagesList,
  };
  return api;
});
