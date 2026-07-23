// @ts-check

// Waits for the page to be genuinely interactive: the map rendered and the
// WASM module (see wasm/main.go, public/wasm-bridge.js) ready — everything
// the planning tools and simulator actually need. Deliberately does NOT
// wait for real repeater data (meta.json/repeaters.geojson) to have
// loaded: that depends on the container's own background fetch reaching a
// live, third-party CoreScope instance over the real network, which can be
// meaningfully slower (or less reliable) from CI infrastructure than from
// a normal dev machine — a dependency most tests here have no actual need
// for (add-repeater/LOS/companion-pin/"load planned repeaters" are all
// client-only). Only basic.spec.js's dedicated "repeater stats populate"
// test should wait on real data, with its own generous timeout.
async function gotoReady(page, path = "/") {
  await page.goto(path);
  await page.waitForSelector(".leaflet-container");
  await page.evaluate(() => window.__hopreachWasmReadyPromise);
}

module.exports = { gotoReady };
