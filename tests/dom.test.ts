import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { collectDom, freezeDom } from "../src/browser/dom.js";
import { MAX_DOM_CHARS, type Rect } from "../src/shared/protocol.js";

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

function position(element: Element, box: Rect) {
  const saved = { ...box, top: box.y, left: box.x, right: box.x + box.width, bottom: box.y + box.height, toJSON() { return this; } };
  element.getBoundingClientRect = () => saved;
  element.getClientRects = () => [saved] as any;
  return saved;
}

test("frozen captures retain content, locators and geometry without modifying or rereading the source", () => {
  const { dom, doc } = page('<main id="card"><button id="target" title="Original">Original label</button></main>');
  const target = doc.querySelector("#target")!;
  const originalBox = position(target, { x: 10, y: 15, width: 30, height: 20 });
  const originalHtml = doc.documentElement.outerHTML;
  const frozen = freezeDom(doc);
  const selection = { x: 10, y: 15, width: 30, height: 20 };
  const before = frozen.collect(selection);
  assert.equal(doc.documentElement.outerHTML, originalHtml);
  assert.deepEqual(frozen.hitTest(20, 20), { rect: selection, locator: "#target" });

  target.id = "changed";
  target.textContent = "Changed label";
  target.setAttribute("title", "Changed title");
  originalBox.x = 500;
  originalBox.width = 2;
  target.remove();
  doc.body.innerHTML = "<section>Replacement</section>";
  dom.window.Element.prototype.getBoundingClientRect = () => { throw new Error("Live geometry was consulted"); };
  dom.window.Element.prototype.getClientRects = () => { throw new Error("Live rects were consulted"); };
  dom.window.getComputedStyle = () => { throw new Error("Live style was consulted"); };
  doc.createRange = () => { throw new Error("Live text ranges were consulted"); };
  assert.deepEqual(frozen.collect(selection), before);
  assert.match(before.html, /title="Original"/);
  assert.match(before.text, /Original label/);
  assert.doesNotMatch(before.html, /Changed|Replacement/);
  const hit = frozen.hitTest(20, 20)!;
  hit.rect.x = 900;
  assert.deepEqual(frozen.hitTest(20, 20), { rect: selection, locator: "#target" });
  assert.equal(frozen.hitTest(501, 20), undefined);
  dom.window.close();
  assert.deepEqual(frozen.collect(selection), before);
});

test("frozen selection filtering preserves text ranges, overflow clipping and strict boundaries", () => {
  const { dom, doc } = page('<div id="clip" style="overflow-x:hidden;overflow-y:hidden"><p id="lines">Visible line<br>Clipped line</p></div><p id="edge">Boundary</p>');
  position(doc.querySelector("#clip")!, { x: 0, y: 0, width: 50, height: 50 });
  position(doc.querySelector("#lines")!, { x: 20, y: 10, width: 60, height: 60 });
  position(doc.querySelector("#lines br")!, { x: 20, y: 30, width: 0, height: 0 });
  position(doc.querySelector("#edge")!, { x: 50, y: 10, width: 10, height: 10 });
  // The element intersects the selection, but only the first text range is visible.
  doc.createRange = () => {
    let node: Node;
    return {
      selectNodeContents(value: Node) { node = value; },
      getClientRects() { return [{ x: 20, y: node!.textContent === "Visible line" ? 10 : 60, width: 30, height: 10 }]; },
      detach() {},
    } as unknown as Range;
  };
  const selection = { x: 0, y: 0, width: 50, height: 50 };
  const expected = collectDom(doc, selection);
  const frozen = freezeDom(doc);
  doc.querySelector("#clip")!.remove();
  const snapshot = frozen.collect(selection);
  assert.deepEqual(snapshot, expected);
  assert.match(snapshot.text, /Visible line/);
  assert.doesNotMatch(snapshot.html, /Clipped line|Boundary/);
  assert.equal(frozen.collect({ x: 50, y: 10, width: 0, height: 10 }).html, "");
  assert.equal(frozen.collect({ x: 0, y: 50, width: 50, height: 10 }).text, "");
  assert.equal(frozen.hitTest(45, 15)?.locator, "#lines");
  assert.notEqual(frozen.hitTest(55, 40)?.locator, "#lines");
  assert.equal(frozen.hitTest(50, 15)?.locator, "#edge");
  assert.notEqual(frozen.hitTest(60, 15)?.locator, "#edge");
  dom.window.close();
});

