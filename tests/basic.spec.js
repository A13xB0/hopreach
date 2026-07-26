// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");

// On a genuinely fresh deployment (this test deliberately doesn't wait for
// real data — see helpers.js), app.js's loadRepeaters()/loadMeta() can lose
// a real startup race against the container's own background fetch and
// log a caught 404 (see app.js's loadRepeaters/loadMeta, both wrapped in
// .catch(console.error)) plus the browser's own network-level "Failed to
// load resource" line for the same request — expected, by-design
// graceful-degradation, not a bug. Filtered out by name; anything else
// still fails the test.
const EXPECTED_STARTUP_RACE_ERRORS = [/HTTP 404/, /Failed to load resource/];

test("site loads, map renders, WASM ready, no unexpected console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await gotoReady(page);
  await expect(page).toHaveTitle(/./); // non-empty; the site's own configured title, not hardcoded here
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator(".leaflet-container")).toBeVisible();

  const unexpected = errors.filter((e) => !EXPECTED_STARTUP_RACE_ERRORS.some((pattern) => pattern.test(e)));
  expect(unexpected, `unexpected console/page errors:\n${unexpected.join("\n")}`).toEqual([]);
});

test("progress.json is well-formed JSON with a known stage", async ({ page, request }) => {
  await page.goto("/");
  const resp = await request.get("/data/progress.json");
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(typeof body.stage).toBe("string");
  expect(body.stage.length).toBeGreaterThan(0);
});

// The one test in this suite that genuinely depends on the container's
// background fetch reaching a live, third-party CoreScope instance over
// the real network — kept isolated from every other test (which have no
// actual need for real data, see helpers.js) so a slow/unreachable
// CoreScope from a given CI environment fails only this one check, not the
// whole suite.
test("repeater stats eventually populate from real data", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await expect(page.locator("#count-active")).not.toHaveText("–", { timeout: 120_000 });
});

