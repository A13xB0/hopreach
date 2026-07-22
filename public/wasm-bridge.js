// Bootstraps the Go/WebAssembly runtime (see wasm_exec.js, Go's own
// runtime shim, loaded just before this file) and instantiates
// hopreach.wasm (compiled from wasm/main.go) — the same
// internal/propagation + internal/demgrid code the backend trusts,
// compiled for the browser instead of a hand-ported, independently
// drifting JS copy.
//
// Exposes self.__hopreachWasm (the module's exports, populated once
// wasm/main.go's main() finishes registering them) and
// self.__hopreachWasmReadyPromise, which propagation.js/terrain.js await
// before their first call into it. Works in both the main thread (loaded
// via <script>) and a Web Worker (loaded via importScripts) — see
// terrain.js's header comment for why everything hangs off `self`.
(function () {
  let resolveReady;
  self.__hopreachWasmReadyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });
  // Called by wasm/main.go's main() once self.__hopreachWasm is fully
  // populated — resolving here, rather than as soon as instantiation
  // succeeds, avoids a race where a caller sees __hopreachWasm before its
  // properties are actually set.
  self.__hopreachWasmReady = () => resolveReady();

  async function instantiate(url, importObject) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(fetch(url), importObject);
      } catch (err) {
        // Falls through to the arrayBuffer path below — e.g. a dev server
        // that doesn't set the application/wasm content type.
      }
    }
    const resp = await fetch(url);
    const bytes = await resp.arrayBuffer();
    return WebAssembly.instantiate(bytes, importObject);
  }

  const go = new Go();
  instantiate("hopreach.wasm", go.importObject)
    .then((result) => go.run(result.instance))
    .catch((err) => console.error("hopreach: failed to load WebAssembly module:", err));
})();