test("frozen hit testing prefers descendants, stacking contexts and later overlapping elements", () => {
  const { dom, doc } = page('<div id="front" style="position:relative;z-index:10"><button id="front-child">Front</button></div><button id="later" style="position:relative;z-index:1">Later</button><button id="hidden" style="display:none">Hidden</button><div id="__pi_browser_capture_overlay__">Overlay</div>');
  position(doc.querySelector("#front")!, { x: 5, y: 5, width: 80, height: 80 });
  position(doc.querySelector("#front-child")!, { x: 10, y: 10, width: 20, height: 20 });
  const frozen = freezeDom(doc);
  doc.querySelector("#front")!.remove();
  assert.equal(frozen.hitTest(15, 15)?.locator, "#front-child");
  assert.equal(frozen.hitTest(50, 50)?.locator, "#front");
  assert.equal(frozen.hitTest(95, 95)?.locator, "#later");
  assert.equal(frozen.hitTest(100, 100), undefined);
  dom.window.close();

  const second = page('<div id="first"><button id="deep">Deep</button></div><button id="last">Last</button>');
  const overlap = freezeDom(second.doc);
  assert.equal(overlap.hitTest(20, 20)?.locator, "#last");
  second.dom.window.close();
});

test("frozen captures share sanitization and shadow conventions without retaining private input data", () => {
  const { dom, doc } = page('<main><script>SCRIPT_SECRET</script><input type="password" value="PASSWORD_SECRET"><input type="hidden" value="HIDDEN_SECRET"><textarea>TEXTAREA_SECRET</textarea><div hidden>HIDDEN_TEXT</div><div style="opacity:0">INVISIBLE_TEXT</div><a id="link" href="/next" onclick="HANDLER_SECRET" data-private="PRIVATE_ATTRIBUTE" aria-label="Accessible label">Next</a><a href="javascript:URL_SECRET">Unsafe</a><img src="data:IMAGE_SECRET"><custom-card id="host"></custom-card></main>');
  const shadow = doc.querySelector("#host")!.attachShadow({ mode: "open" });
  shadow.innerHTML = '<span id="shadow-label">Shadow label</span>';
  position(shadow.querySelector("span")!, { x: 5, y: 5, width: 15, height: 15 });
  position(doc.querySelector("#link")!, { x: 50, y: 50, width: 20, height: 20 });
  const selection = { x: 0, y: 0, width: 100, height: 100 };
  const expected = collectDom(doc, selection);
  const frozen = freezeDom(doc);
  shadow.innerHTML = "<span>Changed shadow</span>";
  doc.querySelector("#link")!.setAttribute("href", "/changed");
  const snapshot = frozen.collect(selection);
  assert.deepEqual(snapshot, expected);
  assert.match(snapshot.html, /<shadow-root>.*Shadow label.*<\/shadow-root>/);
  assert.match(snapshot.html, /href="https:\/\/example.com\/next"/);
  assert.match(snapshot.html, /aria-label="Accessible label"/);
  for (const secret of ["SCRIPT_SECRET", "PASSWORD_SECRET", "HIDDEN_SECRET", "TEXTAREA_SECRET", "HIDDEN_TEXT", "INVISIBLE_TEXT", "HANDLER_SECRET", "PRIVATE_ATTRIBUTE", "URL_SECRET", "IMAGE_SECRET", "Changed shadow"]) {
    assert.ok(!snapshot.html.includes(secret), secret);
    assert.ok(!snapshot.text.includes(secret), secret);
  }
  assert.equal(frozen.hitTest(10, 10)?.locator, "#shadow-label");
  dom.window.close();
});

