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

test("simulate panel opens and is mutually exclusive with the plan panel", async ({ page }) => {
  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();

  await page.click("#plan-toggle");
  await expect(page.locator("#plan-panel")).toBeVisible();
  await expect(page.locator("#sim-panel")).toBeHidden();

  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();
  await expect(page.locator("#plan-panel")).toBeHidden();

  // Connectivity source defaults to "blend" (observed where CoreScope has
  // it, model everywhere else) rather than the propagation model alone —
  // a deliberate product default, not a CoreScope-availability fallback.
  await expect(page.locator("#sim-connectivity-source")).toHaveValue("blend");

  // The "Replay a real CoreScope packet" card links out to the actual
  // CoreScope instance this deployment reads from (set from config —
  // window.HOPREACH_CONFIG.corescopeUrl — not hardcoded, since a different
  // deployment can point at a different instance), opening in a new tab
  // rather than navigating away from the app.
  const corescopeLink = page.locator("#sim-corescope-link");
  await expect(corescopeLink).toHaveText("CoreScope");
  await expect(corescopeLink).toHaveAttribute("target", "_blank");
  const expectedUrl = await page.evaluate(() => window.HOPREACH_CONFIG.corescopeUrl);
  expect(expectedUrl).toMatch(/^https?:\/\//);
  await expect(corescopeLink).toHaveAttribute("href", expectedUrl);
});

// Regression test: the six toolbar buttons that open a results modal start
// with class="hidden" in the HTML and are only revealed once a real run
// actually produces something to show (see renderResults/renderSuggestions/
// renderBottleneckAnalysis/renderRankings/renderOptimizeModal/
// renderEpisodeAnalysis) — but class="hidden" alone does nothing without a
// matching CSS rule, and this project has already hit that exact bug
// twice: the docked sections these buttons replaced, and — found while
// reviewing the redesigned panel — sim-open-optimize-modal/
// sim-open-episode-modal themselves, silently missing from the shared
// selector since the day each was introduced (this very test's own list
// didn't cover them either, which is exactly how it went unnoticed). Also
// checks the modal backdrop itself starts closed — opening Simulate mode
// must not pop any modal open on its own.
test("results/analysis buttons and modals stay hidden until a simulation actually produces something", async ({ page }) => {
  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();
  for (const id of [
    "sim-open-results-modal",
    "sim-open-predictions-modal",
    "sim-open-bottleneck-modal",
    "sim-rankings-expand",
    "sim-open-optimize-modal",
    "sim-open-episode-modal",
  ]) {
    await expect(page.locator(`#${id}`), `#${id} should stay hidden before any simulation has run`).toBeHidden();
  }
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
});

test("loads planned repeaters, builds links, adds a message sender, runs a simulation, and predicts settings", async ({ page }) => {
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
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");

  // "Repeaters & settings" modal shows what got loaded.
  await page.click("#sim-open-nodes-modal");
  await expect(page.locator("#sim-nodes-modal")).toBeVisible();
  await expect(page.locator("#sim-nodes-modal-tbody tr")).toHaveCount(2);
  await expect(page.locator("#sim-nodes-modal-tbody")).toContainText("Sim Test Repeater A");
  await expect(page.locator("#sim-nodes-modal-tbody")).toContainText("Sim Test Repeater B");
  await page.locator("#sim-nodes-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await expect(page.locator("#sim-links-status")).toContainText("built");

  const linkCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getLinkCount());
  expect(linkCount, "expected at least one link between two repeaters 500m apart").toBeGreaterThan(0);

  // A single "+ Add sender" click (inside the Message senders modal) adds
  // one message *generator* (default values: 10 messages, 10-50B,
  // 1000-5000ms apart) — one row here, but it expands to 10 concrete
  // sends (see messagesFromState).
  await addMessageSenderViaModal(page);
  await expect(page.locator("#sim-message-count-badge")).toHaveText("1");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getMessageCount())).toBe(10);

  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  // The Results modal does NOT open automatically — its backdrop would
  // cover the flood propagating on the map — but the toolbar button
  // appears, and the map's own live-stats card (see
  // ensureSimPlaybackControl) is immediately visible without opening it.
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
  await expect(page.locator("#sim-open-results-modal")).toBeVisible();
  await expect(page.locator(".sim-playback-control")).toBeVisible();
  await expect(page.locator("#sim-map-live-stats .sim-stat").first()).toBeVisible();

  await page.click("#sim-open-results-modal");
  await expect(page.locator("#sim-results-modal")).toBeVisible();
  await expect(page.locator("#sim-results-summary")).toContainText("reception");

  const report = await page.evaluate(() => window.__hopreachSimulatorDebug.getLastReport());
  expect(report).not.toBeNull();
  expect(report.receptions.length).toBeGreaterThan(0);
  // Every reception must carry the new CollidedWith field (never absent —
  // see engine.go's Report initialization), the per-repeater ranking
  // table's contention column depends on it.
  for (const r of report.receptions) {
    expect(Array.isArray(r.collidedWith)).toBe(true);
  }
  await page.locator("#sim-results-modal [data-close]").first().click();

  // Repeater rankings are available via their own toolbar button.
  await expect(page.locator("#sim-rankings-expand")).toBeVisible();
  await page.click("#sim-rankings-expand");
  await expect(page.locator("#sim-rankings-fullwindow")).toBeVisible();
  // Item 16 extended this table with a per-repeater scoreboard (duty
  // cycle, delivery, unique/redundant relays, ...) — "Success rate" was
  // also relabelled "Decode rate" so it can't be conflated with genuine
  // packet delivery (a separate, new "Received" column).
  await expect(page.locator("#sim-rankings-fullwindow-body th")).toContainText([
    "Repeater",
    "Duty cycle",
    "Received",
    "Unique deliveries",
    "Redundant relays",
    "Relayed",
    "Successful",
    "Collisions (own)",
    "Missed (tx busy)",
    "Contention (caused)",
    "Avg relay delay",
    "Deferrals (CAD+budget)",
    "Decode rate",
  ]);
  await expect(page.locator("#sim-rankings-fullwindow-body tbody tr")).toHaveCount(2);
  await page.click("#sim-rankings-collapse");

  await page.fill("#sim-trials", "5"); // keep the search fast for a CI run
  await page.click("#sim-predict");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  await expect(page.locator("#sim-predictions-modal")).toBeVisible();
  await expect(page.locator("#sim-suggestions-list .plan-list-item").first()).toBeVisible();
  await expect(page.locator("#sim-per-node-list .plan-list-item")).toHaveCount(2);
});

test("repeater rankings can be sorted from the full-window view", async ({ page }) => {
  test.slow();

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await addMessageSenderViaModal(page);
  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden(); // no modal opens automatically — see runSimulation's own comment
  await expect(page.locator("#sim-rankings-expand")).toBeVisible();

  await page.click("#sim-rankings-expand");
  await expect(page.locator("#sim-rankings-fullwindow")).toBeVisible();
  await expect(page.locator("#sim-rankings-fullwindow-body tbody tr")).toHaveCount(2);

  // Sorting: clicking a header marks it sorted and re-renders the table
  // (row count unchanged — same data, new order).
  await page.locator("#sim-rankings-fullwindow-body th", { hasText: "Collisions" }).click();
  await expect(page.locator("#sim-rankings-fullwindow-body th.sim-rank-sorted")).toContainText("Collisions");
  await expect(page.locator("#sim-rankings-fullwindow-body tbody tr")).toHaveCount(2);

  await page.click("#sim-rankings-collapse");
  await expect(page.locator("#sim-rankings-fullwindow")).toBeHidden();
});

