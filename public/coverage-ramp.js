// Coverage margins (dB) into RGBA pixels, shared by every raster the browser
// paints itself: the planner's preview and the single-repeater view.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HopReachRamp = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // internal/coverage.marginsToImage's ramp, for anything that should read
  // as the real coverage map.
  const SERVER_RAMP = [[249, 115, 22], [34, 197, 94]];

  // NaN margins are transparent; the rest run from `from` (0 dB) to `to`
  // (marginGreenDb and above). Fills rgba in place and returns it.
  function paintMargins(rgba, margins, marginGreenDb, alpha, from, to) {
    for (let i = 0; i < margins.length; i++) {
      const m = margins[i];
      const p = i * 4;
      if (Number.isNaN(m)) {
        rgba[p + 3] = 0;
        continue;
      }
      let t = m / marginGreenDb;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      rgba[p] = from[0] + t * (to[0] - from[0]);
      rgba[p + 1] = from[1] + t * (to[1] - from[1]);
      rgba[p + 2] = from[2] + t * (to[2] - from[2]);
      rgba[p + 3] = alpha;
    }
    return rgba;
  }

  return { SERVER_RAMP, paintMargins };
});
