// Extract a line range of simulator.js into its own public/*.js module.
//
//   node tools/extract_module.mjs SimLinks sim-links 1376 1689 "Doc line."
//
// Works out the module's dependencies from the AST rather than by guessing:
// anything the range references but does not define becomes part of the
// context object simulator.js passes to init(). Names it *defines* that the
// rest of simulator.js still uses are returned from init() and destructured
// back, so no call site changes.
//
// Callables are passed as arrow wrappers so resolution happens at call time —
// that way the order of the init() calls never matters, even between modules
// that reference each other.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "acorn";
import { ancestor } from "acorn-walk";

const [globalName, fileBase, startArg, endArg, doc] = process.argv.slice(2);
const START = Number(startArg);
const END = Number(endArg);
const SIM = "public/simulator.js";
const OUT = `public/${fileBase}.js`;
const WIRE_MARK = "  // --- module wiring ---";

const src = readFileSync(SIM, "utf8");
const lines = src.split("\n");
const block = lines.slice(START - 1, END).join("\n");

const declaredIn = (n, out = []) => {
  if (!n) return out;
  if (n.type === "Identifier") out.push(n.name);
  else if (n.type === "ObjectPattern") n.properties.forEach((p) => declaredIn(p.type === "RestElement" ? p.argument : p.value, out));
  else if (n.type === "ArrayPattern") n.elements.forEach((e) => declaredIn(e, out));
  else if (n.type === "AssignmentPattern") declaredIn(n.left, out);
  else if (n.type === "RestElement") declaredIn(n.argument, out);
  return out;
};

function analyse(code) {
  const ast = parse(`(function(){\n${code}\n})()`, { ecmaVersion: "latest", locations: true });
  const fnBody = ast.body[0].expression.callee.body.body;

  const topLevel = new Set();
  for (const n of fnBody) {
    if (n.type === "FunctionDeclaration" && n.id) topLevel.add(n.id.name);
    if (n.type === "VariableDeclaration") n.declarations.forEach((d) => declaredIn(d.id).forEach((x) => topLevel.add(x)));
  }

  const bound = new Set();
  const add = (n) => declaredIn(n).forEach((x) => bound.add(x));
  ancestor(ast, {
    VariableDeclarator: (n) => add(n.id),
    FunctionDeclaration: (n) => { if (n.id) bound.add(n.id.name); n.params.forEach(add); },
    FunctionExpression: (n) => { if (n.id) bound.add(n.id.name); n.params.forEach(add); },
    ArrowFunctionExpression: (n) => n.params.forEach(add),
    CatchClause: (n) => add(n.param),
  });

  const free = new Set();
  const called = new Set();
  ancestor(ast, {
    Identifier(n, _s, anc) {
      const p = anc[anc.length - 2];
      if (!p) return;
      if (p.type === "MemberExpression" && p.property === n && !p.computed) return;
      if (p.type === "Property" && p.key === n && !p.computed) return;
      if (!bound.has(n.name)) free.add(n.name);
    },
    CallExpression(n) { if (n.callee.type === "Identifier") called.add(n.callee.name); },
  });
  return { topLevel, free, called };
}

const KNOWN = new Set(
  JSON.parse(readFileSync("tools/known_globals.json", "utf8"))
);

const { topLevel: defines, free, called } = analyse(block);
const ctx = [...free].filter((n) => !KNOWN.has(n) && n !== "S").sort();

// Which of the names this block defines does the rest of simulator.js still
// need? Those come back out of init().
const remaining = lines.slice(0, START - 1).concat(lines.slice(END)).join("\n");
const { free: remainingFree } = analyse(
  remaining.replace(/^\(function \(\) \{$/m, "").replace(/^\}\)\(\);$/m, "")
);
const exported = [...defines].filter((n) => remainingFree.has(n)).sort();

const callableCtx = ctx.filter((n) => called.has(n));
const valueCtx = ctx.filter((n) => !called.has(n));

let header = `// ${doc}
//
// Split out of simulator.js. Shared mutable state comes from sim-state.js;
// everything else this module needs from the simulator arrives through the
// context object passed to init().
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.${globalName} = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const S = window.SimState;
`;
if (ctx.length) {
  header += `\n  let ${ctx.join(", ")};\n`;
}
header += "\n";

const footer = `
  function init(context) {
    ({ ${ctx.join(", ")} } = context);
    return api;
  }

  const api = {
    init,
${exported.map((n) => `    ${n},`).join("\n")}
  };
  return api;
});
`;

writeFileSync(OUT, header + block + "\n" + footer);

// Rewrite simulator.js: drop the block, add the wiring.
const wireLines = [];
wireLines.push(`  // ${doc}`);
if (exported.length) {
  wireLines.push(`  const {`);
  exported.forEach((n) => wireLines.push(`    ${n},`));
  wireLines.push(`  } = window.${globalName}.init({`);
} else {
  wireLines.push(`  window.${globalName}.init({`);
}
// Callables are wrapped so they resolve at call time — order-independent.
callableCtx.forEach((n) => wireLines.push(`    ${n}: (...a) => ${n}(...a),`));
if (valueCtx.length) wireLines.push(`    ${valueCtx.join(", ")},`);
wireLines.push(`  });`);
wireLines.push("");

let kept = lines.slice(0, START - 1).concat(lines.slice(END));
const wireAt = kept.findIndex((l) => l === WIRE_MARK);
if (wireAt === -1) {
  console.error(`Add the marker line "${WIRE_MARK}" to ${SIM} first.`);
  process.exit(1);
}
kept = kept.slice(0, wireAt + 2).concat(wireLines, kept.slice(wireAt + 2));
writeFileSync(SIM, kept.join("\n"));

console.log(`${OUT}: ${block.split("\n").length} lines`);
console.log(`  context (${ctx.length}): ${ctx.join(" ") || "none"}`);
console.log(`  exports (${exported.length}): ${exported.join(" ") || "none"}`);
console.log(`  simulator.js -> ${kept.length} lines`);
