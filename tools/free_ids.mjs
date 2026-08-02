// Dev helper: list the identifiers a slice of simulator.js depends on from
// outside itself. Used to work out a module's context before extracting it.
//
//   node tools/free_ids.mjs public/simulator.js 2798 3078
import { readFileSync } from "node:fs";
import { parse } from "acorn";
import { ancestor } from "acorn-walk";

const [file, from, to] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").split("\n");
const src = lines.slice(Number(from) - 1, Number(to)).join("\n");

const ast = parse(`(function(){\n${src}\n})()`, { ecmaVersion: "latest", locations: true });

const declared = (n, out = []) => {
  if (!n) return out;
  if (n.type === "Identifier") out.push(n.name);
  else if (n.type === "ObjectPattern") n.properties.forEach((p) => declared(p.type === "RestElement" ? p.argument : p.value, out));
  else if (n.type === "ArrayPattern") n.elements.forEach((e) => declared(e, out));
  else if (n.type === "AssignmentPattern") declared(n.left, out);
  else if (n.type === "RestElement") declared(n.argument, out);
  return out;
};

const bound = new Set();
const add = (n) => declared(n).forEach((x) => bound.add(x));
ancestor(ast, {
  VariableDeclarator: (n) => add(n.id),
  FunctionDeclaration: (n) => { if (n.id) bound.add(n.id.name); n.params.forEach(add); },
  FunctionExpression: (n) => { if (n.id) bound.add(n.id.name); n.params.forEach(add); },
  ArrowFunctionExpression: (n) => n.params.forEach(add),
  CatchClause: (n) => add(n.param),
});

// Names this slice DEFINES, i.e. what the rest of the file may still need.
const defines = new Set();
ancestor(ast, {
  FunctionDeclaration(n, _s, anc) { if (n.id && anc.length <= 4) defines.add(n.id.name); },
  VariableDeclarator(n, _s, anc) { if (anc.length <= 5) declared(n.id).forEach((x) => defines.add(x)); },
});

const free = new Map();
ancestor(ast, {
  Identifier(n, _s, anc) {
    const p = anc[anc.length - 2];
    if (!p) return;
    if (p.type === "MemberExpression" && p.property === n && !p.computed) return;
    if (p.type === "Property" && p.key === n && !p.computed) return;
    if (bound.has(n.name)) return;
    if (!free.has(n.name)) free.set(n.name, n.loc.start.line - 1 + Number(from) - 1);
  },
});

console.log("DEFINES:", [...defines].sort().join(" "));
console.log("\nNEEDS FROM OUTSIDE:");
for (const [name, line] of [...free].sort()) console.log(`  ${name}  (first use ~${line})`);