// Item 15c's own search — was never exercised end-to-end by this suite
// before (only covered at the Go unit-test level), which is exactly how a
// real hang (a stale cached Web Worker silently dropping an unrecognised
// message kind — see docker/default.conf.template's own Cache-Control fix)
// slipped through undetected.
test("search policies finds a composite policy and shows an action list", async ({ page }) => {
  test.slow();

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await addMessageSenderViaModal(page);

  await page.fill("#sim-trials", "3"); // keep the search fast for a CI run
  await openAdvancedAccordion(page, "sim-acc-policy");
  await page.click("#sim-suggest-policy");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 60_000 });
  await expect(page.locator("#sim-predictions-modal")).toBeVisible();
  await expect(page.locator("#sim-policy-section")).toBeVisible();
  await expect(page.locator("#sim-policy-summary")).toContainText("delivery");
  await expect(page.locator("#sim-policy-suggestions-list .plan-list-item").first()).toBeVisible();
  // Either a real change is recommended (a CLI-command row) or the modal
  // explicitly says there's nothing to change — either is a valid
  // outcome, but the section must never be left blank.
  await expect(page.locator("#sim-policy-actions-list")).not.toBeEmpty();
  await expect(page.locator("#sim-suggest-policy")).toBeEnabled();

  // Profile breakdown — fills
  // in asynchronously after the rest of the results (see
  // renderPolicyProfileSummary's own doc comment), so poll for it rather
  // than asserting immediately. Whichever policy actually won this run,
  // every loaded repeater lands in at least one profile row (even an
  // untiered winner still produces a single "No profile" row covering
  // both repeaters) — word labels only, never a colour swatch.
  const profileRows = page.locator("#sim-policy-profile-summary .sim-policy-profile-row");
  await expect(profileRows.first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#sim-policy-profile-summary [style*=\"background-color\"]")).toHaveCount(0);

  await profileRows.first().click();
  await expect(page.locator("#sim-policy-profile-detail")).toBeVisible();
  await expect(page.locator("#sim-policy-profile-detail-list .plan-list-item").first()).toBeVisible();

  await page.click("#sim-policy-profile-back");
  await expect(page.locator("#sim-policy-profile-detail")).toBeHidden();
});

// Phase 4 work item 4 — the adaptive optimizer requires Search policies to
// have already run (it starts from that search's own winning policy
// rather than searching from nothing — see runOptimizeAdaptive's own
// doc comment) and must say so plainly rather than silently doing
// nothing or erroring.
test("adaptive optimizer refuses to run before a policy search", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await addMessageSenderViaModal(page);

  await openAdvancedAccordion(page, "sim-acc-optimizer");
  await page.click("#sim-optimize-adaptive");
  await expect(page.locator("#sim-status")).toContainText("Search policies");
  await expect(page.locator("#sim-optimize-section")).toBeHidden();
});

// The end-to-end verification this feature specifically needs: phase 3's
// own stall bug shipped because items 15b/15c had only ever been unit
// tested at the Go level, never exercised through the real worker/WASM/UI
// pipeline in a browser — the exact gap that let a silently-dropped
// message kind read as an indefinite hang. This test drives the real
// chunked worker round-trip loop, not just internal/meshsim's own Go tests
// for OptimizeStep.
test("adaptive optimizer runs after a policy search and shows a result with hold-out validation", async ({ page }) => {
  test.slow();

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await addMessageSenderViaModal(page);

  await page.fill("#sim-trials", "3"); // keep both the search and the optimizer fast for a CI run
  await openAdvancedAccordion(page, "sim-acc-policy");
  await page.click("#sim-suggest-policy");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 60_000 });
  await page.locator("#sim-predictions-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  await openAdvancedAccordion(page, "sim-acc-optimizer");
  await page.click("#sim-optimize-adaptive");
  // Deliberately not asserting the progress indicator is visible at some
  // intermediate point — on this tiny 2-node fixture the whole
  // round-by-round loop can complete faster than a polled visibility
  // check reliably observes any single round's own transient state (seen
  // directly while writing this test). The real check is the stable end
  // state below, reached either way.
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 60_000 });
  await expect(page.locator("#sim-optimize-progress")).toBeHidden();
  await expect(page.locator("#sim-optimize-adaptive")).toBeEnabled();
  await expect(page.locator("#sim-optimize-cancel")).toBeHidden();

  await expect(page.locator("#sim-optimize-section")).toBeVisible();
  // Baseline → final, so the summary always shows whether the run
  // actually helped — "31.4% delivery" on its own can't answer that.
  await expect(page.locator("#sim-optimize-summary")).toContainText(/Delivery .+% → .+%/);
  await expect(page.locator("#sim-optimize-summary")).toContainText("contention");
  // Hold-out validation (work item 4's own "guarding against overfitting"
  // requirement) must always be shown once a run finishes, independent of
  // whether this specific tiny 2-node fixture found anything to adjust.
  await expect(page.locator("#sim-optimize-holdout-note")).toContainText("Hold-out validation");
  await expect(page.locator("#sim-optimize-holdout-note")).toContainText("delivery");
  // Either real deviations (a CLI-command row) or the section explicitly
  // says nothing needed adjusting — either is valid, but never blank.
  await expect(page.locator("#sim-optimize-deviations-list")).not.toBeEmpty();

  // The per-repeater table covers EVERY loaded repeater, not just the
  // adjusted ones — "which ones are causing the most contention" is only
  // answerable by seeing them all. Two planned repeaters are loaded here.
  const nodeRows = page.locator("#sim-optimize-nodes-tbody .sim-optimize-node-row");
  await expect(nodeRows).toHaveCount(2);
  // Clicking a repeater opens its own diagnosis, and the close button
  // returns — the same drill-down contract the profile breakdown uses.
  await nodeRows.first().click();
  await expect(page.locator("#sim-optimize-node-detail")).toBeVisible();
  await expect(page.locator("#sim-optimize-node-detail-title")).not.toBeEmpty();
  await page.click("#sim-optimize-node-detail-close");
  await expect(page.locator("#sim-optimize-node-detail")).toBeHidden();

  // One history row per completed round — this is the "improvement over
  // time" view, and an empty one would mean rounds ran but weren't
  // recorded.
  await expect(page.locator("#sim-optimize-history-tbody tr").first()).toBeVisible();

  // Reopening from the toolbar button must work after the modal's closed
  // — the results have to survive being dismissed.
  await page.locator("#sim-optimize-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
  await page.click("#sim-open-optimize-modal");
  await expect(page.locator("#sim-optimize-modal")).toBeVisible();
});

// Clicking Cancel mid-run must always return the UI to a stable,
// interactive state — not leave "Optimize adaptively" disabled forever
// waiting for a reply that may never come (see cancelOptimizeAdaptive's
// own graceful-then-forced design).
test("adaptive optimizer can be cancelled mid-run", async ({ page }) => {
  test.slow();

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await addMessageSenderViaModal(page);

  // Trials at the UI's own max so each round takes long enough to give a
  // real window to click Cancel before the run finishes on its own — this
  // fixture is otherwise so small/fast that a normal run can complete
  // before a click even lands (confirmed while writing this test).
  await page.fill("#sim-trials", "100");
  await openAdvancedAccordion(page, "sim-acc-policy");
  await page.click("#sim-suggest-policy");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 60_000 });
  await page.locator("#sim-predictions-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  await openAdvancedAccordion(page, "sim-acc-optimizer");
  await page.click("#sim-optimize-adaptive");
  // Best-effort: attempt the cancel click, but don't fail the test if the
  // run already finished and hid the button first — completing normally
  // is itself correct behaviour, not a test failure. Either way, the
  // assertion below is the real check: the UI must always settle back to
  // a normal, interactive state, never hang regardless of which path won
  // the race.
  await page
    .locator("#sim-optimize-cancel")
    .click({ timeout: 5_000 })
    .catch(() => {});

  await expect(page.locator("#sim-optimize-adaptive")).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator("#sim-optimize-cancel")).toBeHidden();
});

