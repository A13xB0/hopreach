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

// Replay: the shared transport, real observed links, and replaying a real packet.

test("the replay transport plays, pauses, and seeks in both directions", async ({ page }) => {
  test.slow(); // link-building fetches real DEM tiles

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

  // A run points the shared transport at its own flood and starts playing.
  const bar = page.locator("#sim-transport");
  await expect(bar).toBeVisible();
  await expect(page.locator("#sim-transport-label")).toHaveText("Simulated flood");

  const seek = page.locator("#sim-transport-seek");
  const max = parseInt(await seek.getAttribute("max"), 10);
  expect(max).toBeGreaterThan(0);

  // Pause has to actually stop the clock, not just relabel the button.
  await page.click("#sim-transport-play");
  await expect(page.locator("#sim-transport-play")).toHaveText("▶");
  const pausedAt = await seek.inputValue();
  await page.waitForTimeout(600);
  expect(await seek.inputValue()).toBe(pausedAt);

  // Seeking is what the old fire-and-forget setTimeout replays couldn't do:
  // the drawn state has to follow the scrubber in BOTH directions, which
  // only works because the renderer rebuilds from scratch on a seek rather
  // than assuming it only ever moves forward.
  const linesAt = async (v) => {
    await seek.fill(String(v));
    return page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount());
  };
  const atEnd = await linesAt(max);
  const atStart = await linesAt(0);
  const atMiddle = await linesAt(Math.round(max / 2));
  expect(atStart).toBeLessThan(atEnd);
  expect(atMiddle).toBeGreaterThanOrEqual(atStart);
  expect(atMiddle).toBeLessThanOrEqual(atEnd);

  // Playing from the end restarts rather than sitting there doing nothing.
  await seek.fill(String(max));
  await page.click("#sim-transport-play");
  await expect(page.locator("#sim-transport-play")).toHaveText("⏸");
  await expect
    .poll(async () => parseInt(await seek.inputValue(), 10), { timeout: 5000 })
    .toBeLessThan(max);
});

