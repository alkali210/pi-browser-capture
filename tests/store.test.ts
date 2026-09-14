import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CaptureStore, draftAttachment, expandInput } from "../src/pi/store.js";
import { domSummary, MAX_DOM_SUMMARY_CHARS, marker } from "../src/shared/protocol.js";
import { capture } from "./helpers.js";

test("persists attachments, isolates credentials, expands images once and scopes by session", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-capture-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CaptureStore(root), sid = randomUUID(), c = capture();
  c.login = { origin: "https://example.com", capturedAt: new Date().toISOString(), cookies: [{ name: "session", value: "SECRET_VALUE", httpOnly: true }], localStorage: { token: "SECRET_VALUE" }, sessionStorage: {}, warnings: [] };
  assert.equal(store.token(), new CaptureStore(root).token());
  const result = store.save(sid, c);
  assert.equal(result.duplicate, false);
  assert.equal(store.save(sid, c).duplicate, true);
  assert.equal(store.list(sid).length, 1);
  const draft = draftAttachment(result.saved);
  assert.ok(draft.includes("login-state.json")); assert.ok(!draft.includes("SECRET_VALUE"));
  assert.ok(!readFileSync(join(result.saved.directory, "capture.json"), "utf8").includes("SECRET_VALUE"));
  assert.ok(readFileSync(join(result.saved.directory, "login-state.json"), "utf8").includes("SECRET_VALUE"));
  assert.equal(result.saved.loginSummary?.cookieCount, 1);
  const expanded = expandInput(store, sid, `existing draft\n${draft}\n${marker(c.id)}`);
  assert.equal(expanded.images.length, 1); assert.equal(expanded.images[0].data, c.png);
  assert.ok(expanded.text.startsWith("existing draft")); assert.ok(!expanded.text.includes("SECRET_VALUE"));
  assert.ok(!expanded.text.includes(JSON.stringify(c.dom.html)));
  assert.ok(expanded.text.includes("DOM 摘要"));
  assert.equal(expandInput(store, sid, "removed marker").images.length, 0);
  assert.throws(() => expandInput(store, randomUUID(), marker(c.id)), /不属于/);
  assert.throws(() => store.remove(sid, "../outside"), /identifier/);
  store.remove(sid, c.id);
  assert.ok(!existsSync(result.saved.directory));
  assert.throws(() => expandInput(store, sid, marker(c.id)), /已删除/);
});

test("DOM context is bounded by default and full DOM requires explicit opt-in", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-dom-options-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CaptureStore(root), sid = randomUUID();
  for (const includeFullDom of [undefined, false, true]) {
    const c = capture();
    c.includeFullDom = includeFullDom;
    c.dom.text = "Visible text ".repeat(4000) + "TEXT_TAIL";
    c.dom.html = "<main>HTML_ONLY_CONTENT</main>";
    c.dom.truncated = true;
    const saved = store.save(sid, c).saved;
    const expanded = expandInput(new CaptureStore(root), sid, draftAttachment(saved));
    assert.equal(expanded.text.includes("HTML_ONLY_CONTENT"), includeFullDom === true);
    assert.equal(expanded.text.includes("TEXT_TAIL"), includeFullDom === true);
    assert.equal(expanded.images.length, 1);
    assert.ok(expanded.text.includes("截断"));
    assert.equal(existsSync(join(saved.directory, "dom.html")), includeFullDom === true);
    const metadata = readFileSync(join(saved.directory, "capture.json"), "utf8");
    assert.equal(metadata.includes("HTML_ONLY_CONTENT"), includeFullDom === true);
    assert.equal(metadata.includes("TEXT_TAIL"), includeFullDom === true);
    assert.equal(readFileSync(join(saved.directory, "dom.txt"), "utf8"), includeFullDom === true ? c.dom.text : domSummary(c.dom));
    if (includeFullDom === true) assert.equal(readFileSync(join(saved.directory, "dom.html"), "utf8"), c.dom.html);
    if (includeFullDom !== true) assert.ok(expanded.text.length < 4000);
  }
  const dom = capture().dom;
  dom.text = "x".repeat(MAX_DOM_SUMMARY_CHARS + 1);
  assert.equal(domSummary(dom).length, MAX_DOM_SUMMARY_CHARS);
  assert.ok(domSummary(dom).endsWith("…"));
  dom.text = " \n ";
  assert.ok(domSummary(dom).includes("无可见文本"));
});
test("webpage text cannot create additional attachment markers", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-marker-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CaptureStore(root), sid = randomUUID(), c = capture();
  c.page.title = marker(randomUUID()); c.dom.text = marker(randomUUID());
  const saved = store.save(sid, c).saved;
  assert.equal(expandInput(store, sid, draftAttachment(saved)).images.length, 1);
});
