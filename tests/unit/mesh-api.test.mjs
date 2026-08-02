// Unit tests for public/mesh-api.js — run with `npm run test:unit`.
//
// This module is the browser's only door to mesh data, and it now also decides
// which features are worth offering: a backend that cannot answer a question
// completely gets that feature hidden rather than rendered from a partial
// answer. Getting that logic wrong is not a visible crash — it is a map that
// quietly omits regions, which reads as "no repeaters there".
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Fresh module per test: capabilities are cached for the page's lifetime, and
// that cache is part of what is being tested.
function loadApi(fetchImpl) {
  delete require.cache[require.resolve("../../public/mesh-api.js")];
  global.fetch = fetchImpl;
  return require("../../public/mesh-api.js");
}

const jsonOnce = (body, ok = true) => async () => ({
  ok,
  status: ok ? 200 : 502,
  json: async () => body,
});

test("supportsScopeCatalog is true only when the backend says so", async () => {
  const yes = loadApi(jsonOnce({ source: "corescope", capabilities: { scope_catalog: true } }));
  assert.equal(await yes.supportsScopeCatalog(), true);

  const no = loadApi(jsonOnce({ source: "beacon", capabilities: { scope_catalog: false } }));
  assert.equal(await no.supportsScopeCatalog(), false);
});

test("a backend that declares nothing gets no optional features", async () => {
  // An older deployment predating the capabilities field. Assuming support and
  // discovering the gap later means a half-drawn region filter; assuming none
  // means one missing control, which is recoverable and visibly absent.
  const api = loadApi(jsonOnce({ source: "corescope" }));
  assert.equal(await api.supportsScopeCatalog(), false);
});

test("an unreachable backend claims no capabilities rather than throwing", async () => {
  // Startup must not die because the source endpoint is briefly down — the
  // page still has to render the map from its static data.
  const api = loadApi(async () => {
    throw new Error("connection refused");
  });
  assert.equal(await api.supportsScopeCatalog(), false);
});

test("capabilities are fetched once, not per caller", async () => {
  let calls = 0;
  const api = loadApi(async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ capabilities: { scope_catalog: true } }) };
  });
  await Promise.all([
    api.supportsScopeCatalog(),
    api.supportsScopeCatalog(),
    api.supportsScopeCatalog(),
  ]);
  assert.equal(calls, 1, "each caller re-asking would be a request per control");
});

test("pathComplete treats a backend without the signal as complete", async () => {
  const api = loadApi(jsonOnce({}));
  // CoreScope reports no per-hop confidence and never produces partial paths,
  // so absence must not read as "this reconstruction is a guess".
  assert.equal(api.pathComplete({ hash: "aa" }), true);
  assert.equal(api.pathComplete({ hash: "aa", path_complete: false }), false);
  assert.equal(api.pathComplete(null), false);
});
