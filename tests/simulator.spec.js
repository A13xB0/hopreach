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

// Leaflet occasionally swallows the very first click on a map right after
// it's been shown/resized (its own internal click-vs-drag detection can
// still be settling) — pre-existing flakiness, not specific to any one
// test. Retries once after a short wait rather than failing outright.
async function clickMapUntilNodeCount(page, map, position, expectedCount) {
  await map.click({ position });
  try {
    await expect
      .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount()), { timeout: 1500 })
      .toBe(expectedCount);
  } catch {
    await map.click({ position });
    await expect
      .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount()), { timeout: 3000 })
      .toBe(expectedCount);
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
});

// Regression test: the four toolbar buttons that open a results modal
// start with class="hidden" in the HTML and are only revealed once a real
// run actually produces something to show (see
// renderResults/renderSuggestions/renderBottleneckAnalysis/renderRankings)
// — but class="hidden" alone does nothing without a matching CSS rule, and
// this project has already hit that exact bug once (the docked sections
// these buttons replaced). Also checks the modal backdrop itself starts
// closed — opening Simulate mode must not pop any modal open on its own.
test("results/analysis buttons and modals stay hidden until a simulation actually produces something", async ({ page }) => {
  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();
  for (const id of ["sim-open-results-modal", "sim-open-predictions-modal", "sim-open-bottleneck-modal", "sim-rankings-expand"]) {
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
  // cover the map-docked playback control this same run reveals (see
  // ensureSimPlaybackControl) — but the toolbar button appears, and the
  // map's own playback control is immediately usable without opening it.
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
  await expect(page.locator("#sim-open-results-modal")).toBeVisible();
  await expect(page.locator(".sim-playback-control")).toBeVisible();
  await expect(page.locator("#sim-map-results-log .plan-list-item").first()).toBeVisible();

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
  await expect(page.locator("#sim-rankings-fullwindow-body th")).toContainText(["Repeater", "Successful", "Collisions (own)", "Contention (caused)", "Success rate"]);
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

test("clicking a repeater marker opens the repeaters modal, and applied settings persist", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.selectOption("#plan-select", TEST_PLAN.id);
  await page.click("#plan-toggle");

  await page.click("#sim-toggle");
  await page.click("#sim-load-planned");
  await expect(page.locator("#sim-node-count-badge")).toHaveText("2");

  await page.locator(".sim-marker-icon").first().click({ force: true });
  await expect(page.locator("#sim-nodes-modal")).toBeVisible();
  const firstRow = page.locator("#sim-nodes-modal-tbody tr").first();
  // txDelayFactor, directTxDelayFactor, rxDelayBase, txPowerDbm, hashSize
  // (number inputs) plus loopDetect (its own select, not matched here).
  await expect(firstRow.locator("input[data-field]")).toHaveCount(5);
  await expect(firstRow.locator("select[data-field=\"loopDetect\"]")).toHaveCount(1);

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
  await expect(page.locator("#sim-packet-modal-list .plan-list-item").first()).toBeVisible();
  await page.locator("#sim-packet-modal [data-close]").first().click();
  await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

  // Once a report exists, clicking a repeater marker on the map opens the
  // packet inspector for that node instead of the settings modal. With
  // only two closely-spaced test repeaters, both can end up tucked behind
  // the bottom-right playback control at this viewport size — pan the map
  // so the markers land somewhere clear of it before clicking.
  await page.evaluate(() => window.__hopreachSimulatorDebug.panBy(300, 300));
  await page.locator(".sim-marker-icon").first().click();
  await expect(page.locator("#sim-packet-modal")).toBeVisible();
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
  // inspector, reachable without going back to the map. This modal was
  // also widened (see #sim-nodes-modal's own CSS) so its config table
  // shouldn't need horizontal scrolling at the default test viewport.
  await page.click("#sim-open-nodes-modal");
  await expect(page.locator("#sim-nodes-modal-tbody tr [data-act=\"packets\"]").first()).toBeVisible();
  const overflowsHorizontally = await page.locator(".sim-config-table-scroll").evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(overflowsHorizontally).toBe(false);
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
  await clickMapUntilNodeCount(page, map, { x: box.width / 2, y: box.height / 2 }, 1);
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
  await clickMapUntilNodeCount(page, map, { x: box.width / 2, y: box.height / 2 }, 1);
  await expect(page.locator(".sim-marker-companion")).toHaveCount(1);
  await map.click({ position: { x: box.width / 4, y: box.height / 4 } });
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
  // Replay/skip-to-end work straight from the map-docked playback control,
  // without needing to open the Results modal at all.
  await expect(page.locator("#sim-map-replay-status")).toBeVisible();

  await page.click("#sim-map-skip-to-end");
  await expect(page.locator("#sim-map-replay-status")).toContainText("final state");

  // The same controls, mirrored, also work from inside the modal.
  await page.click("#sim-open-results-modal");
  await expect(page.locator("#sim-results-modal")).toBeVisible();
  await expect(page.locator("#sim-replay-status")).toContainText("final state");
  await page.click("#sim-replay");
  await expect(page.locator("#sim-replay-status")).not.toContainText("final state");
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

  // Replaying a packet opens the Bottleneck analysis modal automatically.
  await expect(page.locator("#sim-bottleneck-modal")).toBeVisible();
  await expect(page.locator("#sim-bottleneck-summary")).toContainText("proven hop");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBeGreaterThan(0);

  // Whichever direction the real data happened to fall in this run, at
  // least one of the two comparison lists should say something concrete —
  // proves the diff logic actually ran, not just that nothing crashed.
  const bottleneckText = await page.locator("#sim-bottleneck-list").innerText();
  const unmodeledText = await page.locator("#sim-unmodeled-list").innerText();
  expect(bottleneckText.length + unmodeledText.length).toBeGreaterThan(0);

  // The map key explaining the line colours should be showing alongside
  // the analysis (see ensureBottleneckLegendControl).
  await expect(page.locator(".sim-bottleneck-legend")).toBeVisible();
  await expect(page.locator(".sim-bottleneck-legend")).toContainText("Proven & modeled");

  // The ±30s real-activity replay only shows once some other real traffic
  // was actually found in that window — on a quiet mesh at replay time
  // there may genuinely be none, so this is conditional rather than
  // asserting it's always present.
  const replaySectionHidden = await page.locator("#sim-bottleneck-replay-section").evaluate((el) => el.classList.contains("hidden"));
  if (!replaySectionHidden) {
    await page.click("#sim-bottleneck-replay-skip");
    await expect(page.locator("#sim-bottleneck-replay-status")).not.toHaveText("");
  }
});
