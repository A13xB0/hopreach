// Replaying one real packet: fetching its window, reconstructing the topology it travelled through, and the bottleneck analysis comparing what was proven against what the model predicts.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimReplay = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;

  let DEFAULT_MESSAGE_HASH_SIZE, addProvenEdge, buildLinksFromCorescope, buildLinksFromModel, buildObserverEvidence, buildRealTimeline, buildReplayObservations, buildReplayTimeline, buildWindowFloodMessages, carriesTransportCode, ensureBottleneckLegendControl, ensureNodeDirectory, escapeHtml, extractPacketHash, fetchPacketsAroundTime, filterRepeatersAliveAt, isCanonicalDelivery, isolatedNodeHint, randomId, rebuildLinkIndexes, redrawNodeMarkers, regionOfPacket, renderEpisodeAnalysis, renderMessageNodeOptions, renderNodeList, renderResults, renderSentMessagesList, scenarioFromState, setRealReplayStatus, setStatus, shortAddressFromPubkey, simProvenLayer, simRealActivityLayer, stopRealTimelineReplay, syncRealReplayControls, updateWorkflowState;

  async function replayFromHash() {
    const hash = extractPacketHash(document.getElementById("sim-replay-hash-input").value);
    if (!hash) {
      setStatus("sim-replay-hash-status", "Couldn't find a packet hash (16 hex characters) in that input.");
      return;
    }
    document.getElementById("sim-replay-hash-go").disabled = true;
    setStatus("sim-replay-hash-status", "Fetching packet + node data from CoreScope…");
    try {
      const [packetData, nodeDir] = await Promise.all([
        fetch(`${MeshApi.BASE}/packets/${encodeURIComponent(hash)}`).then((r) => {
          if (!r.ok) throw new Error(`packet fetch failed: HTTP ${r.status}`);
          return r.json();
        }),
        ensureNodeDirectory(),
      ]);
      const observations = packetData.observations || [];
      if (observations.length === 0) throw new Error("CoreScope has no observations for that hash.");

      const provenEdges = new Map();
      const allPubkeys = new Set();
      let originPubkey = null;
      let targetMs = null;
      for (const obs of observations) {
        // CoreScope's own resolved_path can be entirely null (path
        // resolution failed for this whole observation) or, more subtly,
        // a real array with individual null entries (some hops resolved,
        // one didn't) — treated as a genuine gap, not a straight-through
        // connection: a pair either side of a null hop is NOT a proven
        // direct edge, since the real relay actually went through
        // whichever node failed to resolve.
        const rawChain = obs.resolved_path || [];
        if (rawChain.length === 0) continue;
        if (originPubkey === null && rawChain[0]) originPubkey = rawChain[0].toLowerCase();
        const tMs = Date.parse(obs.timestamp);
        if (Number.isNaN(tMs)) continue; // malformed stamp must not anchor the replay at 1970 (M3)
        if (targetMs === null || tMs < targetMs) targetMs = tMs; // earliest observation = when this packet actually happened
        for (const k of rawChain) if (k) allPubkeys.add(k.toLowerCase());
        const observerKey = (obs.observer_id || "").toLowerCase();
        if (observerKey) allPubkeys.add(observerKey);
        for (let i = 0; i < rawChain.length - 1; i++) {
          if (rawChain[i] && rawChain[i + 1]) {
            addProvenEdge(provenEdges, rawChain[i].toLowerCase(), rawChain[i + 1].toLowerCase(), tMs);
          }
        }
        // Only when the FINAL hop resolved: with a trailing null the
        // observer actually heard the unresolved relay, and bridging over
        // it fabricates a proven edge (SIMULATION_REVIEW.md M2 — the
        // reconstruct flow already drops this case).
        const lastRaw = rawChain[rawChain.length - 1];
        if (observerKey && lastRaw) {
          addProvenEdge(provenEdges, lastRaw.toLowerCase(), observerKey, tMs);
        }
      }
      if (originPubkey === null) throw new Error("Couldn't determine this packet's origin from CoreScope's data.");

      // Everything else CoreScope observed within the configured window of
      // this packet (see "Surrounding activity window", up to ±120s) — the
      // surrounding real activity for the "play in time what happened"
      // replay (see startRealTimelineReplay). Fetched now so any
      // additional node it involves gets placed alongside the target
      // packet's own nodes in one pass, rather than needing a second
      // "load more nodes" round-trip.
      const windowSecs = Math.min(120, Math.max(1, parseInt(document.getElementById("sim-replay-window-secs").value, 10) || 30));
      S.lastRealTimelineWindowSecs = windowSecs;
      const REAL_TIMELINE_WINDOW_MS = windowSecs * 1000;
      setStatus("sim-replay-hash-status", `Fetching surrounding real activity (±${windowSecs}s, ±5min for observer liveness)…`);
      const { packets: windowPackets, liveness, hitCap } = await fetchPacketsAroundTime(targetMs, REAL_TIMELINE_WINDOW_MS, 5 * 60 * 1000);
      for (const p of windowPackets) {
        for (const k of p.resolved_path || []) if (k) allPubkeys.add(k.toLowerCase());
        if (p.observer_id) allPubkeys.add(p.observer_id.toLowerCase());
      }

      // Keep every repeater already on the map and ADD the ones this
      // packet's observations mention. This used to clearNodes() first —
      // "a replay is a fresh investigation" — which quietly rigged the whole
      // comparison: the only repeaters left standing were the ones CoreScope
      // had already proved heard something, so the "predicted" flood had
      // nowhere to spread that reality hadn't already confirmed, and any
      // repeater that exists but simply wasn't heard was deleted before the
      // model got a chance to predict a hop into it. Those are exactly the
      // interesting ones. They stay, the model predicts into them, and
      // renderBottleneckAnalysis reports the result honestly (it can't be
      // confirmed OR refuted from this packet's observations — see its
      // unconfirmable split).
      const pubkeyToIndex = new Map();
      S.simNodes.forEach((n, i) => {
        // Real repeaters carry their pubkey as refId, but the node directory
        // and CoreScope's path data are lowercased — match case-insensitively
        // or an already-loaded repeater gets silently duplicated.
        if (n.source === "real" && n.refId) pubkeyToIndex.set(String(n.refId).toLowerCase(), i);
      });
      const alreadyLoaded = pubkeyToIndex.size;

      // Load the real network AS IT WAS at this packet's moment: every
      // repeater CoreScope had heard within the 25h before the packet (and
      // that already existed by then). Predicting over just the handful of
      // nodes the packet's own observations mention rigs the comparison the
      // other way — the flood has almost nowhere to go — while predicting
      // over TODAY'S map would include repeaters that were dead or unbuilt
      // at the time. Anything already on the map stays.
      let aliveAdded = 0;
      let aliveSkippedDead = 0;
      const planner = window.HopReachPlanner;
      if (planner) {
        const allReal = Object.values(planner.getRealRepeaters());
        const aliveThen = filterRepeatersAliveAt(allReal, targetMs);
        aliveSkippedDead = allReal.length - aliveThen.length;
        for (const r of aliveThen) {
          const pk = String(r.id).toLowerCase();
          if (pubkeyToIndex.has(pk)) continue;
          pubkeyToIndex.set(pk, S.simNodes.length);
          S.simNodes.push({
            id: randomId(), source: "real", refId: r.id, label: r.label, lat: r.lat, lon: r.lon,
            antennaHeightM: r.antennaHeightM ?? null,
            regions: r.scopes || [], hashSize: r.hashSize || null, denyUnscoped: r.observedUnscopedKnown ? !r.observedUnscoped : false,
            address: shortAddressFromPubkey(r.id),
          });
          aliveAdded++;
        }
      }
      let placedForReplay = 0;
      for (const pk of allPubkeys) {
        if (pubkeyToIndex.has(pk)) continue; // already on the map
        const info = nodeDir.get(pk);
        if (!info) continue; // CoreScope knows the key but has no position for it — can't place it
        pubkeyToIndex.set(pk, S.simNodes.length);
        // role (see ensureNodeDirectory) governs canRelay below — a
        // CoreScope-labelled "listener" only ever receives in real life
        // and should never appear as a predicted relay hop, regardless of
        // whether our model's own connectivity would otherwise allow it.
        // regions "*" (accepts any scope), matching what the episode
        // reconstruction does for the same reason: this repeater is in the
        // window's real path data, so it demonstrably WAS relaying this
        // traffic. We just have no scope list for it — the node directory
        // doesn't carry one — and defaulting to "holds no region key" would
        // have the model refuse traffic reality shows it carrying. Load the
        // real repeaters first if you want their actual observed scopes.
        S.simNodes.push({ id: randomId(), source: "real", refId: pk, label: info.name, lat: info.lat, lon: info.lon, role: info.role, regions: ["*"], address: shortAddressFromPubkey(pk) });
        placedForReplay++;
      }
      if (!pubkeyToIndex.has(originPubkey)) {
        throw new Error("The packet's origin has no known position — can't place it on the map.");
      }
      renderNodeList();
      renderMessageNodeOptions();
      redrawNodeMarkers();

      const observedTransmissions = buildRealTimeline(windowPackets, hash, pubkeyToIndex);
      S.realTimelineEvents = observedTransmissions; // replaced below by the merged observed+predicted timeline
      // Fall back to the window's actual start — anchoring at the target
      // instant clamped every pre-target flood to t=0, a fabricated
      // simultaneous pileup (SIMULATION_REVIEW.md M4).
      S.replayWindowStartMs = observedTransmissions.length ? observedTransmissions[0].tMs : targetMs - REAL_TIMELINE_WINDOW_MS;
      S.replayTargetHash = hash;
      stopRealTimelineReplay();
      simRealActivityLayer.clearLayers();
      document.getElementById("sim-bottleneck-replay-section").classList.toggle("hidden", observedTransmissions.length === 0);
      document.getElementById("sim-bottleneck-replay-title").textContent = `Replay real activity (±${windowSecs}s)`;
      const capNote = hitCap ? ` — CoreScope's recent-packet cap was reached before the window's oldest edge, so this may be partial` : "";
      setRealReplayStatus(
        S.realTimelineEvents.length
          ? `${windowPackets.length} real packet${windowPackets.length === 1 ? "" : "s"} observed within ±${windowSecs}s${capNote} — ready to replay.`
          : ""
      );

      setStatus("sim-replay-hash-status", `Building predicted connectivity for ${S.simNodes.length} involved node${S.simNodes.length === 1 ? "" : "s"}…`);
      const source = document.getElementById("sim-connectivity-source").value;
      if (source === "model") S.simLinks = await buildLinksFromModel(S.simNodes);
      else if (source === "corescope") S.simLinks = await buildLinksFromCorescope(S.simNodes);
      else {
        const [modelLinks, observedLinks] = await Promise.all([buildLinksFromModel(S.simNodes), buildLinksFromCorescope(S.simNodes)]);
        const observedPairs = new Set(observedLinks.map((l) => `${l.from}:${l.to}`));
        S.simLinks = observedLinks.concat(modelLinks.filter((l) => !observedPairs.has(`${l.from}:${l.to}`)));
      }
      S.linksGeneration++;
      setStatus(
        "sim-links-status",
        `${S.simLinks.length} directed link${S.simLinks.length === 1 ? "" : "s"} built (${source}).${isolatedNodeHint(S.simNodes, S.simLinks)}`
      );
      updateWorkflowState();
      S.replayObservations = buildReplayObservations(observedTransmissions);

      await MeshSim.ready;
      // Parse the real frame precisely (validated against 400 real frames):
      // header, [4 transport bytes if route 0/3], path_len, path, payload.
      // The APPLICATION payload length is what the engine's own airtime model
      // (onAirLen) then re-derives the full on-air size from — so passing the
      // whole frame length here (as this once did) would double-count the
      // framing/path bytes. Use the packet's own hash size too, recovered
      // from the path_len byte, so the replay reproduces the real packet's
      // airtime rather than an approximation.
      const targetPacket = packetData.packet || {};
      const payloadLen = targetPacket.payload_len || 20;
      const originIndex = pubkeyToIndex.get(originPubkey);
      const seed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
      // Simulate the whole window, not just the target packet: every real
      // flood in it, from its real origin, at its real offset. That's what
      // makes the predicted side say received/relayed/collided the way a
      // normal run does — and it means the surrounding traffic contends for
      // the channel with the target instead of the target flooding a mesh
      // that's implausibly silent.
      const knownRegions = await MeshApi.scopes().catch(() => []);
      let predictedMessages = await buildWindowFloodMessages(windowPackets, pubkeyToIndex, S.replayWindowStartMs);
      // The target itself may be missing from the window list (it's fetched
      // separately, and its own row can fall outside what /api/packets
      // returned) — add it from the detail fetch so there's always something
      // to compare against.
      if (!predictedMessages.some((m) => m.sourceHash === hash)) {
        predictedMessages.push({
          origin: originIndex,
          sendAtMs: Math.max(0, targetMs - S.replayWindowStartMs),
          payloadLen,
          hashSize: targetPacket.hash_size || DEFAULT_MESSAGE_HASH_SIZE,
          region: regionOfPacket(targetPacket),
          sourceHash: hash,
        });
        predictedMessages.sort((a, b) => a.sendAtMs - b.sendAtMs);
      }
      // Long enough to cover the window itself plus the tail of relays the
      // last packet in it sets off; the panel's own duration is the floor.
      const configuredMaxMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
      const windowSpanMs = predictedMessages.length ? predictedMessages[predictedMessages.length - 1].sendAtMs : 0;
      const maxSimTimeMs = Math.max(configuredMaxMs, windowSpanMs + 60000);
      const predictedReport = MeshSim.run(scenarioFromState(), predictedMessages, seed, maxSimTimeMs);

      const routeType = packetData.packet ? packetData.packet.route_type : null;
      // The analysis is about the TARGET packet specifically, so it gets only
      // that packet's own receptions — feeding it the whole window would
      // credit hops from unrelated floods as if they were this one's.
      const targetPid = predictedMessages.findIndex((m) => m.sourceHash === hash);
      // The 🎲 probability analysis re-runs exactly these messages — this
      // flow never populates simMessageGenerators, and consuming stale
      // generators from an earlier reconstruction produced a confident
      // verdict from zero valid runs (SIMULATION_REVIEW.md C1).
      S.lastEpisodeMessages = predictedMessages;
      S.lastEpisodeTargetPid = targetPid;

      // Observer evidence: what was every observer doing at the target's
      // transit? Silent-active observers (provably alive, idle, heard
      // nothing) contradict any predicted delivery at — or routed through —
      // them: reality says the packet never got there this time.
      const { observerEvidence } = buildObserverEvidence({ detail: packetData, targetMs, hash, liveness });
      const evidenceByPubkey = new Map(observerEvidence.map((o) => [o.pubkey, o]));
      // Nodes in the target's own observed relay chains provably HAD the
      // packet — their missing upload never contradicts delivery (C6).
      const provenRelayPk = new Set();
      for (const o of packetData.observations || []) {
        for (const pk of o.resolved_path || []) if (pk) provenRelayPk.add(pk.toLowerCase());
      }
      const contradictedNodes = new Set();
      for (const o of observerEvidence) {
        if (o.state !== "silent-active" || provenRelayPk.has(o.pubkey)) continue;
        const idx = pubkeyToIndex.get(o.pubkey);
        if (idx != null) contradictedNodes.add(idx);
      }
      const targetReceptions = (predictedReport.receptions || []).filter((r) => r.packetId === targetPid);
      const constrained = HopReachEvidence.constrainDeliveries({
        receptions: targetReceptions,
        targetPid,
        contradictedNodes,
        isDelivery: isCanonicalDelivery,
      });
      renderBottleneckAnalysis({ pubkeyToIndex, provenEdges, predictedReport, targetPid, contradictedNodes, constrained });

      // Register the run as an episode too, so the episode analysis modal,
      // the ✕-ring overlay, and the 10× probability button all work from
      // this flow — not just from "Reconstruct window".
      const obsSeen = new Map();
      for (const o of packetData.observations || []) {
        const k = (o.observer_id || "").toLowerCase();
        if (k && pubkeyToIndex.has(k) && !obsSeen.has(k)) obsSeen.set(k, { pubkey: k, name: o.observer_name || k.slice(0, 8), index: pubkeyToIndex.get(k) });
      }
      const allObsSeen = new Map(obsSeen);
      for (const wp of windowPackets) {
        const k = (wp.observer_id || "").toLowerCase();
        if (k && pubkeyToIndex.has(k) && !allObsSeen.has(k)) allObsSeen.set(k, { pubkey: k, name: wp.observer_name || k.slice(0, 8), index: pubkeyToIndex.get(k) });
      }
      for (const o of observerEvidence) {
        if (pubkeyToIndex.has(o.pubkey) && !allObsSeen.has(o.pubkey)) allObsSeen.set(o.pubkey, { pubkey: o.pubkey, name: o.name, index: pubkeyToIndex.get(o.pubkey) });
      }
      const targetMsg = targetPid >= 0 ? predictedMessages[targetPid] : null;
      S.lastEpisode = {
        hash,
        windowSecs,
        fetchedAt: new Date().toISOString(),
        target: targetMsg ? { nodeIndex: targetMsg.origin, atMs: targetMsg.sendAtMs } : null,
        targetNote: targetMsg ? "" : "The target packet couldn't be placed as a flood sender in this window.",
        targetObservers: [...obsSeen.values()],
        allObservers: [...allObsSeen.values()],
        observerEvidence,
        targetPaths: (packetData.observations || []).map((o) => (o.resolved_path || []).map((x) => (x || "").toLowerCase()).filter(Boolean)),
        originInferred: !!(targetMsg && !(JSON.parse((packetData.packet || {}).decoded_json || "{}").pubKey)),
        deafObservers: observerEvidence.filter((o) => o.state === "busy").map((o) => o.pubkey),
      };
      S.episodeBaseline = null;
      document.getElementById("sim-open-episode-modal").classList.remove("hidden");

      // Now the engine has run, the replay timeline can carry both halves —
      // what was observed and what was predicted — on the one clock. The
      // predicted half is evidence-constrained: target deliveries reality
      // contradicts don't animate as if they happened.
      S.realTimelineEvents = buildReplayTimeline(observedTransmissions, predictedReport, S.replayWindowStartMs, {
        targetPid,
        prunedNodes: new Set(constrained.prunedNodes),
        excludedNodes: new Set([...constrained.prunedNodes, ...contradictedNodes]),
      });
      ensureBottleneckLegendControl();
      syncRealReplayControls();

      // A replay's predicted run is a real report and belongs in the same
      // places every other run's does — the reception log, the packet
      // inspector, the per-repeater breakdown. It used to be computed,
      // diffed against reality, and then thrown away: clearNodes() above
      // has already nulled lastReport and torn down the playback control,
      // so the map's reception log sat empty for the whole replay even
      // though a full set of predicted receptions existed. Rendering it
      // (deliberately without startReplay, which would clear the
      // proven/predicted overlay renderBottleneckAnalysis just drew) means
      // the log fills in and "▶ Replay" is there to animate the predicted
      // flood whenever you want it.
      S.lastReport = predictedReport;
      S.lastMessages = predictedMessages;
      rebuildLinkIndexes(predictedReport);
      renderResults(predictedReport);
      renderSentMessagesList();
      renderEpisodeAnalysis(); // evidence text, ✕-rings, actual-vs-predicted
      updateWorkflowState();

      // Flood route types are TRANSPORT_FLOOD (0) and FLOOD (1); direct are
      // DIRECT (2) and TRANSPORT_DIRECT (3). Our model only predicts flood
      // relaying, so warn only for the DIRECT types — the previous check
      // (routeType !== 0) wrongly warned on plain floods and stayed silent
      // on transport-floods.
      const isDirect = routeType === 2 || routeType === 3;
      // Deliberately doesn't open the bottleneck modal automatically. It
      // covers the whole map (see #sim-modal-backdrop), which is precisely
      // what you need to see while a replay plays — the transport controls
      // and the map key are docked on the map itself now, and the
      // "🔍 Bottleneck analysis" button opens the full breakdown on demand.
      // Scoped traffic that couldn't be decoded would be simulated as
      // unscoped and refused by most repeaters, so say so rather than
      // presenting a wall of "Region mismatch" as if it were a finding.
      const scopedCount = predictedMessages.filter((m) => m.region).length;
      const transportCount = predictedMessages.filter((m) => {
        const p = windowPackets.find((w) => w.hash === m.sourceHash);
        return p && carriesTransportCode(p);
      }).length;
      const regionNote =
        knownRegions.length === 0
          ? " Couldn't fetch the region list from the observation backend, so every packet is being simulated as unscoped — expect repeaters that deny unscoped traffic to refuse it."
          : transportCount > scopedCount
            ? ` ${transportCount - scopedCount} scoped packet(s) carry a region we couldn't identify, so they're simulated as unscoped.`
            : "";
      setStatus(
        "sim-replay-hash-status",
        `Loaded ${observations.length} real observation${observations.length === 1 ? "" : "s"} of packet ${hash}. ` +
          `Predicting over ${S.simNodes.length} repeaters (${alreadyLoaded} already loaded, ${aliveAdded} alive at the packet's time, ${placedForReplay} added from this packet's observations${aliveSkippedDead ? `; ${aliveSkippedDead} known repeaters skipped — dead or not yet seen back then` : ""})` +
          `${scopedCount ? `, ${scopedCount} scoped flood(s) decoded` : ""}.${regionNote} ` +
          `Press "▶ Play real ±${windowSecs}s" on the map to watch it, or open the bottleneck analysis for the full breakdown.` +
          (isDirect ? " Note: our model only predicts flood relaying, but this packet used direct (addressed) routing — the prediction side won't be meaningful." : "")
      );
    } catch (err) {
      setStatus("sim-replay-hash-status", `Replay failed: ${err.message || err}`);
    } finally {
      document.getElementById("sim-replay-hash-go").disabled = false;
    }
  }

  function renderBottleneckAnalysis({ pubkeyToIndex, provenEdges, predictedReport, targetPid, contradictedNodes, constrained }) {
    const provenPairIndices = new Set();
    for (const e of provenEdges.values()) {
      const f = pubkeyToIndex.get(e.from);
      const t = pubkeyToIndex.get(e.to);
      if (f != null && t != null) provenPairIndices.add(`${f}:${t}`);
    }

    const predictedPairs = new Map(); // "from:to" -> Reception
    for (const r of predictedReport.receptions || []) {
      if (targetPid != null && targetPid >= 0 && r.packetId !== targetPid) continue;
      predictedPairs.set(`${r.fromNode}:${r.node}`, r);
    }

    // Direction 1: the model expects this hop to work, but no real
    // observation ever confirmed it.
    //
    // "Unconfirmed" on its own badly overstates the case, and it's why this
    // list looks alarmingly long: the node set on the map is every repeater
    // seen anywhere in the whole ±window of surrounding traffic, while
    // provenEdges only ever covers THIS packet's own observations. A
    // predicted hop into a repeater that never appears anywhere in this
    // packet's real path data can't be confirmed or refuted — CoreScope
    // simply has no evidence either way (it only ever learns a hop happened
    // when some observer reported a path through it). Absence of evidence
    // there isn't evidence of absence, so those are split out as
    // "unconfirmable" and are NOT bottleneck candidates.
    //
    // What's left — a predicted hop into a repeater that DOES appear in
    // this packet's real path data, reached some other way but not this one
    // — is the genuinely interesting set: reality had visibility of that
    // node and still didn't record this hop.
    const observedNodeIndices = new Set();
    for (const e of provenEdges.values()) {
      const f = pubkeyToIndex.get(e.from);
      const t = pubkeyToIndex.get(e.to);
      if (f != null) observedNodeIndices.add(f);
      if (t != null) observedNodeIndices.add(t);
    }
    const allUnconfirmed = Array.from(predictedPairs.entries())
      .filter(([key]) => !provenPairIndices.has(key))
      .map(([, r]) => r)
      .sort((a, b) => a.atMs - b.atMs);
    // Refuted beats unconfirmable: "this packet's observations say nothing
    // about that repeater" was treated as no-evidence-either-way, but a
    // predicted hop INTO an observer that was provably alive, idle, and
    // silent at the target's transit IS refuted — a healthy observer's
    // silence is evidence of absence (see public/evidence.js).
    const contradicted = contradictedNodes || new Set();
    const refuted = allUnconfirmed.filter((r) => contradicted.has(r.node));
    const unconfirmed = allUnconfirmed.filter((r) => !contradicted.has(r.node) && observedNodeIndices.has(r.node));
    const unconfirmable = allUnconfirmed.filter((r) => !contradicted.has(r.node) && !observedNodeIndices.has(r.node));

    // Direction 2: CoreScope proved this hop happened, but our model
    // doesn't even consider it a possible link at all (never appears in
    // simLinks — not merely "wasn't used in this particular simulated
    // run"). Real, observed example this surfaced: a packet's own origin
    // repeater had zero model-predicted links to anyone, entirely because
    // its nearest real neighbour is further away than this tool's default
    // planning-range cap — the model wasn't wrong about physics, its
    // defaults just didn't anticipate that link. Distinguishing this from
    // direction 1 matters: it points at the model's own assumptions
    // (range, antenna heights, terrain), not at the real network.
    const modeledPairIndices = new Set(S.simLinks.map((l) => `${l.from}:${l.to}`));
    const unmodeled = Array.from(provenEdges.values())
      .map((e) => ({ from: pubkeyToIndex.get(e.from), to: pubkeyToIndex.get(e.to), firstMs: e.firstMs }))
      .filter((e) => e.from != null && e.to != null && !modeledPairIndices.has(`${e.from}:${e.to}`))
      .sort((a, b) => a.firstMs - b.firstMs);

    document.getElementById("sim-open-bottleneck-modal").classList.remove("hidden");
    const ambiguousCollided = contradictedNodes
      ? (predictedReport.receptions || []).filter((r) => (targetPid == null || r.packetId === targetPid) && r.collided && contradictedNodes.has(r.node)).length
      : 0;
    const constrainedNote = constrained
      ? ` Evidence-constrained reach: ${constrained.keptNodes.size} node${constrained.keptNodes.size === 1 ? "" : "s"} (raw model claimed ${constrained.keptNodes.size + constrained.prunedNodes.size}; ${constrained.prunedNodes.size} contradicted by healthy silent observers${ambiguousCollided ? `; ${ambiguousCollided} collided-at-silent-observer arrival(s) are AMBIGUOUS — a collision logs nothing, see the episode likelihood analysis` : ""}).`
      : "";
    document.getElementById("sim-bottleneck-summary").textContent =
      `${provenEdges.size} proven hop${provenEdges.size === 1 ? "" : "s"} from real CoreScope observations, ` +
      `${predictedPairs.size} predicted by our model — ${unconfirmed.length} predicted but never confirmed, ` +
      `${refuted.length} REFUTED (predicted into observers that were alive, idle and silent — the packet demonstrably never got there), ` +
      `${unconfirmable.length} predicted into repeaters this packet's observations say nothing about (can't be judged either way), ` +
      `${unmodeled.length} proven but not even predicted possible.` +
      constrainedNote;
    const refutedNames = [...new Set(refuted.map((r) => `${S.simNodes[r.fromNode] ? S.simNodes[r.fromNode].label : r.fromNode} → ${S.simNodes[r.node] ? S.simNodes[r.node].label : r.node}`))];
    document.getElementById("sim-bottleneck-unconfirmable-note").textContent =
      (refuted.length
        ? `REFUTED (healthy observers were alive, idle and silent — the packet demonstrably never got there): ${refutedNames.join("; ")}. `
        : "") +
      (unconfirmable.length
        ? `${unconfirmable.length} further predicted hop${unconfirmable.length === 1 ? "" : "s"} went into repeaters that never appear in this packet's real path data at all — CoreScope only learns a hop happened when one of its observers reports a path through it, so it has no evidence either way about those. They're excluded from the list below rather than counted as misses.`
        : "");

    const list = document.getElementById("sim-bottleneck-list");
    list.innerHTML = "";
    if (unconfirmed.length === 0) {
      list.innerHTML = `<div class="plan-empty">Every predicted relay into a repeater this packet's observations cover was confirmed by a real observation.</div>`;
    }
    for (const r of unconfirmed) {
      const from = S.simNodes[r.fromNode];
      const to = S.simNodes[r.node];
      const row = document.createElement("div");
      row.className = "plan-list-item sim-list-item sim-collided";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(from ? from.label : "?")} → ${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">predicted at ~${r.atMs}ms, hop ${r.hopCount}${r.collided ? " · our model also predicts a collision here" : " · this repeater does appear in the packet's real path data, just never via this hop"}</span>
      `;
      list.appendChild(row);
    }

    const unmodeledList = document.getElementById("sim-unmodeled-list");
    unmodeledList.innerHTML = "";
    if (unmodeled.length === 0) {
      unmodeledList.innerHTML = '<div class="plan-empty">Every real observed hop is at least within our model\'s own connectivity assumptions.</div>';
    }
    for (const e of unmodeled) {
      const from = S.simNodes[e.from];
      const to = S.simNodes[e.to];
      const row = document.createElement("div");
      row.className = "plan-list-item sim-list-item";
      row.innerHTML = `
        <span class="plan-item-label">${escapeHtml(from ? from.label : "?")} → ${escapeHtml(to ? to.label : "?")}</span>
        <span class="plan-item-sub">real observed hop, but outside this tool's modeled range/terrain assumptions for that pair</span>
      `;
      unmodeledList.appendChild(row);
    }

    // Map: solid green for proven+modeled hops, solid blue for proven but
    // unmodeled (the model's own blind spot), dashed amber for
    // predicted-but-unconfirmed (the bottleneck candidates), and faint
    // dashed slate for predicted-but-unjudgeable — drawn, because they're
    // still what the model thinks happened and hiding them would misrepresent
    // the predicted flood, but visually demoted so they don't read as
    // failures the way a wall of amber did.
    simProvenLayer.clearLayers();
    const unmodeledPairs = new Set(unmodeled.map((e) => `${e.from}:${e.to}`));
    for (const e of provenEdges.values()) {
      const fIdx = pubkeyToIndex.get(e.from);
      const tIdx = pubkeyToIndex.get(e.to);
      const from = S.simNodes[fIdx];
      const to = S.simNodes[tIdx];
      if (!from || !to) continue;
      const isUnmodeled = unmodeledPairs.has(`${fIdx}:${tIdx}`);
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: isUnmodeled ? "#38bdf8" : "#4ade80", weight: 3, opacity: 0.9 }
      ).addTo(simProvenLayer);
    }
    for (const r of unconfirmed) {
      const from = S.simNodes[r.fromNode];
      const to = S.simNodes[r.node];
      if (!from || !to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: "#facc15", weight: 3, opacity: 0.9, dashArray: "6 6" }
      ).addTo(simProvenLayer);
    }
    for (const r of unconfirmable) {
      const from = S.simNodes[r.fromNode];
      const to = S.simNodes[r.node];
      if (!from || !to) continue;
      L.polyline(
        [
          [from.lat, from.lon],
          [to.lat, to.lon],
        ],
        { color: "#818cf8", weight: 2, opacity: 0.6, dashArray: "3 7" }
      ).addTo(simProvenLayer);
    }
  }

  function init(context) {
    ({ DEFAULT_MESSAGE_HASH_SIZE, addProvenEdge, buildLinksFromCorescope, buildLinksFromModel, buildObserverEvidence, buildRealTimeline, buildReplayObservations, buildReplayTimeline, buildWindowFloodMessages, carriesTransportCode, ensureBottleneckLegendControl, ensureNodeDirectory, escapeHtml, extractPacketHash, fetchPacketsAroundTime, filterRepeatersAliveAt, isCanonicalDelivery, isolatedNodeHint, randomId, rebuildLinkIndexes, redrawNodeMarkers, regionOfPacket, renderEpisodeAnalysis, renderMessageNodeOptions, renderNodeList, renderResults, renderSentMessagesList, scenarioFromState, setRealReplayStatus, setStatus, shortAddressFromPubkey, simProvenLayer, simRealActivityLayer, stopRealTimelineReplay, syncRealReplayControls, updateWorkflowState } = context);
    return api;
  }

  const api = {
    init,
    replayFromHash,
  };
  return api;
});
