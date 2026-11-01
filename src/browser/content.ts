import browser from "webextension-polyfill";
import { collectDom, freezeDom, locator } from "./dom.js";
import { clipRect, type Rect } from "../shared/protocol.js";

const scope = globalThis as typeof globalThis & { __piCaptureLoaded?: boolean };
if (!scope.__piCaptureLoaded) {
  scope.__piCaptureLoaded = true;
  let cancel: (() => void) | undefined;
  let generation = 0;
  let verification: { key: string; selectionKey: string; geometry: string; element?: Element; box?: string; observer?: MutationObserver; changed: boolean } | undefined;
  const geometry = () => JSON.stringify([location.href, innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio, visualViewport?.scale ?? 1, visualViewport?.offsetLeft ?? 0, visualViewport?.offsetTop ?? 0, visualViewport?.width ?? innerWidth, visualViewport?.height ?? innerHeight]);
  const elementBox = (el: Element) => { const r = el.getBoundingClientRect(); return JSON.stringify([r.x, r.y, r.width, r.height]); };
  const pageState = () => ({ url: location.href, title: document.title.slice(0, 4096), capturedAt: new Date().toISOString(), viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, scroll: { x: scrollX, y: scrollY } });
  type Preparation = {
    key: string; selectionKey: string; generation: number; mode: "region" | "element";
    frozen: ReturnType<typeof freezeDom>; geometry: string; page: ReturnType<typeof pageState>;
    changed: () => boolean; stop: () => void;
  };
  let preparation: Preparation | undefined;
  let selectionKey: string | undefined;
  const clearPreparation = () => { preparation?.stop(); preparation = undefined; };
  const clearVerification = () => { verification?.observer?.disconnect(); verification = undefined; };
  const cancelSelection = () => { generation++; cancel?.(); clearPreparation(); clearVerification(); selectionKey = undefined; };
  window.addEventListener("keydown", event => {
    if (!selectionKey || cancel || event.key !== "Escape") return;
    event.preventDefault(); event.stopImmediatePropagation();
    const key = selectionKey;
    cancelSelection();
    void browser.runtime.sendMessage({ type: "selection-cancelled", selectionKey: key }).catch(() => {});
  }, true);
  browser.runtime.onMessage.addListener((message: any) => {
    if (message.type === "verify-selection") {
      const state = verification;
      if (state?.observer?.takeRecords().length) state.changed = true;
      return Promise.resolve({ valid: !!state && state.key === message.key && state.selectionKey === message.selectionKey && !state.changed && state.geometry === geometry() && (!state.element || (state.element.isConnected && state.box === elementBox(state.element))) });
    }
    if (message.type === "release-selection") {
      if (verification?.key === message.key) { clearVerification(); cancel?.(); selectionKey = undefined; }
      return Promise.resolve({ ok: true });
    }
    if (message.type === "cancel-selection") {
      if (!message.selectionKey || message.selectionKey === selectionKey) cancelSelection();
      return Promise.resolve({ ok: true });
    }
    if (message.type === "prepare-selection") {
      cancelSelection();
      selectionKey = message.selectionKey;
      prepare(message.key, message.selectionKey, message.mode === "element" ? "element" : "region");
      return Promise.resolve({ prepared: true, key: message.key });
    }
    if (message.type === "accept-freeze") return acceptFreeze(message);
    if (message.type !== "start-selection") return;
    cancelSelection();
    selectionKey = message.selectionKey;
    return start(message.mode === "element" ? "element" : "region", generation, message.selectionKey).then(() => ({ ok: true }));
  });
  function prepare(key: string, requestKey: string, mode: "region" | "element") {
    let changed = false, stopped = false, frame = 0;
    const markChanged = () => { changed = true; };
    const observer = new MutationObserver(markChanged);
    const removers: (() => void)[] = [];
    const stop = () => {
      stopped = true; observer.disconnect(); cancelAnimationFrame(frame);
      for (const remove of removers) remove();
    };
    const listen = (target: EventTarget, event: string, handler: EventListener) => {
      target.addEventListener(event, handler, true);
      removers.push(() => target.removeEventListener(event, handler, true));
    };
    const watchRoot = (root: Document | ShadowRoot) => {
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      if (root.nodeType === Node.DOCUMENT_NODE) {
        const view = (root as Document).defaultView;
        if (view) {
          for (const event of ["resize", "scroll", "pagehide", "hashchange", "popstate"]) listen(view, event, markChanged);
          if (view.visualViewport) for (const event of ["resize", "scroll"]) listen(view.visualViewport, event, markChanged);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) watchRoot(element.shadowRoot);
        if (element.tagName === "IFRAME") {
          try { const doc = (element as HTMLIFrameElement).contentDocument; if (doc) watchRoot(doc); }
          catch { /* Cross-origin frames have no observable DOM. */ }
        }
      }
    };
    try {
      // Start tracking before reading any snapshot state, including accessible nested trees.
      watchRoot(document);
      const initialGeometry = geometry(), page = pageState();
      const frozen = freezeDom(document, mode === "element");
      const state: Preparation = { key, selectionKey: requestKey, generation, mode, frozen, geometry: initialGeometry, page, changed: () => { if (observer.takeRecords().length) changed = true; return changed; }, stop };
      preparation = state;
      // Sample CSS-only changes without rebuilding the DOM on every animation frame.
      // The post-decode check remains unconditional, even just after a periodic sample.
      let lastLayoutCheck = performance.now();
      const watchLayout = (now: number) => {
        if (stopped || changed) return;
        if (now - lastLayoutCheck >= 200) {
          try { if (geometry() !== initialGeometry || !frozen.matches(freezeDom(document, false))) changed = true; }
          catch { changed = true; }
          lastLayoutCheck = performance.now();
        }
        if (!changed) frame = requestAnimationFrame(watchLayout);
      };
      frame = requestAnimationFrame(watchLayout);
    } catch (error) { stop(); throw error; }
  }
  async function acceptFreeze(message: { key: string; selectionKey: string; frame: string }) {
    const state = preparation;
    if (!state || state.key !== message.key || state.selectionKey !== message.selectionKey) return { valid: false, stale: true };
    try {
      const image = document.createElement("img");
      image.src = message.frame;
      await image.decode();
      if (preparation !== state || state.generation !== generation) return { valid: false, stale: true };
      if (state.changed() || state.geometry !== geometry() || !state.frozen.matches(freezeDom(document, false))) {
        clearPreparation();
        return { valid: false };
      }
      // Only the original pre-capture snapshot is retained. Later page updates are irrelevant.
      clearPreparation();
      await start(state.mode, state.generation, state.selectionKey, { ...state, image });
      return { valid: true, key: state.key };
    } catch (error) {
      if (preparation === state) clearPreparation();
      throw error;
    }
  }
  async function start(mode: "region" | "element", selectionGeneration: number, requestKey: string, accepted?: Preparation & { image: HTMLImageElement }) {
    if (selectionGeneration !== generation) return;
    const frozen = accepted?.frozen;
    const initialGeometry = accepted?.geometry ?? geometry();
    const initialPage = accepted?.page;
    const host = document.createElement("div");
    host.id = "__pi_browser_capture_overlay__";
    host.style.cssText = "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;z-index:2147483647;pointer-events:none";
    host.setAttribute("popover", "manual");
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>:host{all:initial}.box{position:fixed;border:2px solid #73e2c1;background:#73e2c122;box-sizing:border-box;box-shadow:0 0 0 99999px #08131b55;display:none}.hint{position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:12px 20px;background:#102522;color:#e8fff7;border:1px solid #508674;border-radius:12px;font:14px system-ui;box-shadow:0 8px 30px #0005}</style><div class="box"></div><div class="hint">${mode === "region" ? "拖动框选页面区域" : "悬停高亮，点击选取元素"} · Esc 取消</div>`;
    if (accepted) {
      accepted.image.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none";
      root.prepend(accepted.image);
    }
    document.documentElement.append(host);
    try { host.showPopover(); } catch (error) { host.remove(); throw error; }
    const box = root.querySelector<HTMLElement>(".box")!;
    let startPoint: { x: number; y: number } | undefined, selected: Element | undefined, frozenTarget: { rect: Rect; locator: string } | undefined, busy = false, closed = false;
    let rect: Rect | undefined;
    const show = (r: Rect) => { rect = clipRect(r, innerWidth, innerHeight); Object.assign(box.style, { display: "block", left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }); };
    const swallow = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
    const move = (e: PointerEvent) => {
      swallow(e);
      if (busy) return;
      if (mode === "region") { if (startPoint) show({ x: Math.min(e.clientX, startPoint.x), y: Math.min(e.clientY, startPoint.y), width: Math.abs(e.clientX - startPoint.x), height: Math.abs(e.clientY - startPoint.y) }); }
      else if (frozen) {
        frozenTarget = frozen.hitTest(e.clientX, e.clientY);
        if (frozenTarget) show(frozenTarget.rect);
        else { rect = undefined; box.style.display = "none"; }
      } else {
        let el = document.elementFromPoint(e.clientX, e.clientY);
        while (el?.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(e.clientX, e.clientY); if (!inner || inner === el) break; el = inner; }
        if (el && el !== host) { selected = el; show(el.getBoundingClientRect()); }
      }
    };
    const down = (e: PointerEvent) => { swallow(e); if (e.button !== 0) return; startPoint = { x: e.clientX, y: e.clientY }; if (mode === "element") move(e); };
    const up = (e: PointerEvent) => { swallow(e); if (e.button !== 0 || !startPoint || !rect || rect.width < 2 || rect.height < 2 || busy) return; busy = true; void finish(rect, selected); };
    const key = (e: KeyboardEvent) => { swallow(e); if (e.key === "Escape") { cleanup(); clearVerification(); selectionKey = undefined; void browser.runtime.sendMessage({ type: "selection-cancelled", selectionKey: requestKey }).catch(() => {}); } };
    const listeners: [string, EventListener][] = [["pointermove", move as EventListener], ["pointerdown", down as EventListener], ["pointerup", up as EventListener], ["click", swallow], ["dblclick", swallow], ["contextmenu", swallow], ["wheel", swallow], ["keydown", key as EventListener]];
    for (const [event, handler] of listeners) window.addEventListener(event, handler, { capture: true, passive: false });
    const cleanup = () => { closed = true; host.remove(); for (const [event, handler] of listeners) window.removeEventListener(event, handler, true); window.removeEventListener("pagehide", cleanup); if (cancel === cleanup) cancel = undefined; };
    window.addEventListener("pagehide", cleanup, { once: true });
    cancel = cleanup;
    async function finish(r: Rect, element?: Element) {
      const selectionGeometry = frozen ? initialGeometry : geometry();
      const initialBox = element ? elementBox(element) : undefined;
      // Live captures remove the overlay; frozen captures crop the saved image instead.
      if (!frozen) {
        host.style.display = "none";
        await new Promise(resolve => setTimeout(resolve, 80));
        if (closed) return;
        cleanup();
      }
      if (selectionGeometry !== geometry() || (element && (!element.isConnected || initialBox !== elementBox(element)))) {
        cleanup();
        if (selectionKey === requestKey) selectionKey = undefined;
        void browser.runtime.sendMessage({ type: "selection-cancelled", selectionKey: requestKey }).catch(() => {});
        alert("Pi Browser Capture：页面或选区已变化，请重新选取。");
        return;
      }
      const key = crypto.randomUUID();
      const observer = frozen ? undefined : new MutationObserver(() => { if (verification?.key === key) verification.changed = true; });
      verification = { key, selectionKey: requestKey, geometry: selectionGeometry, element, box: element ? elementBox(element) : undefined, observer, changed: false };
      observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const page = { ...(initialPage ?? pageState()), rect: r, mode, locator: frozenTarget?.locator ?? (element ? locator(element) : undefined) };
      const dom = frozen ? frozen.collect(r) : collectDom(document, r);
      try {
        const response = await browser.runtime.sendMessage({ type: "selection-ready", selectionKey: requestKey, key, page, dom }) as { error?: string };
        if (response?.error) throw new Error(response.error);
      } catch (error) { alert(`Pi Browser Capture：${error instanceof Error ? error.message : error}`); }
      finally { if (verification?.key === key) clearVerification(); cleanup(); if (selectionKey === requestKey) selectionKey = undefined; }
    }
  }
}
