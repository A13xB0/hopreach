// Static reference check for the public/*.js browser modules.
//
// These files are loaded as plain <script>s, so a name that no longer exists
// after an extraction fails at CALL time, not load time — and the tests that
// would catch it are Playwright ones needing a live backend. This walks each
// module's real syntax tree and reports identifiers that resolve to nothing:
// neither declared in the file, nor a parameter, nor a known global.
//
// Run: node tools/check_module_refs.mjs [file...]   (default: public/*.js)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";
import { ancestor } from "acorn-walk";

const BROWSER_GLOBALS = new Set([
  "window", "self", "document", "console", "navigator", "location", "fetch",
  "localStorage", "sessionStorage", "setTimeout", "clearTimeout", "requestAnimationFrame",
  "cancelAnimationFrame", "setInterval", "clearInterval", "alert", "confirm", "prompt",
  "Blob", "URL", "FileReader", "TextEncoder", "TextDecoder", "CustomEvent", "Event",
  "performance", "crypto", "structuredClone", "getComputedStyle", "DOMParser",
  "Worker", "Image", "matchMedia", "history", "screen", "AbortController",
  "ResizeObserver", "MutationObserver", "URLSearchParams", "WebAssembly",
  "createImageBitmap", "OffscreenCanvas", "FinalizationRegistry", "importScripts",
]);
const JS_GLOBALS = new Set([
  "Object", "Array", "String", "Number", "Boolean", "Math", "JSON", "Date", "RegExp",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "Symbol", "Error", "TypeError",
  "RangeError", "Infinity", "NaN", "undefined", "isNaN", "isFinite", "parseInt",
  "parseFloat", "encodeURIComponent", "decodeURIComponent", "globalThis",
  "Uint8Array", "Uint32Array", "Int32Array", "Float64Array", "DataView", "ArrayBuffer",
  "BigInt", "Proxy", "Reflect", "Intl", "module", "require", "exports", "arguments",
  "Float32Array", "Float32Array", "Int8Array", "Uint16Array",
]);
// Third-party and cross-module surfaces these pages genuinely load first.
const PAGE_GLOBALS = new Set([
  "L", "MeshApi", "MeshFrame", "SimTopology", "HopReachEvidence", "HopReachPlanner",
  "MCCoverageMap", "HOPREACH_CONFIG", "Go", "meshsim",
  "MeshSim", "Propagation", "Terrain",
]);

const KNOWN = new Set([...BROWSER_GLOBALS, ...JS_GLOBALS, ...PAGE_GLOBALS]);

function declaredNames(node, out = []) {
  if (!node) return out;
  switch (node.type) {
    case "Identifier": out.push(node.name); break;
    case "ObjectPattern":
      for (const p of node.properties) {
        declaredNames(p.type === "RestElement" ? p.argument : p.value, out);
      }
      break;
    case "ArrayPattern":
      for (const e of node.elements) declaredNames(e, out);
      break;
    case "AssignmentPattern": declaredNames(node.left, out); break;
    case "RestElement": declaredNames(node.argument, out); break;
  }
  return out;
}

// Collect every binding introduced anywhere in the file. Scope-insensitive on
// purpose: the goal is "does this name exist at all", which is what an
// extraction breaks. A stricter scope walk would flag legitimate shadowing.
function collectBindings(ast) {
  const names = new Set();
  const add = (n) => declaredNames(n).forEach((x) => names.add(x));
  ancestor(ast, {
    VariableDeclarator: (n) => add(n.id),
    FunctionDeclaration: (n) => { if (n.id) names.add(n.id.name); n.params.forEach(add); },
    FunctionExpression: (n) => { if (n.id) names.add(n.id.name); n.params.forEach(add); },
    ArrowFunctionExpression: (n) => n.params.forEach(add),
    ClassDeclaration: (n) => { if (n.id) names.add(n.id.name); },
    CatchClause: (n) => add(n.param),
    ImportDefaultSpecifier: (n) => names.add(n.local.name),
    ImportSpecifier: (n) => names.add(n.local.name),
    LabeledStatement: (n) => names.add(n.label.name),
  });
  return names;
}

function freeIdentifiers(ast, bound) {
  const free = new Map();
  const report = (node) => {
    if (bound.has(node.name) || KNOWN.has(node.name)) return;
    if (!free.has(node.name)) free.set(node.name, node.loc.start.line);
  };
  ancestor(ast, {
    // acorn-walk reports assignment targets as VariablePattern, NOT
    // Identifier. Missing this hid every `foo = 1` where foo was never
    // declared — which in a non-strict script silently creates a global
    // instead of failing, so it is exactly the case worth catching.
    VariablePattern(node) { report(node); },
    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      // Skip positions that are never variable reads.
      if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
      if (parent.type === "Property" && parent.key === node && !parent.computed) return;
      if (parent.type === "MethodDefinition" && parent.key === node) return;
      if (parent.type === "LabeledStatement" || parent.type === "BreakStatement" ||
          parent.type === "ContinueStatement") return;
      report(node);
    },
  });
  return free;
}

const files = process.argv.length > 2
  ? process.argv.slice(2)
  : readdirSync("public").filter((f) => f.endsWith(".js") && f !== "wasm_exec.js")
      .map((f) => join("public", f));

let failed = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(src, { ecmaVersion: "latest", locations: true, allowReturnOutsideFunction: true });
  } catch (e) {
    console.log(`✖ ${file}: parse error: ${e.message}`);
    failed++;
    continue;
  }
  const free = freeIdentifiers(ast, collectBindings(ast));
  if (free.size === 0) {
    console.log(`✔ ${file}`);
    continue;
  }
  failed++;
  console.log(`✖ ${file}: ${free.size} unresolved reference(s)`);
  for (const [name, line] of free) console.log(`    ${file}:${line}  ${name}`);
}
process.exit(failed ? 1 : 0);
