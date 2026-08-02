// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");

// The planned-coverage overlay: that "Full" genuinely reaches as far as the
// real map does, that "Fast" is still the quick capped estimate, and that a
// raster split across a pool of workers reassembles into one coherent image.
//
// These run the real WASM module against real elevation tiles, which is the
// point — the failure this guards against is a preview that looks plausible
// but stops short of, or disagrees with, the coverage map underneath it.

// Full detail genuinely computes a 708x708 raster across a pool of Web
// Workers, and the first one in a fresh browser also downloads ~200 elevation
// tiles — comfortably past Playwright's 30s default, and much longer again
// when the rest of the suite is competing for the same cores. Running two of
// these at once only makes both slower, so this file goes one at a time.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(300_000);
  await gotoReady(page);
  await page.click("#plan-toggle");
  await expect(page.locator("#plan-panel")).toBeVisible();
});

// Places one repeater near Edinburgh and waits for the preview to finish.
async function placeRepeaterAndWait(page, quality) {
  await page.evaluate((q) => {
    localStorage.setItem("hopreach.previewQuality", q);
    window.MCCoverageMap.map.setView([55.9533, -3.1883], 9);
  }, quality);
  await page.reload();
  await page.evaluate(() => window.__hopreachWasmReadyPromise);
  await page.click("#plan-toggle");
  await page.evaluate(() => window.MCCoverageMap.map.setView([55.9533, -3.1883], 9));

  await page.click('.plan-mode-btn[data-mode="add-repeater"]');
  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });

  await page.waitForFunction(() => window.PlanPreview.lastRunStats() != null, null, { timeout: 240000 });
  return page.evaluate(() => window.PlanPreview.lastRunStats());
}

// Great-circle distance, so the assertions are about real kilometres on the
// ground rather than degrees.
const OVERLAY_SPAN = () =>
  // eslint-disable-next-line no-undef
  (() => {
    const o = window.PlanState.previewOverlay;
    if (!o) return null;
    const b = o.getBounds();
    const R = 6371.0088, rad = Math.PI / 180;
    const hav = (a1, o1, a2, o2) => {
      const dLat = (a2 - a1) * rad, dLon = (o2 - o1) * rad;
      const x = Math.sin(dLat / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dLon / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
    };
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
    return { heightKm: hav(s, w, n, w), widthKm: hav((s + n) / 2, w, (s + n) / 2, e) };
  })();

test("full detail searches the whole link budget, not a capped radius", async ({ page }) => {
  const stats = await placeRepeaterAndWait(page, "full");

  // The regression this exists for: the preview used to stop dead at 35km
  // while the real coverage map underneath carried on to ~78km.
  expect(stats.rangeKm, "full quality must not cap the search radius").toBeGreaterThan(60);

  const span = await page.evaluate(OVERLAY_SPAN);
  expect(span, "a preview overlay should be on the map").not.toBeNull();
  // The overlay is the site's range in every direction, so ~2x the radius.
  expect(span.widthKm).toBeGreaterThan(stats.rangeKm * 1.8);
  expect(span.heightKm).toBeGreaterThan(stats.rangeKm * 1.8);
});

test("fast detail is still the quick capped estimate", async ({ page }) => {
  const stats = await placeRepeaterAndWait(page, "fast");
  expect(stats.rangeKm).toBe(35);

  const span = await page.evaluate(OVERLAY_SPAN);
  expect(span.widthKm).toBeLessThan(90); // 2 x 35km plus rounding, nowhere near full range
});

test("the raster is split across several workers and every band comes back", async ({ page }) => {
  const stats = await placeRepeaterAndWait(page, "full");

  expect(stats.workers, "a full-range raster should be shared out, not computed by one worker").toBeGreaterThan(1);
  expect(stats.bands.length, "every band that was dispatched must report back").toBe(stats.workers);

  // Every band did real work — a band reporting no compute time means its
  // rows were silently dropped, which renders as a blank stripe.
  for (const b of stats.bands) {
    expect(b.rows, "a dispatched band with no rows").toBeGreaterThan(0);
    expect(b.computeMs).toBeGreaterThan(0);
  }
  const rows = stats.bands.reduce((n, b) => n + b.rows, 0);
  expect(rows, "the bands must add up to exactly the raster's height").toBe(stats.raster[1]);
});

test("full detail resolves more sharply than fast, at the same ground scale", async ({ page }) => {
  const fast = await placeRepeaterAndWait(page, "fast");
  const full = await placeRepeaterAndWait(page, "full");

  // Full covers ~2.2x the width, so holding the same metres-per-pixel means a
  // proportionally bigger raster — not the same raster stretched further.
  expect(full.raster[0]).toBeGreaterThan(fast.raster[0] * 2);
});

test("switching quality recomputes and replaces the overlay", async ({ page }) => {
  await placeRepeaterAndWait(page, "fast");
  const before = await page.evaluate(OVERLAY_SPAN);

  await page.selectOption("#plan-preview-quality", "full");
  await page.waitForFunction(
    () => window.PlanPreview.lastRunStats()?.quality === "full",
    null,
    { timeout: 240000 }
  );

  const after = await page.evaluate(OVERLAY_SPAN);
  expect(after.widthKm, "the overlay should grow when full detail is selected").toBeGreaterThan(before.widthKm * 1.5);
});

test("removing the last planned repeater clears the overlay", async ({ page }) => {
  await placeRepeaterAndWait(page, "fast");
  expect(await page.evaluate(OVERLAY_SPAN)).not.toBeNull();

  await page.locator('#plan-repeater-list .plan-list-item [data-act="delete"]').first().click();
  await page.waitForFunction(() => window.PlanState.previewOverlay == null, null, { timeout: 30000 });
});
