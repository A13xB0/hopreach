// Connectivity building: turning a node set into the directed, SNR-valued link graph the engine runs on — from the propagation model, from observed CoreScope reach, or a blend of both.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimLinks = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
  const { SIM_MAX_RANGE_KM, SIM_ZOOM_CAP, CORESCOPE_REACH_DAYS } = window.SimConstants;

  let SF_THRESHOLDS_DB, cfg, effectiveNodeType, effectivePrefsFor, setStatus, updateWorkflowState;

  // --- connectivity building --------------------------------------------

  function boundsForNodes(nodes) {
    let south = 90, north = -90, west = 180, east = -180;
    for (const n of nodes) {
      south = Math.min(south, n.lat);
      north = Math.max(north, n.lat);
      west = Math.min(west, n.lon);
      east = Math.max(east, n.lon);
    }
    // Pad by the max propagation range so pairs near the bbox edge still
    // get a terrain grid wide enough to cover the path between them.
    const padDeg = SIM_MAX_RANGE_KM / 111;
    return { south: south - padDeg, north: north + padDeg, west: west - padDeg, east: east + padDeg };
  }

  // Only nodes with at least one OTHER node within propagation range can
  // ever get a model-derived link at all (buildLinksFromModel already
  // skips any pair beyond SIM_MAX_RANGE_KM) — so a node with no in-range
  // neighbour contributes nothing but wasted bounding-box area. This
  // matters because the loaded node set isn't always geographically
  // compact: a packet replayed from CoreScope (see replayFromHash) can
  // pull in nodes from genuinely distant clusters — one real observed
  // packet's path spanned Scotland to Ireland, a real link far past this
  // tool's own SIM_MAX_RANGE_KM planning default (not a bug in the real
  // network — evidently a genuinely long, well-sited RF link — just one
  // our model doesn't attempt to predict). Fetching one terrain grid
  // covering that whole gap would mean requesting on the order of a
  // thousand DEM tiles at once, enough to genuinely exhaust the browser's
  // own connection resources (observed directly during testing, not a
  // hypothetical).
  function nodesWithInRangeNeighbor(nodes) {
    const keep = new Set();
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        if (Propagation.haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon) <= SIM_MAX_RANGE_KM) {
          keep.add(i);
          keep.add(j);
        }
      }
    }
    return nodes.filter((_, i) => keep.has(i));
  }

  function estimateTileCount(bounds, zoom) {
    const minTileX = Math.floor(Terrain.lonToTileX(bounds.west, zoom));
    const maxTileX = Math.floor(Terrain.lonToTileX(bounds.east, zoom));
    const minTileY = Math.floor(Terrain.latToTileY(bounds.north, zoom));
    const maxTileY = Math.floor(Terrain.latToTileY(bounds.south, zoom));
    return (maxTileX - minTileX + 1) * (maxTileY - minTileY + 1);
  }

  const MAX_GRID_TILES = 400; // keeps one grid fetch well within the browser's concurrent-request budget, even for a legitimately long, densely-spaced chain

  // Converts a propagation-model margin (dB above the receiver's
  // sensitivity spec) into an approximate SNR for meshsim's threshold
  // check. Not a physically rigorous SNR derivation — margin and SNR are
  // different quantities — but a reasonable, clearly-documented proxy:
  // margin==0 (right at the sensitivity floor) is mapped to exactly that
  // SF's own reception threshold (right at the edge of decodability), and
  // margin scales 1:1 in dB from there, since both quantities move
  // linearly with received power. Good for relative comparisons between
  // candidate settings; not a certified RF measurement.
  function approxSnrFromMargin(marginDb, sf) {
    return self.HopReachMeshModel.approxSnrFromMargin(marginDb, sf);
  }

  // CoreScope's reach API doesn't expose a raw SNR reading at all — only
  // real observation counts (we_hear/they_hear: how many times this
  // link's traffic was actually seen in each direction). This converts
  // "how many times we've actually seen it work" into the same SNR-shaped
  // number the engine's threshold check understands, rather than
  // borrowing the propagation model's own prediction — real traffic having
  // happened at all already accounts for everything the terrain model
  // can't see (foliage, buildings, antenna orientation, interference), so
  // it's arguably more trustworthy than a model guess for these specific
  // pairs. More observations -> a higher, safer estimate, capped so a
  // very high count doesn't produce an absurd value; even a single
  // observation clears every SF's threshold, since it genuinely happened.
  function snrFromObservationCount(count, sf) {
    const idx = Math.min(Math.max(sf - 7, 0), 5);
    const threshold = SF_THRESHOLDS_DB[idx];
    if (count <= 0) return threshold - 10;
    return threshold + Math.min(15, Math.log2(1 + count) * 3);
  }

  // ensureGrid returns the cached terrain grid if one's already been built
  // for the current node set, or fetches one fresh — used both by
  // buildLinksFromModel and, independently, by predictSettings() for
  // altitude lookups even when the last link build used pure "corescope"
  // connectivity (which never touches terrain at all).
  async function ensureGrid(nodes) {
    if (S.cachedGrid) return S.cachedGrid;
    await Propagation.ready;
    const clustered = nodesWithInRangeNeighbor(nodes);
    if (clustered.length < 2) {
      throw new Error("no two nodes are within propagation range of each other — nothing to fetch terrain for");
    }
    const bounds = boundsForNodes(clustered);
    // Even after clustering, a legitimately long, densely-spaced chain
    // could still need a big grid — fall back to a coarser zoom rather
    // than fetching an unbounded number of tiles, down to a floor past
    // which the terrain data would be too coarse to be useful anyway.
    let zoom = Math.min(cfg.demZoom, SIM_ZOOM_CAP);
    while (zoom > 4 && estimateTileCount(bounds, zoom) > MAX_GRID_TILES) zoom--;
    if (estimateTileCount(bounds, zoom) > MAX_GRID_TILES) {
      throw new Error(`the involved area is too large to fetch terrain for (${estimateTileCount(bounds, zoom)} tiles even at the coarsest usable zoom)`);
    }
    S.cachedGrid = await Terrain.buildLocalGrid(cfg.demTileURLBase, zoom, bounds);
    return S.cachedGrid;
  }

  // The spreading factor a directed link's SNR must be anchored to is the
  // RECEIVER's own SF — that's the SF the engine checks this reception
  // against (internal/meshsim/engine.go: snrThresholdForSF(listener SF)),
  // so approxSnrFromMargin/snrFromObservationCount must map "margin 0 /
  // one observation" onto the RECEIVER's threshold or the engine silently
  // rejects the link as weak_signal. Previously hardcoded to 11 (the old
  // default preset's SF); the default is now the EU/UK (Narrow) SF8 preset,
  // and a per-node SF override can differ again — so it must be read
  // per-receiver, not assumed. (This is also why applyNodesModalTable now
  // calls invalidateLinks() when a radio setting changes: the baked-in SNR
  // is receiver-SF-specific and must be rebuilt if that SF changes.)
  function receiverSf(node) {
    return effectivePrefsFor(node).radio.sf;
  }

  // Two nodes can only form a modelled radio link if their radios are
  // actually compatible — a LoRa receiver must match the transmitter's
  // centre frequency, bandwidth, and spreading factor to demodulate at
  // all (CR rides in the explicit header, so it needn't match). Nodes on
  // different frequencies genuinely cannot hear each other, and a SF8
  // receiver cannot decode a SF12 transmission. Every node defaults to the
  // same preset, so this changes nothing for a normal uniform-config mesh
  // (the only kind real MeshCore runs) — it only stops the per-node radio
  // override from silently producing physically-impossible links between
  // mismatched radios, which would otherwise read as connectivity that
  // could never exist. Because interference audibility also flows through
  // links (see engine.go audibleTo), this one gate keeps both decoding and
  // interference consistent: mismatched-radio nodes neither hear nor jam
  // each other.
  function radiosCompatible(a, b) {
    const ra = effectivePrefsFor(a).radio;
    const rb = effectivePrefsFor(b).radio;
    return ra.freqMhz === rb.freqMhz && ra.bwKhz === rb.bwKhz && ra.sf === rb.sf;
  }

  // A node's own antenna height above ground (metres), used on BOTH ends of
  // a modelled link. A planned/real repeater uses its configured mast height
  // (falling back to the global repeater default); a companion is a handheld
  // client device, not a mast, so it uses the receiver/handheld height
  // instead. Getting this per-node right matters most for repeater-to-
  // repeater links — the entire subject of the flood simulation — which were
  // previously all computed at the single global default height.
  function nodeAntennaHeightM(node) {
    if (node.antennaHeightM != null) return node.antennaHeightM;
    // Effective type, not source: switching a node to companion is asking
    // "what if this were a handheld", and a handheld isn't on a mast — so
    // the height has to follow, which is also why a type change
    // invalidates modelled links (see the apply path in the nodes table).
    if (effectiveNodeType(node) === "companion") return cfg.propagation.rxHeightM;
    return cfg.propagation.antennaHeightM;
  }

  // The propagation model bakes the receiver height into its Params
  // (RxHeightM), but a modelled link's receiver is itself a repeater with
  // its own mast height — so we hand pathMargin a params variant whose
  // rxHeightM is the RECEIVER node's own height. Cached by height value so a
  // whole mesh of same-height repeaters shares one Wasm params handle rather
  // than marshalling a fresh one per link (see propagation.js handleFor).
  const rxHeightParamsCache = new Map();
  function propagationForRxHeight(rxHeightM) {
    let p = rxHeightParamsCache.get(rxHeightM);
    if (!p) {
      p = { ...cfg.propagation, rxHeightM };
      rxHeightParamsCache.set(rxHeightM, p);
    }
    return p;
  }

  async function buildLinksFromModel(nodes) {
    const grid = await ensureGrid(nodes);
    const links = [];
    const baseTxPowerDbm = cfg.propagation.txPowerDbm;
    for (let i = 0; i < nodes.length; i++) {
      const groundM = grid.at(nodes[i].lat, nodes[i].lon);
      const txHeightASL = groundM + nodeAntennaHeightM(nodes[i]);
      // Received power scales 1:1 with transmit power, and margin is just
      // received power minus a fixed sensitivity/fade — so a node's own
      // `set tx` deviation from the model's baseline power shifts the margin
      // by exactly that difference. This is what finally lets a tx-power
      // change actually affect the simulation (previously it was ignored
      // entirely — the model always used the config's single tx power).
      const txPowerDelta = (effectivePrefsFor(nodes[i]).txPowerDbm ?? baseTxPowerDbm) - baseTxPowerDbm;
      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        if (!radiosCompatible(nodes[i], nodes[j])) continue; // mismatched radios can't communicate — see radiosCompatible
        const d = Propagation.haversineKm(nodes[i].lat, nodes[i].lon, nodes[j].lat, nodes[j].lon);
        if (d > SIM_MAX_RANGE_KM) continue;
        // Receiver is j — anchor the receiver height to j's own antenna.
        const p = propagationForRxHeight(nodeAntennaHeightM(nodes[j]));
        let margin = Propagation.pathMargin(grid, p, nodes[i].lat, nodes[i].lon, txHeightASL, nodes[j].lat, nodes[j].lon, d);
        margin += txPowerDelta;
        if (margin < 0) continue; // below the model's own reception threshold — not a link
        links.push({ from: i, to: j, snrDb: approxSnrFromMargin(margin, receiverSf(nodes[j])) });
      }
    }
    return links;
  }

  // Fetches nodeIndex's real observed reach data and returns the confirmed
  // directed links it implies. we_hear > 0 means this node has actually
  // heard the neighbour (neighbour -> this node); they_hear > 0 means the
  // neighbour has actually heard this node (this node -> neighbour) — two
  // independent, potentially asymmetric real observations, not a single
  // "bidir" flag.
  async function fetchCorescopeLinksFor(nodeIndex, nodes) {
    const n = nodes[nodeIndex];
    if (n.source !== "real") return [];
    const resp = await fetch(`${MeshApi.BASE}/nodes/${encodeURIComponent(n.refId)}/reach?days=${CORESCOPE_REACH_DAYS}`);
    if (!resp.ok) return [];
    const data = await resp.json();
    const links = [];
    for (const l of data.links || []) {
      const targetIdx = nodes.findIndex((x) => x.source === "real" && x.refId === l.pubkey);
      if (targetIdx === -1) continue;
      // Anchor each direction's SNR to ITS OWN receiver's SF (see
      // receiverSf / buildLinksFromModel). we_hear is neighbour -> this
      // node (receiver = this node); they_hear is this node -> neighbour
      // (receiver = the neighbour).
      if (typeof l.we_hear === "number" && l.we_hear > 0) {
        links.push({ from: targetIdx, to: nodeIndex, snrDb: snrFromObservationCount(l.we_hear, receiverSf(n)) });
      }
      if (typeof l.they_hear === "number" && l.they_hear > 0) {
        links.push({ from: nodeIndex, to: targetIdx, snrDb: snrFromObservationCount(l.they_hear, receiverSf(nodes[targetIdx])) });
      }
    }
    return links;
  }

  async function buildLinksFromCorescope(nodes) {
    const realIndices = nodes.map((n, i) => i).filter((i) => nodes[i].source === "real");
    const perNode = await Promise.all(realIndices.map((i) => fetchCorescopeLinksFor(i, nodes)));
    // Every real node's own reach query independently reports both
    // directions of each relationship it knows about — node A's data can
    // say "they_hear" B (A -> B) while node B's own, separately-fetched
    // data says "we_hear" A (also A -> B): the same real-world fact,
    // reported from both sides. Querying every node means that same
    // directed pair lands in the flattened list twice, which the engine
    // would then treat as two distinct links — delivering the same
    // transmission to the same listener twice (visible as an identical
    // reception row appearing more than once for one packet). Dedupe by
    // (from,to), keeping the stronger of the two SNR estimates whenever
    // both sides independently reported the same pair.
    const best = new Map();
    for (const l of perNode.flat()) {
      const key = `${l.from}:${l.to}`;
      const existing = best.get(key);
      if (!existing || l.snrDb > existing.snrDb) best.set(key, l);
    }
    return [...best.values()];
  }

  function isolatedNodeHint(nodes, links) {
    const connected = new Set();
    for (const l of links) {
      connected.add(l.from);
      connected.add(l.to);
    }
    const isolated = nodes.map((n, i) => (connected.has(i) ? null : n.label)).filter(Boolean);
    if (isolated.length === 0) return "";
    return ` ${isolated.length} node${isolated.length === 1 ? "" : "s"} with no links: ${isolated.join(", ")}.`;
  }

  async function buildLinks() {
    if (S.simNodes.length < 2) {
      setStatus("sim-links-status", "Load at least 2 nodes first.");
      return;
    }
    const generation = ++S.linksGeneration;
    const source = document.getElementById("sim-connectivity-source").value;
    setStatus("sim-links-status", "Building connectivity…");
    document.getElementById("sim-build-links").disabled = true;
    try {
      const nodesSnapshot = S.simNodes;
      let links;
      if (source === "model") {
        links = await buildLinksFromModel(nodesSnapshot);
      } else if (source === "corescope") {
        links = await buildLinksFromCorescope(nodesSnapshot);
      } else {
        // blend: observed where CoreScope has real data, model fills every
        // gap (including any pair involving a planned repeater or
        // companion location, which CoreScope has no history for at all).
        const [modelLinks, observedLinks] = await Promise.all([buildLinksFromModel(nodesSnapshot), buildLinksFromCorescope(nodesSnapshot)]);
        const observedPairs = new Set(observedLinks.map((l) => `${l.from}:${l.to}`));
        links = observedLinks.concat(modelLinks.filter((l) => !observedPairs.has(`${l.from}:${l.to}`)));
      }
      if (generation !== S.linksGeneration) return; // node set changed mid-build; discard stale result
      S.simLinks = links;
      setStatus(
        "sim-links-status",
        `${S.simLinks.length} directed link${S.simLinks.length === 1 ? "" : "s"} built (${source}).${isolatedNodeHint(nodesSnapshot, S.simLinks)}`
      );
      updateWorkflowState();
    } catch (err) {
      if (generation !== S.linksGeneration) return;
      setStatus("sim-links-status", `Failed to build links: ${err.message || err}`);
    } finally {
      if (generation === S.linksGeneration) document.getElementById("sim-build-links").disabled = false;
    }
  }


  function init(context) {
    ({ SF_THRESHOLDS_DB, cfg, effectiveNodeType, effectivePrefsFor, setStatus, updateWorkflowState } = context);
    return api;
  }

  const api = {
    init,
    buildLinks,
    buildLinksFromCorescope,
    buildLinksFromModel,
    ensureGrid,
    isolatedNodeHint,
  };
  return api;
});
