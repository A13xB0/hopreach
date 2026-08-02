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

// Nodes, message senders, the packet inspector and saved setups.

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

