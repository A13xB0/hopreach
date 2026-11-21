// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");

// Needs real repeater data and terrain tiles: skips when there are none.
// The first progress poll (~2s in) reloads the data and redraws the markers,
// closing any popup, so wait for it to settle before opening one.
test.beforeEach(async ({ page }) => {
  const firstPoll = page.waitForResponse((r) => r.url().includes("progress.json"));
  await gotoReady(page);
  await firstPoll;
  await page.waitForLoadState("networkidle");
});

// Opens the first repeater's popup with clustering off, so its marker is on
// the map; returns its name, or null when there are no repeaters.
async function openFirstPopup(page) {
  return page.evaluate(async () => {
    const MC = window.MCCoverageMap;
    for (let i = 0; i < 100 && !MC.repeaterLatLng; i++) await new Promise((r) => setTimeout(r, 100));
    MC.setClusteringDisabled(true);
    let marker = null;
    for (let i = 0; i < 100 && !marker; i++) {
      MC.map.eachLayer((l) => {
        if (!marker && l.feature && l.feature.properties && l.feature.properties.public_key) marker = l;
      });
      if (!marker) await new Promise((r) => setTimeout(r, 100));
    }
    if (!marker) return null;
    MC.map.setView(marker.getLatLng(), 9, { animate: false });
    marker.openPopup();
    return marker.feature.properties.name || "Repeater";
  });
}

test("a repeater's coverage shows on its own, and Show all puts the map back", async ({ page }) => {
  const name = await openFirstPopup(page);
  test.skip(!name, "no repeaters");
  const container = page.locator(".leaflet-container");

  await page.locator(".popup-focus").dispatchEvent("click"); // the popup may still be panning into view
  const bar = page.locator(".focus-bar");
  await expect(bar).toContainText(`Preview estimate: ${name} only`);
  await expect(container).toHaveClass(/focus-active/);

  await expect(bar).toHaveClass(/done/, { timeout: 180_000 });
  await expect(bar).not.toContainText("Could not compute");
  await expect(page.locator(".leaflet-focusCoverage-pane img")).toHaveCount(1);
  // Every other coverage image (main, region scope, planner preview) is hidden.
  const shown = await page.$$eval(".leaflet-overlay-pane img.leaflet-image-layer", (imgs) =>
    imgs.filter((i) => getComputedStyle(i).visibility !== "hidden").length);
  expect(shown).toBe(0);

  // A Map detail change that leaves the marker where it is keeps the result.
  await page.evaluate(() => document.getElementById("position-mode-select").dispatchEvent(new Event("change", { bubbles: true })));
  await expect(bar).toHaveClass(/done/);
  await expect(page.locator(".leaflet-focusCoverage-pane img")).toHaveCount(1);

  await page.click(".focus-bar-close");
  await expect(bar).toHaveCount(0);
  await expect(container).not.toHaveClass(/focus-active/);
  await expect(page.locator(".leaflet-focusCoverage-pane img")).toHaveCount(0);
});

test("Esc ends the view, but not while typing or under an open popup", async ({ page }) => {
  const name = await openFirstPopup(page);
  test.skip(!name, "no repeaters");
  await page.locator(".popup-focus").dispatchEvent("click"); // the popup may still be panning into view
  const bar = page.locator(".focus-bar");
  await expect(bar).toBeVisible();

  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "focus-test-input";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press("Escape");
  await expect(bar).toBeVisible();

  // With a popup open and the map focused (as after clicking a marker), the
  // first Esc is Leaflet's, closing the popup; the next one ends the view.
  await page.evaluate(() => document.getElementById("focus-test-input").remove());
  await openFirstPopup(page);
  await page.locator(".leaflet-container").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".leaflet-popup")).toHaveCount(0);
  await expect(bar).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});

test("Simulate ends the view, and it can't start while Simulate is open", async ({ page }) => {
  const name = await openFirstPopup(page);
  test.skip(!name, "no repeaters");
  await page.locator(".popup-focus").dispatchEvent("click"); // the popup may still be panning into view
  await expect(page.locator(".focus-bar")).toBeVisible();
  await page.click("#sim-toggle");
  await expect(page.locator(".focus-bar")).toHaveCount(0);
  await expect(page.locator(".leaflet-container")).not.toHaveClass(/focus-active/);

  await openFirstPopup(page);
  const button = page.locator(".popup-focus").last(); // the previous popup may still be fading out
  await expect(button).toBeHidden();
  await button.dispatchEvent("click");
  await expect(page.locator(".focus-bar")).toHaveCount(0);
});
