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

// Episode reconstruction, server-side region decoding, and map-mode housekeeping.

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