// Item 15b's own offered-load sweep — see the comment on the policy-search
// test above for why an end-to-end test like this matters.
test("stress test sweeps load levels and shows a capacity curve", async ({ page }) => {
  test.slow();

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await openAdvancedAccordion(page, "sim-acc-stress");
  await page.fill("#sim-stress-levels", "5, 20");
  await page.fill("#sim-trials", "3"); // keep the sweep fast for a CI run
  await page.click("#sim-stress-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 60_000 });
  await expect(page.locator("#sim-stress-modal")).toBeVisible();
  await expect(page.locator("#sim-stress-summary")).not.toBeEmpty();
  await expect(page.locator("#sim-stress-tbody tr")).toHaveCount(2);
  await expect(page.locator("#sim-stress-run")).toBeEnabled();
});

test("clicking a repeater marker opens the repeaters modal, and applied settings persist", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");

  await clickUntilVisible(page.locator(".sim-marker-icon").first(), page.locator("#sim-nodes-modal"), { force: true });
  const firstRow = page.locator("#sim-nodes-modal-tbody tr").first();
  // regions (text), allowUnscoped (checkbox), floodMax, floodMaxUnscoped,
  // radioFreqMhz/radioBwKhz/radioSf/radioCr (4), txDelayFactor,
  // directTxDelayFactor, rxDelayBase, txPowerDbm, hashSize = 13 inputs,
  // plus loopDetect and radioPreset as their own selects (not matched here).
  await expect(firstRow.locator("input[data-field]")).toHaveCount(13);
  await expect(firstRow.locator("select[data-field=\"loopDetect\"]")).toHaveCount(1);
  await expect(firstRow.locator("select[data-field=\"radioPreset\"]")).toHaveCount(1);

  // A fresh node with no explicit override defaults to "minimal", a
  // deliberate divergence from real firmware's own "off" default — see
  // DEFAULT_LOOP_DETECT's own comment in simulator.js.
  await expect(firstRow.locator('select[data-field="loopDetect"]')).toHaveValue("minimal");

  // Planned repeaters have no real pubkey yet, so a synthetic 6-byte
  // address (12 hex chars) is generated and stored at creation time —
  // hovering the name shows it, and it's stable (not regenerated per render).
  const addressTitle = await firstRow.locator("td").first().locator("span[title]").getAttribute("title");
  expect(addressTitle).toMatch(/^Address: [0-9A-F]{12}$/);

  await firstRow.locator('input[data-field="txDelayFactor"]').fill("1.25");
  await firstRow.locator('select[data-field="loopDetect"]').selectOption("strict");
  await page.click("#sim-nodes-modal-apply");
  await expect(page.locator("#sim-status")).toContainText("Applied settings for");
  await page.locator("#sim-nodes-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  // Reopening shows the applied values, not the defaults — proves they
  // were actually committed to simNodePrefsOverrides, not just left in
  // the form.
  await page.click("#sim-open-nodes-modal");
  await expect(page.locator("#sim-nodes-modal-tbody tr").first().locator('input[data-field="txDelayFactor"]')).toHaveValue("1.25");
  await expect(page.locator("#sim-nodes-modal-tbody tr").first().locator('select[data-field="loopDetect"]')).toHaveValue("strict");
});

test("bulk-apply fills every row's matching field, and only commits on Apply", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");

  await page.click("#sim-open-nodes-modal");
  await page.fill("#sim-bulk-tx-delay", "1.5");
  await page.selectOption("#sim-bulk-loop-detect", "moderate");
  // Rx delay/tx power/hash-size deliberately left blank — should leave
  // those columns' own per-row values untouched.
  await page.click("#sim-bulk-apply-fill");
  await expect(page.locator("#sim-status")).toContainText("Filled 2 fields");

  const rows = page.locator("#sim-nodes-modal-tbody tr");
  for (let i = 0; i < (await rows.count()); i++) {
    await expect(rows.nth(i).locator('input[data-field="txDelayFactor"]')).toHaveValue("1.5");
    await expect(rows.nth(i).locator('select[data-field="loopDetect"]')).toHaveValue("moderate");
  }

  // Not yet committed until Apply is clicked.
  await page.locator("#sim-nodes-modal [data-close]").first().click();
  await page.click("#sim-open-nodes-modal");
  await expect(page.locator("#sim-nodes-modal-tbody tr").first().locator('select[data-field="loopDetect"]')).not.toHaveValue("moderate");

  // Fill again (the modal reopened with fresh defaults) and actually apply this time.
  await page.fill("#sim-bulk-tx-delay", "1.5");
  await page.selectOption("#sim-bulk-loop-detect", "moderate");
  await page.click("#sim-bulk-apply-fill");
  await page.click("#sim-nodes-modal-apply");
  await page.locator("#sim-nodes-modal [data-close]").first().click();

  await page.click("#sim-open-nodes-modal");
  const rowsAfter = page.locator("#sim-nodes-modal-tbody tr");
  for (let i = 0; i < (await rowsAfter.count()); i++) {
    await expect(rowsAfter.nth(i).locator('select[data-field="loopDetect"]')).toHaveValue("moderate");
  }
});

// Deliberately loaded out of alphabetical order (Zulu, Alpha, Mike) so a
// dropdown/table that just mirrored load order would fail this test.
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

test("repeater names appear alphabetically in the message-sender dropdown and repeaters modal", async ({ page }) => {
  // beforeEach's own addInitScript already seeded TEST_PLAN before the
  // page's first navigation — planner.js only ever reads localStorage at
  // load time, so adding UNORDERED_PLAN requires its own init script plus
  // a fresh navigation to actually take effect.
  await page.addInitScript((plan) => {
    const plans = JSON.parse(localStorage.getItem("hopreach.plans") || "{}");
    plans[plan.id] = plan;
    localStorage.setItem("hopreach.plans", JSON.stringify(plans));
  }, UNORDERED_PLAN);
  await gotoReady(page);

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", UNORDERED_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("3");

  await page.click("#sim-open-messages-modal");
  await expect(page.locator("#sim-message-node option")).toHaveText(["Alpha Repeater", "Mike Repeater", "Zulu Repeater"]);
  await page.locator("#sim-messages-modal [data-close]").first().click();

  await page.click("#sim-open-nodes-modal");
  await expect(page.locator("#sim-nodes-modal-tbody tr")).toContainText(["Alpha Repeater", "Mike Repeater", "Zulu Repeater"]);
});

test("editing an existing message sender updates it in place instead of adding a new one", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await addMessageSenderViaModal(page);
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getMessageGeneratorCount())).toBe(1);

  await page.click("#sim-open-messages-modal");
  await page.click('#sim-message-list [data-act="edit"]');
  await expect(page.locator("#sim-message-add")).toHaveText("Save changes");
  await expect(page.locator("#sim-message-editing-hint")).toBeVisible();

  await page.fill("#sim-message-count", "8");
  await page.click("#sim-message-add");

  // Still exactly one row (updated, not a duplicate), and the form is back
  // to "add" mode.
  await expect(page.locator("#sim-message-list .plan-list-item")).toHaveCount(1);
  await expect(page.locator("#sim-message-list .plan-item-sub")).toContainText("8 messages");
  await expect(page.locator("#sim-message-add")).toHaveText("+ Add sender");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getMessageGeneratorCount())).toBe(1);
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getMessageCount())).toBe(8);
});

// Regression test: path-hash size is a property of the MESSAGE (what its sender stamps on the packet
// at send time — real firmware's Mesh::sendFlood), not of the repeater
// sending it. The sender form's own hash-size select must default to 3
// bytes, and editing it must actually round-trip through the sender list's
// badge.
test("message sender hash size defaults to 3 bytes and round-trips through edit", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");

  await page.click("#sim-open-messages-modal");
  await expect(page.locator("#sim-message-hash-size")).toHaveValue("3");
  await page.selectOption("#sim-message-node", { index: 0 });
  await page.click("#sim-message-add");
  await expect(page.locator("#sim-message-list .plan-list-item")).toHaveCount(1);
  await expect(page.locator("#sim-message-list .sim-badge-hashsize")).toHaveText("3B");

  await page.click('#sim-message-list [data-act="edit"]');
  await expect(page.locator("#sim-message-hash-size")).toHaveValue("3");
  await page.selectOption("#sim-message-hash-size", "1");
  await page.click("#sim-message-add");
  await expect(page.locator("#sim-message-list .plan-list-item")).toHaveCount(1);
  await expect(page.locator("#sim-message-list .sim-badge-hashsize")).toHaveText("1B");
});

// A repeater's own configured hash size (⚙ Repeaters & settings) is what a
// real device would actually use for every packet it originates — the
// sender form's own hash-size field should default to reflect that when
// you pick the repeater as a sender, not an unrelated constant. Still
// overridable afterward; this only checks the seeded starting value.
test("selecting a sender seeds the hash-size field from that repeater's own configured hash size", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");

  await page.click("#sim-open-nodes-modal");
  const firstRow = page.locator("#sim-nodes-modal-tbody tr").first();
  await firstRow.locator('input[data-field="hashSize"]').fill("2");
  await page.click("#sim-nodes-modal-apply");
  await page.locator("#sim-nodes-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  await page.click("#sim-open-messages-modal");
  await page.selectOption("#sim-message-node", { index: 0 });
  await expect(page.locator("#sim-message-hash-size")).toHaveValue("2");

  // Still freely overridable — picking a different value sticks until the
  // node selection changes again.
  await page.selectOption("#sim-message-hash-size", "1");
  await expect(page.locator("#sim-message-hash-size")).toHaveValue("1");
});

test("sent messages list shows one row per message, selecting one highlights its path on the map", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await addMessageSenderViaModal(page);
  const expectedMessages = await page.evaluate(() => window.__hopreachSimulatorDebug.getMessageCount());

  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  await page.click("#sim-open-results-modal"); // the modal no longer opens automatically — see runSimulation's own comment
  await expect(page.locator("#sim-results-modal")).toBeVisible();
  await expect(page.locator("#sim-messages-sent-list .plan-list-item")).toHaveCount(expectedMessages);
  // How long each packet was still producing activity anywhere in the
  // network, right in the list — not just after drilling into Details.
  await expect(page.locator("#sim-messages-sent-list .plan-item-sub").first()).toContainText(/flooding for \d+ms/);

  const firstRow = page.locator("#sim-messages-sent-list .plan-list-item").first();
  await firstRow.click();
  await expect(firstRow).toHaveClass(/sim-message-row-selected/);

  // Clicking the same row again deselects it (toggle), clearing the
  // highlight and its map layer.
  await firstRow.click();
  await expect(firstRow).not.toHaveClass(/sim-message-row-selected/);
  await expect(page.locator(".sim-message-row-selected")).toHaveCount(0);
});

