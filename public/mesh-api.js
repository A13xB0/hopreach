// The browser's single door to mesh observation data.
//
// Every fetch of nodes, links, scopes or packets goes through here, and the
// base path lives in exactly one place. Before this, three front-end files
// each fetched a vendor's API directly (`/corescope-api/…`) and parsed that
// vendor's field names — so supporting a second backend would have meant a
// second parser in each of them, and a 7500-line simulator.js owned its own
// HTTP layer on top of everything else it does.
//
// HopReach now serves whichever backend is configured (CoreScope, MeshCore
// Beacon, …) in one stable shape from /mesh-api/ — see internal/meshapi,
// docs/DATA_SOURCE_SPEC.md and docs/BEACON_COMPATIBILITY_PLAN.md. Switching
// backend is a server config change; nothing here moves.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.MeshApi = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // One definition. If it ever needs to vary per deployment, it varies here.
  const BASE = "/mesh-api/api";

  async function getJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`${url} → HTTP ${resp.status}`);
    }
    return resp.json();
  }

  /** Region/scope names known to the backend. */
  async function scopes() {
    const data = await getJSON(`${BASE}/scope-stats`);
    return (data.byRegion || []).map((r) => r && r.name).filter(Boolean);
  }

  /** Every repeater the backend knows, with positions. */
  async function nodes(limit = 5000) {
    const data = await getJSON(`${BASE}/nodes?limit=${limit}`);
    return data.nodes || [];
  }

  /** Observed links from one node — evidence, not prediction. */
  async function reach(pubkey, days) {
    const data = await getJSON(
      `${BASE}/nodes/${encodeURIComponent(pubkey)}/reach?days=${days}`
    );
    return data.links || [];
  }

  /**
   * Packets heard in [fromMs, toMs].
   *
   * This asks for a time range, not a page. The old code binary-searched
   * `offset` backwards because CoreScope has no time filter; that workaround
   * now lives behind the server-side interface — and on a backend that
   * filters by time (Beacon does) it disappears entirely.
   */
  async function packetsBetween(fromMs, toMs, limit = 500) {
    const data = await getJSON(
      `${BASE}/packets?since=${Math.floor(fromMs)}&until=${Math.ceil(toMs)}` +
        `&limit=${limit}`
    );
    return data.packets || [];
  }

  /** One packet with EVERY observation of it. */
  async function packetDetail(hash) {
    return getJSON(`${BASE}/packets/${encodeURIComponent(hash)}`);
  }

  /** Which backend is behind the API, for display. */
  async function sourceName() {
    try {
      const data = await getJSON(`${BASE}/source`);
      return data.source || "";
    } catch {
      return "";
    }
  }

  /**
   * True when every hop of a path was actually resolved.
   *
   * A backend that reports resolution confidence (Beacon) can tell us a hop
   * was ambiguous; the API then sends an empty string in that position rather
   * than dropping it, so hop counts stay truthful. Callers should treat a
   * false here as "this reconstruction is partial" rather than presenting it
   * as fact.
   */
  function pathComplete(entry) {
    if (!entry) return false;
    if (typeof entry.path_complete === "boolean") return entry.path_complete;
    // Backends without a confidence signal never report partial paths.
    return true;
  }

  return {
    BASE,
    scopes,
    nodes,
    reach,
    packetsBetween,
    packetDetail,
    sourceName,
    pathComplete,
  };
});
