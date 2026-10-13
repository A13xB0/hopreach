// The deployment's branding in the page header: site name and subtitle,
// the optional logo (site.logo in config.yaml) and the optional link back
// to the deployment's own website (site.home_url). All of it arrives
// through window.HOPREACH_CONFIG, rendered by `hopreach -prepare`.
//
// brandFor() is the pure part; applyBrand() only touches the elements a
// page actually has, so index.html and analytics.html share it.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HopReachBrand = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // http(s) URLs and plain relative paths only. Anything else with a
  // scheme (javascript:, data:, …) becomes "" — config.yaml is trusted,
  // but an href is not the place to find out it wasn't.
  function safeUrl(url) {
    if (typeof url !== "string") return "";
    var u = url.trim();
    if (u === "") return "";
    if (/^https?:\/\//i.test(u)) return u;
    var colon = u.indexOf(":");
    var slash = u.indexOf("/");
    if (colon >= 0 && (slash < 0 || colon < slash)) return "";
    return u;
  }

  function brandFor(cfg) {
    var c = cfg || {};
    return {
      title: c.siteName || "",
      subtitle: c.siteSubtitle || "",
      logoUrl: safeUrl(c.logoUrl),
      homeUrl: safeUrl(c.homeUrl),
    };
  }

  // opts.title: also set the h1/subtitle text and document.title (the map
  // page; the analytics page keeps its own heading).
  function applyBrand(doc, cfg, opts) {
    var b = brandFor(cfg);
    var o = opts || {};
    if (o.title) {
      var h1 = doc.getElementById("site-title");
      var sub = doc.getElementById("site-subtitle");
      if (h1) h1.textContent = b.title;
      if (sub) {
        // No subtitle: drop the line so the title centres on the logo.
        sub.textContent = b.subtitle;
        sub.hidden = !b.subtitle;
      }
      if (b.title) doc.title = b.title;
    }
    var logo = doc.getElementById("site-logo");
    if (logo && b.logoUrl) {
      logo.src = b.logoUrl;
      logo.alt = b.title ? b.title + " logo" : "Logo";
      logo.hidden = false;
    }
    var link = doc.getElementById("site-brand");
    if (link && b.homeUrl) link.href = b.homeUrl;
    return b;
  }

  return { safeUrl, brandFor, applyBrand };
});
