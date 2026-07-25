// Runs meshsim's "predict settings" search (MeshSim.suggest) off the main
// thread. A real candidate grid (with per-node Attrs provided) is well
// over a hundred ConfigRules, each evaluated across several full
// simulation runs — genuinely seconds to tens of seconds of CPU work. That
// used to run as one synchronous call on the page's own main thread, which
// meant the whole page — not just the "Predict settings" button — was
// frozen and unresponsive for the entire search, with no way to show
// progress in between. Running it here instead keeps the main thread free
// to actually paint a progress bar as internal/meshsim.Suggest's own
// progress callback reports it (see meshsim-bridge.js's suggest()).
importScripts("wasm_exec.js", "wasm-bridge.js", "meshsim-bridge.js");

self.onmessage = async (e) => {
  const { kind, generation } = e.data;
  if (kind === "suggest") {
    const { tuneRequest } = e.data;
    try {
      await MeshSim.ready;
      const result = MeshSim.suggest(tuneRequest, (done, total) => {
        self.postMessage({ generation, type: "suggest-progress", done, total });
      });
      self.postMessage({ generation, type: "suggest-result", result });
    } catch (err) {
      self.postMessage({ generation, type: "suggest-error", message: err.message || String(err) });
    }
    return;
  }
  if (kind === "stress") {
    // Item 15b's offered-load sweep — same off-main-thread reasoning as
    // "suggest" above: each swept level is its own batch of full
    // simulation runs, easily seconds of CPU work across a real sweep.
    const { stressRequest } = e.data;
    try {
      await MeshSim.ready;
      const result = MeshSim.stress(stressRequest, (done, total) => {
        self.postMessage({ generation, type: "stress-progress", done, total });
      });
      self.postMessage({ generation, type: "stress-result", result });
    } catch (err) {
      self.postMessage({ generation, type: "stress-error", message: err.message || String(err) });
    }
    return;
  }
  if (kind === "suggest-policy") {
    // Item 15c's composite-policy search — see MeshSim.suggestPolicy.
    const { policyTuneRequest } = e.data;
    try {
      await MeshSim.ready;
      const result = MeshSim.suggestPolicy(policyTuneRequest, (done, total) => {
        self.postMessage({ generation, type: "suggest-policy-progress", done, total });
      });
      self.postMessage({ generation, type: "suggest-policy-result", result });
    } catch (err) {
      self.postMessage({ generation, type: "suggest-policy-error", message: err.message || String(err) });
    }
    return;
  }
  if (kind === "optimize-step") {
    // Phase 4 work item 4's adaptive optimizer — deliberately ONE bounded
    // round per message, not a loop in here. Looping to completion inside
    // this one onmessage handler would block this same event loop for the
    // whole optimization, exactly the problem that makes "suggest"/
    // "suggest-policy" uncancellable mid-search — see
    // MeshSim.optimizeStep's doc comment. The caller (simulator.js) is
    // what actually drives the round-by-round loop: it sends one
    // "optimize-step" message, waits for this reply, decides whether to
    // cancel, and only then sends the next one — so a cancel is checked
    // between every single round, which a single long-running call could
    // never allow.
    const { optimizeRequest, state } = e.data;
    try {
      await MeshSim.ready;
      const result = MeshSim.optimizeStep(optimizeRequest, state);
      self.postMessage({ generation, type: "optimize-step-result", result });
    } catch (err) {
      self.postMessage({ generation, type: "optimize-step-error", message: err.message || String(err) });
    }
    return;
  }
  if (kind === "optimize-validate") {
    const { optimizeRequest, policy } = e.data;
    try {
      await MeshSim.ready;
      const result = MeshSim.optimizeValidate(optimizeRequest, policy);
      self.postMessage({ generation, type: "optimize-validate-result", result });
    } catch (err) {
      self.postMessage({ generation, type: "optimize-validate-error", message: err.message || String(err) });
    }
  }
};
