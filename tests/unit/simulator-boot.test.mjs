// Boot smoke test: load every script index.html loads, in that order, against
// a stub DOM, and assert nothing throws.
//
// The reference and contract checks are static. They cannot see a temporal
// dead zone: `const { RADIO_PRESETS } = window.SimRun.init(...)` used by an
// earlier init() call is perfectly resolvable — the name exists — but throws
// at load time because the binding isn't initialised yet. Splitting a file
// into eighteen modules wired through one block is exactly how that happens,
// and it breaks the whole page rather than one feature.
//
// The stub is deliberately permissive: a Proxy that answers any property and
// any call. The question here is "does this file graph evaluate", not "does
// the UI behave" — behaviour is what Playwright is for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function autoStub(name = "stub") {
  const target = function () {};
  target.__name = name;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === "then") return undefined; // never look like a promise
      if (prop === "length") return 0;
      if (prop === "name") return name;
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      return autoStub(`${name}.${String(prop)}`);
    },
    set() { return true; },
    has() { return true; },
    apply() { return autoStub(`${name}()`); },
    construct() { return autoStub(`new ${name}`); },
  });
}

// Scripts the page loads from disk, in index.html order. Remote ones (Leaflet)
// and the Go runtime are stubbed instead.
function localScripts() {
  const html = readFileSync("public/index.html", "utf8");
  return [...html.matchAll(/<script src="([^"]+)"><\/script>/g)]
    .map((m) => m[1])
    .filter((src) => !src.startsWith("http"));
}

function bootContext() {
  const win = autoStub("window");
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    fetch: () => Promise.resolve(autoStub("response")),
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: autoStub("document"),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    matchMedia: () => autoStub("mediaQuery"),
    getComputedStyle: () => autoStub("style"),
    innerWidth: 1280,
    innerHeight: 800,
    navigator: autoStub("navigator"),
    location: autoStub("location"),
    performance: { now: () => 0 },
    L: autoStub("L"),
    Go: function Go() { return autoStub("go"); },
    WebAssembly: autoStub("WebAssembly"),
    Worker: function Worker() { return autoStub("worker"); },
    TextEncoder,
    TextDecoder,
    URL,
    Blob: function Blob() { return autoStub("blob"); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  // Anything a script reads off window that we haven't defined resolves to a
  // permissive stub rather than ReferenceError.
  return new Proxy(sandbox, {
    has: () => true,
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === "symbol") return undefined;
      // Real language built-ins first: stubbing Error would swallow the very
      // stack traces this test exists to produce.
      if (prop in globalThis) return globalThis[prop];
      return autoStub(String(prop));
    },
  });
}

test("every script index.html loads evaluates without throwing", () => {
  const scripts = localScripts();
  assert.ok(scripts.length > 10, `only found ${scripts.length} scripts — did the parse break?`);

  const context = vm.createContext(bootContext());
  for (const src of scripts) {
    // wasm_exec.js is vendored Go runtime glue and does its own environment
    // sniffing; it has nothing to do with the split.
    if (src === "wasm_exec.js") continue;
    const code = readFileSync(`public/${src}`, "utf8");
    try {
      new vm.Script(code, { filename: src }).runInContext(context);
    } catch (err) {
      assert.fail(
        `public/${src} threw while loading: ${err.message}\n` +
          `Scripts are evaluated in index.html order, so this is a load-order ` +
          `problem — most likely a const used by an earlier module's init() ` +
          `than the one that defines it.`
      );
    }
  }
});

test("the simulator registers its debug surface after loading", () => {
  // If the IIFE bailed early the page would look fine to the loader but the
  // simulator would be inert, so check it actually reached the end.
  const context = vm.createContext(bootContext());
  for (const src of localScripts()) {
    if (src === "wasm_exec.js") continue;
    new vm.Script(readFileSync(`public/${src}`, "utf8"), { filename: src }).runInContext(context);
  }
  const registered = vm.runInContext(
    "typeof window.__hopreachSimulatorDebug !== 'undefined'",
    context
  );
  assert.ok(registered, "simulator.js did not reach its debug-hook assignment");
});
