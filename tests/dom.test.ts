import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { collectDom } from "../src/browser/dom.js";
import { MAX_DOM_CHARS } from "../src/shared/protocol.js";

function page(html: string) {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const doc = dom.window.document;
  const box = { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100, toJSON() { return this; } };
  dom.window.Element.prototype.getBoundingClientRect = function () { return this.id === "outside" ? { ...box, x: 500, left: 500, right: 600 } : box; };
  dom.window.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
  return { dom, doc };
}
test("DOM capture includes selection semantics and omits scripts, hidden nodes and password values", () => {
  const { dom, doc } = page(`<main id="card"><h1>Selected title</h1><p id="outside">Outside text</p><script>SECRET_SCRIPT</script><input type="password" value="SECRET_PASSWORD"><input type="hidden" value="SECRET_HIDDEN"><div hidden>HIDDEN_TEXT</div><textarea>PRIVATE_INPUT</textarea><a href="/next" onclick="SECRET_HANDLER">Next</a></main>`);
  const snapshot = collectDom(doc, { x: 0, y: 0, width: 150, height: 150 });
  assert.match(snapshot.html, /Selected title/); assert.match(snapshot.html, /https:\/\/example.com\/next/);
  for (const secret of ["SECRET_SCRIPT", "SECRET_PASSWORD", "SECRET_HIDDEN", "HIDDEN_TEXT", "PRIVATE_INPUT", "SECRET_HANDLER", "Outside text"]) assert.ok(!snapshot.html.includes(secret), secret);
  assert.ok(snapshot.text.includes("Selected title")); dom.window.close();
});
test("open shadow trees are captured and large DOM snapshots are explicitly truncated", () => {
  const { dom, doc } = page("<main><custom-card></custom-card><p></p></main>");
  doc.querySelector("custom-card")!.attachShadow({ mode: "open" }).innerHTML = "<span>Shadow label</span>";
  doc.querySelector("p")!.textContent = "a".repeat(MAX_DOM_CHARS * 2);
  const snapshot = collectDom(doc, { x: 0, y: 0, width: 150, height: 150 });
  assert.match(snapshot.html, /Shadow label/); assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.html.length <= MAX_DOM_CHARS); assert.ok(snapshot.text.length <= MAX_DOM_CHARS);
  dom.window.close();
});
