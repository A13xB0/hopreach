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
  if (e.data.kind !== "suggest") return;
  const { generation, tuneRequest } = e.data;
  try {
    await MeshSim.ready;
    const result = MeshSim.suggest(tuneRequest, (done, total) => {
      self.postMessage({ generation, type: "suggest-progress", done, total });
    });
    self.postMessage({ generation, type: "suggest-result", result });
  } catch (err) {
    self.postMessage({ generation, type: "suggest-error", message: err.message || String(err) });
  }
};
