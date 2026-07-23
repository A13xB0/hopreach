// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");

// None of this file's tests touch real repeater data (add-repeater/LOS are
// client-only bookkeeping, companion pin is pure UI state) — see
// helpers.js for why readiness here doesn't wait on the live CoreScope
// fetch.
test.beforeEach(async ({ page }) => {
  await gotoReady(page);
});

test("plan panel opens, add-repeater places markers via map clicks, closes", async ({ page }) => {
  await page.click("#plan-toggle");
  await expect(page.locator("#plan-panel")).toBeVisible();
  await expect(page.locator("#map-wrap")).toHaveClass(/plan-open/);

  await page.click('.plan-mode-btn[data-mode="add-repeater"]');
  await expect(page.locator('.plan-mode-btn[data-mode="add-repeater"]')).toHaveClass(/active/);

  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  // Two clicks well apart — addRepeaterAt (see planner.js) is purely
  // synchronous bookkeeping (push to plan.repeaters, re-render the list),
  // so no wait for terrain/network is needed before asserting the count.
  // The offset has to clear the first marker's own icon footprint: a
  // second click landing on top of it hits the marker (which stops
  // propagation to the map's own click handler in Leaflet), not empty map,
  // and addRepeaterAt never fires for it.
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await map.click({ position: { x: box.width / 2 + 100, y: box.height / 2 + 100 } });

  await expect(page.locator("#plan-repeater-list .plan-list-item")).toHaveCount(2);

  await page.click("#plan-panel-close");
  await expect(page.locator("#plan-panel")).toBeHidden();
});

test("LOS mode builds a hop chain from map clicks", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.click('.plan-mode-btn[data-mode="los"]');
  await expect(page.locator('.plan-mode-btn[data-mode="los"]')).toHaveClass(/active/);

  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await map.click({ position: { x: box.width / 2 + 100, y: box.height / 2 + 100 } });

  await expect(page.locator("#plan-los-list .plan-list-item")).toHaveCount(2);

  await page.click("#plan-los-clear");
  await expect(page.locator("#plan-los-list")).toContainText("Click the map");
});

test("companion pin toggles on and off", async ({ page }) => {
  const toggle = page.locator("#companion-pin-toggle");
  await toggle.click();
  await expect(toggle).toHaveClass(/active/);
  await expect(page.locator("#companion-pin-hint")).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toHaveClass(/active/);
  await expect(page.locator("#companion-pin-hint")).toBeHidden();
});