test("packet inspector: message details and clicking a repeater after a run both show per-hop breakdowns", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await addMessageSenderViaModal(page);

  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });
  await page.click("#sim-open-results-modal");
  await expect(page.locator("#sim-results-modal")).toBeVisible();

  // "Details" on a sent message opens the packet modal with a flood-time
  // summary and at least one per-hop row.
  await page.locator("#sim-messages-sent-list .sim-message-details-btn").first().click();
  await expect(page.locator("#sim-packet-modal")).toBeVisible();
  await expect(page.locator("#sim-packet-modal-title")).toContainText("Packet #");
  await expect(page.locator("#sim-packet-modal-summary")).toContainText("flood time");
  // The packet's own hash size (defaults to 3 bytes — see
  // DEFAULT_MESSAGE_HASH_SIZE) is shown once for the whole packet, not
  // per hop — real MeshCore packets can never mix hash sizes hop to hop,
  // so a path breadcrumb must never
  // show a per-hop "(NB)" suffix.
  await expect(page.locator("#sim-packet-modal-summary")).toContainText("3B hops");
  const pathTexts = await page.locator(".sim-packet-path").allTextContents();
  for (const text of pathTexts) {
    expect(text).not.toMatch(/\(\d+B\)/);
  }
  await expect(page.locator("#sim-packet-modal-list .plan-list-item").first()).toBeVisible();
  await page.locator("#sim-packet-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  // Once a report exists, clicking a repeater marker on the map opens the
  // packet inspector for that node instead of the settings modal. With
  // only two closely-spaced test repeaters, both can end up tucked behind
  // the bottom-right playback control at this viewport size — pan the map
  // so the markers land somewhere clear of it before clicking.
  await page.evaluate(() => window.__hopreachSimulatorDebug.panBy(300, 300));
  await clickUntilVisible(page.locator(".sim-marker-icon").first(), page.locator("#sim-packet-modal"));
  await expect(page.locator("#sim-packet-modal-title")).toContainText("Packets at");
  await expect(page.locator("#sim-nodes-modal")).toBeHidden();

  // The message sender used by addMessageSenderViaModal is this same node
  // (the dropdown's alphabetically-first option) — the unified activity
  // table should show at least one TX row for it, in the same list as any
  // RX rows (single table, timestamp order, not two separate sections).
  await expect(page.locator("#sim-packet-modal-list .sim-packet-row")).not.toHaveCount(0);
  const txRow = page.locator("#sim-packet-modal-list .sim-packet-row").filter({ has: page.locator(".sim-txrx-tx") }).first();
  await expect(txRow).toBeVisible();

  // Clicking a TX row jumps into that packet's own details.
  await txRow.click();
  await expect(page.locator("#sim-packet-modal-title")).toContainText("details");

  // Delivery checklist: one row per node in the scenario (not just ones
  // that appear in the reception log), origin marked distinctly from an
  // actual receive/non-receive outcome.
  const nodeCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount());
  await expect(page.locator("#sim-packet-modal-checklist-section")).toBeVisible();
  await expect(page.locator("#sim-packet-modal-checklist .sim-checklist-row")).toHaveCount(nodeCount);
  await expect(page.locator("#sim-packet-modal-checklist .sim-checklist-origin")).toHaveCount(1);
  await expect(page.locator("#sim-packet-modal-checklist .sim-checklist-origin")).toContainText("Origin");

  // Back navigation: having drilled node-inspector -> packet-details, the
  // "← Back" button should be showing and return to the node view. A
  // second drill (checklist row -> node-inspector) then back again
  // exercises both directions of the node<->packet chain.
  await expect(page.locator("#sim-packet-modal-back")).toBeVisible();
  const packetDetailsTitle = await page.locator("#sim-packet-modal-title").innerText();
  await page.locator("#sim-packet-modal-back").click();
  await expect(page.locator("#sim-packet-modal-title")).toContainText("Packets at");
  await expect(page.locator("#sim-packet-modal-back")).toBeHidden();

  // Drill forward again the same way, then instead go via a checklist row.
  await page.locator("#sim-packet-modal-list .sim-packet-row").filter({ has: page.locator(".sim-txrx-tx") }).first().click();
  await expect(page.locator("#sim-packet-modal-title")).toContainText("details");
  await page.locator("#sim-packet-modal-checklist .sim-checklist-row").first().click();
  await expect(page.locator("#sim-packet-modal-title")).toContainText("Packets at");
  await expect(page.locator("#sim-packet-modal-back")).toBeVisible();
  await page.locator("#sim-packet-modal-back").click();
  await expect(page.locator("#sim-packet-modal-title")).toContainText(packetDetailsTitle);
  await expect(page.locator("#sim-packet-modal-back")).toBeVisible();

  // Filters: narrowing by node name only shows rows mentioning that node,
  // and the outcome filter narrows by relayed/collided/dropped/received.
  const totalRows = await page.locator("#sim-packet-modal-list .sim-packet-row").count();
  expect(totalRows).toBeGreaterThan(0);
  const nodeNameFragment = (await page.evaluate(() => window.__hopreachSimulatorDebug.getNodes()[0].label)).split(" ")[0];
  await page.fill("#sim-packet-filter-search", nodeNameFragment);
  const filteredRows = page.locator("#sim-packet-modal-list .sim-packet-row");
  await expect(filteredRows.first()).toBeVisible();
  const filteredCount = await filteredRows.count();
  expect(filteredCount).toBeLessThanOrEqual(totalRows);
  for (let i = 0; i < filteredCount; i++) {
    await expect(filteredRows.nth(i)).toContainText(nodeNameFragment);
  }
  // The "Showing X of Y" hint only appears once filtering actually narrows
  // the set — with this test's small 2-node scenario, one shared node name
  // can legitimately match every row, in which case the hint stays blank.
  if (filteredCount < totalRows) {
    await expect(page.locator("#sim-packet-filter-count")).toContainText(`of ${totalRows}`);
  }
  await page.fill("#sim-packet-filter-search", "");

  await page.selectOption("#sim-packet-filter-outcome", "collided");
  await expect(page.locator("#sim-packet-modal-list")).toContainText(/Collided|Nothing to show/);
  const collidedRows = page.locator("#sim-packet-modal-list .sim-packet-row");
  const collidedCount = await collidedRows.count();
  for (let i = 0; i < collidedCount; i++) {
    await expect(collidedRows.nth(i).locator(".sim-packet-reason")).toHaveText(/Collided/);
  }
  await page.selectOption("#sim-packet-filter-outcome", "");

  await page.locator("#sim-packet-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  // The per-row "📨" action in the Repeaters & settings modal is the same
  // inspector, reachable without going back to the map. The table now has
  // enough columns (scopes, hop limits, radio, delay/power settings) that
  // it does need horizontal scrolling even at the widened modal size — the
  // sticky header/first column (see #sim-nodes-modal's own CSS) is what
  // keeps that usable, not avoiding the scroll altogether.
  await page.click("#sim-open-nodes-modal");
  await expect(page.locator("#sim-nodes-modal-tbody tr [data-act=\"packets\"]").first()).toBeVisible();
  await page.locator("#sim-nodes-modal-tbody tr [data-act=\"packets\"]").first().click();
  await expect(page.locator("#sim-packet-modal")).toBeVisible();
});

