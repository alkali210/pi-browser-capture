import browser from "webextension-polyfill";
import { collectDom, locator } from "./dom.js";
import { clipRect, type Rect } from "../shared/protocol.js";

const scope = globalThis as typeof globalThis & { __piCaptureLoaded?: boolean };
if (!scope.__piCaptureLoaded) {
  scope.__piCaptureLoaded = true;
  let cancel: (() => void) | undefined;
  let verification: { key: string; geometry: string; element?: Element; box?: string; observer: MutationObserver; changed: boolean } | undefined;
  const geometry = () => JSON.stringify([location.href, innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio, visualViewport?.scale ?? 1, visualViewport?.offsetLeft ?? 0, visualViewport?.offsetTop ?? 0]);
  const elementBox = (el: Element) => { const r = el.getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height]); };
  const clearVerification = () => { verification?.observer.disconnect(); verification = undefined; };
  browser.runtime.onMessage.addListener((message: any) => {
    if (message.type === "verify-selection") {
      const state = verification;
      if (state?.observer.takeRecords().length) state.changed = true;
      return Promise.resolve({ valid: !!state && state.key === message.key && !state.changed && state.geometry === geometry() && (!state.element || (state.element.isConnected && state.box === elementBox(state.element))) });
    }
    if (message.type === "release-selection") { clearVerification(); return Promise.resolve({ ok: true }); }
    if (message.type !== "start-selection") return;
    cancel?.(); clearVerification();
    start(message.mode === "element" ? "element" : "region");
    return Promise.resolve({ ok: true });
  });
  function start(mode: "region" | "element") {
    const host = document.createElement("div");
    host.id = "__pi_browser_capture_overlay__";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>:host{all:initial}.box{position:fixed;border:2px solid #73e2c1;background:#73e2c122;box-sizing:border-box;box-shadow:0 0 0 99999px #08131b55;display:none}.hint{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:12px 20px;background:#102522;color:#e8fff7;border:1px solid #508674;border-radius:12px;font:14px system-ui;box-shadow:0 8px 30px #0005}</style><div class="box"></div><div class="hint">${mode === "region" ? "拖动框选页面区域" : "悬停高亮，点击选取元素"} · Esc 取消</div>`;
    document.documentElement.append(host);
    const box = root.querySelector<HTMLElement>(".box")!;
    let startPoint: { x: number; y: number } | undefined, selected: Element | undefined, busy = false;
    let rect: Rect | undefined;
    const show = (r: Rect) => { rect = clipRect(r, innerWidth, innerHeight); Object.assign(box.style, { display: "block", left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }); };
    const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const move = (e: PointerEvent) => {
      swallow(e);
      if (busy) return;
      if (mode === "region") { if (startPoint) show({ x: Math.min(e.clientX, startPoint.x), y: Math.min(e.clientY, startPoint.y), width: Math.abs(e.clientX - startPoint.x), height: Math.abs(e.clientY - startPoint.y) }); }
      else {
        let el = document.elementFromPoint(e.clientX, e.clientY);
        while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(e.clientX, e.clientY); if (!inner || inner === el) break; el = inner; }
        if (el && el !== host) { selected = el; show(el.getBoundingClientRect()); }
      }
    };
    const down = (e: PointerEvent) => { swallow(e); if (e.button !== 0) return; startPoint = { x: e.clientX, y: e.clientY }; if (mode === "element") move(e); };
    const up = (e: PointerEvent) => { swallow(e); if (e.button !== 0 || !startPoint || !rect || rect.width < 2 || rect.height < 2 || busy) return; busy = true; void finish(rect, selected); };
    const key = (e: KeyboardEvent) => { swallow(e); if (e.key === "Escape") cleanup(); };
    const listeners: [string, EventListener][] = [["pointermove", move as EventListener], ["pointerdown", down as EventListener], ["pointerup", up as EventListener], ["click", swallow], ["dblclick", swallow], ["contextmenu", swallow], ["wheel", swallow], ["keydown", key as EventListener]];
    for (const [event, handler] of listeners) window.addEventListener(event, handler, { capture: true, passive: false });
    const cleanup = () => { host.remove(); for (const [event, handler] of listeners) window.removeEventListener(event, handler, true); cancel = undefined; };
    cancel = cleanup;
    async function finish(r: Rect, element?: Element) {
      const initialGeometry = geometry();
      const initialBox = element ? elementBox(element) : undefined;
      // Retain click interception through pointerup/click, then remove overlay before capture.
      host.style.display = "none";
      await new Promise(resolve => setTimeout(resolve, 80));
      cleanup();
      if (initialGeometry !== geometry() || (element && (!element.isConnected || initialBox !== elementBox(element)))) {
        alert("Pi Browser Capture：页面或选区已变化，请重新选取。");
        return;
      }
      const key = crypto.randomUUID();
      const observer = new MutationObserver(() => { if (verification?.key === key) verification.changed = true; });
      verification = { key, geometry: geometry(), element, box: element ? elementBox(element) : undefined, observer, changed: false };
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const page = { url: location.href, title: document.title.slice(0, 4096), capturedAt: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, scroll: { x: scrollX, y: scrollY }, rect: r, mode, locator: element ? locator(element) : undefined };
      const dom = collectDom(document, r);
      try {
        const response = await browser.runtime.sendMessage({ type: "selection-ready", key, page, dom }) as { error?: string };
        if (response?.error) throw new Error(response.error);
      } catch (error) { alert(`Pi Browser Capture：${error instanceof Error ? error.message : error}`); }
      finally { clearVerification(); }
    }
  }
}
