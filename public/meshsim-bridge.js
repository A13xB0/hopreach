// JS binding over the Go/WebAssembly module (see wasm/meshsim.go) for the
// LoRa flood simulator — Run and Suggest execute the exact same code the
// engine.go/tune.go tests verify, compiled to WebAssembly, instead of a
// hand-ported JS reimplementation. Callers must `await MeshSim.ready`
// before their first run/suggest call — see simulator.js.
//
// Unlike propagation.js's per-call handle marshaling (a genuine hot path,
// thousands of calls per computation), a simulation run or settings search
// is called a handful of times per user interaction — cheap enough to pass
// as a single JSON string each way rather than building a second handle
// registry.
//
// Works in both the main thread and a Web Worker — see terrain.js's header
// comment for why everything hangs off `self`.
(function () {
  function call(fnName, requestObj, ...extraArgs) {
    const resultJSON = self.__hopreachWasm[fnName](JSON.stringify(requestObj), ...extraArgs);
    const result = JSON.parse(resultJSON);
    if (result && result.error) {
      throw new Error(`MeshSim.${fnName}: ${result.error}`);
    }
    return result;
  }

  // run(scenario, messages, seed, maxSimTimeMs) -> Report
  // scenario: {nodes: [{prefs, canRelay}], links: [{from, to, snrDb}]}
  // messages: [{origin, sendAtMs, payloadLen}]
  function run(scenario, messages, seed, maxSimTimeMs) {
    return call("simRun", { scenario, messages, seed, maxSimTimeMs });
  }

  // suggest(tuneRequest[, onProgress]) -> TuneResult
  // tuneRequest: {scenario, messages, attrs, maxSimTimeMs, trials, seed}
  // attrs (optional): [{altitudeM, neighborCount}] parallel to scenario.nodes
  // onProgress (optional): (done, total) => void, called after the baseline
  // and after every candidate rule is evaluated — see wasm/meshsim.go's
  // jsSimSuggest/internal/meshsim.Suggest. This call can genuinely take
  // seconds to tens of seconds for a real scenario (a real candidate grid
  // is easily 100+ rules, each Trials full simulation runs) — see
  // public/meshsim-worker.js, which is what actually calls this off the
  // main thread so onProgress can drive a real progress bar without the
  // page itself freezing for the whole search.
  function suggest(tuneRequest, onProgress) {
    return call("simSuggest", tuneRequest, onProgress);
  }

  self.MeshSim = {
    ready: self.__hopreachWasmReadyPromise,
    run,
    suggest,
  };
})();
