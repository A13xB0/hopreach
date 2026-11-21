// Coverage rasters the browser paints itself (the planner's preview and the
// single-repeater view): margins (dB) into RGBA pixels, and how to lay them
// on the map.
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
      // Truncated, as Go's uint8() does in marginsToImage.
      rgba[p] = Math.floor(from[0] + t * (to[0] - from[0]));
      rgba[p + 1] = Math.floor(from[1] + t * (to[1] - from[1]));
      rgba[p + 2] = Math.floor(from[2] + t * (to[2] - from[2]));
      rgba[p + 3] = alpha;
    }
    return rgba;
  }

  // Rows are spaced evenly in latitude, but Leaflet stretches an image evenly
  // in Web Mercator. Over ±0.9° at 56°N that puts coverage ~1.2 km off; drawn
  // as n bands it's ~20 m at 8. Returns each band's rows [y0, y1) and edges.
  function latitudeBands(height, north, south, n) {
    const bands = [];
    for (let i = 0; i < n; i++) {
      const y0 = Math.round((i * height) / n);
      const y1 = Math.round(((i + 1) * height) / n);
      if (y1 <= y0) continue;
      bands.push({ y0, y1, north: north - (y0 / height) * (north - south), south: north - (y1 / height) * (north - south) });
    }
    return bands;
  }

  return { SERVER_RAMP, paintMargins, latitudeBands };
});