// "Keep all paths" is a live analysis lens, not a pre-run setting: it used
// to only take effect on the NEXT wave tick, so toggling it in a finished
// (skipped-to-end) view — the common case, having just watched a replay —
// did nothing visible at all. Both directions must re-render immediately.
test("keep-all-paths toggles the map view live, after a run has already finished", async ({ page }) => {
  test.slow(); // link-building fetches real DEM tiles

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

  // Settle into the finished/static state, where the old code did nothing
  // on toggle.
  const seek = page.locator("#sim-transport-seek");
  await seek.fill(await seek.getAttribute("max"));

  const allPathsCount = await page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount());
  expect(allPathsCount).toBeGreaterThan(0);

  // Untick: only the most recent wave's lines should remain, which must be
  // strictly fewer than the full accumulated set.
  await page.uncheck("#sim-view-keep-paths");
  await expect
    .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount()))
    .toBeLessThan(allPathsCount);

  // Re-tick: back to the full accumulated set, same as before.
  await page.check("#sim-view-keep-paths");
  await expect
    .poll(() => page.evaluate(() => window.__hopreachSimulatorDebug.getResultLineCount()))
    .toBe(allPathsCount);
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

  // A replay deliberately does NOT open the analysis modal — that modal
  // covers the whole map, which is exactly what you need to see while a
  // replay plays. The map-docked control carries the key and the transport
  // controls instead, and opens the modal on demand.
  await expect(page.locator("#sim-bottleneck-modal")).not.toBeVisible();
  await expect(page.locator(".sim-bottleneck-legend")).toBeVisible();
  await expect(page.locator(".sim-bottleneck-legend")).toContainText("Proven & modeled");

  // The predicted run is a real report and drives the map-docked live-stats
  // card like any other run, rather than being computed, diffed, and
  // thrown away.
  await expect(page.locator("#sim-map-live-stats")).toBeVisible();

  await page.click("#sim-map-open-bottleneck");
  await expect(page.locator("#sim-bottleneck-modal")).toBeVisible();
  await expect(page.locator("#sim-bottleneck-summary")).toContainText("proven hop");
  expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getNodeCount())).toBeGreaterThan(0);

  // Whichever direction the real data happened to fall in this run, at
  // least one of the two comparison lists should say something concrete —
  // proves the diff logic actually ran, not just that nothing crashed.
  const bottleneckText = await page.locator("#sim-bottleneck-list").innerText();
  const unmodeledText = await page.locator("#sim-unmodeled-list").innerText();
  expect(bottleneckText.length + unmodeledText.length).toBeGreaterThan(0);

  // The ±30s real-activity replay only shows once some other real traffic
  // was actually found in that window — on a quiet mesh at replay time
  // there may genuinely be none, so this is conditional rather than
  // asserting it's always present.
  const replaySectionHidden = await page.locator("#sim-bottleneck-replay-section").evaluate((el) => el.classList.contains("hidden"));
  if (!replaySectionHidden) {
    await page.click("#sim-bottleneck-replay-skip");
    await expect(page.locator("#sim-bottleneck-replay-status")).not.toHaveText("");

    // Status is mirrored between the modal and the map-docked control, so
    // the two can never disagree about what the replay is doing.
    await expect(page.locator("#sim-map-real-replay-status")).not.toHaveText("");

    // The hops must land on a layer that's actually attached to the map:
    // the layer used to be removed when the simulator panel closed and
    // never re-added when it reopened, so every line went into a detached
    // group and the replay silently drew nothing at all.
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.isRealActivityLayerOnMap())).toBe(true);
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount())).toBeGreaterThan(0);

    // Everything below drives the replay from the map-docked controls, so
    // the analysis modal (and its full-map backdrop) has to be out of the
    // way first — which is exactly the workflow the docked controls exist
    // for.
    await page.click("#sim-bottleneck-modal [data-close]");
    await expect(page.locator("#sim-modal-backdrop")).toBeHidden();

    // The replayed packet must be visually distinct from the surrounding
    // traffic — that's the whole point of the window view, so it's asserted
    // on stroke colour rather than left to the eye. Only the target's own
    // colour is guaranteed: a quiet mesh can genuinely have no other traffic
    // in the window, in which case there's nothing to contrast it against.
    const colours = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityColors());
    expect(colours.filter((c) => c === "#f472b6").length).toBeGreaterThan(0);
    expect(colours.every((c) => ["#f472b6", "#22d3ee", "#a855f7", "#f87171"].includes(c))).toBe(true);

    // These are floods, so the replay also plays our model's own simulation
    // of the same window alongside the observations — engine receptions, not
    // a geometric fan, so they carry arrival times and collisions. Without
    // them a flood renders as a single thread and the whole mesh looks like
    // it missed the packet. Conditional because a window whose senders have
    // no modelled links produces no predicted receptions, which is a real
    // (if uninteresting) state rather than a failure.
    if (colours.some((c) => c === "#a855f7" || c === "#f87171")) {
      await page.uncheck("#sim-map-show-flood-reach");
      const withoutReach = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityColors());
      expect(withoutReach.filter((c) => c === "#a855f7" || c === "#f87171").length).toBe(0);
      expect(withoutReach.filter((c) => c === "#f472b6").length).toBeGreaterThan(0);
      await page.check("#sim-map-show-flood-reach");
    }

    // The same shared transport drives the real replay, scrubbing real
    // seconds into the window (compressed play time under the hood).
    await page.click("#sim-map-real-replay");
    await expect(page.locator("#sim-transport")).toBeVisible();
    await expect(page.locator("#sim-transport-label")).toContainText("Real traffic ±");
    await expect(page.locator("#sim-transport-time")).toContainText("s ·");
    const realSeek = page.locator("#sim-transport-seek");
    const realMax = parseInt(await realSeek.getAttribute("max"), 10);
    await realSeek.fill(String(realMax));
    const linesEnd = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount());
    await realSeek.fill("0");
    const linesStart = await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount());
    expect(linesEnd).toBeGreaterThan(0);
    // CoreScope timestamps a whole observation at one instant, so a quiet
    // window can legitimately collapse to a single point in time — there's
    // nothing to scrub through then, and the transport correctly draws
    // everything at position 0. Only demand progression when the window
    // actually spans more than one instant.
    if (realMax > 1) expect(linesStart).toBeLessThan(linesEnd);
    else expect(linesStart).toBe(linesEnd);

    // Clicking a repeater during a replay has to answer "what happened
    // here", the same as it does after a simulation — and label which half
    // is measured and which is predicted. It used to open an inspector of
    // all zeros and "Nothing to show." for any repeater the engine's own
    // single-packet run didn't reach, even ones the map had just drawn a
    // flood line to.
    const probe = await page.evaluate(() => {
      const d = window.__hopreachSimulatorDebug;
      const n = d.getNodeCount();
      const rep = d.getLastReport() || {};
      const busy = new Set((rep.receptions || []).map((r) => r.node));
      let quiet = -1;
      for (let i = 0; i < n; i++) if (!busy.has(i)) { quiet = i; break; }
      return { any: n > 0 ? 0 : -1, quiet };
    });
    for (const idx of [probe.any, probe.quiet]) {
      if (idx < 0) continue;
      await page.evaluate((i) => window.__hopreachSimulatorDebug.openNodeInspector(i), idx);
      await expect(page.locator("#sim-packet-modal")).toBeVisible();
      // Both halves are labelled, so neither can be mistaken for the other.
      await expect(page.locator("#sim-packet-modal-observed-section")).toBeVisible();
      await expect(page.locator("#sim-packet-modal-received-title")).toContainText("Predicted");
      await expect(page.locator("#sim-packet-modal-summary")).toContainText("observed sending");
      await expect(page.locator("#sim-packet-modal-summary")).toContainText("observed receiving");
      // A repeater with no predicted activity explains itself rather than
      // dead-ending on "Nothing to show."
      const body = await page.locator("#sim-packet-modal-list").innerText();
      expect(body).not.toBe("Nothing to show.");
      await page.locator("#sim-packet-modal [data-close]").first().click();
      await expect(page.locator("#sim-modal-backdrop")).toBeHidden();
    }

    // ...including after a close/reopen of the simulator panel, which is
    // the exact sequence that used to detach it.
    await page.click("#sim-panel-close");
    await page.click("#sim-toggle");
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.isRealActivityLayerOnMap())).toBe(true);
    await page.click("#sim-map-real-replay-skip");
    expect(await page.evaluate(() => window.__hopreachSimulatorDebug.getRealActivityLineCount())).toBeGreaterThan(0);
  }
});

