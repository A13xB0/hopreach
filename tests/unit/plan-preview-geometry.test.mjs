// The plan-mode preview's geometry: how far it searches, how sharp it is,
// how the raster is split across workers, and which terrain each worker
// needs.
//
// Worth testing without a browser because two of these are silently wrong
// rather than loudly wrong. A band split that drops or duplicates a row
// renders a seam; a per-band terrain box that's too small doesn't fail, it
// quietly reads the DEM's clamped edge pixel and models a cliff as a plateau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const G = require("../../public/plan-preview-geometry.js");

const EDINBURGH = { lat: 55.9533, lon: -3.1883 };
const LINK_BUDGET_KM = 77.5; // what the shipped config's link budget works out to
const DEM_ZOOM = 11;

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const geom = (quality, sites = [EDINBURGH]) =>
  G.previewGeometry({ sites, linkBudgetKm: LINK_BUDGET_KM, demZoom: DEM_ZOOM, quality });

test("fast reproduces the parameters the preview shipped with", () => {
  const g = geom("fast");
  assert.equal(g.rangeKm, 35, "fast still caps the search radius at 35km");
  assert.equal(g.zoom, 10, "fast still uses the coarser DEM zoom");
  // 320px over a 70km box is what the hard-coded PREVIEW_WIDTH produced.
  assert.ok(Math.abs(g.imageWidth - 320) <= 2, `fast raster width = ${g.imageWidth}, want ~320`);
});

test("full searches the whole link budget at the configured DEM zoom", () => {
  const g = geom("full");
  assert.equal(g.rangeKm, LINK_BUDGET_KM, "full must not cap the search radius at all");
  assert.equal(g.zoom, DEM_ZOOM, "full must use the configured DEM zoom, not a capped one");
});

test("full is sharper in absolute terms but the same ground resolution as fast", () => {
  const fast = geom("fast");
  const full = geom("full");
  assert.ok(full.imageWidth > fast.imageWidth * 2, "a 2.2x wider box needs a proportionally wider raster");

  const groundRes = (g) => {
    const midLat = (g.bounds.north + g.bounds.south) / 2;
    const widthKm = (g.bounds.east - g.bounds.west) * 111.32 * Math.cos((midLat * Math.PI) / 180);
    return (widthKm * 1000) / g.imageWidth;
  };
  // Same metres-per-pixel: Full reaches further, it does not also zoom in.
  assert.ok(Math.abs(groundRes(full) - groundRes(fast)) < 5,
    `ground resolution drifted: fast ${groundRes(fast).toFixed(0)} m/px vs full ${groundRes(full).toFixed(0)} m/px`);
});

test("an unknown quality id falls back to fast rather than throwing", () => {
  assert.equal(geom("ludicrous").rangeKm, 35);
  assert.equal(geom(undefined).rangeKm, 35);
});

test("raster width is capped so a widely spread plan can't ask for the impossible", () => {
  const spread = [
    { lat: 54.6, lon: -6.5 },
    { lat: 58.9, lon: -2.9 },
  ];
  assert.ok(geom("full", spread).imageWidth <= G.MAX_IMAGE_WIDTH);
});

test("bands tile the raster exactly — every row once, in order", () => {
  const g = geom("full");
  for (const n of [1, 2, 3, 6, 7]) {
    const costs = G.rowCosts({ ...g, sites: [EDINBURGH] }, haversineKm, 16);
    const bands = G.splitBands(g.imageHeight, n, costs);
    assert.ok(bands.length > 0 && bands.length <= n, `${n} bands requested, got ${bands.length}`);
    assert.equal(bands[0].rowStart, 0);
    assert.equal(bands[bands.length - 1].rowEnd, g.imageHeight);
    for (let i = 0; i < bands.length; i++) {
      assert.ok(bands[i].rowEnd > bands[i].rowStart, `band ${i} of ${n} is empty`);
      if (i > 0) assert.equal(bands[i].rowStart, bands[i - 1].rowEnd, `gap or overlap before band ${i} of ${n}`);
    }
  }
});

test("bands are balanced by work, not by row count", () => {
  const g = geom("full");
  const costs = G.rowCosts({ ...g, sites: [EDINBURGH] }, haversineKm, 8);
  const bands = G.splitBands(g.imageHeight, 6, costs);

  const cost = (b) => costs.slice(b.rowStart, b.rowEnd).reduce((a, c) => a + c, 0);
  const costs6 = bands.map(cost);
  const spread = Math.max(...costs6) / Math.max(1, Math.min(...costs6));
  assert.ok(spread < 2, `band costs vary ${spread.toFixed(1)}x — the pool would wait on one worker`);

  // The point of balancing by cost: the middle of a disc is where the work
  // is, so an equal-work split must give the middle bands FEWER rows than
  // the mostly-out-of-range top and bottom ones.
  const rows = bands.map((b) => b.rowEnd - b.rowStart);
  const middle = rows[Math.floor(rows.length / 2)];
  assert.ok(middle < rows[0], `middle band has ${middle} rows vs ${rows[0]} at the edge — not cost-balanced`);
});

