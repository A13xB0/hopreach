// Exporting a plan as KML for Google Earth: planned and adjusted repeaters, their coverage rings, and the line-of-sight chain.
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanKml = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.PlanState;

  let escapeHtml, randomId, setActivePlan;

  // --- KML export (Google Earth) --------------------------------------
  //
  // Placemarks for everything in the plan, plus coverage as GroundOverlay
  // imagery (KML's native way to drape a georeferenced raster). Two
  // sources: this plan's own predicted coverage (client-computed, no
  // persisted server file, so embedded as a data: URI to survive outside
  // this browser session) and the live site's own real-network coverage
  // for whichever "Map detail" mode is currently selected (served as real
  // files already, so referenced by absolute URL rather than embedded).
  function planToKML() {
    const parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
    parts.push(`<name>${escapeHtml(S.plan.name || "hopreach plan")}</name>`);
    parts.push(
      '<Style id="mcc-planned"><IconStyle><color>ff4ade80</color><scale>1.1</scale>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/electronics.png</href></Icon></IconStyle></Style>'
    );
    parts.push(
      '<Style id="mcc-adjusted"><IconStyle><color>ff38bdf8</color><scale>1.1</scale>' +
        '<Icon><href>http://maps.google.com/mapfiles/kml/shapes/electronics.png</href></Icon></IconStyle></Style>'
    );

    if (S.plan.repeaters.length > 0) {
      parts.push("<Folder><name>Planned repeaters</name>");
      for (const r of S.plan.repeaters) {
        const desc = [
          "Planned repeater",
          r.antennaHeightM != null ? `Mast height: ${r.antennaHeightM}m` : null,
          `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`,
        ]
          .filter(Boolean)
          .join("&#10;");
        parts.push(
          `<Placemark><name>${escapeHtml(r.label)}</name><styleUrl>#mcc-planned</styleUrl>` +
            `<description>${escapeHtml(desc)}</description>` +
            `<Point><coordinates>${r.lon},${r.lat},0</coordinates></Point></Placemark>`
        );
      }
      parts.push("</Folder>");
    }

    if (S.plan.overrides.length > 0) {
      parts.push("<Folder><name>Adjusted repeaters</name>");
      for (const o of S.plan.overrides) {
        const desc = [
          "Adjusted position",
          o.antennaHeightM != null ? `Mast height: ${o.antennaHeightM}m` : null,
          `${o.lat.toFixed(5)}, ${o.lon.toFixed(5)}`,
        ]
          .filter(Boolean)
          .join("&#10;");
        parts.push(
          `<Placemark><name>${escapeHtml(o.label || o.pubkey)}</name><styleUrl>#mcc-adjusted</styleUrl>` +
            `<description>${escapeHtml(desc)}</description>` +
            `<Point><coordinates>${o.lon},${o.lat},0</coordinates></Point></Placemark>`
        );
      }
      parts.push("</Folder>");
    }

    if (S.losChain.length > 1) {
      const coords = S.losChain.map((p) => `${p.lon},${p.lat},0`).join(" ");
      parts.push(
        "<Placemark><name>Line-of-sight chain</name><LineString><tessellate>1</tessellate>" +
          `<coordinates>${coords}</coordinates></LineString></Placemark>`
      );
    }

    const overlays = [];
    if (S.previewOverlay) {
      const b = S.previewOverlay.getBounds();
      overlays.push({
        name: "Planned coverage (preview)",
        href: S.previewOverlay.getElement().src, // already a data:image/png;base64,... URI
        north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest(),
      });
    }
    const meta = window.MCCoverageMap.currentCoverageMeta ? window.MCCoverageMap.currentCoverageMeta() : null;
    if (meta && meta.tiles) {
      for (const t of meta.tiles) {
        overlays.push({
          name: "Estimated coverage",
          href: new URL(`data/${t.image}`, location.href).href,
          north: t.bounds.North, south: t.bounds.South, east: t.bounds.East, west: t.bounds.West,
        });
      }
    }
    for (const o of overlays) {
      parts.push(
        `<GroundOverlay><name>${escapeHtml(o.name)}</name><Icon><href>${o.href}</href></Icon>` +
          `<LatLonBox><north>${o.north}</north><south>${o.south}</south><east>${o.east}</east><west>${o.west}</west></LatLonBox></GroundOverlay>`
      );
    }

    parts.push("</Document></kml>");
    return parts.join("\n");
  }





  // Deferred to init(): these run against things the context supplies, so at
  // module-load time there is nothing yet to bind to.
  function bindDom() {
    document.getElementById("plan-export-kml").addEventListener("click", () => {
      S.plan.name = document.getElementById("plan-name").value || "Untitled plan";
      const blob = new Blob([planToKML()], { type: "application/vnd.google-earth.kml+xml" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${S.plan.name.replace(/[^a-z0-9-_ ]/gi, "_")}.kml`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.getElementById("plan-import-btn").addEventListener("click", () => {
      document.getElementById("plan-import-file").click();
    });

    document.getElementById("plan-import-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported = JSON.parse(text);
        if (!Array.isArray(imported.repeaters)) throw new Error("not a valid plan file");
        imported.id = randomId(); // avoid clobbering an existing stored plan with the same id
        setActivePlan(imported);
      } catch (err) {
        alert(`Could not import plan: ${err.message || err}`);
      }
      e.target.value = "";
    });

    document.getElementById("plan-share").addEventListener("click", async () => {
      S.plan.name = document.getElementById("plan-name").value || "Untitled plan";
      const resultEl = document.getElementById("plan-share-result");
      resultEl.classList.remove("hidden");
      resultEl.textContent = "Sharing…";
      try {
        // Only structural data — no coverage raster — is ever sent; see
        // cmd/shareapi.
        const payload = { name: S.plan.name, repeaters: S.plan.repeaters, hopChains: S.plan.hopChains, overrides: S.plan.overrides, notes: S.plan.notes };
        const resp = await fetch("/api/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const { url } = await resp.json();
        const fullUrl = new URL(url, location.href).toString();
        resultEl.innerHTML = `Link (expires in 7 days): <a href="${fullUrl}">${fullUrl}</a>`;
        if (navigator.clipboard) navigator.clipboard.writeText(fullUrl).catch(() => {});
      } catch (err) {
        resultEl.textContent = `Share failed: ${err.message || err}`;
      }
    });
  }

  function init(context) {
    ({ escapeHtml, randomId, setActivePlan } = context);
    bindDom();
    return api;
  }

  const api = {
    init,

  };
  return api;
});