test("saved setups: save, reload without rebuilding links, and delete", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await addMessageSenderViaModal(page);
  await page.fill("#sim-seed", "42");
  await page.fill("#sim-max-time", "12345");
  await page.fill("#sim-trials", "7");

  await openAccordion(page, "sim-acc-setups");
  await page.fill("#sim-setup-name", "My Setup");
  await page.click("#sim-setup-save");
  await expect(page.locator("#sim-status")).toContainText('Saved setup "My Setup"');
  await expect(page.locator("#sim-setup-select")).toHaveValue(await page.evaluate(() => Object.keys(window.__hopreachSimulatorDebug.getSavedSetups())[0]));

  // "New" clears the workspace back to empty, same as Clear all.
  await page.click("#sim-setup-new");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("0");
  await expect(page.locator("#sim-message-count-badge")).toHaveText("0");
  await expect(page.locator("#sim-setup-name")).toHaveValue("");

  // Reloading via the select restores nodes, links (no rebuild needed),
  // senders, and the run controls in one step.
  const setupId = await page.evaluate(() => Object.keys(window.__hopreachSimulatorDebug.getSavedSetups())[0]);
  await page.selectOption("#sim-setup-select", setupId);
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");
  await expect(page.locator("#sim-message-count-badge")).toHaveText("1");
  await expect(page.locator("#sim-setup-name")).toHaveValue("My Setup");
  await expect(page.locator("#sim-seed")).toHaveValue("42");
  await expect(page.locator("#sim-max-time")).toHaveValue("12345");
  await expect(page.locator("#sim-trials")).toHaveValue("7");
  await expect(page.locator("#sim-links-status")).toContainText("restored from");
  const linkCountAfterLoad = await page.evaluate(() => window.__hopreachSimulatorDebug.getLinkCount());
  expect(linkCountAfterLoad).toBeGreaterThan(0);

  // The restored links are actually usable — running doesn't require
  // clicking "Build links" again first.
  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });

  page.once("dialog", (dialog) => dialog.accept());
  await page.click("#sim-setup-delete");
  await expect(page.locator("#sim-setup-select")).toContainText("(no saved setups)");
});

test("saved setups: export downloads a self-contained .json, importing it restores the workspace", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await addMessageSenderViaModal(page);
  await openAccordion(page, "sim-acc-setups");
  await page.fill("#sim-setup-name", "Export Test Setup");

  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sim-setup-export")]);
  expect(download.suggestedFilename()).toBe("Export Test Setup.json");
  const downloadPath = await download.path();
  const fs = require("fs");
  const exported = JSON.parse(fs.readFileSync(downloadPath, "utf8"));
  expect(exported.name).toBe("Export Test Setup");
  expect(Array.isArray(exported.nodes)).toBe(true);
  expect(exported.nodes.length).toBe(2);
  // Self-contained: each node carries its own lat/lon/label rather than a
  // reference back into the (possibly no-longer-existing) source plan.
  for (const n of exported.nodes) {
    expect(typeof n.lat).toBe("number");
    expect(typeof n.lon).toBe("number");
    expect(typeof n.label).toBe("string");
  }
  expect(exported.messageGenerators.length).toBe(1);

  // Reimporting into a cleared workspace restores everything, without
  // needing the original plan still loaded.
  await page.click("#sim-setup-new");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("0");

  await page.setInputFiles("#sim-setup-import-file", downloadPath);
  await expect(page.locator("#sim-status")).toContainText('Imported setup "Export Test Setup"');
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");
  await expect(page.locator("#sim-message-count-badge")).toHaveText("1");
  await expect(page.locator("#sim-setup-name")).toHaveValue("Export Test Setup");
  await expect(page.locator("#sim-links-status")).toContainText("restored from");

  // Imported but not yet saved under any id — the select shouldn't claim
  // it's one of the stored entries until Save is clicked.
  const savedIds = await page.evaluate(() => Object.keys(window.__hopreachSimulatorDebug.getSavedSetups()));
  expect(savedIds.length).toBe(0);
});

test("clear all removes loaded nodes and hides results", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");

  await page.click("#sim-nodes-clear");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("0");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBe(0);
});

test("places a virtual companion location by clicking the map, and stops when toggled off", async ({ page }) => {
  await page.click("#sim-toggle");
  await page.click("#sim-add-companion");
  await expect(page.locator("#sim-add-companion")).toHaveClass(/active/);
  await expect(page.locator("#sim-companion-hint")).toBeVisible();
  // Docked (like the plan panel), not a full-viewport overlay — the map
  // stays visible/clickable the whole time.
  await expect(page.locator("#sim-panel")).toBeVisible();

  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  await clickMapUntilNodeCount(page, map, await findClickableMapPoint(page, map), 1);
  await expect(page.locator("#sim-node-count-badge")).toHaveText("1");
  await expect(page.locator(".sim-marker-companion")).toHaveCount(1);

  // Toggling placement off means further map clicks don't add more nodes.
  await page.click("#sim-add-companion");
  await expect(page.locator("#sim-add-companion")).not.toHaveClass(/active/);
  await map.click({ position: { x: box.width / 4, y: box.height / 4 } });
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBe(1);
});

// Regression test: companion labels used to be numbered from the
// *current* companion count + 1, which breaks the moment one is removed
// — add two, remove the first, add another, and the new one collided with
// the survivor's own label (both "Companion 2"). Labels must stay unique
// for the whole session regardless of what's been removed in between.
test("companion labels never repeat, even after removing one and adding another", async ({ page }) => {
  await page.click("#sim-toggle");
  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");

  // Spaced a quarter of the map apart (not just a few px) so the first
  // marker's own clickable area can never intercept the second click.
  await page.click("#sim-add-companion");
  const firstSpot = await findClickableMapPoint(page, map);
  await clickMapUntilNodeCount(page, map, firstSpot, 1);
  await expect(page.locator(".sim-marker-companion")).toHaveCount(1);
  // Far enough from the first that its own marker can't intercept, and
  // re-probed so the new marker isn't sitting on the second point either.
  await map.click({ position: await findClickableMapPoint(page, map) });
  await expect(page.locator(".sim-marker-companion")).toHaveCount(2);
  await page.click("#sim-add-companion"); // stop placing

  let labels = await page.evaluate(() => window.__hopreachSimulatorDebug.getNodes().map((n) => n.label));
  expect(labels).toEqual(["Companion 1", "Companion 2"]);

  // Remove "Companion 1" via the repeaters modal, then place a third companion.
  await page.click("#sim-open-nodes-modal");
  const firstRow = page.locator('#sim-nodes-modal-tbody tr[data-node-id]').filter({ hasText: "Companion 1" });
  await firstRow.locator('[data-act="remove"]').click();
  await page.locator("#sim-nodes-modal [data-close]").first().click();

  await page.click("#sim-add-companion");
  await map.click({ position: { x: box.width / 4, y: (3 * box.height) / 4 } });

  labels = await page.evaluate(() => window.__hopreachSimulatorDebug.getNodes().map((n) => n.label));
  expect(labels.sort()).toEqual(["Companion 2", "Companion 3"]);
  expect(new Set(labels).size).toBe(labels.length); // no duplicates
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

  await addMessageSenderViaModal(page);
  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });

  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getWaveCount())).toBeGreaterThan(0);
  // The shared transport bar drives replay straight from the map, without
  // needing to open the Results modal at all — and the map-docked card
  // shows a live running tally (see ensureSimPlaybackControl) that tracks
  // the scrubber rather than jumping straight to the final count.
  await expect(page.locator("#sim-transport")).toBeVisible();
  await expect(page.locator("#sim-map-live-stats .sim-stat").first()).toBeVisible();

  const seek = page.locator("#sim-transport-seek");
  const max = await seek.getAttribute("max");
  await seek.fill(max); // skip to the end
  const report = await page.evaluate(() => window.__hopreachSimulatorDebug.getLastReport());
  await expect(page.locator("#sim-map-live-stats")).toContainText(String(report.receptions.length));

  // The same controls, mirrored, also work from inside the modal.
  await page.click("#sim-open-results-modal");
  await expect(page.locator("#sim-results-modal")).toBeVisible();
  await expect(page.locator("#sim-replay-status")).toContainText("final state");
  await page.click("#sim-replay");
  await expect(page.locator("#sim-replay-status")).not.toContainText("final state");
});

test("the replay transport plays, pauses, and seeks in both directions", async ({ page }) => {
  test.slow(); // link-building fetches real DEM tiles

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await addMessageSenderViaModal(page);
  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });

  // A run points the shared transport at its own flood and starts playing.
  const bar = page.locator("#sim-transport");
  await expect(bar).toBeVisible();
  await expect(page.locator("#sim-transport-label")).toHaveText("Simulated flood");

  const seek = page.locator("#sim-transport-seek");
  const max = parseInt(await seek.getAttribute("max"), 10);
  expect(max).toBeGreaterThan(0);

  // Pause has to actually stop the clock, not just relabel the button.
  await page.click("#sim-transport-play");
  await expect(page.locator("#sim-transport-play")).toHaveText("▶");
  const pausedAt = await seek.inputValue();
  await page.waitForTimeout(600);
  expect(await seek.inputValue()).toBe(pausedAt);

  // Seeking is what the old fire-and-forget setTimeout replays couldn't do:
  // the drawn state has to follow the scrubber in BOTH directions, which
  // only works because the renderer rebuilds from scratch on a seek rather
  // than assuming it only ever moves forward.
  const linesAt = async (v) => {
    await seek.fill(String(v));
    return page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount());
  };
  const atEnd = await linesAt(max);
  const atStart = await linesAt(0);
  const atMiddle = await linesAt(Math.round(max / 2));
  expect(atStart).toBeLessThan(atEnd);
  expect(atMiddle).toBeGreaterThanOrEqual(atStart);
  expect(atMiddle).toBeLessThanOrEqual(atEnd);

  // Playing from the end restarts rather than sitting there doing nothing.
  await seek.fill(String(max));
  await page.click("#sim-transport-play");
  await expect(page.locator("#sim-transport-play")).toHaveText("⏸");
  await expect
    .poll(async () => parseInt(await seek.inputValue(), 10), { timeout: 5000 })
    .toBeLessThan(max);
});

