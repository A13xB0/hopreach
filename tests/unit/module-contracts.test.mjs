// Contract tests for the split-out simulator modules.
//
// simulator.js was one 7500-line closure; the feature areas are being lifted
// out into public/sim-*.js, each taking a context object from simulator.js
// and handing back the functions the simulator still calls. Two things can
// silently break in that handover, and neither shows up as a syntax error:
//
//   1. The module destructures a context key the simulator doesn't pass.
//      The name is `undefined` until something calls it, then it throws —
//      possibly only on a code path a user reaches once a week.
//   2. The simulator destructures a name the module doesn't return. Same
//      failure, opposite direction.
//
// Both are decidable without a browser, so they are checked here rather than
// left to a Playwright run that needs a live backend and a live mesh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { parse } from "acorn";
import { ancestor } from "acorn-walk";

const require = createRequire(import.meta.url);

// The three files that own extracted modules. Checking only simulator.js is
// how map-responsive.js — wired from app.js — escaped every check here.
const HOSTS = ["public/simulator.js", "public/planner.js", "public/app.js"];
const hostSrc = Object.fromEntries(HOSTS.map((f) => [f, readFileSync(f, "utf8")]));
const allHostSrc = HOSTS.map((f) => hostSrc[f]).join("\n");

// Every `window.X.init({...})` call in simulator.js, with what it passes and
// what it destructures back.
function initCallSites() {
  const sites = new Map();
  for (const host of HOSTS) collectSites(sites, host);
  return sites;
}

function collectSites(sites, host) {
  const ast = parse(hostSrc[host], { ecmaVersion: "latest", locations: true, ranges: true });
  ancestor(ast, {
    CallExpression(node, _s, ancestors) {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.property.name !== "init") return;
      const target = callee.object;
      if (target.type !== "MemberExpression" || target.object.name !== "window") return;
      const globalName = target.property.name;

      const arg = node.arguments[0];
      const provides = new Set();
      if (arg && arg.type === "ObjectExpression") {
        for (const p of arg.properties) {
          if (p.type === "Property") provides.add(p.key.name ?? p.key.value);
          else if (p.type === "SpreadElement") provides.add("...spread");
        }
      }

      // The destructuring pattern this init() result is assigned to, if any.
      const takes = new Set();
      for (let i = ancestors.length - 2; i >= 0; i--) {
        const a = ancestors[i];
        if (a.type === "VariableDeclarator" && a.init === node) {
          if (a.id.type === "ObjectPattern") {
            for (const p of a.id.properties) if (p.type === "Property") takes.add(p.key.name);
          }
          break;
        }
      }
      sites.set(globalName, { provides, takes, host, line: node.loc.start.line });
    },
  });
}

// What a module destructures out of its context, and what it returns.
function moduleContract(file) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, { ecmaVersion: "latest", locations: true });

  let globalName = null;
  const needs = new Set();
  const returns = new Set();

  ancestor(ast, {
    AssignmentExpression(node) {
      // `root.SimRankings = factory();`
      const l = node.left;
      if (l.type === "MemberExpression" && l.object.name === "root") globalName = l.property.name;
      // `({ a, b } = context);` inside init
      if (l.type === "ObjectPattern" && node.right.type === "Identifier") {
        for (const p of l.properties) if (p.type === "Property") needs.add(p.key.name);
      }
    },
    VariableDeclarator(node) {
      // `const { a } = context;`
      if (node.id.type === "ObjectPattern" && node.init && node.init.type === "Identifier" &&
          /context|ctx/.test(node.init.name)) {
        for (const p of node.id.properties) if (p.type === "Property") needs.add(p.key.name);
      }
      // `const api = { ... }`
      if (node.id.name === "api" && node.init && node.init.type === "ObjectExpression") {
        for (const p of node.init.properties) {
          if (p.type === "Property") returns.add(p.key.name ?? p.key.value);
        }
      }
    },
  });
  return { globalName, needs, returns };
}

