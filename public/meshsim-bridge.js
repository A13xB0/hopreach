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

  // stress(stressRequest[, onProgress]) -> StressResult
  // stressRequest: {scenario, maxSimTimeMs, trials, seed, minPayload,
  //   maxPayload, loadLevels}
  // onProgress (optional): (done, total) => void, called after each swept
  // load level finishes — see wasm/meshsim.go's jsSimStress/
  // internal/meshsim.StressTest. Same reasoning as suggest's own
  // onProgress: each level is itself `trials` full simulation runs, and
  // public/meshsim-worker.js is what actually calls this off the main
  // thread.
  function stress(stressRequest, onProgress) {
    return call("simStress", stressRequest, onProgress);
  }

  // suggestPolicy(policyTuneRequest[, onProgress]) -> PolicyTuneResult
  // policyTuneRequest: {scenario, messages, attrs, maxSimTimeMs, trials, seed}
  // Item 15c's own search — composite multi-rule ConfigPolicies (not one
  // ConfigRule at a time, unlike suggest()), ranked by DeliveryRatio, and
  // including topology-derived models (articulation points, MPR-style
  // marginal coverage) suggest()'s own grid doesn't have. See
  // wasm/meshsim.go's jsSimSuggestPolicy/internal/meshsim.SuggestPolicy —
  // suggest() itself is untouched, this is a separate, additive search.
  function suggestPolicy(policyTuneRequest, onProgress) {
    return call("simSuggestPolicy", policyTuneRequest, onProgress);
  }

  // assignPolicy(scenario, attrs, policy) -> PolicyAssignment[]
  // attrs (optional, parallel to scenario.nodes): [{altitudeM, neighborCount, ...}]
  // Phase 4 work item 6's "which tier was this repeater labelled" query —
  // see wasm/meshsim.go's jsSimAssignPolicy/internal/meshsim.AssignPolicy.
  // Each result is {node, matchedRules: [ruleIndex, ...]} in the policy's
  // own application order — deliberately indices, not a single resolved
  // label, since a node can match more than one rule; the UI decides its
  // own display convention (see renderPolicyProfileSummary).
  function assignPolicy(scenario, attrs, policy) {
    return call("simAssignPolicy", { scenario, attrs, policy });
  }

  // meshMethods() -> MeshMethod[]
  // {name, policy, source, asOf, direction, note} for every built-in
  // community method (phase 4 work item 5) — see wasm/meshsim.go's
  // jsSimMeshMethods/internal/meshsim.BuiltinMeshMethods. Every entry's
  // source is non-empty by construction (enforced by a Go test) — always
  // show it next to a community-method result, since it's a real-world
  // convention, not a firmware-verified fact.
  function meshMethods() {
    return call("simMeshMethods", {});
  }

  // optimizeStep(optimizeRequest, state) -> OptimizeState
  // optimizeRequest: {scenario, messages, attrs, basePolicy, maxSimTimeMs,
  //   trials, confirmTrials, seed, deliveryTolerance, minImprovement,
  //   maxRounds, staleRoundsLimit, holdoutSeed, holdoutTrials}
  // state: {} (or omitted) for a fresh start, otherwise the previous
  // call's own returned OptimizeState fed back in.
  // Phase 4 work item 4's adaptive optimizer — see wasm/meshsim.go's
  // jsSimOptimizeStep/internal/meshsim.OptimizeStep for the full
  // "why one call is exactly one bounded round" rationale. Deliberately
  // NOT looped in here or in the worker — public/simulator.js drives the
  // whole optimization by calling this once per round via
  // public/meshsim-worker.js's own "optimize-step" message, so the
  // worker's event loop gets a real chance to notice a cancel between
  // rounds (see meshsim-worker.js's own comment on this).
  function optimizeStep(optimizeRequest, state) {
    return call("simOptimizeStep", { request: optimizeRequest, state: state || {} });
  }

  // optimizeValidate(optimizeRequest, policy) -> {delivery, collision}
  // Hold-out validation — re-evaluates policy against optimizeRequest's own holdoutSeed/
  // holdoutTrials, seeds the search itself never drew from. Called once,
  // after optimizeStep-driven iteration stops — see wasm/meshsim.go's
  // jsSimOptimizeValidate/internal/meshsim.OptimizeValidate.
  function optimizeValidate(optimizeRequest, policy) {
    return call("simOptimizeValidate", { request: optimizeRequest, policy });
  }

  self.MeshSim = {
    ready: self.__hopreachWasmReadyPromise,
    run,
    suggest,
    stress,
    suggestPolicy,
    assignPolicy,
    meshMethods,
    optimizeStep,
    optimizeValidate,
  };
})();