// "Keep all paths" is a live analysis lens, not a pre-run setting: it used
// to only take effect on the NEXT wave tick, so toggling it in a finished
// (skipped-to-end) view — the common case, having just watched a replay —
// did nothing visible at all. Both directions must re-render immediately.
test("keep-all-paths toggles the map view live, after a run has already finished", async ({ page }) => {
  test.slow(); // link-building fetches real DEM tiles

  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await page.selectOption("#sim-connectivity-source", "model");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });

  await addMessageSenderViaModal(page);
  await page.click("#sim-run");
  await expect(page.locator("#sim-status")).toHaveText("Done.", { timeout: 30_000 });

  // Settle into the finished/static state, where the old code did nothing
  // on toggle.
  const seek = page.locator("#sim-transport-seek");
  await seek.fill(await seek.getAttribute("max"));

  const allPathsCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount());
  expect(allPathsCount).toBeGreaterThan(0);

  // Untick: only the most recent wave's lines should remain, which must be
  // strictly fewer than the full accumulated set.
  await page.uncheck("#sim-view-keep-paths");
  await expect
    .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount()))
    .toBeLessThan(allPathsCount);

  // Re-tick: back to the full accumulated set, same as before.
  await page.check("#sim-view-keep-paths");
  await expect
    .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount()))
    .toBe(allPathsCount);
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
  await expect(page.locator("#sim-node-count-badge")).not.toHaveText("0", { timeout: 120_000 });

  await page.selectOption("#sim-connectivity-source", "corescope");
  await page.click("#sim-build-links");
  await expect(page.locator("#sim-links-status")).not.toContainText("Building", { timeout: 60_000 });
  await expect(page.locator("#sim-links-status")).toContainText("built");

  const links = await page.evaluate(() => window.__hopreachSimulatorDebug.getLinks());
  expect(links.length, "expected at least one real observed link among the site's real repeaters").toBeGreaterThan(0);

  // Regression check for a real bug: each real node's own reach data
  // independently reports both directions of a relationship (its own
  // we_hear and the neighbour's they_hear for the same underlying fact),
  // and buildLinksFromCorescope queries every node — so the same directed
  // pair could be reported twice, once from each side. Left undeduplicated
  // this delivered the same transmission to the same listener twice (an
  // identical reception row appearing more than once for one packet).
  const pairs = links.map((l) => `${l.from}:${l.to}`);
  const duplicates = pairs.filter((p, i) => pairs.indexOf(p) !== i);
  expect(duplicates, "buildLinksFromCorescope must never emit the same (from,to) pair twice").toEqual([]);
});

// Also genuinely network-dependent (CoreScope's own scope-stats, and the
// per-repeater region data "Load real repeaters" filters by), kept
// isolated the same way.
test("filtering by region before loading real repeaters loads a real subset", async ({ page }) => {
  test.slow();
  await page.click("#sim-toggle");
  await page.waitForFunction(() => document.getElementById("sim-scope-filter").options.length > 1, { timeout: 60_000 });

  await page.click("#sim-load-real");
  await expect(page.locator("#sim-node-count-badge")).not.toHaveText("0", { timeout: 120_000 });
  const allCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount());

  await page.click("#sim-nodes-clear");
  const scopeValue = await page.locator("#sim-scope-filter option").nth(1).getAttribute("value");
  await page.selectOption("#sim-scope-filter", scopeValue);
  await page.click("#sim-load-real");
  await expect(page.locator("#sim-node-count-badge")).not.toHaveText("0", { timeout: 120_000 });
  const filteredCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount());

  expect(filteredCount, `expected ${scopeValue}'s own repeater count to be no more than the unfiltered total`).toBeLessThanOrEqual(allCount);
  expect(filteredCount).toBeGreaterThan(0);
});

