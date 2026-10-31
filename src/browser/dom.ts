import { MAX_DOM_CHARS, MAX_NODES, type DomSnapshot, type Rect } from "../shared/protocol.js";

const intersect = (a: Rect, b: Rect) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0 && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
const clippedOverflow = new Set(["hidden", "clip", "scroll", "auto"]);
const rect = (r: Rect): Rect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

export function locator(element: Element): string {
  const parts: string[] = [];
  let el: Element | null = element;
  while (el && parts.length < 8) {
    const esc = (s: string) => (el!.ownerDocument.defaultView?.CSS?.escape ?? ((v: string) => v.replace(/[^\w-]/g, "\\$&")))(s);
    if (el.id) { parts.unshift(`#${esc(el.id)}`); break; }
    const parent: Element | null = el.parentElement;
    const siblings: Element[] = parent ? [...parent.children].filter(s => s.tagName === el!.tagName) : [];
    parts.unshift(`${el.localName}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : ""}`);
    if (!parent && (el.getRootNode() as ShadowRoot).host) { parts.unshift("::shadow"); el = (el.getRootNode() as ShadowRoot).host; }
    else el = parent;
  }
  return parts.join(" > ").slice(0, 4096);
}

type TextData = { text: string; rects: Iterable<Rect> };
type Child<T> = { element: T } | TextData;
type FrameData<T> = { root?: T; x: number; y: number; sx: number; sy: number; width: number; height: number };
type ElementData<T> = {
  name: string; box: Rect; rects: Iterable<Rect>; clipX: boolean; clipY: boolean; clipBox?: Rect;
  attributes: string; children: Iterable<Child<T>>; shadow?: Iterable<T>; custom: boolean;
  frame?: FrameData<T>;
  z: number; stacking: boolean; pickable: boolean; positioned: boolean; phase: number; atomic: boolean; paintStyle: string;
};
type Reader<T> = (element: T) => ElementData<T> | undefined;

function attributes(el: Element): string {
  return [...el.attributes].filter(a => ["id", "class", "role", "alt", "title", "type", "name", "href", "src", "data-testid"].includes(a.name) || a.name.startsWith("aria-")).map(a => {
    let value = a.value.slice(0, 1000);
    if (["href", "src"].includes(a.name)) { try { const url = new URL(value, el.ownerDocument.baseURI); if (!["http:", "https:"].includes(url.protocol)) return ""; value = url.href; } catch { return ""; } }
    return ` ${a.name}="${escape(value)}"`;
  }).join("");
}

// Both live and frozen captures use the same visibility, privacy and serialization rules.
function readElement(el: Element, snapshot = false): ElementData<Element> | undefined {
  if (excluded.has(el.tagName) || el.id === "__pi_browser_capture_overlay__" || el.hasAttribute("hidden") || el.getAttribute("type")?.toLowerCase() === "hidden") return;
  const view = el.ownerDocument.defaultView;
  if (!view) return;
  const style = view.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return;
  const box = rect(el.getBoundingClientRect());
  const doc = el.ownerDocument;
  let clipBox: Rect | undefined;
  const rootStyle = el === doc.body ? view.getComputedStyle(doc.documentElement) : undefined;
  // Root overflow, and body overflow propagated through a visible root, clip the viewport.
  // Their border boxes may have zero height when the app is absolutely positioned.
  if (el === doc.documentElement || (rootStyle && ["", "visible"].includes(rootStyle.overflowX) && ["", "visible"].includes(rootStyle.overflowY))) {
    clipBox = { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
  }
  const password = el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "password";
  function* children(): IterableIterator<Child<Element>> {
    if (password || el.tagName === "TEXTAREA") return;
    for (const node of el.childNodes) {
      if (node.nodeType === 1) yield { element: node as Element };
      else if (node.nodeType === 3 && node.textContent?.trim()) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(node);
        const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()] : [box];
        range.detach();
        yield { text: node.textContent, rects };
      }
    }
  }
  let frame: FrameData<Element> | undefined;
  if (el.tagName === "IFRAME") {
    const iframe = el as HTMLIFrameElement;
    const sx = box.width / (iframe.offsetWidth || box.width || 1), sy = box.height / (iframe.offsetHeight || box.height || 1);
    frame = { x: box.x + iframe.clientLeft * sx, y: box.y + iframe.clientTop * sy, sx, sy, width: iframe.clientWidth * sx, height: iframe.clientHeight * sy };
    try { frame.root = iframe.contentDocument?.documentElement; } catch { /* Cross-origin frames have no accessible tree. */ }
  }
  const z = Number.parseInt(style.zIndex, 10);
  const positioned = ["absolute", "relative", "fixed", "sticky"].includes(style.position);
  const floating = style.cssFloat !== "" && style.cssFloat !== "none";
  const inline = style.display.startsWith("inline") || ["contents", "ruby"].includes(style.display);
  return {
    name: el.localName, box, rects: el.getClientRects(), clipX: clippedOverflow.has(style.overflowX), clipY: clippedOverflow.has(style.overflowY), clipBox,
    attributes: snapshot ? "" : attributes(el), children: children(), shadow: el.shadowRoot?.children, custom: el.localName.includes("-"), frame,
    z: Number.isFinite(z) ? z : 0,
    pickable: style.pointerEvents !== "none",
    stacking: (Number.isFinite(z) && positioned) || ["fixed", "sticky"].includes(style.position) || (style.opacity !== "" && Number(style.opacity) < 1) || (style.transform !== "" && style.transform !== "none") || style.isolation === "isolate",
    positioned, phase: floating ? 3 : inline ? 4 : 2,
    atomic: floating || ["inline-block", "inline-table", "inline-flex", "inline-grid"].includes(style.display) || el.tagName === "IFRAME",
    paintStyle: snapshot ? [style.position, style.display, style.cssFloat, style.zIndex, style.opacity, style.visibility, style.transform, style.isolation, style.pointerEvents, style.overflowX, style.overflowY].join("\n") : "",
  };
}