// Every extracted module, not just the simulator's. The planner and map ones
// were outside this glob for a while, which is exactly how map-responsive.js
// shipped a module-scope `.addTo(map)` that blanked the whole page.
//
// The *-state.js files are plain data with no init() handshake to check.
const MODULE_PREFIXES = ["sim-", "plan-", "map-", "mesh-"];
const STATE_FILES = new Set(["sim-state.js", "plan-state.js", "map-state.js"]);

const moduleFiles = readdirSync("public")
  .filter((f) => f.endsWith(".js") && !STATE_FILES.has(f) &&
    MODULE_PREFIXES.some((p) => f.startsWith(p)))
  .map((f) => `public/${f}`);

const sites = initCallSites();

test("every extracted simulator module is actually wired up", () => {
  assert.ok(moduleFiles.length > 0, "no sim-*.js modules found — did the glob break?");
  for (const file of moduleFiles) {
    const { globalName, returns } = moduleContract(file);
    assert.ok(globalName, `${file}: does not register itself on root`);
    // Two shapes are in use. A module that needs simulator helpers takes them
    // through init(); a pure one (sim-topology.js) is called directly. Either
    // is fine — being referenced by nothing is not.
    // A module taking helpers is wired through init(); a pure one is simply
    // called by name, with or without the window. prefix.
    const wired = returns.has("init")
      ? sites.has(globalName)
      : new RegExp(`\\b${globalName}\\b`).test(allHostSrc);
    assert.ok(
      wired,
      `${file}: no host file references window.${globalName} — the ` +
        `module is dead code, or the page still expects it on the old path`
    );
  }
});

test("simulator.js passes every context key each module destructures", () => {
  for (const file of moduleFiles) {
    const { globalName, needs } = moduleContract(file);
    const site = sites.get(globalName);
    if (!site) continue;
    for (const key of needs) {
      assert.ok(
        site.provides.has(key),
        `${file} destructures "${key}" out of its context, but the init() call ` +
          `at ${site.host}:${site.line} doesn't pass it. That is undefined at call ` +
          `time, not load time — it would only surface when a user hits that path.`
      );
    }
  }
});

test("every module returns the names simulator.js destructures from it", () => {
  for (const file of moduleFiles) {
    const { globalName, returns } = moduleContract(file);
    const site = sites.get(globalName);
    if (!site) continue;
    for (const key of site.takes) {
      assert.ok(
        returns.has(key),
        `${site.host}:${site.line} destructures "${key}" from window.${globalName}, ` +
          `but ${file}'s api doesn't include it.`
      );
    }
  }
});

test("modules don't take context they never use", () => {
  // Not a correctness bug, but a context key nothing reads is a leftover from
  // an earlier shape of the split, and it makes the real dependencies harder
  // to see. Cheap to keep honest.
  for (const file of moduleFiles) {
    const { globalName, needs } = moduleContract(file);
    const site = sites.get(globalName);
    if (!site) continue;
    for (const key of site.provides) {
      if (key === "...spread") continue;
      assert.ok(
        needs.has(key),
        `${site.host}:${site.line} passes "${key}" to window.${globalName}, but ${file} ` +
          `never destructures it — stale context entry.`
      );
    }
  }
});

test("modules read shared state from SimState, not from a private copy", () => {
  // The whole point of sim-state.js is that there is one copy. A module that
  // captured `const simNodes = S.simNodes` at load time would pin the first
  // array and silently render a stale mesh after the next run.
  const stateKeys = new Set(Object.keys(require("../../public/sim-state.js")));
  assert.ok(stateKeys.size > 0, "sim-state.js exported nothing");
  for (const file of moduleFiles) {
    const src = readFileSync(file, "utf8");
    for (const key of stateKeys) {
      const pinned = new RegExp(`const\\s+${key}\\s*=\\s*S\\.${key}\\b`);
      assert.ok(
        !pinned.test(src),
        `${file} pins S.${key} into a const at load time — it must read S.${key} ` +
          `at use, or it will keep showing the first value forever.`
      );
    }
  }
});

