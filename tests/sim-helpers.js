// @ts-check

// Fixtures and page helpers shared by the simulator specs.
//
// These lived at the top of a 1748-line simulator.spec.js. Splitting that
// file by feature meant every part needed them, so they moved here rather
// than being copied — a drifted copy of openAccordion would fail in ways
// that look like a UI regression.
const { gotoReady } = require("./helpers");

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

// Registers the shared setup: seed the plan above into localStorage, then
// wait for the page to be genuinely interactive.
//
// A registrar rather than a bare beforeEach, because a beforeEach in a
// required module attaches to whichever file happened to require it first —
// Playwright would then run it for the wrong specs, or not at all. Each spec
// calls this explicitly.
//
// These specs all use "Load planned repeaters" (client-only, from the seeded
// plan), never "Load real repeaters", so there is no need to wait on a live
// CoreScope fetch — see helpers.js.
function useSeededPlan(test) {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((plan) => {
      localStorage.setItem("hopreach.plans", JSON.stringify({ [plan.id]: plan }));
    }, TEST_PLAN);
    await gotoReady(page);
  });
}

// Adds one message-sender generator via the "Message senders" modal —
// every test that needs at least one scheduled send goes through this,
// covering the modal open -> fill -> add -> close flow the same way a
// real user would (rather than poking simMessageGenerators directly).
async function addMessageSenderViaModal(page) {
  await page.click("#sim-open-messages-modal");
  await expect(page.locator("#sim-messages-modal")).toBeVisible();
  await page.selectOption("#sim-message-node", { index: 0 });
  await page.click("#sim-message-add");
  await expect(page.locator("#sim-message-list .plan-list-item")).toHaveCount(1);
  await page.locator("#sim-messages-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
}

// Every accordion in the redesigned Simulate panel starts collapsed
// except the four core workflow sections (Nodes/Connectivity/Senders/Run)
// — Saved setups and, under Advanced, Policy search/Adaptive
// optimizer/Stress test all need an explicit open before their own
// controls are clickable.
async function openAccordion(page, accordionId) {
  const acc = page.locator(`#${accordionId}`);
  if (!(await acc.evaluate((el) => el.classList.contains("open")))) {
    await page.click(`#${accordionId} .sim-acc-head`);
  }
  await expect(acc).toHaveClass(/open/);
}

// Policy search, the adaptive optimizer, and the stress test also sit
// behind the Advanced tier itself (see setSimTier in simulator.js) —
// genuinely advanced tools, hidden from Basic by design rather than a bug.
async function openAdvancedAccordion(page, accordionId) {
  await page.click("#sim-tier-advanced");
  await openAccordion(page, accordionId);
}

// Finds a point on the map that a click will actually reach the map with.
// Anything sitting on top — a repeater marker, a cluster bubble, a docked
// control — consumes the click itself, and Leaflet never fires its own map
// click, so no node gets placed. Which points are covered depends entirely
// on where the live repeater data happens to put markers, so a fixed
// coordinate (the map's centre, say) works locally and then fails against
// a different dataset. Probes a spread of candidates and returns the first
// whose topmost element is the map surface itself.
async function findClickableMapPoint(page, map) {
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  const fractions = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];
  for (const fy of fractions) {
    for (const fx of fractions) {
      const point = { x: Math.round(box.width * fx), y: Math.round(box.height * fy) };
      const clear = await page.evaluate(
        ({ x, y, left, top }) => {
          const el = document.elementFromPoint(left + x, top + y);
          if (!el) return false;
          // Tiles and the map container itself are fine; a marker, a
          // Leaflet control, or either docked panel is not.
          return !el.closest(".leaflet-marker-icon, .leaflet-control, .leaflet-popup, #sim-panel, #plan-panel, #map-tools, #sim-transport");
        },
        { ...point, left: box.x, top: box.y }
      );
      if (clear) return point;
    }
  }
  throw new Error("no clickable point found on the map — every probe was covered");
}

// Leaflet occasionally swallows the very first click on a map right after
// it's been shown/resized (its own internal click-vs-drag detection can
// still be settling) — pre-existing flakiness, not specific to any one
// test. Retries on a fresh clear point rather than failing outright.
async function clickMapUntilNodeCount(page, map, position, expectedCount) {
  await map.click({ position });
  try {
    await expect
      .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount()), { timeout: 1500 })
      .toBe(expectedCount);
  } catch {
    await map.click({ position: await findClickableMapPoint(page, map) });
    await expect
      .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount()), { timeout: 5000 })
      .toBe(expectedCount);
  }
}

// Same pre-existing Leaflet click-swallowing flakiness as
// clickMapUntilNodeCount above, generalized for "click this marker, then
// wait for some other element to become visible as a result" instead of a
// node-count check — CI runners (slower/more resource-constrained than a
// local dev machine) hit this more often than local runs did.
async function clickUntilVisible(clickLocator, visibleLocator, clickOptions) {
  await clickLocator.click(clickOptions);
  try {
    await expect(visibleLocator).toBeVisible({ timeout: 1500 });
  } catch {
    await clickLocator.click(clickOptions);
    await expect(visibleLocator).toBeVisible({ timeout: 3000 });
  }
}


const UNORDERED_PLAN = {
  id: "e2e-sim-unordered-plan",
  name: "E2E Sim Unordered Plan",
  repeaters: [
    { id: "u-r1", label: "Zulu Repeater", lat: 56.0, lon: -4.6, antennaHeightM: null },
    { id: "u-r2", label: "Alpha Repeater", lat: 56.003, lon: -4.6, antennaHeightM: null },
    { id: "u-r3", label: "Mike Repeater", lat: 56.006, lon: -4.6, antennaHeightM: null },
  ],
  hopChains: [],
  overrides: [],
  notes: "",
};

module.exports = {
  useSeededPlan,
  TEST_PLAN,
  UNORDERED_PLAN,
  addMessageSenderViaModal,
  openAccordion,
  openAdvancedAccordion,
  findClickableMapPoint,
  clickMapUntilNodeCount,
  clickUntilVisible,
};
