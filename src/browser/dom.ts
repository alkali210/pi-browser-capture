import { MAX_DOM_CHARS, MAX_NODES, type DomSnapshot, type Rect } from "../shared/protocol.js";

const intersect = (a: Rect, b: Rect) => a.width > 0 && a.height > 0 && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const excluded = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);

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

export function collectDom(doc: Document, selection: Rect): DomSnapshot {
  let visited = 0, included = 0, chars = 0, truncated = false;
  const notices = new Set<string>();
  const texts: string[] = [];
  const budget = (s: string) => {
    const left = MAX_DOM_CHARS - chars;
    if (s.length > left) truncated = true;
    const result = s.slice(0, Math.max(0, left));
    chars += result.length;
    return result;
  };
  const visit = (el: Element, region: Rect, depth: number): string => {
    if (++visited > 10_000 || included >= MAX_NODES || depth > 60 || chars >= MAX_DOM_CHARS) { truncated = true; return ""; }
    if (excluded.has(el.tagName) || el.id === "__pi_browser_capture_overlay__" || el.hasAttribute("hidden") || el.getAttribute("type")?.toLowerCase() === "hidden") return "";
    const view = el.ownerDocument.defaultView;
    if (!view) return "";
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return "";
    const box = el.getBoundingClientRect();
    const hit = [...el.getClientRects()].some(r => intersect(r, region));
    const parts: string[] = [];
    // Client rects alone do not account for overflow clipping by ancestors.
    const childRegion = { ...region };
    if (["hidden", "clip", "scroll", "auto"].includes(style.overflowX)) {
      childRegion.x = Math.max(region.x, box.x);
      childRegion.width = Math.max(0, Math.min(region.x + region.width, box.x + box.width) - childRegion.x);
    }
    if (["hidden", "clip", "scroll", "auto"].includes(style.overflowY)) {
      childRegion.y = Math.max(region.y, box.y);
      childRegion.height = Math.max(0, Math.min(region.y + region.height, box.y + box.height) - childRegion.y);
    }
    const password = el.tagName === "INPUT" && el.getAttribute("type")?.toLowerCase() === "password";
    if (!password && el.tagName !== "TEXTAREA") for (const node of el.childNodes) {
      if (chars >= MAX_DOM_CHARS || included >= MAX_NODES || visited > 10_000) { truncated = true; break; }
      if (node.nodeType === 1) parts.push(visit(node as Element, childRegion, depth + 1));
      else if (node.nodeType === 3 && node.textContent?.trim()) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(node);
        const rects = typeof range.getClientRects === "function" ? [...range.getClientRects()] : [box];
        if (rects.some(r => intersect(r, childRegion))) {
          const text = node.textContent.replace(/\s+/g, " ");
          const encoded = budget(escape(text));
          texts.push(text.slice(0, encoded.length));
          parts.push(encoded);
        }
        range.detach();
      }
    }
    if (el.shadowRoot) {
      const shadow = [...el.shadowRoot.children].map(child => visit(child, childRegion, depth + 1)).join("");
      if (shadow) parts.push(`<shadow-root>${shadow}</shadow-root>`);
    } else if (el.localName.includes("-") && hit) notices.add("自定义元素若使用封闭 Shadow DOM，只能采集外层元素与截图。");
    if (el.tagName === "IFRAME" && hit) {
      try {
        const frame = el as HTMLIFrameElement;
        const inner = frame.contentDocument;
        if (!inner?.documentElement) throw new Error("Unavailable frame");
        const sx = box.width / (frame.offsetWidth || box.width), sy = box.height / (frame.offsetHeight || box.height);
        const x = box.x + frame.clientLeft * sx, y = box.y + frame.clientTop * sy;
        const left = Math.max(region.x, x), top = Math.max(region.y, y);
        const right = Math.min(region.x + region.width, x + frame.clientWidth * sx), bottom = Math.min(region.y + region.height, y + frame.clientHeight * sy);
        parts.push(`<frame-document>${visit(inner.documentElement, { x: (left - x) / sx, y: (top - y) / sy, width: Math.max(0, right - left) / sx, height: Math.max(0, bottom - top) / sy }, depth + 1)}</frame-document>`);
      } catch { notices.add("选区包含跨域或不可访问 iframe；仅保留外层信息与截图。"); }
    }
    const children = parts.join("");
    if (!hit && !children) return "";
    included++;
    const attributes = [...el.attributes].filter(a => ["id", "class", "role", "alt", "title", "type", "name", "href", "src", "data-testid"].includes(a.name) || a.name.startsWith("aria-")).map(a => {
      let value = a.value.slice(0, 1000);
      if (["href", "src"].includes(a.name)) { try { const url = new URL(value, el.ownerDocument.baseURI); if (!["http:", "https:"].includes(url.protocol)) return ""; value = url.href; } catch { return ""; } }
      return ` ${a.name}="${escape(value)}"`;
    }).join("");
    return `${budget(`<${el.localName}${attributes}>`)}${children}${budget(`</${el.localName}>`)}`;
  };
  const html = visit(doc.documentElement, selection, 0);
  if (truncated) notices.add(`DOM 已按 ${MAX_NODES} 个节点 / ${MAX_DOM_CHARS} 字符上限截断。`);
  return { html: html.slice(0, MAX_DOM_CHARS), text: texts.join(" ").slice(0, MAX_DOM_CHARS), truncated: truncated || html.length > MAX_DOM_CHARS, warnings: [...notices] };
}