// Also genuinely network-dependent (CoreScope's real packet data), so kept
// isolated the same way. Discovers a real, currently-available packet hash
// from CoreScope's own recent-packets list rather than hardcoding one —
// a specific historical hash could eventually age out of CoreScope's own
// retention window and silently break this test regardless of whether the
// feature itself still works.
test("replays a real CoreScope packet: proven vs. predicted bottleneck analysis", async ({ page, request }) => {
  test.slow();

  const packetsResp = await request.get("/corescope-api/api/packets?limit=50");
  expect(packetsResp.ok()).toBeTruthy();
  const packetsData = await packetsResp.json();
  const multiObservation = (packetsData.packets || []).filter((p) => p.observation_count > 1);
  test.skip(multiObservation.length === 0, "no multi-observation packet currently available from CoreScope to replay");

  // observation_count > 1 alone isn't enough — CoreScope's own path
  // resolution can legitimately fail for a given packet too
  // (resolved_path comes back null, or its very first hop specifically
  // does even though later hops resolved), which the app itself handles
  // gracefully (a clear error, not a crash) but isn't what this test is
  // trying to exercise. replayFromHash specifically needs at least one
  // observation whose first hop resolves (that's what it uses as the
  // packet's origin) — check the real detail endpoint for that before
  // committing to a hash, not just "some path data exists somewhere".
  let candidateHash = null;
  for (const p of multiObservation.slice(0, 10)) {
    const detailResp = await request.get(`/corescope-api/api/packets/${p.hash}`);
    if (!detailResp.ok()) continue;
    const detail = await detailResp.json();
    const hasResolvableOrigin = (detail.observations || []).some((o) => Array.isArray(o.resolved_path) && o.resolved_path.length > 0 && o.resolved_path[0]);
    if (hasResolvableOrigin) {
      candidateHash = p.hash;
      break;
    }
  }
  test.skip(!candidateHash, "no packet with resolvable path data currently available from CoreScope to replay");

  await page.click("#sim-toggle");
  await page.fill("#sim-replay-hash-input", candidateHash);
  await page.click("#sim-replay-hash-go");
  await expect(page.locator("#sim-replay-hash-status")).toContainText("Loaded", { timeout: 60_000 });

  // A replay deliberately does NOT open the analysis modal — that modal
  // covers the whole map, which is exactly what you need to see while a
  // replay plays. The map-docked control carries the key and the transport
  // controls instead, and opens the modal on demand.
  await expect(page.locator("#sim-bottleneck-modal")).not.toBeVisible();
  await expect(page.locator(".sim-bottleneck-legend")).toBeVisible();
  await expect(page.locator(".sim-bottleneck-legend")).toContainText("Proven & modeled");

  // The predicted run is a real report and drives the map-docked live-stats
  // card like any other run, rather than being computed, diffed, and
  // thrown away.
  await expect(page.locator("#sim-map-live-stats")).toBeVisible();

  await page.click("#sim-map-open-bottleneck");
  await expect(page.locator("#sim-bottleneck-modal")).toBeVisible();
  await expect(page.locator("#sim-bottleneck-summary")).toContainText("proven hop");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBeGreaterThan(0);

  // Whichever direction the real data happened to fall in this run, at
  // least one of the two comparison lists should say something concrete —
  // proves the diff logic actually ran, not just that nothing crashed.
  const bottleneckText = await page.locator("#sim-bottleneck-list").innerText();
  const unmodeledText = await page.locator("#sim-unmodeled-list").innerText();
  expect(bottleneckText.length + unmodeledText.length).toBeGreaterThan(0);

  // The ±30s real-activity replay only shows once some other real traffic
  // was actually found in that window — on a quiet mesh at replay time
  // there may genuinely be none, so this is conditional rather than
  // asserting it's always present.
  const replaySectionHidden = await page.locator("#sim-bottleneck-replay-section").evaluate((el) => el.classList.contains("hidden"));
  if (!replaySectionHidden) {
    await page.click("#sim-bottleneck-replay-skip");
    await expect(page.locator("#sim-bottleneck-replay-status")).not.toHaveText("");

    // Status is mirrored between the modal and the map-docked control, so
    // the two can never disagree about what the replay is doing.
    await expect(page.locator("#sim-map-real-replay-status")).not.toHaveText("");

    // The hops must land on a layer that's actually attached to the map:
    // the layer used to be removed when the simulator panel closed and
    // never re-added when it reopened, so every line went into a detached
    // group and the replay silently drew nothing at all.
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.isRealActivityLayerOnMap())).toBe(true);
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount())).toBeGreaterThan(0);

    // Everything below drives the replay from the map-docked controls, so
    // the analysis modal (and its full-map backdrop) has to be out of the
    // way first — which is exactly the workflow the docked controls exist
    // for.
    await page.click("#sim-bottleneck-modal [data-close]");
    await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

    // The replayed packet must be visually distinct from the surrounding
    // traffic — that's the whole point of the window view, so it's asserted
    // on stroke colour rather than left to the eye. Only the target's own
    // colour is guaranteed: a quiet mesh can genuinely have no other traffic
    // in the window, in which case there's nothing to contrast it against.
    const colours = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityColors());
    expect(colours.filter((c) => c === "#f472b6").length).toBeGreaterThan(0);
    expect(colours.every((c) => ["#f472b6", "#22d3ee", "#a855f7", "#f87171"].includes(c))).toBe(true);

    // These are floods, so the replay also plays our model's own simulation
    // of the same window alongside the observations — engine receptions, not
    // a geometric fan, so they carry arrival times and collisions. Without
    // them a flood renders as a single thread and the whole mesh looks like
    // it missed the packet. Conditional because a window whose senders have
    // no modelled links produces no predicted receptions, which is a real
    // (if uninteresting) state rather than a failure.
    if (colours.some((c) => c === "#a855f7" || c === "#f87171")) {
      await page.uncheck("#sim-map-show-flood-reach");
      const withoutReach = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityColors());
      expect(withoutReach.filter((c) => c === "#a855f7" || c === "#f87171").length).toBe(0);
      expect(withoutReach.filter((c) => c === "#f472b6").length).toBeGreaterThan(0);
      await page.check("#sim-map-show-flood-reach");
    }

    // The same shared transport drives the real replay, scrubbing real
    // seconds into the window (compressed play time under the hood).
    await page.click("#sim-map-real-replay");
    await expect(page.locator("#sim-transport")).toBeVisible();
    await expect(page.locator("#sim-transport-label")).toContainText("Real traffic ±");
    await expect(page.locator("#sim-transport-time")).toContainText("s ·");
    const realSeek = page.locator("#sim-transport-seek");
    const realMax = parseInt(await realSeek.getAttribute("max"), 10);
    await realSeek.fill(String(realMax));
    const linesEnd = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount());
    await realSeek.fill("0");
    const linesStart = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount());
    expect(linesEnd).toBeGreaterThan(0);
    // CoreScope timestamps a whole observation at one instant, so a quiet
    // window can legitimately collapse to a single point in time — there's
    // nothing to scrub through then, and the transport correctly draws
    // everything at position 0. Only demand progression when the window
    // actually spans more than one instant.
    if (realMax > 1) expect(linesStart).toBeLessThan(linesEnd);
    else expect(linesStart).toBe(linesEnd);

    // Clicking a repeater during a replay has to answer "what happened
    // here", the same as it does after a simulation — and label which half
    // is measured and which is predicted. It used to open an inspector of
    // all zeros and "Nothing to show." for any repeater the engine's own
    // single-packet run didn't reach, even ones the map had just drawn a
    // flood line to.
    const probe = await page.evaluate(() => {
      const d = window.__hopreachSimulatorDebug;
      const n = d.getNodeCount();
      const rep = d.getLastReport() || {};
      const busy = new Set((rep.receptions || []).map((r) => r.node));
      let quiet = -1;
      for (let i = 0; i < n; i++) if (!busy.has(i)) { quiet = i; break; }
      return { any: n > 0 ? 0 : -1, quiet };
    });
    for (const idx of [probe.any, probe.quiet]) {
      if (idx < 0) continue;
      await page.evaluate((i) => window.__hopreachSimulatorDebug.openNodeInspector(i), idx);
      await expect(page.locator("#sim-packet-modal")).toBeVisible();
      // Both halves are labelled, so neither can be mistaken for the other.
      await expect(page.locator("#sim-packet-modal-observed-section")).toBeVisible();
      await expect(page.locator("#sim-packet-modal-received-title")).toContainText("Predicted");
      await expect(page.locator("#sim-packet-modal-summary")).toContainText("observed sending");
      await expect(page.locator("#sim-packet-modal-summary")).toContainText("observed receiving");
      // A repeater with no predicted activity explains itself rather than
      // dead-ending on "Nothing to show."
      const body = await page.locator("#sim-packet-modal-list").innerText();
      expect(body).not.toBe("Nothing to show.");
      await page.locator("#sim-packet-modal [data-close]").first().click();
      await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
    }

    // ...including after a close/reopen of the simulator panel, which is
    // the exact sequence that used to detach it.
    await page.click("#sim-panel-close");
    await page.click("#sim-toggle");
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.isRealActivityLayerOnMap())).toBe(true);
    await page.click("#sim-map-real-replay-skip");
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount())).toBeGreaterThan(0);
  }
});

// Region decoding used to go through SubtleCrypto, which is undefined
// outside a secure context — i.e. on any plain-http deployment that isn't
// localhost, including this project's own production setup. It threw, got
// swallowed, and left every packet simulated as unscoped, which most
// repeaters then refuse: a whole replay of "Region mismatch — not relayed"
// on exactly the deployment it's built for, while working fine locally.
// This pins the pure-JS implementation that replaced it against real
// packets and an independent reference.
test("decodes real packet regions without SubtleCrypto", async ({ page, request }) => {
  const crypto = require("crypto");

  const statsResp = await request.get("http://localhost:8080/corescope-api/api/scope-stats?window=7d");
  test.skip(!statsResp.ok(), "CoreScope scope-stats unavailable");
  const names = ((await statsResp.json()).byRegion || []).map((r) => r.name).filter(Boolean);
  test.skip(names.length === 0, "no live regions to decode against");

  const pktResp = await request.get("http://localhost:8080/corescope-api/api/packets?limit=120");
  test.skip(!pktResp.ok(), "CoreScope packets unavailable");
  const packets = ((await pktResp.json()).packets || []).filter((p) => p.raw_hex).slice(0, 60);
  test.skip(packets.length === 0, "no live packets to decode");

  // Independent reference: the same algorithm via node:crypto, mirroring
  // internal/corescope/scope.go's decodePacketRegion.
  const reference = (rawHex) => {
    const raw = Buffer.from(rawHex, "hex");
    if (raw.length < 6) return "";
    const routeType = raw[0] & 0x03;
    if (routeType !== 0 && routeType !== 3) return "";
    const code1 = raw[1] | (raw[2] << 8);
    const pathLenByte = raw[5];
    const pathEnd = 6 + (pathLenByte & 0x3f) * ((pathLenByte >> 6) + 1);
    if (pathEnd > raw.length) return "";
    const msg = Buffer.concat([Buffer.from([(raw[0] >> 2) & 0x0f]), raw.slice(pathEnd)]);
    for (const n of names) {
      const key = crypto.createHash("sha256").update(n).digest().slice(0, 16);
      const mac = crypto.createHmac("sha256", key).update(msg).digest();
      if ((mac[0] | (mac[1] << 8)) === code1) return n;
    }
    return "";
  };

  await page.waitForFunction(() => !!(window.__hopreachSimulatorDebug && window.__hopreachSimulatorDebug.decodeRegion));

  let scoped = 0;
  for (const p of packets) {
    const got = await page.evaluate((hex) => window.__hopreachSimulatorDebug.decodeRegion(hex), p.raw_hex);
    expect(got, `region for packet ${p.hash}`).toBe(reference(p.raw_hex));
    if (got) scoped++;
  }
  // Real ScotMesh traffic is largely scoped; decoding none of it would mean
  // the decoder is silently returning "" for everything, which is precisely
  // the failure this test exists to catch.
  expect(scoped).toBeGreaterThan(0);
});

