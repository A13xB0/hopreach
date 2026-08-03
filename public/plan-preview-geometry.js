// Geometry and work-splitting for the plan-mode coverage preview.
//
// Pure arithmetic, no DOM, no WASM, no workers — so the decisions that
// actually determine whether a preview is correct (how far it searches, how
// sharp it is, and which slice of terrain each worker needs) can be tested
// without a browser. plan-preview.js owns the moving parts.
//
// Background: the preview and the server's nightly raster run the SAME
// physics (internal/propagation, compiled to WebAssembly), but the preview
// used to run it with a hard 35km search radius, a coarser DEM zoom and a
// fixed 320px raster, because it recomputed on every marker drag. That made
// a proposed site's coverage stop dead well short of where the real map's
// coverage for an existing site keeps going — the planner looked pessimistic
// when it was really just truncated. Quality levels replace the truncation
// with a choice.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PlanPreviewGeometry = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Ground resolution both quality levels hold. 219 m/px is what the shipped
  // preview already produced (320px across its 70km box) and is close to the
  // nightly standard raster's own resolution over a region the size of
  // Scotland, so "Full" matches the real map rather than beating it.
  const GROUND_M_PER_PX = 219;

  // Ceiling on raster width, so a plan whose sites are spread across the
  // whole region can't ask for a raster nothing can compute. Hit only by
  // genuinely huge plans; a single site at full range needs ~709.
  const MAX_IMAGE_WIDTH = 1600;

  // The two levels offered in the Plan panel.
  //
  // FAST is exactly what shipped before quality was selectable — kept
  // bit-identical so choosing it is a real "as it was", not a new
  // approximation.
  //
  // FULL removes both caps: it searches the full link-budget range and uses
  // the configured DEM zoom, which is precisely what the server's nightly
  // raster does. Its cost is roughly 5x FAST's, which is why it is a choice
  // and not the default.
  const QUALITY = {
    fast: { id: "fast", label: "Fast", maxRangeKm: 35, maxZoom: 10 },
    full: { id: "full", label: "Full", maxRangeKm: Infinity, maxZoom: Infinity },
  };

  function qualityFor(id) {
    return QUALITY[id] || QUALITY.fast;
  }

  const KM_PER_DEG_LAT = 110.574;

  function kmPerDegLon(lat) {
    return Math.max(1, 111.32 * Math.cos((lat * Math.PI) / 180));
  }

  // previewGeometry decides everything about the raster before any terrain is
  // fetched: how far to search, which DEM zoom, the lat/lon box, and the
  // pixel dimensions.
  //
  // linkBudgetKm is passed in rather than computed because it comes from
  // WebAssembly (propagation.LinkBudgetMaxRangeKm) and this module stays pure.
  function previewGeometry({ sites, linkBudgetKm, demZoom, quality }) {
    const q = qualityFor(quality);
    const rangeKm = Math.min(linkBudgetKm, q.maxRangeKm);
    const zoom = Math.min(demZoom, q.maxZoom);

    let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
    for (const s of sites) {
      const latPad = rangeKm / KM_PER_DEG_LAT;
      const lonPad = rangeKm / kmPerDegLon(s.lat);
      south = Math.min(south, s.lat - latPad);
      north = Math.max(north, s.lat + latPad);
      west = Math.min(west, s.lon - lonPad);
      east = Math.max(east, s.lon + lonPad);
    }
    const bounds = { south, north, west, east };

    const avgLat = (south + north) / 2;
    const widthKm = (east - west) * (111.32 * Math.cos((avgLat * Math.PI) / 180));
    const heightKm = (north - south) * KM_PER_DEG_LAT;

    const imageWidth = Math.max(
      1,
      Math.min(MAX_IMAGE_WIDTH, Math.round((widthKm * 1000) / GROUND_M_PER_PX))
    );
    const imageHeight = Math.max(1, Math.round(imageWidth * (heightKm / widthKm)));

    return { quality: q.id, rangeKm, zoom, bounds, imageWidth, imageHeight };
  }

  // rowCosts estimates how much work each raster row is, by counting how many
  // of its pixels are within range of any site. Rows near the top and bottom
  // of the box are mostly out-of-range corners that the raster skips with a
  // single distance check, so splitting the raster into equal ROW counts
  // would leave the middle workers doing several times the work of the edge
  // ones and everyone waiting on them.
  //
  // Sampled every `step` pixels: this only has to get the proportions right.
  function rowCosts({ sites, bounds, imageWidth, imageHeight, rangeKm }, haversineKm, step = 8) {
    const costs = new Array(imageHeight);
    for (let py = 0; py < imageHeight; py++) {
      const lat = bounds.north - ((py + 0.5) / imageHeight) * (bounds.north - bounds.south);
      let n = 0;
      for (let px = 0; px < imageWidth; px += step) {
        const lon = bounds.west + ((px + 0.5) / imageWidth) * (bounds.east - bounds.west);
        for (const s of sites) {
          if (haversineKm(lat, lon, s.lat, s.lon) <= rangeKm) {
            n++;
            break;
          }
        }
      }
      costs[py] = n;
    }
    return costs;
  }

  // splitBands cuts [0, imageHeight) into `bandCount` contiguous row bands of
  // roughly equal total cost. Every row lands in exactly one band and the
  // bands are returned in top-to-bottom order, so concatenating their results
  // reproduces the whole raster.
  //
  // Bands are never empty: with more workers than rows, the extra bands are
  // dropped rather than handed zero rows to compute.
  function splitBands(imageHeight, bandCount, costs) {
    const n = Math.max(1, Math.min(bandCount, imageHeight));
    const weights = costs && costs.length === imageHeight ? costs : new Array(imageHeight).fill(1);
    const total = weights.reduce((a, b) => a + b, 0);

    // A raster where nothing is in range of anything has no work to balance.
    if (total === 0) {
      const bands = [];
      for (let i = 0; i < n; i++) {
        bands.push({
          rowStart: Math.floor((i * imageHeight) / n),
          rowEnd: Math.floor(((i + 1) * imageHeight) / n),
        });
      }
      return bands.filter((b) => b.rowEnd > b.rowStart);
    }

    const share = total / n;
    const bands = [];
    let rowStart = 0;
    let acc = 0;
    for (let py = 0; py < imageHeight; py++) {
      acc += weights[py];
      const isLastBand = bands.length === n - 1;
      // Rows that would be left over if this band closed here, against the
      // bands still to open. Closing greedily on cost alone can starve the
      // tail, leaving the last band to cover half the raster.
      const rowsAfter = imageHeight - (py + 1);
      const bandsAfter = n - bands.length - 1;
      if (isLastBand) continue; // the final band takes whatever remains
      if (rowsAfter < bandsAfter) continue; // closing here would starve the tail
      // Close on reaching this band's share of the work — or when the tail is
      // down to exactly one row per remaining band, whichever comes first.
      if (acc >= share || rowsAfter === bandsAfter) {
        bands.push({ rowStart, rowEnd: py + 1 });
        rowStart = py + 1;
        acc = 0;
      }
    }
    bands.push({ rowStart, rowEnd: imageHeight });
    return bands;
  }

  // bandGridBounds is the slice of terrain a worker needs to compute one band
  // — and getting it wrong is silent, because demgrid clamps a lookup outside
  // its grid to the nearest edge pixel rather than failing. It would just
  // quietly model a cliff edge as a plateau.
  //
  // Every terrain sample the band takes lies on a straight line from one of
  // the sites to one of the band's own pixels, so the union of the sites'
  // positions and the band's rows bounds all of them. Longitude always spans
  // the full raster (a row does), latitude only has to reach from the
  // furthest site to the furthest row of this band — which is what makes an
  // edge band's grid much smaller than the whole raster's.
  function bandGridBounds(bounds, imageHeight, band, sites) {
    // Row edges, not centres: the band owns the full height of its rows.
    const span = bounds.north - bounds.south;
    const bandNorth = bounds.north - (band.rowStart / imageHeight) * span;
    const bandSouth = bounds.north - (band.rowEnd / imageHeight) * span;

    let south = bandSouth, north = bandNorth;
    for (const s of sites) {
      south = Math.min(south, s.lat);
      north = Math.max(north, s.lat);
    }
    return { south, north, west: bounds.west, east: bounds.east };
  }

  // poolSize picks how many workers to run a raster across.
  //
  // Bounded by cores, but also by memory: every worker builds its own DEM
  // mosaic (there is no SharedArrayBuffer here — that needs cross-origin
  // isolation, which the page's CDN script tags don't currently satisfy), so
  // N workers means N copies of the terrain. At full range that mosaic is
  // ~59MB, and an unbounded pool would be the fastest way to get the tab
  // killed on a modest machine.
  function poolSize({ cores, mosaicBytes, budgetBytes = 256 * 1024 * 1024, maxWorkers = 6 }) {
    const byCores = Math.max(1, Math.min(maxWorkers, (cores || 2) - 1));
    if (!mosaicBytes || mosaicBytes <= 0) return byCores;
    const byMemory = Math.max(1, Math.floor(budgetBytes / mosaicBytes));
    return Math.max(1, Math.min(byCores, byMemory));
  }

  // mosaicBytes is what buildLocalGrid will allocate for a bounds/zoom pair:
  // one 256x256 float32 tile per tile the box touches. Mirrors terrain.js's
  // own tile-index maths so poolSize can budget before anything is fetched.
  function mosaicBytes(bounds, zoom) {
    const n = Math.pow(2, zoom);
    const lonToTileX = (lon) => ((lon + 180) / 360) * n;
    const latToTileY = (lat) => {
      const r = (lat * Math.PI) / 180;
      return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * n;
    };
    const tilesWide = Math.floor(lonToTileX(bounds.east)) - Math.floor(lonToTileX(bounds.west)) + 1;
    const tilesHigh = Math.floor(latToTileY(bounds.south)) - Math.floor(latToTileY(bounds.north)) + 1;
    return Math.max(1, tilesWide) * Math.max(1, tilesHigh) * 256 * 256 * 4;
  }

  return {
    GROUND_M_PER_PX,
    MAX_IMAGE_WIDTH,
    QUALITY,
    qualityFor,
    previewGeometry,
    rowCosts,
    splitBands,
    bandGridBounds,
    poolSize,
    mosaicBytes,
  };
});
