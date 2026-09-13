import browser from "webextension-polyfill";
import { FIRST_PORT, LAST_PORT, VERSION, MAX_STATE_CHARS, pixelRect, validateCapture, validateSession, type Capture, type LoginState, type SessionInfo, type ServerMessage } from "../shared/protocol.js";

declare const __FIREFOX__: boolean;
interface Peer { socket: WebSocket; session?: SessionInfo; lastSeen: number }
interface Preview { capture: Capture; tabId: number; createdAt: number }
const peers = new Map<number, Peer>();
const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const selecting = new Set<number>();
let scanning: Promise<void> | undefined;
let retryDelay = 1000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const PREVIEWS = "previews";
const previewTTL = 30 * 60_000;
// Serialize storage read-modify-write operations across multiple review windows.
let storageQueue = Promise.resolve();
function storageTask<T>(task: () => Promise<T>): Promise<T> {
  const result = storageQueue.then(task);
  storageQueue = result.then(() => {}, () => {});
  return result;
}
async function previews(): Promise<Record<string, Preview>> {
  const saved = (await browser.storage.local.get(PREVIEWS))[PREVIEWS] ?? {};
  return Object.fromEntries(Object.entries(saved as Record<string, Preview>).filter(([, p]) => Date.now() - p.createdAt < previewTTL));
}
async function setPreview(preview: Preview) {
  await storageTask(async () => {
    const all = await previews();
    all[preview.capture.id] = preview;
    const entries = Object.entries(all).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 3);
    while (entries.length > 1 && JSON.stringify(Object.fromEntries(entries)).length > 8_000_000) entries.pop();
    if (JSON.stringify(Object.fromEntries(entries)).length > 8_000_000) throw new Error("选区附件过大，请缩小选区后重试。");
    await browser.storage.local.set({ [PREVIEWS]: Object.fromEntries(entries) });
  });
}
async function deletePreview(id: string) {
  await storageTask(async () => { const all = await previews(); delete all[id]; await browser.storage.local.set({ [PREVIEWS]: all }); });
}

