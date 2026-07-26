// @ts-check
const { test, expect } = require("@playwright/test");
const { gotoReady } = require("./helpers");

// None of this file's tests touch real repeater data (add-repeater/LOS are
// client-only bookkeeping, companion pin is pure UI state) — see
// helpers.js for why readiness here doesn't wait on the live CoreScope
// fetch.
test.beforeEach(async ({ page }) => {
  await gotoReady(page);
});

test("plan panel opens, add-repeater places markers via map clicks, closes", async ({ page }) => {
  await page.click("#plan-toggle");
  await expect(page.locator("#plan-panel")).toBeVisible();
  await expect(page.locator("#map-wrap")).toHaveClass(/plan-open/);

  await page.click('.plan-mode-btn[data-mode="add-repeater"]');
  await expect(page.locator('.plan-mode-btn[data-mode="add-repeater"]')).toHaveClass(/active/);

  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  // Two clicks well apart — addRepeaterAt (see planner.js) is purely
  // synchronous bookkeeping (push to plan.repeaters, re-render the list),
  // so no wait for terrain/network is needed before asserting the count.
  // The offset has to clear the first marker's own icon footprint: a
  // second click landing on top of it hits the marker (which stops
  // propagation to the map's own click handler in Leaflet), not empty map,
  // and addRepeaterAt never fires for it.
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await map.click({ position: { x: box.width / 2 + 100, y: box.height / 2 + 100 } });

  await expect(page.locator("#plan-repeater-list .plan-list-item")).toHaveCount(2);

  await page.click("#plan-panel-close");
  await expect(page.locator("#plan-panel")).toBeHidden();
});

test("LOS mode builds a hop chain from map clicks", async ({ page }) => {
  await page.click("#plan-toggle");
  await page.click('.plan-mode-btn[data-mode="los"]');
  await expect(page.locator('.plan-mode-btn[data-mode="los"]')).toHaveClass(/active/);

  const map = page.locator("#map");
  const box = await map.boundingBox();
  if (!box) throw new Error("map has no bounding box");
  await map.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await map.click({ position: { x: box.width / 2 + 100, y: box.height / 2 + 100 } });

  await expect(page.locator("#plan-los-list .plan-list-item")).toHaveCount(2);

  await page.click("#plan-los-clear");
  await expect(page.locator("#plan-los-list")).toContainText("Click the map");
});

test("companion pin toggles on and off", async ({ page }) => {
  const toggle = page.locator("#companion-pin-toggle");
  await toggle.click();
  await expect(toggle).toHaveClass(/active/);
  await expect(page.locator("#companion-pin-hint")).toBeVisible();

  await toggle.click();
  await expect(toggle).not.toHaveClass(/active/);
  await expect(page.locator("#companion-pin-hint")).toBeHidden();
});

// Connect repeaters used to answer only "is every hop's margin >= 0 dB?",
// which is the bare demodulation threshold — a hop scraping in at 0.2 dB
// counted exactly the same as one with 25 dB of headroom, so a route could
// be reported as connected while being far too marginal to rely on.
// The finished route is now handed to the same meshsim engine the Simulate
// panel uses (planner-worker.js's checkRoute): it floods a packet from one
// end across several seeded trials and reports how often the other end
// actually received it, plus which single hop is weakest.
//
// Genuinely network-dependent (it needs real repeaters to connect and real
// DEM tiles for the terrain), so it's slow-marked and skips rather than
// fails on an instance with too few repeaters to bridge.
test("connect repeaters reports a simulated verdict for the route it found", async ({ page }) => {
  test.slow();

  await page.waitForFunction(() => document.querySelectorAll(".leaflet-marker-icon").length > 3, null, { timeout: 120_000 });
  // Un-cluster so individual repeaters are clickable rather than bubbles.
  await page.evaluate(() => {
    const cb = document.querySelector("#disable-clustering-toggle");
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await expect.poll(() => page.locator("path.leaflet-interactive").count(), { timeout: 30_000 }).toBeGreaterThan(3);

  await page.click("#plan-toggle");
  await page.click('.plan-mode-btn[data-mode="connect-repeaters"]');

  const markerPoints = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("path.leaflet-interactive")]
        .map((m) => {
          const r = m.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })
        .filter((p) => p.x > 60 && p.x < 1000 && p.y > 120 && p.y < 850)
    );

  const first = await markerPoints();
  test.skip(first.length < 2, "this instance has too few visible repeaters to connect two of them");
  first.sort((a, b) => a.y - b.y);
  const a = first[Math.floor(first.length / 2)];
  await page.mouse.click(a.x, a.y);
  await expect(page.locator("#plan-connect-status")).toContainText("selected", { timeout: 30_000 });

  // Re-query: selecting the first endpoint re-renders the markers, so the
  // earlier coordinates can be stale. Pick the nearest other repeater —
  // far-apart pairs frequently can't be bridged within the site cap at all.
  const second = await markerPoints();
  const b = second
    .filter((p) => Math.hypot(p.x - a.x, p.y - a.y) > 60)
    .sort((u, v) => Math.hypot(u.x - a.x, u.y - a.y) - Math.hypot(v.x - a.x, v.y - a.y))[0];
  test.skip(!b, "no second repeater within a bridgeable distance on screen");
  await page.mouse.click(b.x, b.y);

  const verdict = page.locator("#plan-connect-check");
  const status = page.locator("#plan-connect-status");
  await expect
    .poll(
      async () => {
        if (/Couldn't find a path/i.test((await status.textContent()) || "")) return "unbridgeable";
        return (await verdict.isVisible()) && (await verdict.textContent())?.trim() ? "verdict" : "";
      },
      { timeout: 300_000 }
    )
    .not.toBe("");
  test.skip(/Couldn't find a path/i.test((await status.textContent()) || ""), "these two repeaters can't be bridged within the site cap");

  // The verdict must be a real simulated result, not a placeholder.
  await expect(verdict).toContainText(/Simulated/);
  await expect(verdict).toContainText(/trials/);
  await expect(verdict).toContainText(/weakest hop -?\d+(\.\d+)? dB/);

  // The search never builds a hop below the lowest quality target (0 dB),
  // so a negative weakest hop means the reported figure didn't come from
  // the route on screen. That really happened: every route named its new
  // sites relay-0, relay-1, … and the margin cache is keyed by node-id
  // pair, so the second route's relay-0 read back the first route's
  // margin for a site somewhere else entirely — surfacing impossible
  // values like -15 dB and, worse, feeding the ranking bad numbers.
  const weakest = parseFloat(((await verdict.textContent()) || "").match(/weakest hop (-?\d+(?:\.\d+)?) dB/)[1]);
  expect(weakest, "a route the search built cannot contain a below-threshold hop").toBeGreaterThanOrEqual(0);
  // And it must commit to one of the three states, which is what colours it.
  const cls = (await verdict.getAttribute("class")) || "";
  expect(cls, `verdict classes were ${cls}`).toMatch(/\b(good|warn|bad)\b/);
  expect(cls).not.toContain("hidden");
});