// Also genuinely network-dependent (CoreScope's own GET /api/scope-stats,
// fetched client-side — see app.js's initScopeFilterControl), kept
// isolated the same way. This only checks that the control itself renders
// with a real, live region list and that toggling one filters markers —
// see the test below for actually checking a per-scope coverage overlay
// renders (skipped here since that needs corescope.scope_observation to be
// enabled, off by default, so meta.json's scope_coverage may legitimately
// be empty on a given instance).
test("scope filter control renders real CoreScope regions and filters markers", async ({ page }) => {
  test.slow();
  await page.goto("/");
  const control = page.locator(".scope-filter-control");
  await expect(control).toBeVisible({ timeout: 60_000 });

  const checkboxes = control.locator('input[type="checkbox"]');
  await expect(checkboxes.first()).toBeAttached({ timeout: 60_000 });
  const scopeCount = await checkboxes.count();
  expect(scopeCount).toBeGreaterThan(0);

  // Every option should be either a real "#..." region name (from
  // CoreScope's own scope-stats) or the synthetic "unscoped" bucket —
  // never empty/garbage.
  const scopes = await checkboxes.evaluateAll((els) => els.map((el) => el.dataset.scope));
  for (const s of scopes) {
    expect(s === "unscoped" || /^#/.test(s), `unexpected scope option ${JSON.stringify(s)}`).toBeTruthy();
  }
});

// Per-scope coverage tiles (run()'s "computing_scope_coverage" block) are
// pre-rendered server-side, nightly — same reliability as the main
// coverage layer, unlike an earlier version of this feature that computed
// live client-side WASM rasters on every tick. Skips (rather than fails)
// when scope_coverage is empty: corescope.scope_observation is off by
// default, so a CI instance running the image's built-in config
// legitimately has none — this only verifies real rendering behaviour
// when real per-scope tiles do exist.
test("checking a region with real coverage tiles renders that region's own overlay", async ({ page, request }) => {
  await page.goto("/");
  const metaResp = await request.get("/data/meta.json");
  expect(metaResp.ok()).toBeTruthy();
  const meta = await metaResp.json();
  const scopeNames = Object.keys(meta.scope_coverage || {});
  test.skip(scopeNames.length === 0, "no scope_coverage on this instance (scope_observation disabled, or no region has any member repeater yet)");

  const name = scopeNames[0];
  const control = page.locator(".scope-filter-control");
  await expect(control).toBeVisible({ timeout: 60_000 });
  await page.locator(`.scope-filter-control input[data-scope="${name}"]`).check();

  const overlay = page.locator('.leaflet-image-layer[src*="coverage-scope-"]').first();
  await expect(overlay).toBeVisible({ timeout: 10_000 });

  // Unchecking removes it again — not just adds and forgets.
  await page.locator(`.scope-filter-control input[data-scope="${name}"]`).uncheck();
  await expect(page.locator('.leaflet-image-layer[src*="coverage-scope-"]')).toHaveCount(0);
});

// "Map detail" defaults to Calibrated Precision when it's available (see
// app.js's POSITION_MODE_MIGRATION_KEY), including a one-time reset for a
// visitor with an older saved preference from before that was the default
// — but only once: a choice made after that reset is saved and respected
// normally, same as before this default even existed.
test("map detail defaults to Calibrated Precision, resetting an old saved preference once", async ({ page }) => {
  test.slow(); // waits on the real meta.json coverage tiers to know what's actually available

  // A genuinely fresh visitor gets the new default, saved.
  await page.goto("/");
  // The control only exists once meta.json reports more than one coverage
  // tier, so an instance that hasn't computed any (a fresh container with
  // no coverage run behind it) legitimately never renders it. Skip in that
  // case rather than timing out — the assertions below are about the
  // default *among available tiers*, which is vacuous without them.
  const modeSelect = page.locator("#position-mode-select");
  try {
    await modeSelect.waitFor({ state: "visible", timeout: 60_000 });
  } catch {
    test.skip(true, "this instance publishes no coverage tiers, so there's no Map detail control");
  }
  const available = await modeSelect.locator("option").evaluateAll((els) => els.map((el) => el.value));
  test.skip(!available.includes("calibrated_precision"), "this instance doesn't have a calibrated_precision tier to default to");

  await expect(page.locator("#position-mode-select")).toHaveValue("calibrated_precision");
  expect(await page.evaluate(() => localStorage.getItem("hopreach.positionMode"))).toBe("calibrated_precision");
  const migrationKey = await page.evaluate(() =>
    Object.keys(localStorage).find((k) => k.startsWith("hopreach.positionModeDefaultMigrated"))
  );
  expect(migrationKey).toBeTruthy();

  // A returning visitor with an old saved preference, predating the
  // migration flag, gets reset to the new default exactly once.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("hopreach.positionMode", "standard");
  });
  await page.reload();
  await page.waitForSelector("#position-mode-select", { timeout: 60_000 });
  await expect(page.locator("#position-mode-select")).toHaveValue("calibrated_precision");

  // Once migrated, explicitly choosing something else sticks across a reload.
  await page.selectOption("#position-mode-select", "standard");
  await page.reload();
  await page.waitForSelector("#position-mode-select", { timeout: 60_000 });
  await expect(page.locator("#position-mode-select")).toHaveValue("standard");
});

