// JS binding over the Go/WebAssembly module (see wasm/main.go and
// wasm-bridge.js) for the link-budget/knife-edge-diffraction physics —
// pathMargin and linkBudgetMaxRangeKm now run the exact same code as the
// server's real coverage map (internal/propagation), compiled to
// WebAssembly, instead of a hand-ported, independently drifting JS copy.
// Callers must `await Propagation.ready` before their first
// linkBudgetMaxRangeKm/pathMargin call — see planner.js/planner-worker.js.
//
// haversineKm alone stays plain JS: it's a single, stable, well-known
// formula with no model/state to drift on, and (unlike the other two) is
// called from a couple of synchronous UI render paths that can't await a
// WASM-readiness promise — not worth the complexity of threading async
// through those call sites for four lines of trigonometry.
//
// Works in both the main thread and a Web Worker — see terrain.js's header
// comment for why everything hangs off `self`.
(function () {
  const EARTH_RADIUS_KM = 6371.0088;

  function haversineKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_KM * c;
  }

  // paramsHandles caches one Go-side handle per distinct propagation-params
  // object (keyed by reference identity) rather than re-marshaling all 10
  // fields across the JS/Wasm boundary on every single call in a hot search
  // loop — every call site already reuses the same params object across a
  // whole computation.
  const paramsHandles = new WeakMap();

  function handleFor(p) {
    let h = paramsHandles.get(p);
    if (h === undefined) {
      h = self.__hopreachWasm.createParams(p);
      paramsHandles.set(p, h);
    }
    return h;
  }

  // linkBudgetMaxRangeKm — see internal/propagation.LinkBudgetMaxRangeKm.
  function linkBudgetMaxRangeKm(p) {
    return self.__hopreachWasm.linkBudgetMaxRangeKm(handleFor(p));
  }

  // pathMargin — see internal/propagation.PathMargin. `grid` must be a
  // Terrain.buildLocalGrid() result.
  function pathMargin(grid, p, txLat, txLon, txHeightM, rxLat, rxLon, distanceKm) {
    return self.__hopreachWasm.pathMargin(grid.__handle, handleFor(p), txLat, txLon, txHeightM, rxLat, rxLon, distanceKm);
  }

  self.Propagation = {
    ready: self.__hopreachWasmReadyPromise,
    haversineKm,
    linkBudgetMaxRangeKm,
    pathMargin,
  };
})();
