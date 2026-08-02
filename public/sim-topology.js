// The JS half of MeshCore's config rules and topology attributes.
//
// Every function here mirrors a specific Go one — internal/meshsim/rules.go
// (RuleCondition.matches, ConfigRule.ApplyWithAttrs, applyPolicyToScenario)
// and internal/meshsim/topology.go (findArticulationPoints,
// marginalCoverageFor, computeTopologyAttrs). The browser needs its own copy
// because SuggestPolicy computes these attributes internally and returns only
// the winning policy, so showing WHICH repeaters a policy changes means
// re-deriving them client-side.
//
// Two mirrors of the same algorithm drift unless something checks. Inside
// simulator.js nothing did: these had no direct assertions at all. As a
// module they run under node --test, against the same fixtures the Go tests
// use, so a divergence shows up as a failure rather than as a wrong action
// list.
//
// Nodes and links are parameters here, not closure variables — that is the
// entire reason this is testable.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimTopology = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Per-node real-world attributes (altitude, neighbour count) the rule
  // search can key conditional overrides on — see internal/meshsim/
  // rules.go's NodeAttrs. Altitude comes from the same terrain grid link-
  // building already fetches (or a fresh one if the last build was pure
  // "corescope", which never touches terrain); neighbour count is derived
  // straight from the currently-built links, in either direction.
  function nodeAttrs(nodes, links, grid) {
    const neighbors = nodes.map(() => new Set());
    for (const l of links) {
      if (neighbors[l.from]) neighbors[l.from].add(l.to);
      if (neighbors[l.to]) neighbors[l.to].add(l.from);
    }
    return nodes.map((n, i) => ({
      altitudeM: grid ? grid.at(n.lat, n.lon) : 0,
      neighborCount: neighbors[i].size,
    }));
  }

  // Mirrors internal/meshsim/rules.go's RuleCondition.matches — kept in
  // sync manually, same as defaultPrefs() mirroring DefaultNodePrefs. The
  // last three cases (item 15c) are additive — the older single-rule
  // "Predict settings" feature never produces a rule using them, so this
  // extension doesn't change its own existing behaviour at all.
  function ruleMatchesAttrs(rule, attrs, nodeIndex) {
    const c = rule.condition;
    switch (c.kind) {
      case "":
        return true;
      case "altitude_at_least_m":
        return attrs.altitudeM >= c.threshold;
      case "altitude_at_most_m":
        return attrs.altitudeM <= c.threshold;
      case "neighbors_at_least":
        return attrs.neighborCount >= c.threshold;
      case "neighbors_at_most":
        return attrs.neighborCount <= c.threshold;
      case "is_articulation":
        return !!attrs.isArticulation;
      case "marginal_coverage_at_least":
        return attrs.marginalCoverage >= c.threshold;
      case "node_index_in":
        // Optimizer policies target explicit node lists (rules.go
        // ConditionNodeIndexIn, JSON field `nodes`; the index is matched
        // separately from attrs, mirroring matchesNode) — without this
        // case every optimizer rule rendered through the mirror silently
        // matched nothing.
        return Array.isArray(c.nodes) && nodeIndex != null && c.nodes.includes(nodeIndex);
      default:
        return false;
    }
  }

  // Mirrors internal/meshsim/rules.go's ConfigRule.Apply.
  // Mirrors internal/meshsim/rules.go's RuleScale.valueAt exactly — linear
  // interpolation between (atMin, valueAtMin) and (atMax, valueAtMax),
  // clamped outside that range, atMin==atMax returns valueAtMin rather
  // than dividing by zero.
  function ruleScaleValueAt(scale, x) {
    if (scale.atMax === scale.atMin) return scale.valueAtMin;
    let t = (x - scale.atMin) / (scale.atMax - scale.atMin);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return scale.valueAtMin + t * (scale.valueAtMax - scale.valueAtMin);
  }

  // Mirrors internal/meshsim/rules.go's ConfigRule.ApplyWithAttrs
  // (attrs is required, not optional, unlike Go's plain Apply — every JS
  // caller already has NodeAttrs on hand, see applyPolicyToNodeState).
  // A rule's own
  // Scale, when set, computes txDelayFactor from a node attribute instead
  // of the constant txDelayFactor field — same Scale-wins tie-break as
  // the Go side if a rule somehow sets both.
  function applyRule(basePrefs, rule, attrs) {
    const out = { ...basePrefs };
    if (rule.txDelayFactor != null) out.txDelayFactor = rule.txDelayFactor;
    if (rule.directTxDelayFactor != null) out.directTxDelayFactor = rule.directTxDelayFactor;
    if (rule.rxDelayBase != null) out.rxDelayBase = rule.rxDelayBase;
    if (rule.scale) {
      const attrValue =
        rule.scale.attr === "neighbor_count" ? attrs.neighborCount :
        rule.scale.attr === "altitude_m" ? attrs.altitudeM :
        rule.scale.attr === "marginal_coverage" ? attrs.marginalCoverage :
        null;
      if (attrValue != null) out.txDelayFactor = ruleScaleValueAt(rule.scale, attrValue);
    }
    return out;
  }

  // --- item 15c: JS mirrors of the Go-side topology attributes -----------
  //
  // internal/meshsim.SuggestPolicy computes IsArticulation/MarginalCoverage
  // itself and never returns them — only the winning ConfigPolicy comes
  // back. To show which specific repeaters that policy actually changes
  // (the action list below), this needs to re-derive the same per-node
  // attributes client-side, from the same simLinks topology, using the
  // same algorithms as internal/meshsim/topology.go.

  function neighborSets(nodes, links) {
    const neighbors = nodes.map(() => new Set());
    for (const l of links) {
      if (neighbors[l.from]) neighbors[l.from].add(l.to);
      if (neighbors[l.to]) neighbors[l.to].add(l.from);
    }
    return neighbors;
  }

  // Mirrors internal/meshsim/topology.go's findArticulationPoints (Tarjan's
  // low-link DFS).
  function findArticulationPoints(neighbors) {
    const n = neighbors.length;
    const disc = new Array(n).fill(0);
    const low = new Array(n).fill(0);
    const visited = new Array(n).fill(false);
    const isArt = new Array(n).fill(false);
    let timer = 0;
    function dfs(u, parent) {
      visited[u] = true;
      timer++;
      disc[u] = timer;
      low[u] = timer;
      let children = 0;
      for (const v of neighbors[u]) {
        if (v === parent) continue;
        if (visited[v]) {
          if (disc[v] < low[u]) low[u] = disc[v];
          continue;
        }
        children++;
        dfs(v, u);
        if (low[v] < low[u]) low[u] = low[v];
        if (parent !== -1 && low[v] >= disc[u]) isArt[u] = true;
      }
      if (parent === -1 && children > 1) isArt[u] = true;
    }
    for (let i = 0; i < n; i++) {
      if (!visited[i]) dfs(i, -1);
    }
    return isArt;
  }

  // Mirrors internal/meshsim/topology.go's marginalCoverageFor.
  function marginalCoverageFor(u, neighbors) {
    let unique = 0;
    for (const v of neighbors[u]) {
      let coveredByOther = false;
      for (const w of neighbors[u]) {
        if (w === v) continue;
        if (neighbors[w].has(v)) {
          coveredByOther = true;
          break;
        }
      }
      if (!coveredByOther) unique++;
    }
    return unique;
  }

  // Mirrors internal/meshsim/topology.go's computeTopologyAttrs — the
  // JS-side counterpart used purely for rendering the action list, never
  // sent to the engine (the WASM/Go side always recomputes these itself).
  function topologyAttrs(nodes, links) {
    const neighbors = neighborSets(nodes, links);
    const isArt = findArticulationPoints(neighbors);
    return nodes.map((n, i) => ({
      neighborCount: neighbors[i].size,
      isArticulation: isArt[i],
      marginalCoverage: marginalCoverageFor(i, neighbors),
    }));
  }

  // Applies every rule in a ConfigPolicy (item 15c) to one node's baseline
  // prefs/floodMax, in order — later rules override earlier ones per-field,
  // mirroring internal/meshsim.applyPolicyToScenario exactly.
  function applyPolicyToNodeState(basePrefs, baseFloodMax, policy, attrs, nodeIndex) {
    let prefs = basePrefs;
    let floodMax = baseFloodMax;
    for (const rule of policy) {
      if (!ruleMatchesAttrs(rule, attrs, nodeIndex)) continue;
      prefs = applyRule(prefs, rule, attrs);
      if (rule.floodMax != null) floodMax = rule.floodMax;
    }
    return { prefs, floodMax };
  }

  return {
    nodeAttrs,
    ruleMatchesAttrs,
    ruleScaleValueAt,
    applyRule,
    neighborSets,
    findArticulationPoints,
    marginalCoverageFor,
    topologyAttrs,
    applyPolicyToNodeState,
  };
});
