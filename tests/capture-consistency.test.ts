import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { build } from "esbuild";
import { JSDOM, type DOMWindow } from "jsdom";
import type { Capture, Rect } from "../src/shared/protocol.js";
import { PNG } from "./helpers.js";

// Run the real content/background consumers; only browser platform boundaries are simulated.
const bundles = Promise.all(["content", "background"].map(async name => {
  const result = await build({
    entryPoints: [`src/browser/${name}.ts`], bundle: true, write: false, format: "iife", platform: "browser",
    define: { __FIREFOX__: "false" },
    plugins: [{ name: "browser-platform", setup(builder) {
      builder.onResolve({ filter: /^webextension-polyfill$/ }, () => ({ path: "browser-platform", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export default globalThis.__captureTestBrowser;" }));
    } }],
  });
  return result.outputFiles[0]!.text;
}));

type Frame = { text: string; x: number };
interface Harness {
  dom: JSDOM; window: DOMWindow; document: Document; target: HTMLButtonElement; layout: Rect;
  screenshots: Frame[]; screenshotTimes: number[]; crops: Frame[]; observers: Set<MutationObserver>;
  frames: Map<number, FrameRequestCallback>; contentMessages: any[]; sourceMessages: any[];
  start(): Promise<any>; contentMessage(message: any): Promise<any>; pumpFrame(elapsed: number): void;
  select(x?: number): Promise<Capture>; escape(): boolean; close(): void;
}
type Hooks = { capture?: (attempt: number, state: Harness) => void | Promise<void>; decode?: (attempt: number, state: Harness) => void | Promise<void> };
async function harness(hooks: Hooks = {}, freezePage = true): Promise<Harness> {
  const [contentCode, backgroundCode] = await bundles;
  const dom = new JSDOM('<title>Original title</title><main><button id="target">Original label</button></main>', { url: "https://example.com/page", runScripts: "outside-only", pretendToBeVisual: true });
  const window = dom.window, document = window.document;
  const target = document.querySelector<HTMLButtonElement>("#target")!;
  const layout = { x: 20, y: 20, width: 80, height: 30 };
  const rect = (value: typeof layout) => ({ ...value, top: value.y, left: value.x, right: value.x + value.width, bottom: value.y + value.height, toJSON() { return this; } });
  window.Element.prototype.getBoundingClientRect = function () { return rect(this === target ? layout : { x: 0, y: 0, width: 1024, height: 768 }); };
  window.Element.prototype.getClientRects = function () { return [this.getBoundingClientRect()] as any; };
  document.elementFromPoint = (x, y) => target.isConnected && x >= layout.x && x < layout.x + layout.width && y >= layout.y && y < layout.y + layout.height ? target : document.body;
  window.HTMLElement.prototype.showPopover = () => {};
  window.alert = message => { throw new Error(String(message)); };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0, frameTime = 0;
  Object.defineProperty(window.performance, "now", { value: () => frameTime });
  window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  window.cancelAnimationFrame = id => { frames.delete(id); };
  window.setTimeout = ((callback: () => void) => { queueMicrotask(callback); return 1; }) as typeof window.setTimeout;
  const observers = new Set<MutationObserver>();
  const NativeObserver = window.MutationObserver;
  window.MutationObserver = class extends NativeObserver {
    observe(node: Node, options?: MutationObserverInit) { observers.add(this); super.observe(node, options); }
    disconnect() { observers.delete(this); super.disconnect(); }
  };
  const contentListeners: ((message: any) => any)[] = [];
  const backgroundListeners: ((message: any, sender: any) => any)[] = [];
  const contentMessages: any[] = [];
  const sourceMessages: any[] = [];
  const screenshots: Frame[] = [], screenshotTimes: number[] = [], crops: Frame[] = [];
  const saved: Record<string, any> = { freezePage };
  let now = 10_000, decodes = 0;
  let api: Harness;
  let resolveSelection!: () => void;
  const selectionFinished = new Promise<void>(resolve => { resolveSelection = resolve; });
  const contentMessage = async (message: any) => {
    contentMessages.push(message);
    for (const listener of contentListeners) {
      const response = listener(message);
      if (response !== undefined) return await response;
    }
  };
  const backgroundMessage = async (message: any, sender: any) => {
    for (const listener of backgroundListeners) {
      const response = listener(message, sender);
      if (response !== undefined) return await response;
    }
  };
  const extensionUrl = "moz-extension://capture-test/";
  const sourceSender = { tab: { id: 1 }, frameId: 0, url: document.URL };
  const contentBrowser = { runtime: {
    onMessage: { addListener: (listener: typeof contentListeners[number]) => contentListeners.push(listener) },
    sendMessage: async (message: any) => {
      sourceMessages.push(message);
      try { return await backgroundMessage(message, sourceSender); }
      finally { if (message.type === "selection-ready") resolveSelection(); }
    },
  } };
  const noopEvent = { addListener() {} };
  const backgroundBrowser = {
    runtime: { onMessage: { addListener: (listener: typeof backgroundListeners[number]) => backgroundListeners.push(listener) }, onStartup: noopEvent, onInstalled: noopEvent, getURL: (path: string) => extensionUrl + path },
    alarms: { create() {}, onAlarm: noopEvent }, commands: { onCommand: noopEvent },
    scripting: { executeScript: async () => [] },
    storage: { local: {
      get: async (key: string) => ({ [key]: saved[key] }),
      set: async (values: Record<string, unknown>) => { Object.assign(saved, values); },
    } },
    tabs: {
      get: async () => ({ id: 1, windowId: 1, active: true, url: document.URL }),
      sendMessage: async (_id: number, message: any) => {
        try { return await contentMessage(message); }
        catch (error) { throw new Error(error && typeof error === "object" && "message" in error ? String(error.message) : String(error)); }
      },
      onRemoved: noopEvent,
      captureVisibleTab: async () => {
        const frame = { text: target.textContent!, x: layout.x };
        screenshots.push(frame); screenshotTimes.push(now);
        await hooks.capture?.(screenshots.length, api);
        return `data:image/png;base64,${Buffer.from(JSON.stringify(frame)).toString("base64")}`;
      },
    },
    windows: { create: async () => ({}) },
  };
  Object.assign(window, { __captureTestBrowser: contentBrowser, visualViewport: null });
  window.HTMLImageElement.prototype.decode = async function () { await hooks.decode?.(++decodes, api); };
  window.eval(contentCode!);
  class ClockDate extends Date { static now() { return now; } }
  class Canvas {
    getContext() { return { drawImage: (bitmap: { frame: Frame }) => { crops.push(bitmap.frame); } }; }
    async convertToBlob() { return new Blob([Buffer.from(PNG, "base64")], { type: "image/png" }); }
  }
  vm.runInNewContext(backgroundCode!, {
    __captureTestBrowser: backgroundBrowser, crypto: webcrypto, Date: ClockDate, Error, URL, Blob, Uint8Array,
    atob, btoa, OffscreenCanvas: Canvas,
    createImageBitmap: async (blob: Blob) => ({ width: 1024, height: 768, frame: JSON.parse(await blob.text()), close() {} }),
    setInterval() {}, clearTimeout() {},
    setTimeout(callback: () => void, delay: number) {
      // Discovery retries are unrelated long-lived timers. Capture spacing advances virtual time.
      if (delay <= 600) { now += delay; queueMicrotask(callback); }
      return 1;
    },
  });
  api = {
    dom, window, document, target, layout, screenshots, screenshotTimes, crops, observers, frames, contentMessages, sourceMessages,
    start: () => backgroundMessage({ type: "start", tabId: 1, mode: "element" }, { url: extensionUrl + "ui.html" }),
    contentMessage,
    pumpFrame(elapsed) { frameTime += elapsed; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(frameTime); },
    async select(x = layout.x + 5) {
      for (const type of ["pointerdown", "pointerup"]) window.dispatchEvent(new window.MouseEvent(type, { clientX: x, clientY: layout.y + 5, button: 0, bubbles: true, cancelable: true }));
      await selectionFinished;
      return Object.values(saved.previews as Record<string, { capture: Capture }>)[0]!.capture;
    },
    escape() { return window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", cancelable: true })); },
    close() { dom.window.close(); },
  };
  return api;
}

for (const phase of ["capture", "decode"] as const) test(`a ${phase}-interval update retries with matching new pixels, DOM and geometry`, { timeout: 5_000 }, async () => {
  const state = await harness({ [phase]: (attempt: number, page: Harness) => {
    if (attempt !== 1) return;
    page.target.textContent = "Updated label";
    page.document.title = "Updated title";
    page.layout.x = 150;
  } });
  try {
    const started = await state.start();
    assert.equal(started.ok, true, started.error);
    assert.equal(state.screenshots.length, 2);
    assert.ok(state.screenshotTimes[1]! - state.screenshotTimes[0]! >= 600);
    assert.equal(state.observers.size, 0);
    assert.equal(state.frames.size, 0);
    // Updates after acceptance must not invalidate the immutable selection or metadata.
    state.target.remove(); state.document.body.textContent = "Later live replacement"; state.document.title = "Later title";
    const capture = await state.select(155);
    assert.match(capture.dom.text, /Updated label/);
    assert.doesNotMatch(capture.dom.text, /Original label|Later live/);
    assert.equal(capture.page.title, "Updated title");
    assert.equal(capture.page.locator, "#target");
    assert.equal(capture.page.rect.x, 150);
    assert.deepEqual(state.crops, [{ text: "Updated label", x: 150 }]);
    assert.equal(state.document.querySelector("#__pi_browser_capture_overlay__"), null);
  } finally { state.close(); }
});

test("a mutation that reverts during decode still discards the first image and snapshot", { timeout: 5_000 }, async () => {
  const state = await harness({ decode(attempt, page) {
    if (attempt !== 1) return;
    page.target.firstChild!.textContent = "Temporary change";
    page.target.firstChild!.textContent = "Original label";
  } });
  try {
    assert.equal((await state.start()).ok, true);
    assert.equal(state.screenshots.length, 2);
    assert.equal(state.observers.size, 0);
    await state.select();
  } finally { state.close(); }
});

for (const transient of [false, true]) test(`CSS-only layout changes${transient ? " that revert after a sampled frame" : " during decoding"} retry`, { timeout: 5_000 }, async () => {
  const state = await harness({ decode(attempt, page) {
    if (attempt !== 1) return;
    page.layout.x = 150;
    if (transient) { page.pumpFrame(200); page.layout.x = 20; }
  } });
  try {
    assert.equal((await state.start()).ok, true);
    assert.equal(state.screenshots.length, 2);
    const capture = await state.select();
    assert.equal(capture.page.rect.x, transient ? 20 : 150);
  } finally { state.close(); }
});

test("the final consistency check detects CSS-only movement just after a periodic sample", { timeout: 5_000 }, async () => {
  const state = await harness({ decode(attempt, page) {
    if (attempt !== 1) return;
    page.pumpFrame(200);
    page.pumpFrame(16);
    page.layout.x = 150;
  } });
  try {
    assert.equal((await state.start()).ok, true);
    assert.equal(state.screenshots.length, 2);
    const capture = await state.select();
    assert.equal(capture.page.rect.x, 150);
    assert.deepEqual(state.crops, [{ text: "Original label", x: 150 }]);
  } finally { state.close(); }
});

test("a continuously changing page fails after three spaced attempts without a mask or observer leak", { timeout: 5_000 }, async () => {
  const state = await harness({ decode(attempt, page) { page.target.textContent = `Changing ${attempt}`; } });
  try {
    assert.match((await state.start()).error, /页面持续变化/);
    assert.equal(state.screenshots.length, 3);
    for (let i = 1; i < 3; i++) assert.ok(state.screenshotTimes[i]! - state.screenshotTimes[i - 1]! >= 600);
    assert.equal(state.observers.size, 0);
    assert.equal(state.frames.size, 0);
    assert.equal(state.document.querySelector("#__pi_browser_capture_overlay__"), null);
    assert.equal(state.escape(), true);
  } finally { state.close(); }
});

test("Escape during decode cancels preparation and stale responses cannot replace a newer freeze", { timeout: 5_000 }, async () => {
  let entered!: () => void, resume!: () => void;
  const decoding = new Promise<void>(resolve => { entered = resolve; });
  const pause = new Promise<void>(resolve => { resume = resolve; });
  const state = await harness({ async decode(attempt) { if (attempt === 1) { entered(); await pause; } } });
  try {
    const first = state.start();
    await decoding;
    const stale = state.contentMessages.find(message => message.type === "accept-freeze");
    assert.equal(state.escape(), false);
    assert.equal(state.observers.size, 0);
    assert.equal(state.frames.size, 0);
    assert.equal((await state.start()).ok, true);
    const overlay = state.document.querySelector("#__pi_browser_capture_overlay__");
    assert.ok(overlay);
    resume();
    assert.match((await first).error, /取消/);
    assert.equal((await state.contentMessage(stale)).stale, true);
    assert.equal(state.document.querySelector("#__pi_browser_capture_overlay__"), overlay);
    await state.select();
  } finally { resume(); state.close(); }
});

test("accepted freeze still dismisses normally with Escape", { timeout: 5_000 }, async () => {
  const state = await harness();
  try {
    assert.equal((await state.start()).ok, true);
    assert.equal(state.escape(), false);
    assert.equal(state.document.querySelector("#__pi_browser_capture_overlay__"), null);
    assert.equal(state.observers.size, 0);
    assert.equal(state.frames.size, 0);
    assert.equal((await state.start()).ok, true);
    await state.select();
  } finally { state.close(); }
});

test("image decoding failures release the preparation without exposing a selection mask", { timeout: 5_000 }, async () => {
  const state = await harness({ decode() { throw new Error("Decode failed"); } });
  try {
    assert.match((await state.start()).error, /Decode failed/);
    assert.equal(state.screenshots.length, 1);
    assert.equal(state.document.querySelector("#__pi_browser_capture_overlay__"), null);
    assert.equal(state.observers.size, 0);
    assert.equal(state.frames.size, 0);
    assert.equal(state.escape(), true);
  } finally { state.close(); }
});

test("non-freeze selection still captures only after the live selection", { timeout: 5_000 }, async () => {
  const state = await harness({}, false);
  try {
    assert.equal((await state.start()).ok, true);
    assert.equal(state.screenshots.length, 0);
    state.target.textContent = "Live label";
    const capture = await state.select();
    assert.equal(state.screenshots.length, 1);
    assert.match(capture.dom.text, /Live label/);
    assert.deepEqual(state.crops, [{ text: "Live label", x: 20 }]);
    assert.equal(state.observers.size, 0);
  } finally { state.close(); }
});
