// @ts-check
const { test, expect } = require("@playwright/test");

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

test.beforeEach(async ({ page }) => {
  await page.addInitScript((plan) => {
    localStorage.setItem("hopreach.plans", JSON.stringify({ [plan.id]: plan }));
  }, TEST_PLAN);
  await page.goto("/");
  await expect(page.locator("#count-active")).not.toHaveText("–", { timeout: 60_000 });
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
