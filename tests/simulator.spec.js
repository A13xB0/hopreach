// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");
const {
  TEST_PLAN,
  UNORDERED_PLAN,
  addMessageSenderViaModal,
  openAccordion,
  openAdvancedAccordion,
  findClickableMapPoint,
  clickMapUntilNodeCount,
  clickUntilVisible,
} = require("./sim-helpers");
const { useSeededPlan } = require("./sim-helpers");

useSeededPlan(test);

// Panel, run, predict, policy search and the adaptive optimizer.

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


