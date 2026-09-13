export const VERSION = 1;
export const FIRST_PORT = 43821;
export const LAST_PORT = 43852;
export const MAX_WIRE_BYTES = 20 * 1024 * 1024;
export const MAX_DOM_CHARS = 60_000;
export const MAX_NODES = 1500;
export const MAX_STATE_CHARS = 2_000_000;

export interface Rect { x: number; y: number; width: number; height: number }
export interface PageInfo {
  url: string; title: string; capturedAt: string;
  viewport: { width: number; height: number; dpr: number };
  scroll: { x: number; y: number };
  rect: Rect; mode: "region" | "element"; locator?: string;
}
export interface DomSnapshot { html: string; text: string; truncated: boolean; warnings: string[] }
export interface LoginState {
  origin: string; capturedAt: string;
  cookies: Record<string, unknown>[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  warnings: string[];
}
export interface Capture {
  id: string; page: PageInfo; dom: DomSnapshot;
  png: string; prompt: string; login?: LoginState;
}
export interface SessionInfo { instanceId: string; sessionId: string; name: string; cwd: string; busy: boolean }
export type ClientMessage =
  | { type: "hello"; version: 1; token: string }
  | { type: "ping" }
  | { type: "capture"; version: 1; instanceId: string; sessionId: string; capture: Capture };
export type ServerMessage =
  | { type: "welcome"; version: 1; session: SessionInfo }
  | { type: "session"; session: SessionInfo }
  | { type: "pong" }
  | { type: "ack"; id: string; duplicate: boolean }
  | { type: "error"; id?: string; code: string; message: string };

export const isId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const warnings = (v: unknown): boolean => Array.isArray(v) && v.length <= 100 && v.every(x => str(x, 2000));
const strings = (v: unknown): boolean => record(v) && Object.entries(v).every(([k, x]) => str(k, 10_000) && str(x, MAX_STATE_CHARS));

export function validateSession(value: unknown): asserts value is SessionInfo {
  if (!record(value) || !isId(value.instanceId) || !isId(value.sessionId) || !str(value.name, 4096) || !str(value.cwd, 16_384) || typeof value.busy !== "boolean") throw new Error("Invalid session advertisement");
}

export function validateCapture(value: unknown): asserts value is Capture {
  const c = value;
  if (!record(c) || !isId(c.id) || !str(c.prompt, 20_000) || !record(c.page) || !record(c.dom)) throw new Error("Invalid capture envelope");
  const p = c.page;
  if (!str(p.url, 16_384) || !/^https?:\/\//.test(p.url) || !str(p.title, 4096) || !str(p.capturedAt, 64) || !Number.isFinite(Date.parse(p.capturedAt))) throw new Error("Invalid page metadata");
  const v = p.viewport, r = p.rect, s = p.scroll;
  if (!record(v) || !record(r) || !record(s) || ![v.width,v.height,v.dpr,r.x,r.y,r.width,r.height,s.x,s.y].every(finite) || v.width <= 0 || v.height <= 0 || v.dpr <= 0 || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 || r.x + r.width > v.width + 1 || r.y + r.height > v.height + 1) throw new Error("Invalid capture geometry");
  if (!["region", "element"].includes(p.mode) || (p.locator !== undefined && !str(p.locator, 4096))) throw new Error("Invalid selection mode");
  if (!str(c.dom.html, MAX_DOM_CHARS) || !str(c.dom.text, MAX_DOM_CHARS) || typeof c.dom.truncated !== "boolean" || !warnings(c.dom.warnings)) throw new Error("Invalid DOM snapshot");
  if (!str(c.png, 16_000_000) || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(c.png) || c.png.length % 4 !== 0) throw new Error("Invalid PNG attachment");
  if (c.login !== undefined) {
    const l = c.login;
    if (!record(l) || l.origin !== new URL(p.url).origin || !str(l.capturedAt, 64) || !Number.isFinite(Date.parse(l.capturedAt)) || !Array.isArray(l.cookies) || !l.cookies.every(record) || !strings(l.localStorage) || !strings(l.sessionStorage) || !warnings(l.warnings) || JSON.stringify(l).length > MAX_STATE_CHARS) throw new Error("Invalid login state");
  }
}

export function clipRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, rect.x));
  const y = Math.max(0, Math.min(height, rect.y));
  return { x, y, width: Math.max(0, Math.min(width, rect.x + rect.width) - x), height: Math.max(0, Math.min(height, rect.y + rect.height) - y) };
}
export function pixelRect(rect: Rect, viewport: { width: number; height: number }, image: { width: number; height: number }): Rect {
  const sx = image.width / viewport.width, sy = image.height / viewport.height;
  const x = Math.floor(rect.x * sx), y = Math.floor(rect.y * sy);
  return { x, y, width: Math.min(image.width, Math.ceil((rect.x + rect.width) * sx)) - x, height: Math.min(image.height, Math.ceil((rect.y + rect.height) * sy)) - y };
}
export const marker = (id: string) => `[pi-browser-capture:${id}]`;
export const markerPattern = () => /\[pi-browser-capture:([0-9a-f-]{36})\]/gi;
export const safeText = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
