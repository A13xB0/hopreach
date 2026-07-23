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
