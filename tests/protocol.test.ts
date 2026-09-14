import test from "node:test";
import assert from "node:assert/strict";
import { clipRect, pixelRect, prepareCapture, validateCapture, validateSession, MAX_DOM_CHARS, MAX_DOM_SUMMARY_CHARS } from "../src/shared/protocol.js";
import { randomUUID } from "node:crypto";
import { capture } from "./helpers.js";

test("clips selection and crops using actual screenshot scale, including fractional zoom", () => {
  assert.deepEqual(clipRect({ x: -20, y: 70, width: 80, height: 80 }, 100, 100), { x: 0, y: 70, width: 60, height: 30 });
  assert.deepEqual(pixelRect({ x: 10.2, y: 5.3, width: 20.2, height: 10.2 }, { width: 100, height: 100 }, { width: 150, height: 200 }), { x: 15, y: 10, width: 31, height: 21 });
});
test("validates geometry, scheme, identifiers, payload bounds and origin-scoped login state", () => {
  validateCapture(capture());
  for (const change of [
    (c: any) => c.id = "../../outside",
    (c: any) => c.page.rect.x = -1,
    (c: any) => c.page.rect.width = Infinity,
    (c: any) => c.page.rect.width = 2000,
    (c: any) => c.page.url = "file:///etc/passwd",
    (c: any) => c.png = "not-an-image",
    (c: any) => c.dom.html = "x".repeat(MAX_DOM_CHARS + 1),
    (c: any) => c.includeFullDom = "true",
    (c: any) => c.login = { origin: "https://other.example", capturedAt: new Date().toISOString(), cookies: [], localStorage: {}, sessionStorage: {}, warnings: [] }
  ]) { const c = capture(); change(c); assert.throws(() => validateCapture(c)); }
});
test("rejects malformed discovery advertisements", () => {
  const info = { instanceId: randomUUID(), sessionId: randomUUID(), name: "test", cwd: "D:/test", busy: false };
  validateSession(info);
  assert.throws(() => validateSession({ ...info, sessionId: undefined }));
  assert.throws(() => validateSession({ ...info, busy: "false" }));
});

test("summary transport omits full HTML and text while preserving selection metadata", () => {
  for (const includeFullDom of [undefined, false, true]) {
    const c = capture();
    c.includeFullDom = includeFullDom;
    c.page.locator = "#settings > button";
    c.dom.text = "x".repeat(5000) + "TEXT_TAIL";
    const payload = prepareCapture(c);
    validateCapture(payload);
    assert.deepEqual(payload.page, c.page);
    assert.equal(payload.png, c.png);
    assert.equal(payload.dom.html, includeFullDom === true ? c.dom.html : "");
    assert.equal(JSON.stringify(payload).includes("TEXT_TAIL"), includeFullDom === true);
    if (includeFullDom !== true) assert.ok(payload.dom.text.length <= MAX_DOM_SUMMARY_CHARS);
    assert.deepEqual(prepareCapture(payload), payload);
    assert.ok(c.dom.text.endsWith("TEXT_TAIL"));
  }
});