function scheduleScan() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = undefined; void scan(); }, retryDelay);
  retryDelay = Math.min(30_000, retryDelay * 2);
}
async function scan(): Promise<void> {
  if (scanning) return scanning;
  scanning = (async () => {
    const { token } = await browser.storage.local.get("token");
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return;
    await Promise.all(Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i).map(port => new Promise<void>(resolve => {
      if (peers.has(port)) { resolve(); return; }
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      const peer: Peer = { socket, lastSeen: Date.now() };
      peers.set(port, peer);
      const timer = setTimeout(() => { if (!peer.session) socket.close(); resolve(); }, 1800);
      socket.onopen = () => socket.send(JSON.stringify({ type: "hello", version: VERSION, token }));
      socket.onerror = () => { clearTimeout(timer); resolve(); };
      socket.onclose = () => {
        clearTimeout(timer);
        if (peers.get(port) === peer) peers.delete(port);
        for (const [key, pending] of waiting) if (key.startsWith(`${port}:`)) { clearTimeout(pending.timer); pending.reject(new Error("连接中断，内容保留，可重试。")); waiting.delete(key); }
        resolve(); scheduleScan();
      };
      socket.onmessage = event => {
        try {
          const msg = JSON.parse(event.data) as ServerMessage;
          peer.lastSeen = Date.now();
          if (msg.type === "welcome") {
            if (msg.version !== VERSION) { socket.close(); return; }
            validateSession(msg.session);
            peer.session = msg.session; clearTimeout(timer); retryDelay = 1000; resolve();
          } else if (msg.type === "session") { validateSession(msg.session); peer.session = msg.session; }
          else if (msg.type === "ack" || (msg.type === "error" && msg.id)) {
            const key = `${port}:${msg.id}`, pending = waiting.get(key);
            if (pending) { clearTimeout(pending.timer); waiting.delete(key); if (msg.type === "ack") pending.resolve(); else pending.reject(new Error(msg.message)); }
          }
        } catch { socket.close(); }
      };
    })));
  })().finally(() => { scanning = undefined; scheduleScan(); });
  return scanning;
}
setInterval(() => {
  for (const peer of peers.values()) {
    if (Date.now() - peer.lastSeen > 45_000) peer.socket.close();
    else if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify({ type: "ping" }));
  }
}, 20_000);
browser.alarms.create("pi-discovery", { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(() => { void scan(); void storageTask(async () => { await browser.storage.local.set({ [PREVIEWS]: await previews() }); }); });
browser.runtime.onStartup.addListener(() => { void scan(); });
browser.runtime.onInstalled.addListener(() => { void scan(); });
void scan();

async function startSelection(tabId: number, mode: "region" | "element") {
  const tab = await browser.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//.test(tab.url)) throw new Error("此页面不允许选取，请打开普通 HTTP / HTTPS 网页。");
  await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  selecting.add(tabId);
  try { await browser.tabs.sendMessage(tabId, { type: "start-selection", mode }); }
  catch (error) { selecting.delete(tabId); throw error; }
}
browser.commands.onCommand.addListener(async command => {
  if (command !== "capture-region") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) try { await startSelection(tab.id, "region"); }
  catch (error) { await browser.windows.create({ url: browser.runtime.getURL(`ui.html?error=${encodeURIComponent(error instanceof Error ? error.message : "无法选取此页面")}`), type: "popup", width: 520, height: 640 }); }
});
browser.tabs.onRemoved.addListener(id => selecting.delete(id));

async function cropPng(dataUrl: string, capture: Pick<Capture, "page">): Promise<string> {
  const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  try {
    if (bitmap.width * bitmap.height > 64_000_000) throw new Error("截图尺寸过大，请缩小浏览器窗口后重试。");
    const rect = pixelRect(capture.page.rect, capture.page.viewport, bitmap);
    const canvas = new OffscreenCanvas(rect.width, rect.height);
    const context = canvas.getContext("2d");
    if (!context || rect.width < 1 || rect.height < 1) throw new Error("选区为空");
    context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const result = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let i = 0; i < result.length; i += 8192) binary += String.fromCharCode(...result.subarray(i, i + 8192));
    return btoa(binary);
  } finally { bitmap.close(); }
}
async function captureSelection(message: any, tabId: number) {
  if (!selecting.delete(tabId)) throw new Error("选取已过期，请重新开始。");
  const tab = await browser.tabs.get(tabId);
  const verify = async () => {
    const current = await browser.tabs.get(tabId);
    const checked = await browser.tabs.sendMessage(tabId, { type: "verify-selection", key: message.key }) as { valid?: boolean };
    if (!current.active || current.url !== message.page?.url || !checked?.valid) throw new Error("页面或选区已变化，请重新选取。");
  };
  try {
    await verify();
    const full = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    await verify();
    const capture: Capture = { id: crypto.randomUUID(), page: message.page, dom: message.dom, png: "", prompt: "" };
    capture.png = await cropPng(full, capture);
    validateCapture(capture);
    await setPreview({ capture, tabId, createdAt: Date.now() });
    await browser.windows.create({ url: browser.runtime.getURL(`ui.html?capture=${capture.id}`), type: "popup", width: 540, height: 790 });
    return { ok: true };
  } finally { await browser.tabs.sendMessage(tabId, { type: "release-selection" }).catch(() => {}); }
}

async function loginState(preview: Preview): Promise<LoginState> {
  const tab = await browser.tabs.get(preview.tabId);
  if (tab.url !== preview.capture.page.url) throw new Error("源页面已跳转，无法附加登录状态，请重新选取。");
  const origin = new URL(tab.url).origin;
  if (!await browser.permissions.contains({ permissions: ["cookies"], origins: [`${origin}/*`] })) throw new Error("请先勾选携带登录状态并允许当前站点权限。");
  const results = await browser.scripting.executeScript({ target: { tabId: preview.tabId }, func: () => {
    const warnings: string[] = [];
    const read = (name: "localStorage" | "sessionStorage") => {
      const result: Record<string, string> = Object.create(null);
      try { const s = window[name]; for (let i = 0; i < s.length; i++) { const key = s.key(i); if (key !== null) result[key] = s.getItem(key) ?? ""; } }
      catch { warnings.push(`${name} 无法读取`); }
      return result;
    };
    return { origin: location.origin, url: location.href, localStorage: read("localStorage"), sessionStorage: read("sessionStorage"), warnings };
  } });
  const result = results[0]?.result as { origin: string; url: string; localStorage: Record<string, string>; sessionStorage: Record<string, string>; warnings: string[] } | undefined;
  if (!result || result.origin !== origin || result.url !== preview.capture.page.url) throw new Error("源页面已变化，无法读取登录状态。");
  // Match the source tab's cookie store (Firefox containers / private windows included).
  const stores = await browser.cookies.getAllCookieStores();
  const store = stores.find(s => s.tabIds.includes(preview.tabId));
  if (!store) throw new Error("无法确定源标签页的 Cookie store。");
  const query: any = { url: tab.url, storeId: store.id };
  const warnings = result.warnings;
  let cookies: browser.Cookies.Cookie[] = [];
  try { cookies = await browser.cookies.getAll(query); }
  catch { warnings.push("浏览器隔离策略阻止 Cookie 读取；未跨 first-party domain 查询，仍保留可访问的 Storage。"); }
  let partitioned: any[] = [];
  try {
    if (__FIREFOX__) {
      partitioned = await browser.cookies.getAll({ ...query, partitionKey: { topLevelSite: origin, hasCrossSiteAncestor: false } } as any);
    } else {
      const cookiesApi = (globalThis as any).chrome.cookies;
      if (cookiesApi.getPartitionKey) {
        const { partitionKey } = await cookiesApi.getPartitionKey({ tabId: preview.tabId, frameId: 0 });
        partitioned = await cookiesApi.getAll({ ...query, partitionKey });
      } else warnings.push("此 Chromium 版本无法精确查询分区 Cookie；仅包含普通 Cookie。");
    }
  } catch { warnings.push("分区 Cookie 不可用；仅包含已读取的 Cookie。"); }
  const merged = new Map([...cookies, ...partitioned].map(c => [JSON.stringify([c.name, c.domain, c.path, c.storeId, c.partitionKey, c.firstPartyDomain]), c]));
  const state: LoginState = { origin, capturedAt: new Date().toISOString(), cookies: [...merged.values()] as unknown as Record<string, unknown>[], localStorage: result.localStorage, sessionStorage: result.sessionStorage, warnings };
  if (JSON.stringify(state).length > MAX_STATE_CHARS) throw new Error("登录状态超过 2 MB，请取消附加登录状态后重试。");
  if ((await browser.tabs.get(preview.tabId)).url !== tab.url) throw new Error("读取期间源页面发生跳转，请重新采集。");
  return state;
}

