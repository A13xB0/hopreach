// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");

// Two close-together points (~500m apart, well within simulator.js's
// SIM_MAX_RANGE_KM) near Loch Lomond — real Scottish terrain, so DEM tiles
// genuinely exist there. Seeded straight into localStorage (the same
// "hopreach.plans" key/shape planner.js itself reads — see its STORAGE_KEY
// and emptyPlan()) rather than driven via imprecise map-pixel clicks: this
// test cares about exact geographic control (a real link, a fast terrain
// grid), not exercising the click-to-place UI itself (already covered by
// planning.spec.js).
const TEST_PLAN = {
  id: "e2e-sim-test-plan",
  name: "E2E Sim Test Plan",
  repeaters: [
    { id: "sim-r1", label: "Sim Test Repeater A", lat: 56.0, lon: -4.6, antennaHeightM: null },
    { id: "sim-r2", label: "Sim Test Repeater B", lat: 56.005, lon: -4.6, antennaHeightM: null },
  ],
  hopChains: [],
  overrides: [],
  notes: "",
};

// This file's tests all use "Load planned repeaters" (client-only, from
// the seeded plan above), never "Load real repeaters" — no need to wait
// on the live CoreScope fetch (see helpers.js).
test.beforeEach(async ({ page }) => {
  await page.addInitScript((plan) => {
    localStorage.setItem("hopreach.plans", JSON.stringify({ [plan.id]: plan }));
  }, TEST_PLAN);
  await gotoReady(page);
});

test("simulate panel opens and is mutually exclusive with the plan panel", async ({ page }) => {
  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();

  await page.click("#plan-toggle");
  await expect(page.locator("#plan-panel")).toBeVisible();
  await expect(page.locator("#sim-panel")).toBeHidden();

  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();
  await expect(page.locator("#plan-panel")).toBeHidden();
});

test("loads planned repeaters, builds links, runs a simulation, and predicts settings", async ({ page }) => {
  test.slow(); // link-building fetches real DEM tiles + predict-settings runs many trials

  // Load the seeded plan so its repeaters are available to "Load planned
  // repeaters" (planner.js never auto-resumes a saved plan on its own).
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await expect(page.locator("#plan-repeater-list .plan-list-item")).toHaveCount(2);
  await page.click("#plan-toggle"); // back off plan mode; also closes the plan panel

  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();

  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-list .plan-list-item")).toHaveCount(2);
  await expect(page.locator("#sim-node-list")).toContainText("Sim Test Repeater A");
  await expect(page.locator("#sim-node-list")).toContainText("Sim Test Repeater B");

  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await expect(page.locator("#sim-links-status")).toContainText("built");

  const linkCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getLinkCount());
  expect(linkCount, "expected at least one link between two repeaters 500m apart").toBeGreaterThan(0);

  await page.selectOption("#sim-message-node", { index: 0 });
  await page.click("#sim-message-add");
  await expect(page.locator("#sim-message-list .plan-list-item")).toHaveCount(1);

  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  await expect(page.locator("#sim-results-section")).toBeVisible();
  await expect(page.locator("#sim-results-summary")).toContainText("reception");

  const report = await page.evaluate(() => window.__hopreachSimulatorDebug.getLastReport());
  expect(report).not.toBeNull();
  expect(report.receptions.length).toBeGreaterThan(0);

  await page.fill("#sim-trials", "5"); // keep the search fast for a CI run
  await page.click("#sim-predict");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  await expect(page.locator("#sim-suggestions-section")).toBeVisible();
  await expect(page.locator("#sim-suggestions-list .plan-list-item").first()).toBeVisible();
});

test("clear all removes loaded nodes and hides results", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-list .plan-list-item")).toHaveCount(2);

  await page.click("#sim-nodes-clear");
  await expect(page.locator("#sim-node-list")).toContainText("None yet");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBe(0);
});

test("places a virtual companion location by clicking the map, and stops when toggled off", async ({ page }) => {
  await page.click("#sim-toggle");
  await page.click("#sim-add-companion");
  await expect(page.locator("#sim-add-companion")).toHaveClass(/active/);
  await expect(page.locator("#sim-companion-hint")).toBeVisible();

  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(page.locator("#sim-node-list")).toContainText("Companion 1");
  await expect(page.locator(".sim-marker-companion")).toHaveCount(1);
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBe(1);

  // Toggling placement off means further map clicks don't add more nodes.
  await page.click("#sim-add-companion");
  await expect(page.locator("#sim-add-companion")).not.toHaveClass(/active/);
  await map.click({ position: { x: box.width / 4, y: box.height / 4 } });
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBe(1);
});

test("runs a replay after a simulation and can skip to the final state", async ({ page }) => {
  test.slow(); // link-building fetches real DEM tiles

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getLinkCount())).toBeGreaterThan(0);

  await page.selectOption("#sim-message-node", { index: 0 });
  await page.click("#sim-message-add");
  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });

  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getWaveCount())).toBeGreaterThan(0);
  await expect(page.locator("#sim-replay-status")).toBeVisible();

  await page.click("#sim-skip-to-end");
  await expect(page.locator("#sim-replay-status")).toContainText("final state");
});

// The one test in this file that genuinely depends on the container's
// background fetch reaching a live, third-party CoreScope instance over
// the real network (see tests/basic.spec.js's own isolated CoreScope test
// for why this is kept separate, generously timed, and not something the
// rest of the suite's readiness gate waits on).
test("builds real links from CoreScope's observed reach data", async ({ page }) => {
  test.slow();
  await page.click("#sim-toggle");
  await page.click("#sim-load-real");
  await expect(page.locator("#sim-node-list .plan-list-item").first()).toBeVisible({ timeout: 120_000 });

  await page.selectOption("#sim-connectivity-source", "corescope");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await expect(page.locator("#sim-links-status")).toContainText("built");

  const linkCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getLinkCount());
  expect(linkCount, "expected at least one real observed link among the site's real repeaters").toBeGreaterThan(0);
});
