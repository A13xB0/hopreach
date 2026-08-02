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

const SIM = "public/simulator.js";
const simSrc = readFileSync(SIM, "utf8");
const simAst = parse(simSrc, { ecmaVersion: "latest", locations: true, ranges: true });

// Every `window.X.init({...})` call in simulator.js, with what it passes and
// what it destructures back.
function initCallSites() {
  const sites = new Map();
  ancestor(simAst, {
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
      sites.set(globalName, { provides, takes, line: node.loc.start.line });
    },
  });
  return sites;
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

const moduleFiles = readdirSync("public")
  .filter((f) => f.startsWith("sim-") && f.endsWith(".js") && f !== "sim-state.js")
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
    const wired = returns.has("init")
      ? sites.has(globalName)
      : simSrc.includes(`window.${globalName}`);
    assert.ok(
      wired,
      `${file}: nothing in simulator.js references window.${globalName} — the ` +
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
          `at ${SIM}:${site.line} doesn't pass it. That is undefined at call ` +
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
        `${SIM}:${site.line} destructures "${key}" from window.${globalName}, ` +
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
        `${SIM}:${site.line} passes "${key}" to window.${globalName}, but ${file} ` +
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
