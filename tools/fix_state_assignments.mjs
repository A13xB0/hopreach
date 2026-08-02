// Repairs bare assignments to lifted state: `foo = 1` -> `S.foo = 1`.
//
// tools/lift_state.mjs originally missed these. acorn-walk reports an
// assignment TARGET as a VariablePattern node, not an Identifier, so a walk
// that only visits Identifier sees every read of `foo` and none of the
// writes. In a non-strict script the surviving `foo = 1` creates a global
// instead of throwing, so the state object kept its old value and nothing
// complained.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "acorn";
import { ancestor } from "acorn-walk";

const stateNames = new Set(Object.keys(JSON.parse(readFileSync("tools/state_names.json", "utf8"))));

let total = 0;
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, { ecmaVersion: "latest", ranges: true, locations: true });

  // Anything genuinely declared in this file keeps its own binding.
  const declared = new Set();
  const declaredNodes = new Set();
  const names = (n, out = []) => {
    if (!n) return out;
    if (n.type === "Identifier") out.push(n);
    else if (n.type === "ObjectPattern") n.properties.forEach((p) => names(p.type === "RestElement" ? p.argument : p.value, out));
    else if (n.type === "ArrayPattern") n.elements.forEach((e) => names(e, out));
    else if (n.type === "AssignmentPattern") names(n.left, out);
    else if (n.type === "RestElement") names(n.argument, out);
    return out;
  };
  ancestor(ast, {
    VariableDeclarator: (n) => names(n.id).forEach((i) => { declared.add(i.name); declaredNodes.add(i); }),
    FunctionDeclaration: (n) => { if (n.id) declared.add(n.id.name); n.params.forEach((p) => names(p).forEach((i) => { declared.add(i.name); declaredNodes.add(i); })); },
    FunctionExpression: (n) => n.params.forEach((p) => names(p).forEach((i) => { declared.add(i.name); declaredNodes.add(i); })),
    ArrowFunctionExpression: (n) => n.params.forEach((p) => names(p).forEach((i) => { declared.add(i.name); declaredNodes.add(i); })),
    CatchClause: (n) => names(n.param).forEach((i) => { declared.add(i.name); declaredNodes.add(i); }),
  });

  const edits = [];
  ancestor(ast, {
    VariablePattern(node) {
      if (!stateNames.has(node.name)) return;
      if (declared.has(node.name) || declaredNodes.has(node)) return;
      edits.push({ start: node.range[0], end: node.range[1], line: node.loc.start.line });
    },
  });
  if (!edits.length) { console.log(`  ${file}: nothing to fix`); continue; }

  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + "S." + out.slice(e.start);
  }
  writeFileSync(file, out);
  total += edits.length;
  console.log(`  ${file}: fixed ${edits.length}`);
}
console.log(`total ${total}`);