// A meta-test on the reference checker itself.
//
// The checker missed every bare assignment for a while, because acorn-walk
// reports an assignment target as a VariablePattern rather than an
// Identifier. In a non-strict script `foo = 1` on an undeclared name creates
// a global instead of throwing, so 98 broken writes to lifted simulator state
// passed review and passed the checker. This pins the hole shut.
test("the reference checker catches an implicit global", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = mkdtempSync(join(tmpdir(), "refcheck-"));
  const good = join(dir, "good.js");
  const bad = join(dir, "bad.js");
  writeFileSync(good, "(function(){ let x = 1; x = 2; return x; })();\n");
  writeFileSync(bad, "(function(){ oopsUndeclared = 2; })();\n");

  const run = (f) => {
    try {
      execFileSync("node", ["tools/check_module_refs.mjs", f], { encoding: "utf8" });
      return { ok: true };
    } catch (e) {
      return { ok: false, out: e.stdout || "" };
    }
  };

  assert.ok(run(good).ok, "a declared-then-assigned local must pass");
  const badRun = run(bad);
  assert.ok(!badRun.ok, "an assignment to an undeclared name must fail the check");
  assert.match(badRun.out, /oopsUndeclared/);
});

test("no module touches its context at load time", () => {
  // The bug this exists for: map-responsive.js had
  //
  //   const layersControl = L.control.layers(...).addTo(map);
  //
  // at module scope. `map` arrives with the context, so at load time it is
  // undefined and Leaflet throws *inside the factory* — the module never
  // registers itself, and app.js, planner.js and simulator.js all fail after
  // it. A blank page from one `const`.
  //
  // Neither static check caught it (the name exists, it is simply not set
  // yet) and neither did the boot smoke test, whose permissive stubs make
  // `undefined.addTo(...)` succeed. The rule that does catch it is simple:
  // anything a module receives through init() may only be used from inside a
  // function, never while the file is being evaluated.
  for (const file of moduleFiles) {
    const src = readFileSync(file, "utf8");
    const ast = parse(src, { ecmaVersion: "latest", locations: true });
    const factory = ast.body[0]?.expression?.arguments?.[1];
    if (!factory?.body) continue;

    const { needs } = moduleContract(file);
    if (needs.size === 0) continue;

    const offenders = [];
    // Walk only the factory's own top level: descend into nested statements
    // (if/for/try) but never into a function, since that body runs later.
    const scan = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
          node.type === "ArrowFunctionExpression") {
        return;
      }
      if (node.type === "Identifier" && needs.has(node.name)) {
        offenders.push(`${node.name} at ${file}:${node.loc.start.line}`);
        return;
      }
      for (const key of Object.keys(node)) {
        if (key === "loc" || key === "start" || key === "end") continue;
        // `let map, escapeHtml;` declares the context slots — that is where
        // they are supposed to appear, and it is not a use.
        if (node.type === "VariableDeclarator" && key === "id") continue;
        // Nor is a property NAME that happens to match a context name.
        if (node.type === "MemberExpression" && key === "property" && !node.computed) continue;
        if (node.type === "Property" && key === "key" && !node.computed) continue;
        const child = node[key];
        if (Array.isArray(child)) child.forEach(scan);
        else if (child && typeof child.type === "string") scan(child);
      }
    };
    factory.body.body.forEach(scan);

    assert.deepEqual(
      offenders, [],
      `${file} uses context at module-evaluation time:\n  ${offenders.join("\n  ")}\n` +
        `Move it into init() (or a function init() calls). At load time these ` +
        `are undefined, and throwing here stops the module registering itself ` +
        `at all — which takes down every file loaded after it.`
    );
  }
});