test("frozen same-origin frames retain scaled geometry and unavailable frames retain their warning", () => {
  const { dom, doc } = page('<iframe id="frame"></iframe><iframe id="unavailable"></iframe>');
  const frame = doc.querySelector<HTMLIFrameElement>("#frame")!;
  position(frame, { x: 100, y: 40, width: 200, height: 100 });
  for (const [key, value] of Object.entries({ offsetWidth: 100, offsetHeight: 50, clientWidth: 100, clientHeight: 50, clientLeft: 0, clientTop: 0 })) {
    Object.defineProperty(frame, key, { value });
  }
  const inner = frame.contentDocument!;
  inner.body.innerHTML = '<p id="frame-label">Frame label</p>';
  position(inner.documentElement, { x: 0, y: 0, width: 100, height: 50 });
  position(inner.body, { x: 0, y: 0, width: 100, height: 50 });
  position(inner.querySelector("p")!, { x: 10, y: 5, width: 20, height: 10 });
  const unavailable = doc.querySelector("#unavailable")!;
  Object.defineProperty(unavailable, "contentDocument", { value: null });
  const frozen = freezeDom(doc);
  inner.body.textContent = "Changed frame";
  frame.remove();
  unavailable.remove();
  const snapshot = frozen.collect({ x: 120, y: 50, width: 10, height: 10 });
  assert.match(snapshot.html, /<frame-document>.*Frame label.*<\/frame-document>/);
  assert.doesNotMatch(snapshot.html, /Changed frame/);
  assert.deepEqual(frozen.hitTest(125, 55), { rect: { x: 120, y: 50, width: 40, height: 20 }, locator: "#frame-label" });
  assert.ok(frozen.collect({ x: 0, y: 0, width: 50, height: 50 }).warnings.some(warning => warning.includes("iframe")));
  assert.ok(!snapshot.warnings.some(warning => warning.includes("iframe")));
  dom.window.close();
});