function clip(region: Rect, box: Rect, clipX: boolean, clipY: boolean): Rect {
  const result = { ...region };
  if (clipX) {
    result.x = Math.max(region.x, box.x);
    result.width = Math.max(0, Math.min(region.x + region.width, box.x + box.width) - result.x);
  }
  if (clipY) {
    result.y = Math.max(region.y, box.y);
    result.height = Math.max(0, Math.min(region.y + region.height, box.y + box.height) - result.y);
  }
  return result;
}

function collectTree<T>(root: T | undefined, selection: Rect, read: Reader<T>, incomplete = false): DomSnapshot {
  let visited = 0, included = 0, chars = 0, truncated = incomplete;
  const notices = new Set<string>();
  const texts: string[] = [];
  const budget = (s: string) => {
    const left = MAX_DOM_CHARS - chars;
    if (s.length > left) truncated = true;
    const result = s.slice(0, Math.max(0, left));
    chars += result.length;
    return result;
  };
  const visit = (element: T, region: Rect, depth: number): string => {
    if (++visited > 10_000 || included >= MAX_NODES || depth > 60 || chars >= MAX_DOM_CHARS) { truncated = true; return ""; }
    const el = read(element);
    if (!el) return "";
    const hit = [...el.rects].some(r => intersect(r, region));
    const parts: string[] = [];
    const childRegion = clip(region, el.clipBox ?? el.box, el.clipX, el.clipY);
    for (const child of el.children) {
      if (chars >= MAX_DOM_CHARS || included >= MAX_NODES || visited > 10_000) { truncated = true; break; }
      if ("element" in child) parts.push(visit(child.element, childRegion, depth + 1));
      else if ([...child.rects].some(r => intersect(r, childRegion))) {
        const text = child.text.replace(/\s+/g, " ");
        const encoded = budget(escape(text));
        texts.push(text.slice(0, encoded.length));
        parts.push(encoded);
      }
    }
    if (el.shadow) {
      const shadow: string[] = [];
      for (const child of el.shadow) {
        if (chars >= MAX_DOM_CHARS || included >= MAX_NODES || visited > 10_000) { truncated = true; break; }
        shadow.push(visit(child, childRegion, depth + 1));
      }
      const html = shadow.join("");
      if (html) parts.push(`<shadow-root>${html}</shadow-root>`);
    } else if (el.custom && hit) notices.add("自定义元素若使用封闭 Shadow DOM，只能采集外层元素与截图。");
    if (el.frame && hit) {
      const frame = el.frame;
      if (!frame.root) notices.add("选区包含跨域或不可访问 iframe；仅保留外层信息与截图。");
      else if (frame.sx > 0 && frame.sy > 0) {
        const clipped = clip(region, { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, true, true);
        parts.push(`<frame-document>${visit(frame.root, { x: (clipped.x - frame.x) / frame.sx, y: (clipped.y - frame.y) / frame.sy, width: clipped.width / frame.sx, height: clipped.height / frame.sy }, depth + 1)}</frame-document>`);
      }
    }
    const children = parts.join("");
    if (!hit && !children) return "";
    included++;
    return `${budget(`<${el.name}${el.attributes}>`)}${children}${budget(`</${el.name}>`)}`;
  };
  const html = root ? visit(root, selection, 0) : "";
  if (truncated) notices.add(`DOM 已按 ${MAX_NODES} 个节点 / ${MAX_DOM_CHARS} 字符上限截断。`);
  return { html: html.slice(0, MAX_DOM_CHARS), text: texts.join(" ").slice(0, MAX_DOM_CHARS), truncated: truncated || html.length > MAX_DOM_CHARS, warnings: [...notices] };
}

export function collectDom(doc: Document, selection: Rect): DomSnapshot {
  return collectTree(doc.documentElement, selection, readElement);
}

type FrozenElement = { data: ElementData<FrozenElement> };
type FrozenLocator = { part: string; parent?: FrozenLocator };
type FrozenHit = { rect: Rect; visible: Rect[]; locator: FrozenLocator; paint: number[]; root: boolean };
type Transform = { x: number; y: number; sx: number; sy: number };
type FrozenDom = {
  collect(selection: Rect): DomSnapshot;
  hitTest(x: number, y: number): { rect: Rect; locator: string } | undefined;
  matches(other: FrozenDom): boolean;
};
type FrozenState = { root?: FrozenElement; viewport: Rect; truncated: boolean };
const frozenStates = new WeakMap<FrozenDom, FrozenState>();

// Frozen state contains only owned plain objects, arrays and scalar values.
// Compare it directly rather than serializing large trees or consulting either document.
function sameFrozenValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameFrozenValue(a[i], b[i])) return false;
    return true;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key in left) if (!Object.hasOwn(right, key) || !sameFrozenValue(left[key], right[key])) return false;
  for (const key in right) if (!Object.hasOwn(left, key)) return false;
  return true;
}

