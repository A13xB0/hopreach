// @ts-check
const { test, expect } = require("@playwright/test");

test("site loads, map renders, repeater stats populate, no console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");
  await expect(page).toHaveTitle(/./); // non-empty; the site's own configured title, not hardcoded here
  await expect(page.locator("#map")).toBeVisible();
  await expect(page.locator(".leaflet-container")).toBeVisible();

  // Repeater counts start at "–" and flip once repeaters.geojson loads —
  // a fast CoreScope fetch, not the (much slower) coverage compute.
  await expect(page.locator("#count-active")).not.toHaveText("–", { timeout: 60_000 });

  expect(errors, `unexpected console/page errors:\n${errors.join("\n")}`).toEqual([]);
});

test("progress.json is well-formed JSON with a known stage", async ({ page, request }) => {
  await page.goto("/");
  const resp = await request.get("/data/progress.json");
  expect(resp.ok()).toBeTruthy();
  const body = await resp.json();
  expect(typeof body.stage).toBe("string");
  expect(body.stage.length).toBeGreaterThan(0);
});
