// CARTO basemap URLs, with the deployment's API key carried when one is
// configured. CARTO's raster basemaps now require a key (they serve an
// "API KEY REQUIRED" watermark tile without one); the key arrives through
// config.yaml's map.carto_api_key or the CARTO_API_KEY environment
// variable, rendered into window.HOPREACH_CONFIG.cartoApiKey by
// `hopreach -prepare`. Pure string work, so `node --test` can reach it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HopReachCartoTiles = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // withKey("https://…/{z}/{x}/{y}{r}.png", "abc") -> "…?key=abc".
  // An empty or missing key returns the URL untouched, which is exactly
  // the pre-key behaviour: anonymous tiles, watermarked by CARTO.
  function withKey(url, key) {
    if (!key) return url;
    var sep = url.indexOf("?") >= 0 ? "&" : "?";
    return url + sep + "key=" + encodeURIComponent(key);
  }

  return { withKey };
});
