// Moves a module's top-level statements into a bindDom() called from init().
//
// The extractor lifts a contiguous range out of a big IIFE, and those ranges
// often contain event registrations that sat at the closure's top level. In
// the original file that was fine — everything they referenced was already in
// scope. In a module it is not: `map.on("click", ...)` runs the moment the
// script loads, before init() has supplied `map`, so the page dies on load.
//
// Declarations stay where they are; only executable statements move.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "acorn";

for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, "utf8");
  const ast = parse(src, { ecmaVersion: "latest", ranges: true, locations: true });
  const factory = ast.body[0]?.expression?.arguments?.[1];
  if (!factory?.body) { console.log(`  ${file}: not a module factory`); continue; }

  const stray = factory.body.body.filter(
    (n) =>
      n.type !== "FunctionDeclaration" &&
      n.type !== "VariableDeclaration" &&
      n.type !== "ReturnStatement" &&
      !(n.type === "ExpressionStatement" && n.expression.type === "Literal")
  );
  if (!stray.length) { console.log(`  ${file}: nothing to defer`); continue; }

  // Take each statement with the comment block directly above it.
  const lines = src.split("\n");
  const chunks = [];
  const drop = [];
  for (const n of stray) {
    let start = n.loc.start.line - 1;
    while (start > 0 && lines[start - 1].trim().startsWith("//")) start--;
    const end = n.loc.end.line - 1;
    chunks.push(lines.slice(start, end + 1).map((l) => (l ? "  " + l : l)).join("\n"));
    drop.push([start, end]);
  }

  const kept = lines.filter((_, i) => !drop.some(([a, b]) => i >= a && i <= b));
  let out = kept.join("\n");

  const bind = `
  // Deferred to init(): these run against things the context supplies, so at
  // module-load time there is nothing yet to bind to.
  function bindDom() {
${chunks.join("\n\n")}
  }
`;
  // Insert bindDom before init, and call it from init.
  out = out.replace(/\n  function init\(/, `${bind}\n  function init(`);
  out = out.replace(/(\n  function init\([^)]*\) \{\n(?:.*\n)*?)(    return api;\n  \})/,
                    "$1    bindDom();\n$2");
  writeFileSync(file, out);
  console.log(`  ${file}: deferred ${stray.length} statement(s)`);
}
