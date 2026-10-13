// Unit tests for public/site-brand.js — run with `npm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const B = require("../../public/site-brand.js");

// Just enough of a document for applyBrand: elements by id, and a title.
function stubDoc(ids) {
  const els = {};
  for (const id of ids) els[id] = { id, textContent: "", hidden: id === "site-logo", src: "", alt: "", href: undefined };
  return { title: "before", els, getElementById: (id) => els[id] || null };
}

test("safeUrl keeps http(s) and relative paths", () => {
  assert.equal(B.safeUrl("https://example.org/"), "https://example.org/");
  assert.equal(B.safeUrl("HTTP://example.org"), "HTTP://example.org");
  assert.equal(B.safeUrl("site-logo.svg"), "site-logo.svg");
  assert.equal(B.safeUrl("/img/logo.png"), "/img/logo.png");
  assert.equal(B.safeUrl("img/a:b.png"), "img/a:b.png");
});

test("safeUrl drops other schemes and non-strings", () => {
  assert.equal(B.safeUrl("javascript:alert(1)"), "");
  assert.equal(B.safeUrl(" data:image/svg+xml,<svg/>"), "");
  assert.equal(B.safeUrl(""), "");
  assert.equal(B.safeUrl(undefined), "");
  assert.equal(B.safeUrl(42), "");
});

test("applyBrand with no logo or home URL leaves the header as it was", () => {
  const doc = stubDoc(["site-title", "site-subtitle", "site-logo", "site-brand"]);
  B.applyBrand(doc, { siteName: "Net", siteSubtitle: "Sub" }, { title: true });
  assert.equal(doc.els["site-title"].textContent, "Net");
  assert.equal(doc.els["site-subtitle"].textContent, "Sub");
  assert.equal(doc.title, "Net");
  assert.equal(doc.els["site-logo"].hidden, true);
  assert.equal(doc.els["site-brand"].href, undefined);
});

test("applyBrand shows the logo and links the brand home", () => {
  const doc = stubDoc(["site-title", "site-subtitle", "site-logo", "site-brand"]);
  B.applyBrand(doc, { siteName: "Net", logoUrl: "site-logo.svg", homeUrl: "https://net.example/" }, { title: true });
  assert.equal(doc.els["site-logo"].src, "site-logo.svg");
  assert.equal(doc.els["site-logo"].alt, "Net logo");
  assert.equal(doc.els["site-logo"].hidden, false);
  assert.equal(doc.els["site-brand"].href, "https://net.example/");
});

test("applyBrand without opts.title keeps the page's own heading", () => {
  const doc = stubDoc(["site-title", "site-logo"]);
  doc.els["site-title"].textContent = "Analytics";
  B.applyBrand(doc, { siteName: "Net", logoUrl: "l.png" });
  assert.equal(doc.els["site-title"].textContent, "Analytics");
  assert.equal(doc.title, "before");
  assert.equal(doc.els["site-logo"].hidden, false);
});

test("applyBrand never puts an unsafe URL into the page", () => {
  const doc = stubDoc(["site-logo", "site-brand"]);
  B.applyBrand(doc, { logoUrl: "javascript:x", homeUrl: "javascript:y" });
  assert.equal(doc.els["site-logo"].hidden, true);
  assert.equal(doc.els["site-brand"].href, undefined);
});

test("applyBrand hides an empty subtitle, and shows a set one", () => {
  const doc = stubDoc(["site-title", "site-subtitle"]);
  B.applyBrand(doc, { siteName: "Repeater Coverage", siteSubtitle: "" }, { title: true });
  assert.equal(doc.els["site-subtitle"].hidden, true);
  B.applyBrand(doc, { siteName: "Net", siteSubtitle: "Sub" }, { title: true });
  assert.equal(doc.els["site-subtitle"].hidden, false);
});