test("splitBands degrades sanely when there are more workers than rows", () => {
  const bands = G.splitBands(3, 8, null);
  assert.equal(bands.length, 3);
  assert.deepEqual(bands, [{ rowStart: 0, rowEnd: 1 }, { rowStart: 1, rowEnd: 2 }, { rowStart: 2, rowEnd: 3 }]);
});

test("splitBands still tiles the raster when no row has any work", () => {
  const bands = G.splitBands(10, 4, new Array(10).fill(0));
  assert.equal(bands[0].rowStart, 0);
  assert.equal(bands[bands.length - 1].rowEnd, 10);
  for (let i = 1; i < bands.length; i++) assert.equal(bands[i].rowStart, bands[i - 1].rowEnd);
});

test("a band's terrain box covers every path from a site to its own pixels", () => {
  // The failure this guards is silent: demgrid clamps an out-of-grid lookup
  // to the nearest edge pixel, so a too-small box returns plausible garbage.
  const g = geom("full");
  const sites = [EDINBURGH, { lat: 56.2, lon: -3.6 }];
  const costs = G.rowCosts({ ...g, sites }, haversineKm, 16);

  for (const band of G.splitBands(g.imageHeight, 5, costs)) {
    const box = G.bandGridBounds(g.bounds, g.imageHeight, band, sites);
    for (const s of sites) {
      assert.ok(s.lat >= box.south && s.lat <= box.north, "a site sits outside its own band's terrain box");
    }
    // Sample the band's own corners and centre, plus the midpoint of the
    // path from each site to each — every terrain sample lies on such a line.
    for (const py of [band.rowStart, Math.floor((band.rowStart + band.rowEnd) / 2), band.rowEnd - 1]) {
      const lat = g.bounds.north - ((py + 0.5) / g.imageHeight) * (g.bounds.north - g.bounds.south);
      for (const lon of [g.bounds.west, g.bounds.east]) {
        assert.ok(lat >= box.south && lat <= box.north, `row ${py} outside its band's box`);
        assert.ok(lon >= box.west && lon <= box.east, "raster column outside its band's box");
        for (const s of sites) {
          const midLat = (s.lat + lat) / 2;
          const midLon = (s.lon + lon) / 2;
          assert.ok(midLat >= box.south && midLat <= box.north, "path midpoint outside the band's box");
          assert.ok(midLon >= box.west && midLon <= box.east, "path midpoint outside the band's box");
        }
      }
    }
  }
});

test("edge bands need much less terrain than the whole raster", () => {
  // This is the whole reason for a per-band box: without it every worker
  // holds a full copy of the DEM and the pool is memory-bound, not CPU-bound.
  const g = geom("full");
  const bands = G.splitBands(g.imageHeight, 6, G.rowCosts({ ...g, sites: [EDINBURGH] }, haversineKm, 16));
  const whole = G.mosaicBytes(g.bounds, g.zoom);
  const top = G.mosaicBytes(G.bandGridBounds(g.bounds, g.imageHeight, bands[0], [EDINBURGH]), g.zoom);
  assert.ok(top < whole * 0.75, `top band needs ${(top / whole * 100).toFixed(0)}% of the full grid — no saving`);
});

test("pool size is bounded by memory as well as cores", () => {
  const budget = 256 * 1024 * 1024;
  assert.equal(G.poolSize({ cores: 12, mosaicBytes: 1024, budgetBytes: budget }), 6, "capped at maxWorkers");
  assert.equal(G.poolSize({ cores: 4, mosaicBytes: 1024, budgetBytes: budget }), 3, "cores - 1");
  assert.equal(G.poolSize({ cores: 1, mosaicBytes: 1024, budgetBytes: budget }), 1, "never zero workers");
  // A 100MB grid per worker must not run 6 workers against a 256MB budget.
  assert.equal(G.poolSize({ cores: 12, mosaicBytes: 100 * 1024 * 1024, budgetBytes: budget }), 2);
  assert.equal(G.poolSize({ cores: 12, mosaicBytes: 900 * 1024 * 1024, budgetBytes: budget }), 1,
    "a grid bigger than the whole budget still gets one worker, not zero");
});

test("mosaicBytes tracks how much terrain a box actually needs", () => {
  const g = geom("full");
  const bytes = G.mosaicBytes(g.bounds, g.zoom);
  // ~14x14 zoom-11 tiles over a 155km box, one float32 per 256x256 pixel.
  assert.ok(bytes > 30e6 && bytes < 90e6, `full-range mosaic = ${(bytes / 1e6).toFixed(0)}MB, expected ~50-60MB`);
  assert.ok(G.mosaicBytes(geom("fast").bounds, geom("fast").zoom) < bytes, "fast needs less terrain than full");
});