test("frozen snapshots remain bounded and explicitly report truncation", () => {
  const { dom, doc } = page("<main><p></p></main>");
  doc.querySelector("p")!.textContent = "a".repeat(MAX_DOM_CHARS * 6);
  const frozen = freezeDom(doc);
  doc.querySelector("p")!.remove();
  const snapshot = frozen.collect({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(snapshot.truncated, true);
  assert.ok(snapshot.html.length <= MAX_DOM_CHARS);
  assert.ok(snapshot.text.length <= MAX_DOM_CHARS);
  assert.ok(snapshot.warnings.some(warning => warning.includes("截断")));
  dom.window.close();
});

test("DOM truncation does not prevent frozen element selection later in the document", () => {
  const { dom, doc } = page('<p id="large"></p><button id="target">Select this</button>');
  doc.querySelector("#large")!.textContent = "a".repeat(MAX_DOM_CHARS * 6);
  const target = doc.querySelector("#target")!;
  const selection = { x: 10, y: 10, width: 30, height: 20 };
  position(target, selection);
  const frozen = freezeDom(doc);
  target.remove();
  assert.equal(frozen.collect(selection).truncated, true);
  assert.deepEqual(frozen.hitTest(20, 20), { rect: selection, locator: "#target" });
  dom.window.close();
});

test("offscreen content does not consume the visible frozen DOM budget", () => {
  const { dom, doc } = page(`<section id="offscreen">${`<p class="${"unused".repeat(160)}">${"offscreen ".repeat(120)}</p>`.repeat(300)}</section><button id="target">Visible target</button>`);
  for (const element of doc.querySelectorAll("#offscreen, #offscreen p")) position(element, { x: 0, y: 2000, width: 100, height: 20 });
  const frozen = freezeDom(doc);
  doc.body.replaceChildren();
  const result = frozen.collect({ x: 0, y: 0, width: 100, height: 100 });
  assert.equal(result.truncated, false);
  assert.match(result.text, /Visible target/);
  assert.doesNotMatch(result.html, /offscreen|unused/);
  assert.equal(frozen.hitTest(20, 20)?.locator, "#target");
  dom.window.close();
});

test("frozen hit testing ignores pointer-transparent page overlays and preserves sibling locators", () => {
  const { dom, doc } = page(`<main>${"<button>Card</button>".repeat(100)}</main><div style="position:fixed;z-index:1000;pointer-events:none"></div>`);
  const target = doc.querySelector("main")!.lastElementChild!;
  position(target, { x: 10, y: 10, width: 20, height: 20 });
  const frozen = freezeDom(doc);
  const hit = frozen.hitTest(15, 15)!;
  assert.equal(doc.querySelector(hit.locator), target);
  target.remove();
  assert.deepEqual(frozen.hitTest(15, 15), hit);
  dom.window.close();
});

test("ignored page nodes and deep app wrappers do not exclude visible frozen targets", () => {
  const { dom, doc } = page(`${"<script></script>".repeat(10_010)}${"<div>".repeat(75)}<button id="deep-target">Deep target</button>${"</div>".repeat(75)}`);
  const target = doc.querySelector("#deep-target")!;
  position(target, { x: 10, y: 10, width: 20, height: 20 });
  const frozen = freezeDom(doc);
  target.remove();
  assert.equal(frozen.hitTest(15, 15)?.locator, "#deep-target");
  dom.window.close();
});

test("viewport-scrolling roots with zero-height border boxes retain absolute app elements", () => {
  for (const [rootOverflow, bodyOverflow] of [["visible", "scroll"], ["auto", "visible"]]) {
    const { dom, doc } = page('<main style="position:absolute"><button id="search">Search control</button></main>');
    doc.documentElement.style.overflowX = doc.documentElement.style.overflowY = rootOverflow!;
    doc.body.style.overflowX = doc.body.style.overflowY = bodyOverflow!;
    position(doc.documentElement, { x: 0, y: 0, width: 100, height: 0 });
    position(doc.body, { x: 0, y: 0, width: 100, height: 0 });
    const selection = { x: 10, y: 10, width: 30, height: 20 };
    position(doc.querySelector("#search")!, selection);
    assert.match(collectDom(doc, selection).text, /Search control/);
    const frozen = freezeDom(doc);
    doc.body.replaceChildren();
    assert.deepEqual(frozen.hitTest(20, 20), { rect: selection, locator: "#search" });
    assert.match(frozen.collect(selection).text, /Search control/);
    dom.window.close();
  }
});

test("frozen painting phases keep positioned auto subtrees above later in-flow siblings", () => {
  for (const position of ["absolute", "relative"]) {
    for (const child of ["", '<div id="descendant">Descendant</div>']) {
      const { dom, doc } = page(`<div id="positioned" style="position:${position};z-index:auto">${child}</div><div id="later">Later static sibling</div>`);
      const frozen = freezeDom(doc);
      assert.equal(frozen.hitTest(20, 20)?.locator, child ? "#descendant" : "#positioned", `${position}: ${child ? "descendant" : "element"}`);
      dom.window.close();
    }
  }
});

test("frozen stacking descendants escape auto groups but stay inside real stacking contexts", () => {
  const cases = [
    {
      name: "positive descendant escapes positioned auto ancestor",
      html: '<div style="position:relative"><div><div id="child" style="position:absolute;z-index:5"></div></div></div><div id="later" style="position:relative;z-index:1"></div>',
      expected: "#child",
    },
    {
      name: "negative descendant participates below its auto ancestor",
      html: '<div id="parent" style="position:relative"><div id="child" style="position:absolute;z-index:-1"></div></div><div id="later"></div>',
      expected: "#parent",
    },
    {
      name: "zero context contains positive descendant",
      html: '<div style="position:relative;z-index:0"><div id="child" style="position:absolute;z-index:5"></div></div><div id="later" style="position:relative;z-index:1"></div>',
      expected: "#later",
    },
    {
      name: "negative context contains positive descendant below in-flow content",
      html: '<div style="position:relative;z-index:-1"><div id="child" style="position:absolute;z-index:100"></div></div><div id="later"></div>',
      expected: "#later",
    },
    {
      name: "negative descendant remains above the positive context background",
      html: '<div style="position:relative;z-index:2"><div id="child" style="position:absolute;z-index:-100"></div></div><div id="later" style="position:relative;z-index:1"></div>',
      expected: "#child",
    },
    {
      name: "nested auto descendant participates in ancestor tree order",
      html: '<div style="position:relative"><div><div id="child" style="position:absolute"></div></div></div><div id="later" style="position:relative"></div>',
      expected: "#later",
    },
    {
      name: "auto and zero contexts share tree order",
      html: '<div style="position:relative;z-index:0"><div id="child"></div></div><div id="later" style="position:relative"></div>',
      expected: "#later",
    },
    {
      name: "opacity context contains positioned descendant",
      html: '<div style="opacity:0.5"><div id="child" style="position:absolute;z-index:100"></div></div><div id="later" style="position:relative;z-index:1"></div>',
      expected: "#later",
    },
  ];
  for (const { name, html, expected } of cases) {
    const { dom, doc } = page(html);
    assert.equal(freezeDom(doc).hitTest(20, 20)?.locator, expected, name);
    dom.window.close();
  }
});

test("frozen in-flow paint phases order blocks, floats and inline content", () => {
  const cases = [
    ['<div id="float" style="float:left"></div><div id="block"></div>', "#float"],
    ['<span id="inline" style="display:inline"></span><div id="float" style="float:left"></div>', "#inline"],
    ['<div id="float" style="float:left"><div id="descendant"></div></div><div id="block"></div>', "#descendant"],
    ['<div style="float:left"><div id="child" style="position:relative;z-index:5"></div></div><div id="later" style="position:relative;z-index:1"></div>', "#child"],
    ['<span style="display:inline-block"><div id="child" style="position:relative;z-index:5"></div></span><div id="later" style="position:relative;z-index:1"></div>', "#child"],
  ];
  for (const [html, expected] of cases) {
    const { dom, doc } = page(html!);
    assert.equal(freezeDom(doc).hitTest(20, 20)?.locator, expected, html);
    dom.window.close();
  }
});

test("frozen block text paints in the inline phase above overlapping floats", () => {
  const { dom, doc } = page('<div id="text">Foreground text</div><div id="float" style="float:left"></div>');
  doc.createRange = () => ({
    selectNodeContents() {},
    getClientRects() { return [{ x: 10, y: 10, width: 20, height: 20 }]; },
    detach() {},
  }) as unknown as Range;
  const frozen = freezeDom(doc);
  assert.equal(frozen.hitTest(20, 20)?.locator, "#text");
  assert.equal(frozen.hitTest(50, 50)?.locator, "#float");
  dom.window.close();
});

test("frozen matches compares immutable state independently of the hit index", () => {
  const { dom, doc } = page('<main id="card"><button id="target">Original label</button></main>');
  const target = doc.querySelector("#target")!;
  const originalBox = position(target, { x: 10, y: 15, width: 30, height: 20 });
  const withHits = freezeDom(doc);
  const region = freezeDom(doc, false);
  assert.equal(withHits.matches(region), true);
  assert.equal(region.matches(withHits), true);
  assert.equal(region.hitTest(20, 20), undefined);
  target.textContent = "Changed label";
  originalBox.x = 500;
  target.remove();
  dom.window.Element.prototype.getBoundingClientRect = () => { throw new Error("Live geometry was consulted"); };
  dom.window.Element.prototype.getClientRects = () => { throw new Error("Live rects were consulted"); };
  dom.window.getComputedStyle = () => { throw new Error("Live style was consulted"); };
  doc.createRange = () => { throw new Error("Live text ranges were consulted"); };
  assert.equal(withHits.matches(region), true);
  assert.equal(region.matches(withHits), true);
  dom.window.close();
  assert.equal(withHits.matches(region), true);
});

test("frozen matches detects content, layout, clipping, visibility and paint-input changes", () => {
  const changes: [string, (doc: Document, target: HTMLElement) => void][] = [
    ["text", (_doc, target) => { target.textContent = "Changed"; }],
    ["removal", (_doc, target) => { target.remove(); }],
    ["attribute", (_doc, target) => { target.title = "Changed"; }],
    ["geometry", (_doc, target) => { position(target, { x: 5, y: 6, width: 70, height: 80 }); }],
    ["positioning", (_doc, target) => { target.style.position = "absolute"; }],
    ["transform", (_doc, target) => { target.style.transform = "translateX(2px)"; }],
    ["opacity", (_doc, target) => { target.style.opacity = "0.5"; }],
    ["z-index", (_doc, target) => { target.style.zIndex = "2"; }],
    ["float", (_doc, target) => { target.style.cssFloat = "left"; }],
    ["inline phase", (_doc, target) => { target.style.display = "inline"; }],
    ["pointer events", (_doc, target) => { target.style.pointerEvents = "none"; }],
    ["visibility", (_doc, target) => { target.style.visibility = "hidden"; }],
    ["clipping", (doc) => { doc.body.style.overflowX = "hidden"; }],
    ["root attribute", (doc) => { doc.documentElement.className = "changed"; }],
    ["root clipping", (doc) => { doc.documentElement.style.overflowY = "hidden"; }],
    ["root visibility", (doc) => { doc.documentElement.style.visibility = "hidden"; }],
    ["viewport", (doc) => { Object.defineProperty(doc.defaultView!, "innerWidth", { value: 900 }); }],
  ];
  for (const [name, change] of changes) {
    const { dom, doc } = page('<div id="target">Original label</div>');
    const before = freezeDom(doc, false);
    change(doc, doc.querySelector<HTMLElement>("#target")!);
    const after = freezeDom(doc, false);
    assert.equal(before.matches(after), false, name);
    assert.equal(after.matches(before), false, name);
    dom.window.close();
  }
});

test("frozen matches includes text range geometry, shadow trees and truncation state", () => {
  const { dom, doc } = page('<custom-card id="host">Text</custom-card>');
  let textX = 1;
  doc.createRange = () => ({
    selectNodeContents() {},
    getClientRects() { return [{ x: textX, y: 1, width: 10, height: 10 }]; },
    detach() {},
  }) as unknown as Range;
  const before = freezeDom(doc, false);
  textX = 2;
  assert.equal(before.matches(freezeDom(doc, false)), false);
  const host = doc.querySelector("#host")!;
  host.attachShadow({ mode: "open" }).innerHTML = "<span>Shadow text</span>";
  const shadow = freezeDom(doc, false);
  host.shadowRoot!.querySelector("span")!.textContent = "Changed shadow";
  assert.equal(shadow.matches(freezeDom(doc, false)), false);
  dom.window.close();

  const large = page("<p></p>");
  large.doc.querySelector("p")!.textContent = "a".repeat(MAX_DOM_CHARS * 4);
  const complete = freezeDom(large.doc, false);
  large.doc.querySelector("p")!.append("a");
  assert.equal(complete.matches(freezeDom(large.doc, false)), false);
  large.dom.window.close();
});

test("frozen matches includes frame geometry and immutable same-origin frame content", () => {
  const { dom, doc } = page('<iframe id="frame"></iframe>');
  const frame = doc.querySelector<HTMLIFrameElement>("iframe")!;
  for (const [key, value] of Object.entries({ offsetWidth: 100, offsetHeight: 100, clientWidth: 100, clientHeight: 100, clientLeft: 0, clientTop: 0 })) {
    Object.defineProperty(frame, key, { value, configurable: true });
  }
  const inner = frame.contentDocument!;
  inner.body.innerHTML = '<p id="label">Frame text</p>';
  for (const element of inner.querySelectorAll("*")) position(element, { x: 0, y: 0, width: 100, height: 100 });
  const first = freezeDom(doc, false);
  const equivalent = freezeDom(doc);
  assert.equal(first.matches(equivalent), true);
  inner.querySelector("p")!.textContent = "Changed frame";
  assert.equal(first.matches(freezeDom(doc, false)), false);
  assert.equal(first.matches(equivalent), true);
  inner.querySelector("p")!.textContent = "Frame text";
  Object.defineProperty(frame, "clientWidth", { value: 50, configurable: true });
  assert.equal(first.matches(freezeDom(doc, false)), false);
  dom.window.close();
});