// Region decoding used to run in the browser, through SubtleCrypto — which
// is undefined outside a secure context, i.e. on any plain-http deployment
// that isn't localhost, including this project's own production setup. It
// threw, got swallowed, and left every packet simulated as unscoped, which
// most repeaters then refuse: a whole replay of "Region mismatch — not
// relayed" on exactly the deployment it's built for.
//
// It is the backend's job now (internal/corescope's RegionOfPacket, unit
// tested against a real captured packet). What this checks is the thing unit
// tests can't: that a REAL deployment's packets come back through /mesh-api/
// with regions actually on them, cross-checked against an independent
// implementation of the same algorithm.
test("the API decodes real packet regions server-side", async ({ request }) => {
  const crypto = require("crypto");

  const statsResp = await request.get("http://localhost:8080/mesh-api/api/scope-stats");
  test.skip(!statsResp.ok(), "scope-stats unavailable");
  const names = ((await statsResp.json()).byRegion || []).map((r) => r.name).filter(Boolean);
  test.skip(names.length === 0, "no live regions to decode against");

  // A window wide enough to be sure of catching traffic on a quiet mesh.
  const until = Date.now();
  const since = until - 6 * 60 * 60 * 1000;
  const pktResp = await request.get(
    `http://localhost:8080/mesh-api/api/packets?since=${since}&until=${until}&limit=200`
  );
  expect(pktResp.ok(), "the packet window must not error — a 502 here is the " +
    "replay being broken, not the mesh being quiet").toBeTruthy();
  const packets = (await pktResp.json()).packets || [];
  test.skip(packets.length === 0, "no live packets in the window");

  // Independent reference: the same algorithm via node:crypto and the raw
  // frame, straight from the vendor API rather than through our own layer.
  const reference = (rawHex) => {
    const raw = Buffer.from(rawHex, "hex");
    if (raw.length < 6) return "";
    const routeType = raw[0] & 0x03;
    if (routeType !== 0 && routeType !== 3) return "";
    const code1 = raw[1] | (raw[2] << 8);
    const pathLenByte = raw[5];
    const pathEnd = 6 + (pathLenByte & 0x3f) * ((pathLenByte >> 6) + 1);
    if (pathEnd > raw.length) return "";
    const msg = Buffer.concat([Buffer.from([(raw[0] >> 2) & 0x0f]), raw.slice(pathEnd)]);
    for (const n of names) {
      const key = crypto.createHash("sha256").update(n).digest().slice(0, 16);
      const mac = crypto.createHmac("sha256", key).update(msg).digest();
      if ((mac[0] | (mac[1] << 8)) === code1) return n;
    }
    return "";
  };

  const rawResp = await request.get("http://localhost:8080/corescope-api/api/packets?limit=200");
  test.skip(!rawResp.ok(), "vendor API unavailable for cross-checking");
  const rawByHash = new Map(
    ((await rawResp.json()).packets || []).filter((p) => p.raw_hex).map((p) => [p.hash, p.raw_hex])
  );

  let checked = 0;
  let scoped = 0;
  for (const p of packets) {
    const rawHex = rawByHash.get(p.hash);
    if (!rawHex) continue; // outside the vendor page we fetched
    expect(p.scope || "", `region for packet ${p.hash}`).toBe(reference(rawHex));
    // The frame facts the browser no longer derives itself must be present.
    expect(p.frame_bytes, `frame_bytes for ${p.hash}`).toBe(Math.floor(rawHex.length / 2));
    checked++;
    if (p.scope) scoped++;
  }
  test.skip(checked === 0, "no overlap between the two pages to cross-check");
  // Real ScotMesh traffic is largely scoped; decoding none of it would mean
  // the backend is silently returning "" for everything, which is precisely
  // the failure this test exists to catch.
  expect(scoped).toBeGreaterThan(0);
});

