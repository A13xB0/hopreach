// One repeater's coverage on its own: the pure half of focus-view.js.
//
// The map's coverage is one best-server raster of every repeater, so it can't
// be filtered to one. Instead the browser computes that repeater alone with the
// planner's preview worker (same WASM propagation as the server), at the
// position the current map mode uses, and paints it with the server's ramp.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HopReachFocus = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // internal/coverage.marginsToImage's ramp, so it reads as the same map.
  const ORANGE = [249, 115, 22];
  const GREEN = [34, 197, 94];

  // The site the server computes for this repeater in the given mode:
  // calibrated position when the mode uses one and it exists.
  function focusSite(props, lat, lon, calibrated) {
    const useCal = calibrated && props.calibrated_lat != null && props.calibrated_lon != null;
    return {
      id: props.public_key,
      lat: useCal ? props.calibrated_lat : lat,
      lon: useCal ? props.calibrated_lon : lon,
      isReal: true,
      label: props.name || null,
    };
  }

  // Margins (dB, NaN = no coverage) into RGBA pixels, in place.
  function paintMargins(rgba, margins, marginGreenDb, alpha) {
    for (let i = 0; i < margins.length; i++) {
      const m = margins[i];
      const p = i * 4;
      if (Number.isNaN(m)) {
        rgba[p + 3] = 0;
        continue;
      }
      let t = m / marginGreenDb;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      rgba[p] = ORANGE[0] + t * (GREEN[0] - ORANGE[0]);
      rgba[p + 1] = ORANGE[1] + t * (GREEN[1] - ORANGE[1]);
      rgba[p + 2] = ORANGE[2] + t * (GREEN[2] - ORANGE[2]);
      rgba[p + 3] = alpha;
    }
    return rgba;
  }

  return { focusSite, paintMargins };
});
