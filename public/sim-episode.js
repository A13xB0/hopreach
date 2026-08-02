// Episode reconstruction: rebuilding what actually happened in a packet's window as a runnable scenario, then the analysis and probability verdict comparing prediction against evidence.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimEpisode = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { DEFAULT_MESSAGE_HASH_SIZE } = window.SimConstants;

  let buildLinksFromModel, buildObserverEvidence, ensureNodeDirectory, episodeEvidenceLayer, escapeHtml, extractPacketHash, fetchPacketsAroundTime, hideResults, isCanonicalDelivery, map, messagesFromState, mulberry32, originPubkeyOfPacket, randomId, redrawNodeMarkers, regionOfPacket, renderMessageList, renderMessageNodeOptions, renderNodeList, scenarioFromState, setStatus, shortAddressFromPubkey;

  async function reconstructEpisodeFromWindow() {
    const hash = extractPacketHash(document.getElementById("sim-replay-hash-input").value);
    if (!hash) {
      setStatus("sim-replay-hash-status", "Couldn't find a packet hash (16 hex characters) in that input.");
      return;
    }
    const btn = document.getElementById("sim-reconstruct-episode");
    btn.disabled = true;
    try {
      setStatus("sim-replay-hash-status", "Reconstructing — fetching the target packet…");
      // The window is centred on the target packet's own time.
      const detailResp = await fetch(`${MeshApi.BASE}/packets/${encodeURIComponent(hash)}`);
      if (!detailResp.ok) throw new Error(`packet ${hash} not found (HTTP ${detailResp.status})`);
      const detail = await detailResp.json();
      const targetMs = Date.parse((detail.packet && detail.packet.timestamp) || (detail.observations && detail.observations[0] && detail.observations[0].timestamp));
      if (Number.isNaN(targetMs)) throw new Error("target packet has no usable timestamp");

      const windowSecs = Math.min(120, Math.max(1, parseInt(document.getElementById("sim-replay-window-secs").value, 10) || 30));
      const windowMs = windowSecs * 1000;
      const windowStartMs = targetMs - windowMs;
      setStatus("sim-replay-hash-status", `Fetching real activity within ±${windowSecs}s (and ±5min for observer liveness)…`);
      const LIVENESS_MS = 5 * 60 * 1000;
      const { packets, liveness, hitCap } = await fetchPacketsAroundTime(targetMs, windowMs, LIVENESS_MS);
      if (packets.length === 0) throw new Error("no real activity found in that window");

      const dir = await ensureNodeDirectory();

      // "Path records" the topology is built from: every window packet (the
      // list gives one representative observation each), PLUS the target
      // packet's OWN full set of observations (from its detail) — the latter
      // is essential, because the window list carries only one path per
      // packet, so the target's other real paths to the very observers we
      // compare against would otherwise be missing from the graph (and our
      // sim would spuriously "fail" to deliver to them).
      const targetOrigin = originPubkeyOfPacket(detail.packet || {});
      const pathRecords = packets.map((p) => ({ path: (p.resolved_path || []).map((x) => (x || "").toLowerCase()), observer: (p.observer_id || "").toLowerCase(), origin: originPubkeyOfPacket(p), snr: typeof p.snr === "number" ? p.snr : NaN }));
      for (const o of detail.observations || []) {
        pathRecords.push({ path: (o.resolved_path || []).map((x) => (x || "").toLowerCase()), observer: (o.observer_id || "").toLowerCase(), origin: targetOrigin, snr: typeof o.snr === "number" ? o.snr : NaN });
      }

      // Collect every node that appears in the window (relay, observer, or
      // advert origin) and has a known position — those become the sim nodes.
      const involved = new Set();
      for (const r of pathRecords) {
        for (const k of r.path) if (k) involved.add(k);
        if (r.observer) involved.add(r.observer);
        if (r.origin) involved.add(r.origin);
      }
      const pubkeys = [...involved].filter((k) => dir.has(k));
      if (pubkeys.length < 2) throw new Error("fewer than 2 positioned nodes in the window — nothing to reconstruct");
      const indexByPubkey = new Map(pubkeys.map((k, i) => [k, i]));

      const nodes = pubkeys.map((k) => {
        const info = dir.get(k);
        return { id: randomId(), source: "real", refId: k, label: info.name, lat: info.lat, lon: info.lon, role: info.role, regions: ["*"], address: shortAddressFromPubkey(k) };
      });

      // Connectivity: the real proven directed edges observed in the window
      // (origin→relay0, relay_i→relay_{i+1}, last_relay→observer), each a
      // "this really decoded that" fact, so assigned a strong SNR. This is the
      // topology phase 7 validated at 100% delivery recall.
      const edgeMap = new Map();
      const addEdge = (fromK, toK, snrDb) => {
        if (!fromK || !toK) return;
        const fi = indexByPubkey.get(fromK);
        const ti = indexByPubkey.get(toK);
        if (fi == null || ti == null || fi === ti) return;
        // A real measured SNR (the observer edge of an observation) beats the
        // idealized 20 dB placeholder — marginal real links then behave
        // marginally under collision capture, like they do on air.
        const key = `${fi}:${ti}`;
        const real = Number.isFinite(snrDb) ? Math.max(-25, Math.min(25, snrDb)) : null;
        const existing = edgeMap.get(key);
        if (!existing) {
          edgeMap.set(key, { from: fi, to: ti, snrDb: real != null ? real : 20 });
        } else if (real != null && existing.snrDb === 20) {
          existing.snrDb = real; // upgrade a placeholder with a measurement
        }
      };
      for (const r of pathRecords) {
        if (r.origin && r.path[0]) addEdge(r.origin, r.path[0]);
        for (let i = 0; i + 1 < r.path.length; i++) addEdge(r.path[i], r.path[i + 1]);
        if (r.path.length && r.observer) addEdge(r.path[r.path.length - 1], r.observer, r.snr);
      }

      // Blend in the propagation model to fill the gaps a single sparse
      // window's proven edges miss. Real ScotMesh traffic is low-rate, so the
      // proven edges alone form a thin tree — but the nodes that COULD hear
      // each other (whether or not they relayed in this window) are exactly
      // what makes a flood's own relays contend, which is the thing worth
      // tuning. Proven edges (real) always win over a modelled one for the
      // same pair. Terrain can legitimately fail for nodes spread too far for
      // one grid fetch — fall back to proven-only rather than aborting.
      let modelAdded = 0;
      try {
        setStatus("sim-replay-hash-status", "Filling connectivity gaps with the terrain model…");
        // Race the terrain fetch against a timeout — real repeaters can be
        // spread across the whole region, and a large or slow DEM fetch must
        // never hang the reconstruction. Proven edges alone are a complete,
        // validated fallback.
        const modelLinks = await Promise.race([
          buildLinksFromModel(nodes),
          new Promise((_, reject) => setTimeout(() => reject(new Error("terrain fetch timed out")), 15000)),
        ]);
        for (const l of modelLinks) {
          const key = `${l.from}:${l.to}`;
          if (!edgeMap.has(key)) {
            edgeMap.set(key, l);
            modelAdded++;
          }
        }
      } catch {
        /* terrain unavailable / too large / too slow — proven edges alone still work */
      }
      const links = [...edgeMap.values()];

      // Senders + background: each real packet becomes a fixed transmission at
      // its observed second (offset from the window start). Flood traffic
      // (route 0/1) → tunable flood senders injected at their origin (advert
      // pubkey, else the first observed relay). Everything else → a fixed
      // background transmission at its first observed hop, loading the channel
      // without being routed.
      const generators = [];
      let targetGen = null;
      let floodCount = 0;
      let bgCount = 0;
      let skipped = 0;
      // Verified against the live CoreScope API: /api/packets returns ONE
      // row per packet (400 rows / 400 unique hashes sampled), not one per
      // observation. The dedupe below is a cheap invariant guard so an
      // instance that ever returns per-observation rows can't turn one
      // flood into several same-second senders colliding with themselves
      // (SIMULATION_REVIEW.md C4).
      const seenGenHashes = new Set();
      for (const p of packets) {
        if (p.hash && seenGenHashes.has(p.hash)) {
          continue;
        }
        if (p.hash) seenGenHashes.add(p.hash);
        const tMs = Date.parse(p.timestamp);
        if (Number.isNaN(tMs)) {
          skipped++;
          continue;
        }
        const atMs = Math.max(0, tMs - windowStartMs);
        const path = (p.resolved_path || []).map((x) => (x || "").toLowerCase());
        const isFlood = p.route_type === 0 || p.route_type === 1;
        if (isFlood) {
          const originKey = originPubkeyOfPacket(p) || path[0];
          const oi = indexByPubkey.get(originKey);
          if (oi == null) {
            skipped++;
            continue;
          }
          const gen = {
            id: randomId(),
            fixed: true,
            nodeIndex: oi,
            atMs,
            payloadLen: p.payload_len || 20,
            hashSize: p.hash_size || DEFAULT_MESSAGE_HASH_SIZE,
            // A non-empty region marks the packet as transport-coded (route 0)
            // for the +4-byte airtime; the reconstructed nodes all hold the
            // "*" wildcard so this never gates relaying, only sizes airtime.
            // Prefer the real decoded name, falling back to the route type so
            // a region we can't name still gets its transport-code bytes.
            region: regionOfPacket(p),
            background: false,
            sourceHash: p.hash,
            isTarget: p.hash === hash,
          };
          generators.push(gen);
          if (gen.isTarget) targetGen = gen;
          floodCount++;
        } else {
          const firstHop = path[0];
          const bi = indexByPubkey.get(firstHop);
          if (bi == null) {
            skipped++;
            continue;
          }
          generators.push({
            id: randomId(),
            fixed: true,
            background: true,
            nodeIndex: bi,
            atMs,
            frameBytes: p.frame_bytes || 24,
            payloadLen: p.payload_len || 20,
            hashSize: p.hash_size || DEFAULT_MESSAGE_HASH_SIZE,
            region: regionOfPacket(p),
            sourceHash: p.hash,
          });
          bgCount++;
        }
      }

      // The target packet's real observers (those our reconstructed node set
      // actually contains), and every observer seen anywhere in the window
      // (for the observer-deafness check) — the ground truth the episode
      // analysis compares our simulation against.
      // Deduped by node — the SAME observer often appears in several
      // observations (different relay paths / times); it's still one repeater
      // that heard the packet once, so it counts once toward recall.
      const targetObsMap = new Map();
      for (const o of detail.observations || []) {
        const k = (o.observer_id || "").toLowerCase();
        if (indexByPubkey.has(k) && !targetObsMap.has(k)) targetObsMap.set(k, { pubkey: k, name: o.observer_name || k.slice(0, 8), index: indexByPubkey.get(k) });
      }
      const targetObservers = [...targetObsMap.values()];
      const allObserversMap = new Map(); // pubkey -> {pubkey, name, index}
      for (const p of packets) {
        const k = (p.observer_id || "").toLowerCase();
        if (indexByPubkey.has(k) && !allObserversMap.has(k)) allObserversMap.set(k, { pubkey: k, name: p.observer_name || k.slice(0, 8), index: indexByPubkey.get(k) });
      }
      const allObservers = [...allObserversMap.values()]; // plain array so lastEpisode serialises into a saved setup

      // Observer-evidence classification (public/evidence.js): what was every
      // observer doing at the target's transit? heard / busy (overlapping
      // rx or relay — could have missed it) / silent-active (provably alive,
      // idle, silent — the packet did NOT reach it) / silent-unknown
      // (possibly offline). Liveness comes from the wider ±5min fetch, and
      // "observer" here means every observer id seen in that span — an
      // observer needn't be a positioned repeater to bear witness.
      const { observerEvidence } = buildObserverEvidence({ detail, targetMs, hash, liveness });

      // If the target itself couldn't be placed as a flood sender, say why —
      // the surrounding traffic is still reconstructed and tunable, but there's
      // no actual-vs-predicted to show for the target.
      let targetNote = "";
      if (!targetGen) {
        const trt = detail.packet && detail.packet.route_type;
        targetNote =
          trt === 2 || trt === 3
            ? "The target packet used direct (addressed) routing, which this tool reproduces as background traffic rather than a flood — so there's no flood delivery to compare. The surrounding traffic is still reconstructed; pick a flood packet to compare actual vs predicted."
            : "The target packet couldn't be placed as a flood sender (its origin isn't a positioned repeater, or it fell just outside the fetched window). The surrounding traffic is still reconstructed and tunable.";
      }

      S.lastEpisodeMessages = null; // this flow runs from simMessageGenerators
      S.lastEpisodeTargetPid = -1;
      S.lastEpisode = {
        hash,
        windowSecs,
        fetchedAt: new Date().toISOString(),
        target: targetGen ? { nodeIndex: targetGen.nodeIndex, atMs: targetGen.atMs } : null,
        targetNote,
        targetObservers,
        allObservers,
        observerEvidence,
        // The target's observed relay chains (lowercased pubkeys) — every
        // node in them CERTAINLY transmitted (the next hop decoded it), so
        // they anchor the failure-frontier analysis.
        targetPaths: (detail.observations || []).map((o) => (o.resolved_path || []).map((x) => (x || "").toLowerCase()).filter(Boolean)),
        originInferred: !!(targetGen && !(JSON.parse((detail.packet || {}).decoded_json || "{}").pubKey)),
        deafObservers: observerEvidence.filter((o) => o.state === "busy").map((o) => o.pubkey), // legacy field for old saved setups
      };
      S.episodeBaseline = null;

      // Commit to the workspace (same shape applySetupData leaves it in).
      S.simNodes = nodes;
      S.simLinks = links;
      S.simMessageGenerators = generators;
      S.simNodePrefsOverrides = {};
      S.currentSetupId = null;
      document.getElementById("sim-setup-name").value = `CoreScope ${hash.slice(0, 8)} ±${windowSecs}s`;
      // A sim window that comfortably covers the whole reconstructed span.
      document.getElementById("sim-max-time").value = String(2 * windowMs + 5000);
      S.cachedGrid = null;

      hideResults();
      renderNodeList();
      renderMessageNodeOptions();
      renderMessageList();
      redrawNodeMarkers();
      setStatus("sim-links-status", `${links.length} links (${links.length - modelAdded} real proven + ${modelAdded} terrain-model fill) reconstructed from the window.`);
      setStatus(
        "sim-status",
        `Reconstructed ${nodes.length} repeaters, ${floodCount} flood sender${floodCount === 1 ? "" : "s"}, ${bgCount} background transmission${bgCount === 1 ? "" : "s"} from ±${windowSecs}s around ${hash.slice(0, 8)}.` +
          (skipped ? ` ${skipped} packet(s) skipped (unpositioned nodes).` : "") +
          (hitCap ? " Window hit the fetch cap — partial coverage of the oldest edge." : "") +
          " Now run the simulation, or tweak settings / run the optimizer and re-run to see if the problems shrink."
      );
      // Fit the map to the reconstructed nodes so the user sees the episode.
      if (nodes.length > 0) {
        const lats = nodes.map((n) => n.lat);
        const lons = nodes.map((n) => n.lon);
        map.fitBounds([[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]], { padding: [40, 40], maxZoom: 12 });
      }
      // Surface the episode-analysis entry point now that an episode is
      // loaded; a normal run below fills it in.
      document.getElementById("sim-open-episode-modal").classList.remove("hidden");
    } catch (err) {
      setStatus("sim-replay-hash-status", `Reconstruction failed: ${err.message || err}`);
    } finally {
      btn.disabled = false;
    }
  }

  // Computes the episode's own actual-vs-predicted figures for the target
  // packet plus the run's problem counts — the raw material both the observer
  // table and the before/after delta render from. Returns null unless an
  // episode is loaded and its target flood is present in this run.
  function computeEpisodeStats(report, messages) {
    if (!S.lastEpisode || !S.lastEpisode.target) return null;
    const t = S.lastEpisode.target;
    let targetPid = -1;
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].background && messages[i].origin === t.nodeIndex && messages[i].sendAtMs === t.atMs) {
        targetPid = i;
        break;
      }
    }
    if (targetPid < 0) return null;

    const delivered = new Set();
    for (const r of report.receptions || []) {
      if (r.packetId === targetPid && isCanonicalDelivery(r)) delivered.add(r.node);
    }
    // Re-resolve each observer's node index from its pubkey against the
    // CURRENT node set rather than trusting the index captured at
    // reconstruction — nodes may have been reordered or removed since (or the
    // episode restored from a saved setup), which would otherwise silently
    // compare against the wrong node. An observer whose node no longer exists
    // is dropped from the comparison.
    const indexByRefId = episodeIndexByRefId();
    const curIdx = (o) => (indexByRefId.has(o.pubkey) ? indexByRefId.get(o.pubkey) : -1);

    const realObservers = (S.lastEpisode.targetObservers || []).filter((o) => curIdx(o) >= 0);
    const realHeard = new Set(realObservers.map((o) => curIdx(o)));
    const observerRows = realObservers.map((o) => ({ name: o.name, simDelivered: delivered.has(curIdx(o)) }));
    const reached = observerRows.filter((o) => o.simDelivered).length;
    const recall = observerRows.length ? reached / observerRows.length : 1;

    // Observers our sim delivered the target to that reality's observation
    // list does NOT include — classified by what they were doing at the
    // target's transit (public/evidence.js): busy observers could simply have
    // missed it; a silent-active observer is proof the packet never arrived.
    const evidenceByPubkey = new Map((S.lastEpisode.observerEvidence || []).map((o) => [o.pubkey, o]));
    // Legacy saved setups predate observerEvidence — degrade their deaf list
    // to "busy" so old episodes keep rendering sensibly.
    if (evidenceByPubkey.size === 0) {
      for (const pk of S.lastEpisode.deafObservers || []) evidenceByPubkey.set(pk, { pubkey: pk, state: "busy", reason: "was transmitting at the time (legacy episode)" });
    }
    const overPredicted = [];
    for (const info of S.lastEpisode.allObservers || []) {
      const idx = curIdx(info);
      if (idx < 0 || realHeard.has(idx) || !delivered.has(idx)) continue;
      const ev = evidenceByPubkey.get(info.pubkey);
      overPredicted.push({ name: info.name, state: ev ? ev.state : "silent-unknown", reason: ev ? ev.reason : "no evidence collected" });
    }

    // Evidence-constrained reach: reality says the packet never arrived at
    // silent-active observers, so their deliveries — and every delivery whose
    // only chains pass through them — are contradicted, not predicted.
    const contradictedNodes = episodeContradictedNodes(indexByRefId);
    const targetReceptions = (report.receptions || []).filter((r) => r.packetId === targetPid);
    const constrained = HopReachEvidence.constrainDeliveries({
      receptions: targetReceptions,
      targetPid,
      contradictedNodes,
      isDelivery: isCanonicalDelivery,
    });

    const evidenceCounts = { heard: 0, busy: 0, "silent-active": 0, "silent-unknown": 0 };
    for (const o of S.lastEpisode.observerEvidence || []) if (evidenceCounts[o.state] != null) evidenceCounts[o.state]++;

    const collisions = (report.receptions || []).filter((r) => r.collided).length;
    // Ring overlay set: pruned deliveries PLUS contradicted nodes the sim
    // reached only with collided arrivals ("it got there and collided" is
    // the disputed claim too — SIMULATION_REVIEW.md L5).
    const ringNodes = new Set(constrained.prunedNodes);
    for (const r of targetReceptions) {
      if (contradictedNodes.has(r.node)) ringNodes.add(r.node);
    }
    return {
      observerRows,
      overPredicted,
      recall,
      reached,
      realCount: observerRows.length,
      modelReach: delivered.size,
      constrainedReach: constrained.keptNodes.size,
      prunedNodes: [...constrained.prunedNodes],
      ringNodes: [...ringNodes],
      contradictedNodes: [...contradictedNodes],
      evidenceCounts,
      targetPid,
      problems: {
        "Real deliveries our sim missed": observerRows.length - reached,
        "Deliveries contradicted by silent observers": constrained.prunedNodes.size,
        "Collisions across the run": collisions,
        "Reception delivery recall": Math.round(recall * 100),
      },
      recallIsPercent: true,
    };
  }

  function renderEpisodeAnalysis() {
    if (!S.lastEpisode) return;
    document.getElementById("sim-episode-provenance").innerHTML =
      `Reconstructed from packet <code>${escapeHtml(S.lastEpisode.hash)}</code> · ±${S.lastEpisode.windowSecs}s window · fetched ${escapeHtml(new Date(S.lastEpisode.fetchedAt).toLocaleString())}.`;

    const stats = S.lastReport ? computeEpisodeStats(S.lastReport, S.lastMessages || []) : null;
    episodeEvidenceLayer.clearLayers();
    if (stats && (stats.ringNodes || stats.prunedNodes).length) {
      for (const idx of stats.ringNodes || stats.prunedNodes) {
        const n = S.simNodes[idx];
        if (!n) continue;
        L.circleMarker([n.lat, n.lon], {
          radius: 14,
          color: "#d33",
          weight: 2,
          dashArray: "4 4",
          fill: false,
          interactive: true,
        })
          .bindTooltip(`${n.label}: simulated delivery contradicted — healthy observers on this path heard nothing`, { direction: "top" })
          .addTo(episodeEvidenceLayer);
      }
    }
    const recallEl = document.getElementById("sim-episode-recall");
    const obsBody = document.getElementById("sim-episode-observers-tbody");
    const probBody = document.getElementById("sim-episode-problems-tbody");
    obsBody.innerHTML = "";
    probBody.innerHTML = "";

    renderFrontierAnalysis(null);
    if (!stats) {
      recallEl.textContent = S.lastEpisode.target
        ? "Run the simulation to compare it against what really happened."
        : S.lastEpisode.targetNote || "No target packet to compare — the surrounding traffic is still reconstructed and tunable.";
      return;
    }

    const contradictedCount = stats.prunedNodes.length;
    recallEl.innerHTML =
      (stats.realCount === 0
        ? `None of this packet's real observers are in the current node set — recall can't be judged. `
        : `Our simulation delivered this packet to <strong>${stats.reached} of ${stats.realCount}</strong> repeaters that really heard it (${Math.round(stats.recall * 100)}% recall). `) +
      `Raw model spread: <strong>${stats.modelReach}</strong> nodes — evidence-constrained: <strong>${stats.constrainedReach}</strong>` +
      (contradictedCount
        ? ` (<span class="sim-episode-worse">${contradictedCount} contradicted</span> — healthy observers on those paths heard nothing, so reality says the packet did not spread there this time; contradicted nodes are ✕-ringed on the map).`
        : ".") +
      (S.lastEpisode.originInferred ? " <em>Origin approximated at the first observed relay (true sender is one RF hop upstream and unpositioned).</em>" : "");
    const evEl = document.getElementById("sim-episode-evidence");
    if (evEl) {
      const c = stats.evidenceCounts;
      evEl.innerHTML =
        `Observer evidence at the target's transit (±5min liveness lookback): ` +
        `<strong>${c.heard}</strong> heard it · <strong>${c.busy}</strong> busy (could have missed it) · ` +
        `<strong>${c["silent-active"]}</strong> healthy &amp; silent (it never reached them) · ` +
        `<strong>${c["silent-unknown"]}</strong> no sign of life (possibly offline). ` +
        `<em>Caveat: an observer transmitting its own traffic leaves no CoreScope trace, so "healthy &amp; silent" is strong evidence, not certainty.</em>`;
    }

    if (stats.observerRows.length === 0) {
      obsBody.innerHTML = '<tr><td colspan="4" class="plan-empty">None of this packet\'s real observers are in the reconstructed node set.</td></tr>';
    } else {
      for (const o of stats.observerRows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="sim-col-sticky">${escapeHtml(o.name)}</td>
          <td>✓ yes</td>
          <td class="${o.simDelivered ? "sim-optimize-round-kept" : ""}">${o.simDelivered ? "✓ yes" : "✕ no"}</td>
          <td>${o.simDelivered ? "match" : "our sim missed a real delivery"}</td>
        `;
        obsBody.appendChild(tr);
      }
      const verdictFor = (o) =>
        o.state === "busy"
          ? `busy — ${escapeHtml(o.reason)}`
          : o.state === "silent-active"
            ? `<span class="sim-episode-worse">over-predicted</span> — ${escapeHtml(o.reason)}`
            : `unknown — ${escapeHtml(o.reason)}`;
      for (const o of stats.overPredicted) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="sim-col-sticky">${escapeHtml(o.name)}</td>
          <td>${o.state === "busy" ? "— (busy)" : "✕ no"}</td>
          <td>✓ yes</td>
          <td>${verdictFor(o)}</td>
        `;
        obsBody.appendChild(tr);
      }
    }

    // Before/after problem delta.
    const now = stats.problems;
    const base = S.episodeBaseline;
    const keys = Object.keys(now);
    for (const k of keys) {
      const nowVal = now[k];
      const baseVal = base ? base[k] : null;
      const isRecall = k.includes("recall");
      let deltaText = "—";
      if (base != null && baseVal != null) {
        const d = nowVal - baseVal;
        const good = isRecall ? d > 0 : d < 0;
        const bad = isRecall ? d < 0 : d > 0;
        deltaText = d === 0 ? "no change" : `<span class="${good ? "sim-optimize-round-kept" : bad ? "sim-episode-worse" : ""}">${d > 0 ? "+" : ""}${d}${isRecall ? " pts" : ""}</span>`;
      }
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="sim-col-sticky">${escapeHtml(k)}${isRecall ? " %" : ""}</td>
        <td>${base ? baseVal : "—"}</td>
        <td>${nowVal}</td>
        <td>${deltaText}</td>
      `;
      probBody.appendChild(tr);
    }
  }

  // Case-normalized refId → node index. Planner-loaded repeaters keep
  // their original casing while CoreScope data is lowercased — a
  // case-sensitive map silently dropped observers from recall AND from
  // the contradicted set (SIMULATION_REVIEW.md C5).
  function episodeIndexByRefId() {
    return new Map(S.simNodes.map((n, i) => [String(n.refId || "").toLowerCase(), i]));
  }

  // Node indices reality contradicts, from the FULL observer evidence
  // (both entry points used to disagree — the reconstruct flow only
  // contradicted window-observers, C3), minus any node in the target's
  // own observed relay chains: those provably HAD the packet, so their
  // missing upload never contradicts delivery (C6).
  function episodeContradictedNodes(indexByRefId) {
    const out = new Set();
    if (!S.lastEpisode) return out;
    const provenPk = new Set();
    for (const path of S.lastEpisode.targetPaths || []) for (const pk of path) provenPk.add(pk);
    for (const o of S.lastEpisode.observerEvidence || []) {
      if (o.state !== "silent-active" || provenPk.has(o.pubkey)) continue;
      const idx = indexByRefId.get(o.pubkey);
      if (idx != null) out.add(idx);
    }
    return out;
  }

  // "Where did the flood die?" — the failure-frontier inference
  // (docs/REPLAY_NEGATIVE_EVIDENCE_PLAN.md round 3). The proven core
  // (origin + observed relays) certainly transmitted; compares the two
  // competing explanations for the silent observers: one local loss at the
  // proven frontier vs an independent collision at every distant receiver.
  function renderFrontierAnalysis(ensembleVerdict) {
    const el = document.getElementById("sim-episode-frontier");
    if (!el) return;
    if (!S.lastEpisode || !S.lastEpisode.target || !(S.lastEpisode.targetPaths || []).length) {
      el.textContent = "No observed relay chains to anchor a frontier analysis.";
      return;
    }
    const indexByRefId = new Map(S.simNodes.map((n, i) => [String(n.refId || "").toLowerCase(), i]));
    const proven = new Set([S.lastEpisode.target.nodeIndex]);
    for (const path of S.lastEpisode.targetPaths) {
      for (const pk of path) {
        const idx = indexByRefId.get(pk);
        if (idx != null) proven.add(idx);
      }
    }
    const stateByIndex = new Map();
    for (const o of S.lastEpisode.observerEvidence || []) {
      const idx = indexByRefId.get(o.pubkey);
      if (idx != null) stateByIndex.set(idx, o.state);
    }
    const fa = HopReachEvidence.frontierAnalysis({
      provenTransmitters: [...proven],
      links: S.simLinks,
      stateOf: (n) => stateByIndex.get(n) || null,
    });
    const silentActiveTotal = (S.lastEpisode.observerEvidence || []).filter((o) => o.state === "silent-active" && indexByRefId.has(o.pubkey)).length;
    const nameOf = (i) => (S.simNodes[i] ? S.simNodes[i].label : `#${i}`);
    const rows = fa.frontier
      .map((f) => {
        const bits = [];
        if (f.neighbors.heard.length) bits.push(`heard by ${f.neighbors.heard.map(nameOf).join(", ")}`);
        if (f.neighbors.silentActive.length) bits.push(`<span class="sim-episode-worse">copy lost at ${f.neighbors.silentActive.map(nameOf).join(", ")}</span>`);
        if (f.neighbors.other.length) bits.push(`${f.neighbors.other.length} neighbour(s) with no observer feed`);
        return `<li><strong>${escapeHtml(nameOf(f.node))}</strong> transmitted (proven)${bits.length ? " — " + bits.join(" · ") : ""}</li>`;
      })
      .join("");
    el.innerHTML =
      `<p>The packet demonstrably existed at <strong>${fa.frontier.length}</strong> transmitter(s) (origin + observed relays). ` +
      `For the flood to have <strong>died at that frontier</strong>, ${fa.lossesIfDiedLocal || "0"} copy/copies had to be lost — all in the sender's local area, plausibly one collision window. ` +
      `For the model's full spread to be true instead, <strong>${silentActiveTotal}</strong> healthy observer(s) across the wider mesh must EACH have independently lost their copy.</p>` +
      `<ul>${rows}</ul>` +
      `<p id="sim-episode-frontier-verdict">${ensembleVerdict ? ensembleVerdict : "Run the 🎲 probability analysis below to quantify which story is more likely."}</p>`;
  }

  function setEpisodeBaseline() {
    if (!S.lastEpisode || !S.lastReport) return;
    const stats = computeEpisodeStats(S.lastReport, S.lastMessages || []);
    if (!stats) return;
    S.episodeBaseline = { ...stats.problems };
    renderEpisodeAnalysis();
    setStatus("sim-status", "Pinned the current run as the before/after baseline.");
  }

  // Phase 4 of the negative-evidence plan: CoreScope stamps whole seconds,
  // so within-second ordering — and therefore which packet wins a collision
  // — is partly arbitrary in any single reconstruction. Run the episode N
  // times with ±1s timing jitter and fresh seeds and report how OFTEN the
  // target got through, instead of presenting one arbitrary ordering as
  // fact.
  async function runEpisodeProbability() {
    if (!S.lastEpisode || !S.lastEpisode.target) {
      setStatus("sim-episode-probability-status", "Load an episode with a flood target first.");
      return;
    }
    const usingEpisodeMessages = !!(S.lastEpisodeMessages && S.lastEpisodeTargetPid >= 0);
    if (!usingEpisodeMessages && (S.simMessageGenerators.length === 0 || S.simLinks.length === 0)) {
      setStatus("sim-episode-probability-status", "Reconstruct the episode (nodes/links/senders) first.");
      return;
    }
    const RUNS = 10;
    const JITTER_MS = 1000;
    const btn = document.getElementById("sim-episode-probability");
    btn.disabled = true;
    try {
      await MeshSim.ready;
      const baseSeed = parseInt(document.getElementById("sim-seed").value, 10) || 0;
      const maxSimTimeMs = parseInt(document.getElementById("sim-max-time").value, 10) || 60000;
      const t = S.lastEpisode.target;
      const scenario = scenarioFromState();
      const deliveredCount = new Map(); // node -> runs delivered (raw model)
      const keptCount = new Map(); // node -> runs delivered after evidence pruning
      let escapedRuns = 0; // runs where any contradicted-region delivery survived jitter

      // Contradicted node set is timing-independent (it's reality's verdict)
      // — same source of truth as every other consumer (C3/C5/C6).
      const evidenceByPubkey = new Map((S.lastEpisode.observerEvidence || []).map((o) => [o.pubkey, o]));
      const indexByRefId = episodeIndexByRefId();
      const contradictedNodes = episodeContradictedNodes(indexByRefId);
      // Joint-silence counting (C2): the per-run outcome we actually need.
      let validRuns = 0;
      let jointSilentRuns = 0;

      for (let run = 0; run < RUNS; run++) {
        setStatus("sim-episode-probability-status", `Run ${run + 1}/${RUNS}…`);
        const seed = baseSeed + 1000 * (run + 1);
        // Replay flow: re-run the episode's OWN messages (generators are
        // never populated there). Reconstruct flow: expand the generators.
        const messages = usingEpisodeMessages
          ? S.lastEpisodeMessages.map((m) => ({ ...m }))
          : messagesFromState(seed);
        // Find the target BEFORE jittering — by identity (sourceHash) when
        // available; (origin, sendAtMs) confuses same-second re-sends (M5).
        let targetPid = usingEpisodeMessages ? S.lastEpisodeTargetPid : -1;
        if (targetPid < 0) {
          for (let i = 0; i < messages.length; i++) {
            if (messages[i].background) continue;
            if (messages[i].sourceHash === S.lastEpisode.hash) {
              targetPid = i;
              break;
            }
          }
        }
        if (targetPid < 0) {
          for (let i = 0; i < messages.length; i++) {
            if (!messages[i].background && messages[i].origin === t.nodeIndex && messages[i].sendAtMs === t.atMs) {
              targetPid = i;
              break;
            }
          }
        }
        // Jitter every reconstructed transmission's second-resolution time.
        const jrng = mulberry32(seed ^ 0x5eed);
        for (const m of messages) {
          m.sendAtMs = Math.max(0, m.sendAtMs + Math.round((jrng() * 2 - 1) * JITTER_MS));
        }
        if (targetPid < 0) continue;
        validRuns++;
        const report = MeshSim.run(scenario, messages, seed, maxSimTimeMs);
        const targetReceptions = (report.receptions || []).filter((r) => r.packetId === targetPid);
        const deliveredNodes = new Set();
        for (const r of targetReceptions) if (isCanonicalDelivery(r)) deliveredNodes.add(r.node);
        for (const n of deliveredNodes) deliveredCount.set(n, (deliveredCount.get(n) || 0) + 1);
        // Joint outcome: did EVERY contradicted (healthy-silent) observer
        // stay clean-undelivered in this run? Deliveries share relay
        // chains, so this joint count is the honest estimator — the
        // independence product over marginals overstated "died near
        // sender" by up to ~an order of magnitude (C2).
        let allSilentThisRun = true;
        for (const idx of contradictedNodes) {
          if (deliveredNodes.has(idx)) {
            allSilentThisRun = false;
            break;
          }
        }
        if (contradictedNodes.size > 0 && allSilentThisRun) jointSilentRuns++;
        const constrained = HopReachEvidence.constrainDeliveries({
          receptions: targetReceptions,
          targetPid,
          contradictedNodes,
          isDelivery: isCanonicalDelivery,
        });
        for (const n of constrained.keptNodes) keptCount.set(n, (keptCount.get(n) || 0) + 1);
        if (constrained.prunedNodes.size > 0) escapedRuns++;
        await new Promise((r) => setTimeout(r, 0)); // keep the UI alive
      }

      if (validRuns === 0) {
        // Never fabricate a verdict from nothing (C1's failure mode).
        document.getElementById("sim-episode-probability-result").innerHTML = "";
        setStatus(
          "sim-episode-probability-status",
          "No run contained this episode's target packet — reload the episode (🔗 Replay or 🏗️ Reconstruct) and try again."
        );
        return;
      }

      // Render: per-observer delivery frequency plus the reach distribution.
      const rows = [];
      for (const info of S.lastEpisode.allObservers || []) {
        const idx = indexByRefId.has(info.pubkey) ? indexByRefId.get(info.pubkey) : -1;
        if (idx < 0) continue;
        const ev = evidenceByPubkey.get(info.pubkey);
        const real = ev && ev.state === "heard";
        const hits = deliveredCount.get(idx) || 0;
        rows.push(
          `<tr><td class="sim-col-sticky">${escapeHtml(info.name)}</td><td>${real ? "✓ yes" : ev ? escapeHtml(ev.state) : "?"}</td><td>${hits}/${validRuns} runs</td></tr>`
        );
      }
      const meanModel = [...deliveredCount.values()].reduce((a, b) => a + b, 0) / validRuns;
      const meanKept = [...keptCount.values()].reduce((a, b) => a + b, 0) / validRuns;

      // Likelihood verdict (plan round 3, estimator fixed per review C2):
      // count the JOINT outcome directly — the fraction of runs in which
      // every healthy-silent observer got no clean delivery. Deliveries to
      // those observers share relay chains, so multiplying per-observer
      // marginals as if independent overstated "died near sender". A
      // collided arrival logs nothing, so only clean deliveries count
      // against silence.
      const silentNames = [];
      for (const info of S.lastEpisode.allObservers || []) {
        const ev = evidenceByPubkey.get(info.pubkey);
        const idx = indexByRefId.has(info.pubkey) ? indexByRefId.get(info.pubkey) : -1;
        if (ev && ev.state === "silent-active" && contradictedNodes.has(idx)) silentNames.push(info.name);
      }
      let verdict = "";
      if (contradictedNodes.size > 0) {
        const pJoint = jointSilentRuns / validRuns;
        const frac = `${jointSilentRuns}/${validRuns} runs`;
        verdict =
          pJoint <= 0.15
            ? `<strong>Verdict: the flood almost certainly died near the sender.</strong> If it had spread as modelled, ALL ${contradictedNodes.size} healthy observer(s)${silentNames.length ? ` (${silentNames.map(escapeHtml).join(", ")})` : ""} stayed silent together in only ${frac} — one local loss at the proven frontier explains what the model needs a rare joint coincidence for.`
            : `<strong>Verdict: inconclusive.</strong> All ${contradictedNodes.size} healthy observer(s) stayed silent together in ${frac} under the model — the modelled spread with unlucky collisions is a plausible story here. (${validRuns} runs can only resolve to ±${Math.round(100 / validRuns)}%.)`;
        const verdictEl = document.getElementById("sim-episode-frontier-verdict");
        if (verdictEl) verdictEl.innerHTML = verdict;
      }

      document.getElementById("sim-episode-probability-result").innerHTML =
        `<p>Across ${RUNS} jittered runs: mean model reach <strong>${meanModel.toFixed(1)}</strong> nodes; ` +
        `mean evidence-constrained reach <strong>${meanKept.toFixed(1)}</strong>. ` +
        `The model spread into evidence-contradicted territory in <strong>${escapedRuns}/${validRuns}</strong> runs — ` +
        (escapedRuns === 0
          ? "model and evidence agree; nothing to reconcile."
          : escapedRuns > validRuns / 2
            ? "the model consistently over-reaches versus reality here; treat the constrained figure as the real footprint."
            : "timing luck decides it; the real packet plausibly lost such a coin toss.") +
        `</p>` +
        (verdict ? `<p>${verdict}</p>` : "") +
        `<div class="sim-config-table-scroll"><table class="sim-config-table"><thead><tr><th class="sim-col-sticky">Observer</th><th>Reality</th><th>Sim delivery rate</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
      setStatus("sim-episode-probability-status", "Done.");
    } catch (err) {
      setStatus("sim-episode-probability-status", `Failed: ${err.message || err}`);
    } finally {
      btn.disabled = false;
    }
  }

  // Every TRANSMISSION observed in the window, in chronological order — not
  // every hop. That distinction is the whole point: CoreScope's
  // resolved_path is a chain (origin → relay → relay → observer), which is
  // the single thread it managed to reconstruct, but each link in that chain
  // was a *broadcast*. These are floods (route type 0/1), not addressed
  // packets: when a repeater relays one, every repeater in earshot hears it,
  // not just the next node in the reconstructed path.
  //
  // Drawing the chain alone made a flood look like a piece of string and
  // made the rest of the mesh look like it had missed the packet, when
  // really CoreScope just has no observer positioned to report those hops.
  // So hops sharing a sender and an instant are collapsed into one
  // transmission with a list of confirmed recipients, and the renderer fans

  function init(context) {
    ({ buildLinksFromModel, buildObserverEvidence, ensureNodeDirectory, episodeEvidenceLayer, escapeHtml, extractPacketHash, fetchPacketsAroundTime, hideResults, isCanonicalDelivery, map, messagesFromState, mulberry32, originPubkeyOfPacket, randomId, redrawNodeMarkers, regionOfPacket, renderMessageList, renderMessageNodeOptions, renderNodeList, scenarioFromState, setStatus, shortAddressFromPubkey } = context);
    return api;
  }

  const api = {
    init,
    reconstructEpisodeFromWindow,
    renderEpisodeAnalysis,
    runEpisodeProbability,
    setEpisodeBaseline,
  };
  return api;
});