// Simulate mode is about individual repeaters and the links between them,
// and both the coverage raster and marker clustering get in the way of
// that — clustering especially, since a cluster bubble is itself a marker
// and swallows clicks meant for the simulated node underneath it.
test("entering simulate mode clears coverage and clustering, and restores them on exit", async ({ page }) => {
  await page.waitForFunction(() => document.querySelectorAll(".leaflet-marker-icon").length > 0, { timeout: 60_000 });

  const state = () =>
    page.evaluate(() => {
      let coverageOn = null;
      document.querySelectorAll(".leaflet-control-layers-overlays label").forEach((l) => {
        if (l.textContent.includes("Estimated coverage")) coverageOn = l.querySelector("input").checked;
      });
      return {
        coverageOn,
        clusters: document.querySelectorAll(".marker-cluster").length,
        clusterDisabled: (document.getElementById("disable-clustering-toggle") || {}).checked,
      };
    });

  const before = await state();
  test.skip(before.coverageOn === null, "no coverage overlay published in this build");

  await page.click("#sim-toggle");
  await expect.poll(async () => (await state()).coverageOn, { timeout: 10_000 }).toBe(false);
  const during = await state();
  expect(during.clusterDisabled).toBe(true);
  expect(during.clusters).toBe(0);

  // Restored, not blanket re-enabled.
  await page.click("#sim-panel-close");
  await expect.poll(async () => (await state()).coverageOn, { timeout: 10_000 }).toBe(before.coverageOn);
  expect((await state()).clusterDisabled).toBe(before.clusterDisabled);

  // Someone who had already turned clustering off keeps it off afterwards,
  // rather than having the map reconfigured behind them.
  await page.evaluate(() => {
    const el = document.getElementById("disable-clustering-toggle");
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.click("#sim-toggle");
  await page.click("#sim-panel-close");
  await expect.poll(async () => (await state()).clusterDisabled, { timeout: 10_000 }).toBe(true);
});