// Simulate mode is about individual repeaters and the links between them,
// and both the coverage raster and marker clustering get in the way of
// that — clustering especially, since a cluster bubble is itself a marker
// and swallows clicks meant for the simulated node underneath it.
test("entering simulate mode clears coverage and clustering, and restores them on exit", async ({ page }) => {
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-marker-icon").length > 0, { timeout: 60_000 });

  const state = () =>
    page.evaluate(() => {
      let coverageOn = null;
      document.querySelectorAll(".leaflet-control-layers-overlays label").forEach((l) => {
        if (l.textContent.includes("Estimated coverage")) coverageOn = l.querySelector("input").checked;
      });
      return {
        coverageOn,
        clusters: document.querySelectorAll(".marker-cluster").length,
        clusterDisabled: (document.getElementById("disable-clustering-toggle") || {}).checked,
      };
    });

  const before = await state();
  test.skip(before.coverageOn === null, "no coverage overlay published in this build");

  await page.click("#sim-toggle");
  await expect.poll(async () => (await state()).coverageOn, { timeout: 10_000 }).toBe(false);
  const during = await state();
  expect(during.clusterDisabled).toBe(true);
  expect(during.clusters).toBe(0);

  // Restored, not blanket re-enabled.
  await page.click("#sim-panel-close");
  await expect.poll(async () => (await state()).coverageOn, { timeout: 10_000 }).toBe(before.coverageOn);
  expect((await state()).clusterDisabled).toBe(before.clusterDisabled);

  // Someone who had already turned clustering off keeps it off afterwards,
  // rather than having the map reconfigured behind them.
  await page.evaluate(() => {
    const el = document.getElementById("disable-clustering-toggle");
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.click("#sim-toggle");
  await page.click("#sim-panel-close");
  await expect.poll(async () => (await state()).clusterDisabled, { timeout: 10_000 }).toBe(true);
});

test("the map key clears the map-tools buttons instead of sitting under them", async ({ page }) => {
  await page.goto("/");
  await page.click("#sim-toggle");

  // The Plan/Simulate/Companion pin/Declutter row is absolutely positioned
  // in the bottom-left corner above Leaflet's control corners, so anything
  // Leaflet docks along the bottom edge has to clear it. Both corners are
  // lifted by the measured height of that row (see --map-tools-clearance).
  // Measured with a probe in the corner rather than the corner element
  // itself: an empty corner has no size to measure, and the thing that
  // actually has to clear the buttons is a control sitting in it.
  await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.id = "clearance-probe";
    probe.style.cssText = "width:40px;height:40px";
    document.querySelector("#map-wrap .leaflet-bottom.leaflet-left").appendChild(probe);
  });
  const toolsBox = await page.locator("#map-tools").boundingBox();
  const probeBox = await page.locator("#clearance-probe").boundingBox();
  expect(probeBox.y + probeBox.height).toBeLessThanOrEqual(toolsBox.y);
});

test("reconstructs a real CoreScope window as an editable episode with actual-vs-predicted analysis", async ({ page, request }) => {
  test.slow();

  // Find a flood packet (route 0/1) with a resolvable path — the same
  // liveness guard the bottleneck-replay test uses, since CoreScope's own
  // path resolution can legitimately be empty for a given packet.
  const packetsResp = await request.get("/corescope-api/api/packets?limit=60");
  expect(packetsResp.ok()).toBeTruthy();
  const packetsData = await packetsResp.json();
  const floods = (packetsData.packets || []).filter((p) => (p.route_type === 0 || p.route_type === 1) && p.observation_count > 1);
  let candidateHash = null;
  for (const p of floods.slice(0, 12)) {
    const detailResp = await request.get(`/corescope-api/api/packets/${p.hash}`);
    if (!detailResp.ok()) continue;
    const detail = await detailResp.json();
    if ((detail.observations || []).some((o) => Array.isArray(o.resolved_path) && o.resolved_path.length > 0 && o.resolved_path[0])) {
      candidateHash = p.hash;
      break;
    }
  }
  test.skip(!candidateHash, "no flood packet with resolvable path data currently available from CoreScope");

  await page.click("#sim-toggle");
  await page.fill("#sim-replay-hash-input", candidateHash);
  await page.fill("#sim-replay-window-secs", "20");
  await page.click("#sim-reconstruct-episode");
  // Reconstruction ends by re-enabling its button and reporting success — wait
  // for the completed state, not just the episode entry point becoming visible
  // (which can race the node commit under parallel load).
  await expect(page.locator("#sim-reconstruct-episode")).toBeEnabled({ timeout: 120_000 });
  await expect(page.locator("#sim-status")).toContainText("Reconstructed", { timeout: 5_000 });
  await expect(page.locator("#sim-open-episode-modal")).toBeVisible();

  // A runnable scenario was loaded from real data.
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBeGreaterThan(1);
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getLinkCount())).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getMessageGeneratorCount())).toBeGreaterThan(0);
  const episode = await page.evaluate(() => window.__hopreachSimulatorDebug.getEpisode());
  expect(episode.hash).toBe(candidateHash);

  // Run it, then the episode analysis compares our simulation to reality.
  await page.click("#sim-run");
  await page.waitForFunction(() => window.__hopreachSimulatorDebug.getLastReport() !== null, { timeout: 60_000 });
  await page.click("#sim-open-episode-modal");
  await expect(page.locator("#sim-episode-modal")).toBeVisible();
  await expect(page.locator("#sim-episode-provenance")).toContainText(candidateHash);
  await expect(page.locator("#sim-episode-recall")).toContainText(/delivered this packet to/);
  // The before/after problem table always has its four rows (incl. the
  // evidence-contradicted deliveries count).
  await expect(page.locator("#sim-episode-problems-tbody tr")).toHaveCount(4);

  // Pin a baseline, and the delta column becomes populated.
  await page.click("#sim-episode-set-baseline");
  await expect(page.locator("#sim-episode-problems-tbody tr").first()).toContainText("no change");
});

// "Add repeater" is the counterpart to "Add companion location": place a
// hypothetical relay by clicking the map, without needing it to exist in a
// saved plan or in CoreScope first. The two differ in exactly one way that
// matters to the engine — a companion never relays (canRelay) — so the
// nodes table also lets any node's type be switched, which is a what-if
// switch and deliberately does not touch the underlying CoreScope data.
test("places a repeater by clicking the map, and can switch a node's type", async ({ page }) => {
  await page.click("#sim-toggle");
  await openAccordion(page, "sim-acc-nodes");

  const map = page.locator("#map");
  const box = await map.boundingBox();

  await page.click("#sim-add-repeater");
  await expect(page.locator("#sim-add-repeater")).toHaveClass(/active/);
  await expect(page.locator("#sim-repeater-hint")).toBeVisible();

  const p1 = await findClickableMapPoint(page, map);
  await page.mouse.click(box.x + p1.x, box.y + p1.y);
  await expect(page.locator("#sim-node-count-badge")).toHaveText("1");

  // Toggling the button off stops placing — a further map click must not
  // add another node.
  await page.click("#sim-add-repeater");
  await expect(page.locator("#sim-add-repeater")).not.toHaveClass(/active/);
  await expect(page.locator("#sim-repeater-hint")).toBeHidden();

  // A placed repeater relays, so it renders as a repeater marker rather
  // than a companion one.
  await expect(page.locator(".sim-marker-icon")).toHaveCount(1);
  await expect(page.locator(".sim-marker-companion")).toHaveCount(0);

  // The two placement modes are mutually exclusive, not additive.
  await page.click("#sim-add-repeater");
  await page.click("#sim-add-companion");
  await expect(page.locator("#sim-add-repeater")).not.toHaveClass(/active/);
  await expect(page.locator("#sim-repeater-hint")).toBeHidden();
  await expect(page.locator("#sim-add-companion")).toHaveClass(/active/);
  await page.click("#sim-add-companion");

  // Switch that repeater to a companion in the settings table.
  await page.click("#sim-open-nodes-modal");
  const typeSelect = page.locator('#sim-nodes-modal-tbody [data-field="nodeType"]').first();
  await expect(typeSelect).toHaveValue("repeater");
  await typeSelect.selectOption("companion");
  await page.click("#sim-nodes-modal-apply");

  // The map has to follow the switch, not just the table.
  await expect(page.locator(".sim-marker-companion")).toHaveCount(1);
  await expect(page.locator(".sim-marker-icon")).toHaveCount(0);

  // And it must survive a reopen of the table rather than being a
  // render-time-only flourish. (Apply deliberately leaves the modal open,
  // so close it before reopening or its own backdrop eats the click.)
  await page.click("#sim-nodes-modal [data-close]");
  await expect(page.locator("#sim-nodes-modal")).toBeHidden();
  await page.click("#sim-open-nodes-modal");
  await expect(page.locator('#sim-nodes-modal-tbody [data-field="nodeType"]').first()).toHaveValue("companion");
});
