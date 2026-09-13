import { randomUUID } from "node:crypto";
import type { Capture } from "../src/shared/protocol.js";
export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5AAAAABJRU5ErkJggg==";
export function capture(): Capture {
  return { id: randomUUID(), png: PNG, prompt: "调整卡片布局", page: { url: "https://example.com/account", title: "Example", capturedAt: new Date().toISOString(), viewport: { width: 1000, height: 800, dpr: 2 }, scroll: { x: 0, y: 50 }, rect: { x: 10, y: 10, width: 100, height: 100 }, mode: "region" }, dom: { html: "<main><h1>Example</h1></main>", text: "Example", truncated: false, warnings: [] } };
}