// Build the public operations outside the capture scope, so their closures cannot
// retain the source document, element readers or locator caches.
function frozenDom(state: FrozenState, hits: FrozenHit[]): FrozenDom {
  const formatLocator = (path: FrozenLocator): string => {
    const parts: string[] = [];
    for (let current: FrozenLocator | undefined = path; current && parts.length < 8; current = current.parent) parts.unshift(current.part);
    return parts.join(" > ").slice(0, 4096);
  };
  const frozen: FrozenDom = {
    collect: selection => collectTree(state.root, selection, element => element.data, state.truncated),
    matches(other) {
      const otherState = frozenStates.get(other);
      return otherState !== undefined && sameFrozenValue(state, otherState);
    },
    hitTest(x, y) {
      let fallback: FrozenHit | undefined;
      for (let i = hits.length - 1; i >= 0; i--) {
        const hit = hits[i]!;
        if (!hit.visible.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) continue;
        if (hit.root) { fallback ??= hit; continue; }
        return { rect: { ...hit.rect }, locator: formatLocator(hit.locator) };
      }
      return fallback ? { rect: { ...fallback.rect }, locator: formatLocator(fallback.locator) } : undefined;
    },
  };
  frozenStates.set(frozen, state);
  return frozen;
}

/** Snapshot once; returned operations never retain or read the source DOM. */
export function freezeDom(doc: Document, includeHitTest = true): FrozenDom {
  let chars = 0, rectangles = 0, truncated = false, order = 0;
  const hits: FrozenHit[] = [];
  const viewport = { x: 0, y: 0, width: doc.defaultView?.innerWidth ?? 0, height: doc.defaultView?.innerHeight ?? 0 };
  const paths = new WeakMap<Element, FrozenLocator>();
  const siblingParts = new WeakMap<Element, Map<Element, string>>();
  const savedLocator = (element: Element): FrozenLocator => {
    const cached = paths.get(element);
    if (cached) return cached;
    const esc = (s: string) => (element.ownerDocument.defaultView?.CSS?.escape ?? ((v: string) => v.replace(/[^\w-]/g, "\\$&")))(s);
    let path: FrozenLocator;
    if (element.id) path = { part: `#${esc(element.id)}` };
    else if (element.parentElement) {
      const parent = element.parentElement;
      let parts = siblingParts.get(parent);
      if (!parts) {
        parts = new Map();
        const counts = new Map<string, number>(), indices = new Map<string, number>();
        for (const child of parent.children) counts.set(child.localName, (counts.get(child.localName) ?? 0) + 1);
        for (const child of parent.children) {
          const index = (indices.get(child.localName) ?? 0) + 1;
          indices.set(child.localName, index);
          parts.set(child, `${child.localName}${counts.get(child.localName)! > 1 ? `:nth-of-type(${index})` : ""}`);
        }
        siblingParts.set(parent, parts);
      }
      path = { part: parts.get(element)!, parent: savedLocator(parent) };
    } else {
      const host = (element.getRootNode() as ShadowRoot).host;
      path = { part: element.localName, parent: host ? { part: "::shadow", parent: savedLocator(host) } : undefined };
    }
    paths.set(element, path);
    return path;
  };
  // A frozen tree also retains locators and geometry, not just serialized markup.
  const snapshotChars = MAX_DOM_CHARS * 4;
  const store = (value: string) => {
    const remaining = Math.max(0, snapshotChars - chars);
    if (value.length > remaining) truncated = true;
    const result = value.slice(0, remaining);
    chars += result.length;
    return result;
  };
  const copyRects = (source: Iterable<Rect>, transform: Transform, clipping: Rect): Rect[] => {
    const result: Rect[] = [];
    for (const value of source) {
      if (!intersect(transformRect(value, transform), clipping)) continue;
      if (++rectangles > 40_000) { truncated = true; break; }
      result.push(rect(value));
    }
    return result;
  };
  const transformRect = (r: Rect, t: Transform): Rect => ({ x: t.x + r.x * t.sx, y: t.y + r.y * t.sy, width: r.width * t.sx, height: r.height * t.sy });
  const capture = (element: Element, depth: number, transform: Transform, clipping: Rect, stackingPaint: number[], flowPaint: number[]): FrozenElement | undefined => {
    if (depth > 512) { truncated = true; return; }
    if (clipping.width <= 0 || clipping.height <= 0) return;
    const source = readElement(element, true);
    if (!source) return;
    const index = ++order;
    // CSS painting phases: context background, negative contexts, in-flow blocks,
    // floats, inline content, positioned auto/zero, then positive contexts.
    // Auto-positioned/float/inline-block groups contain ordinary descendants, but
    // positioned descendants still participate in the nearest real stacking context.
    const context = !includeHitTest ? flowPaint : source.stacking
      ? [...stackingPaint, source.z < 0 ? 1 : source.z > 0 ? 6 : 5, source.z, index]
      : source.positioned ? [...stackingPaint, 5, 0, index]
      : source.atomic ? [...flowPaint, source.phase, 0, index] : flowPaint;
    const childStacking = source.stacking || source.frame ? context : stackingPaint;
    const children: Child<FrozenElement>[] = [];
    const data: ElementData<FrozenElement> = { ...source, rects: copyRects(source.rects, transform, clipping), children, shadow: undefined, frame: undefined };
    const box = transformRect(source.box, transform);
    const visible = [...data.rects].map(r => clip(transformRect(r, transform), clipping, true, true)).filter(r => r.width > 0 && r.height > 0);
    if (includeHitTest && visible.length && source.pickable) {
      const paint = source.stacking || source.positioned || source.atomic
        ? [...context, 0, 0, index] : [...context, source.phase, 0, index];
      hits.push({ rect: box, visible, locator: savedLocator(element), paint, root: source.name === "html" || source.name === "body" });
    }
    const childClipping = clip(clipping, source.clipBox ? transformRect(source.clipBox, transform) : box, source.clipX, source.clipY);
    for (const child of source.children) {
      if ("element" in child) {
        const frozen = capture(child.element, depth + 1, transform, childClipping, childStacking, context);
        if (frozen) children.push({ element: frozen });
      } else if (chars < snapshotChars) {
        const rects = copyRects(child.rects, transform, childClipping);
        if (rects.length) children.push({ text: store(child.text), rects });
        // A block's background is below floats, but its text is inline foreground.
        if (includeHitTest && rects.length && source.pickable) {
          const visible = rects.map(r => clip(transformRect(r, transform), childClipping, true, true)).filter(r => r.width > 0 && r.height > 0);
          hits.push({ rect: box, visible, locator: savedLocator(element), paint: [...context, 4, 0, ++order], root: false });
        }
      } else truncated = true;
    }
    if (source.shadow) {
      const shadow: FrozenElement[] = [];
      data.shadow = shadow;
      for (const child of source.shadow) {
        const frozen = capture(child, depth + 1, transform, childClipping, childStacking, context);
        if (frozen) shadow.push(frozen);
      }
    }
    if (source.frame) {
      const { root, ...frame } = source.frame;
      data.frame = frame;
      if (root && frame.sx > 0 && frame.sy > 0) {
        const frameBox = transformRect(frame, transform);
        const frameTransform = { x: frameBox.x, y: frameBox.y, sx: transform.sx * frame.sx, sy: transform.sy * frame.sy };
        data.frame.root = capture(root, depth + 1, frameTransform, clip(childClipping, frameBox, true, true), context, context);
      }
    }
    if (!visible.length && !children.length && !data.shadow && !data.frame?.root) return;
    data.attributes = store(attributes(element));
    return { data };
  };
  const root = doc.documentElement ? capture(doc.documentElement, 0, { x: 0, y: 0, sx: 1, sy: 1 }, viewport, [], []) : undefined;
  const comparePaint = (a: FrozenHit, b: FrozenHit) => {
    for (let i = 0; i < Math.min(a.paint.length, b.paint.length); i++) if (a.paint[i] !== b.paint[i]) return a.paint[i]! - b.paint[i]!;
    return a.paint.length - b.paint.length;
  };
  hits.sort(comparePaint);
  return frozenDom({ root, viewport, truncated }, hits);
}
