// One-shot refactor helper: lift simulator.js's top-level mutable state into
// public/sim-state.js and rewrite every reference to go through it.
//
// AST-driven, not regex: it only rewrites Identifier nodes in value position,
// so property names, object keys, strings and comments are untouched. It
// refuses to run if any of the names is shadowed anywhere, because then a
// blind rewrite would capture the wrong binding.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "acorn";
import { ancestor, full } from "acorn-walk";

const [FILE, STATE_FILE, GLOBAL] = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["public/simulator.js", "public/sim-state.js", "SimState"];
const src = readFileSync(FILE, "utf8");
const ast = parse(src, { ecmaVersion: "latest", locations: true, ranges: true });

const iife = ast.body.find(
  (n) => n.type === "ExpressionStatement" && n.expression.type === "CallExpression"
);
const body = iife.expression.callee.body.body;

// The state to lift: every top-level `let` in the IIFE.
const decls = [];
for (const n of body) {
  if (n.type !== "VariableDeclaration" || n.kind !== "let") continue;
  for (const d of n.declarations) {
    if (d.id.type !== "Identifier") continue;
    decls.push({
      name: d.id.name,
      init: d.init ? src.slice(d.init.range[0], d.init.range[1]) : "undefined",
      // Keep the declaration's own comment block with it.
      stmt: n,
    });
  }
}
const names = new Set(decls.map((d) => d.name));

// Bail on shadowing: a nested binding of the same name means the rewrite
// would point the wrong reference at shared state.
const shadows = [];
const declaredIn = (node, out = []) => {
  if (!node) return out;
  if (node.type === "Identifier") out.push(node);
  else if (node.type === "ObjectPattern")
    node.properties.forEach((p) => declaredIn(p.type === "RestElement" ? p.argument : p.value, out));
  else if (node.type === "ArrayPattern") node.elements.forEach((e) => declaredIn(e, out));
  else if (node.type === "AssignmentPattern") declaredIn(node.left, out);
  else if (node.type === "RestElement") declaredIn(node.argument, out);
  return out;
};
const topLevelDeclNodes = new Set();
for (const n of body) {
  if (n.type === "VariableDeclaration" && n.kind === "let") {
    n.declarations.forEach((d) => declaredIn(d.id).forEach((i) => topLevelDeclNodes.add(i)));
  }
}
full(ast, (node) => {
  const check = (idNode) => {
    if (names.has(idNode.name) && !topLevelDeclNodes.has(idNode)) {
      shadows.push(`${idNode.name} at line ${idNode.loc.start.line}`);
    }
  };
  if (node.type === "VariableDeclarator") declaredIn(node.id).forEach(check);
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") {
    node.params.forEach((p) => declaredIn(p).forEach(check));
  }
  if (node.type === "CatchClause" && node.param) declaredIn(node.param).forEach(check);
});
if (shadows.length) {
  console.error("Refusing to rewrite — these names are shadowed:\n  " + shadows.join("\n  "));
  process.exit(1);
}

// Collect every reference to rewrite.
//
// BOTH visitors are required. acorn-walk reports an assignment TARGET as a
// VariablePattern, not an Identifier, so an Identifier-only walk rewrites
// every read and no write — and in a non-strict script the surviving
// `foo = 1` quietly creates a global rather than throwing. See
// tools/fix_state_assignments.mjs, which repaired 170 of exactly that.
const edits = [];
ancestor(ast, {
  VariablePattern(node) {
    if (!names.has(node.name)) return;
    if (topLevelDeclNodes.has(node)) return;
    edits.push({ start: node.range[0], end: node.range[1], text: `S.${node.name}` });
  },
  Identifier(node, _s, ancestors) {
    if (!names.has(node.name)) return;
    if (topLevelDeclNodes.has(node)) return; // the declaration itself
    const parent = ancestors[ancestors.length - 2];
    if (!parent) return;
    if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
    if (parent.type === "Property" && parent.key === node && !parent.computed) {
      // Shorthand `{ simNodes }` needs `simNodes: S.simNodes`, not `{ S.simNodes }`.
      if (parent.shorthand) edits.push({ start: node.range[0], end: node.range[1], text: `${node.name}: S.${node.name}` });
      return;
    }
    edits.push({ start: node.range[0], end: node.range[1], text: `S.${node.name}` });
  },
});

// Drop the lifted declarations (whole statements).
const dropRanges = [];
for (const n of body) {
  if (n.type !== "VariableDeclaration" || n.kind !== "let") continue;
  if (!n.declarations.every((d) => d.id.type === "Identifier" && names.has(d.id.name))) continue;
  // Swallow the trailing newline so no blank hole is left.
  let end = n.range[1];
  while (end < src.length && src[end] !== "\n") end++;
  dropRanges.push([n.range[0], end + 1]);
}

let out = src;
const all = [
  ...edits.map((e) => ({ start: e.start, end: e.end, text: e.text })),
  ...dropRanges.map(([a, b]) => ({ start: a, end: b, text: "" })),
].sort((a, b) => b.start - a.start);
for (const e of all) out = out.slice(0, e.start) + e.text + out.slice(e.end);

writeFileSync(FILE, out);

// Emit the state module.
const lines = decls.map((d) => `  ${d.name}: ${d.init},`);
writeFileSync(
  STATE_FILE,
  `// The simulator's shared mutable state, in one place.
//
// ${FILE.split('/').pop()} used to hold all of this as ${decls.length} closure variables, which is
// exactly why it could not be split: every feature area read and reassigned
// them, so moving any one of them out meant threading a getter for each. As a
// single object, a module that needs the current nodes just reads S.simNodes
// and always sees the live value.
//
// Deliberately a plain mutable object rather than an event-emitting store:
// this is a faithful lift of what the closure already did, and adding change
// notification at the same time would have made it a rewrite instead of a
// move.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.${GLOBAL} = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {
${lines.join("\n")}
  };
});
`
);

console.log(`lifted ${decls.length} state variables, rewrote ${edits.length} references`);
