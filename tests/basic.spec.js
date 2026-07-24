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
// renders (skipped here since that needs corescope.scope_inference to be
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
// when scope_coverage is empty: corescope.scope_inference is off by
// default, so a CI instance running the image's built-in config
// legitimately has none — this only verifies real rendering behaviour
// when real per-scope tiles do exist.
test("checking a region with real coverage tiles renders that region's own overlay", async ({ page, request }) => {
  await page.goto("/");
  const metaResp = await request.get("/data/meta.json");
  expect(metaResp.ok()).toBeTruthy();
  const meta = await metaResp.json();
  const scopeNames = Object.keys(meta.scope_coverage || {});
  test.skip(scopeNames.length === 0, "no scope_coverage on this instance (scope_inference disabled, or no region has any member repeater yet)");

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
  await page.waitForSelector("#position-mode-select", { timeout: 60_000 });
  const available = await page.locator("#position-mode-select option").evaluateAll((els) => els.map((el) => el.value));
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