async function sendCapture(message: any) {
  const preview = (await previews())[message.id];
  if (!preview) throw new Error("预览已过期，请重新选取。");
  const pair = [...peers.entries()].find(([, p]) => p.session && `${p.session.instanceId}:${p.session.sessionId}` === message.target);
  if (!pair || pair[1].socket.readyState !== WebSocket.OPEN) throw new Error("目标会话已断开或切换，请重新选择。");
  const [port, peer] = pair;
  const session = { ...peer.session! };
  const capture = { ...preview.capture, prompt: message.prompt };
  if (message.includeLogin === true) capture.login = await loginState(preview);
  validateCapture(capture);
  if (peer.session?.instanceId !== session.instanceId || peer.session?.sessionId !== session.sessionId || peer.socket.readyState !== WebSocket.OPEN) throw new Error("目标会话已变化，请重新选择。");
  const key = `${port}:${capture.id}`;
  if (waiting.has(key)) throw new Error("此附件正在发送，请稍候。");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(key); reject(new Error("确认超时，内容保留，可安全重试。")); }, 12_000);
    waiting.set(key, { resolve, reject, timer });
    try { peer.socket.send(JSON.stringify({ type: "capture", version: VERSION, instanceId: session.instanceId, sessionId: session.sessionId, capture })); }
    catch (error) { clearTimeout(timer); waiting.delete(key); reject(error); }
  });
  await deletePreview(capture.id);
  return { ok: true };
}

browser.runtime.onMessage.addListener((message: any, sender: browser.Runtime.MessageSender) => {
  if (message?.type === "selection-ready" && sender.tab?.id && sender.frameId === 0) return captureSelection(message, sender.tab.id).catch(error => ({ error: error.message }));
  if (!sender.url?.startsWith(browser.runtime.getURL(""))) return;
  return (async () => {
    switch (message?.type) {
      case "status": {
        void scan();
        const { token } = await browser.storage.local.get("token");
        return { paired: !!token, sessions: [...peers.values()].flatMap(p => p.session ? [p.session] : []) };
      }
      case "pair": {
        if (typeof message.token !== "string" || !/^[a-f0-9]{64}$/.test(message.token.trim())) throw new Error("请输入 pi 中显示的 64 位配对令牌。");
        await browser.storage.local.set({ token: message.token.trim() });
        for (const peer of peers.values()) peer.socket.close();
        peers.clear();
        await scanning;
        await scan();
        return { ok: true };
      }
      case "start": await startSelection(message.tabId, message.mode); return { ok: true };
      case "preview": return { preview: (await previews())[message.id] };
      case "discard": await deletePreview(message.id); return { ok: true };
      case "send": return await sendCapture(message);
      default: throw new Error("Unknown request");
    }
  })().catch(error => ({ error: error instanceof Error ? error.message : "操作失败" }));
});