// Regression test for a real bug found from live phone screenshots:
// #map-tools docks bottom-left and the panels used to dock right at up to
// 92vw, so on a phone a panel's left edge sat ON TOP of the toolbar —
// same z-index, later in DOM order, so the panel won. The toolbar stayed
// visibly on screen but every tap on it hit whatever panel content was
// underneath, confirmed via elementFromPoint at a button's own centre
// landing on an unrelated button inside the panel.
//
// The phone layout removes the overlap rather than working around it: the
// panels are bottom SHEETS and #map-tools is the full-width tab bar
// directly beneath them, so the two stack. The invariant worth pinning
// down is therefore the one the bug actually violated — a tap on a tab
// bar button reaches that button — not the old workaround of hiding the
// bar, which cost the phone layout its navigation.
test("the tab bar stays tappable, not swallowed by an open sheet, on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/");
  await expect(page.locator("#map-tools")).toBeVisible();

  for (const [openId, panelId, closeId] of [
    ["#sim-toggle", "#sim-panel", "#sim-panel-close"],
    ["#plan-toggle", "#plan-panel", "#plan-panel-close"],
  ]) {
    await page.click(openId);
    await expect(page.locator(panelId)).toBeVisible();
    // The nav stays put while a sheet is open — that's the whole point of
    // a tab bar.
    await expect(page.locator("#map-tools")).toBeVisible();

    // The sheet must sit entirely ABOVE the bar, never across it.
    const stacked = await page.evaluate((sel) => {
      const sheet = document.querySelector(sel).getBoundingClientRect();
      const bar = document.querySelector("#map-tools").getBoundingClientRect();
      return { overlaps: sheet.bottom > bar.top + 1, barTop: bar.top, sheetBottom: sheet.bottom };
    }, panelId);
    expect(stacked.overlaps, `sheet ${panelId} overlaps the tab bar: ${JSON.stringify(stacked)}`).toBe(false);

    // And the original bug directly: hit-testing each button's own centre
    // must return that button, not something inside the sheet.
    const misrouted = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll("#map-tools button").forEach((btn) => {
        if (btn.offsetParent === null) return; // not shown at this width
        const r = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || hit.closest("#map-tools") === null) bad.push(btn.id);
      });
      return bad;
    });
    expect(misrouted, `taps on these tab bar buttons land elsewhere: ${misrouted.join(", ")}`).toEqual([]);

    await page.click(closeId);
    await expect(page.locator(panelId)).toBeHidden();
  }

  // Desktop must be completely unaffected — there the toolbar is still the
  // floating bottom-left cluster and the panels are still right-docked
  // sidebars, which coexist without overlapping at all.
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.click("#sim-toggle");
  await expect(page.locator("#sim-panel")).toBeVisible();
  await expect(page.locator("#map-tools")).toBeVisible();
});

// The phone layout moves the controls that stack down the map's right edge
// on desktop into a single "Map options" sheet — MOVED, not copied, so
// there's exactly one of each with its listeners intact. Both directions
// of the breakpoint have to work: a rotate or a desktop window resize must
// not leave a control stranded in a sheet that's now display:none.
test("map controls move into the Map options sheet on a phone and back on desktop", async ({ page }) => {
  const inSheet = () => page.locator("#map-options-body > *").count();
  const onMap = () => page.locator(".leaflet-top.leaflet-right > *").count();

  await page.setViewportSize({ width: 1500, height: 900 });
  await page.goto("/");
  // Wait for the async-mounting controls (the region filter waits on a
  // live CoreScope call) so the counts below aren't racing the last one in.
  await expect(page.locator(".scope-filter-control")).toBeVisible({ timeout: 60_000 });

  const desktopOnMap = await onMap();
  expect(desktopOnMap).toBeGreaterThan(0);
  expect(await inSheet()).toBe(0);
  await expect(page.locator("#map-options-sheet")).toBeHidden();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(inSheet).toBeGreaterThan(0);
  expect(await onMap()).toBe(0);

  // Exactly one of each — a clone would silently double them up, and the
  // copy without listeners is the one you'd end up tapping.
  for (const sel of [".map-display-control", ".position-mode-control", ".scope-filter-control", ".legend"]) {
    expect(await page.locator(sel).count(), `${sel} should exist exactly once`).toBe(1);
  }

  // The sheet opens from the tab bar and the moved controls still work —
  // toggling a real checkbox proves the listeners came with the element.
  await page.click("#map-options-toggle");
  await expect(page.locator("#map-options-sheet")).toBeVisible();
  const clustering = page.locator("#map-options-body #toggle-clustering");
  if (await clustering.count()) {
    await page.click("#map-options-body .map-display-control .map-control-header");
    await clustering.check();
    await expect(clustering).toBeChecked();
  }
  await page.click("#map-options-close");
  await expect(page.locator("#map-options-sheet")).toBeHidden();

  // Back to desktop: everything returns to the map, nothing stranded.
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(onMap).toBe(desktopOnMap);
  expect(await inSheet()).toBe(0);
});
