import browser from "webextension-polyfill";
import type { Capture, SessionInfo } from "../shared/protocol.js";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const captureId = params.get("capture");
let capture: Capture | undefined;
let sending = false, finished = false;
const target = $<HTMLSelectElement>("target");
const login = $<HTMLInputElement>("login");
function message(text: string, error = false) { const el = $("message"); el.textContent = text; el.classList.toggle("error", error); }
async function request(data: Record<string, unknown>): Promise<any> {
  const result: any = await browser.runtime.sendMessage(data);
  if (result?.error) throw new Error(result.error);
  return result;
}
function fail(error: unknown) { message(error instanceof Error ? error.message : String(error), true); }
async function refresh() {
  const state = await request({ type: "status" });
  const sessions = state.sessions as SessionInfo[];
  $("connection").textContent = sessions.length ? `${sessions.length} 个会话在线` : "等待 Pi";
  $("connection").classList.toggle("online", sessions.length > 0);
  if (!state.paired) $<HTMLDetailsElement>("pair-panel").open = true;
  const selected = target.value;
  const previous = target.dataset.sessions;
  const serialized = JSON.stringify(sessions);
  if (previous !== serialized) {
    target.replaceChildren();
    const placeholder = new Option(sessions.length ? "选择目标 Pi 会话" : "未发现会话，请启动 Pi 并配对", "");
    target.add(placeholder);
    for (const s of sessions) target.add(new Option(`${s.name} · ${s.cwd} · ${s.busy ? "运行中" : "空闲"} · ${s.sessionId.slice(0, 8)}`, `${s.instanceId}:${s.sessionId}`));
    if (sessions.some(s => `${s.instanceId}:${s.sessionId}` === selected)) target.value = selected;
    // Auto-select a single session only on the initial discovery, never after a selected session disappears.
    else if (!target.dataset.everSelected && sessions.length === 1) target.selectedIndex = 1;
    if (target.value) target.dataset.everSelected = "true";
    target.dataset.sessions = serialized;
  }
  $<HTMLButtonElement>("send").disabled = !capture || !target.value || sending || finished;
}
target.addEventListener("change", () => { if (target.value) target.dataset.everSelected = "true"; void refresh().catch(fail); });
$("pair").addEventListener("click", async () => {
  const button = $<HTMLButtonElement>("pair"); button.disabled = true;
  try {
    await request({ type: "pair", token: $<HTMLInputElement>("token").value });
    $<HTMLInputElement>("token").value = "";
    message("令牌已保存，正在发现 Pi 会话。");
    await refresh();
    if (target.options.length > 1) $<HTMLDetailsElement>("pair-panel").open = false;
  } catch (error) { fail(error); } finally { button.disabled = false; }
});
for (const mode of ["region", "element"]) $(mode).addEventListener("click", async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("未找到当前标签页。");
    await request({ type: "start", tabId: tab.id, mode });
    window.close();
  } catch (error) { fail(error); }
});
login.addEventListener("change", async () => {
  if (!login.checked || !capture) return;
  try {
    // Request from the checkbox's user gesture, before any asynchronous work.
    const granted = await browser.permissions.request({ permissions: ["cookies"], origins: [`${new URL(capture.page.url).origin}/*`] });
    if (!granted) { login.checked = false; message("未授权登录状态读取；仍可发送截图和 DOM。"); }
  } catch (error) { login.checked = false; fail(error); }
});
$("send").addEventListener("click", async () => {
  if (sending || !capture) return;
  sending = true;
  $<HTMLButtonElement>("send").disabled = true;
  $<HTMLButtonElement>("discard").disabled = true;
  login.disabled = true; target.disabled = true;
  message("正在添加到 Pi 草稿…");
  try {
    await request({ type: "send", id: capture.id, target: target.value, prompt: $<HTMLTextAreaElement>("prompt").value, includeLogin: login.checked });
    finished = true;
    $("review").hidden = true; $("success").hidden = false; $("pair-panel").hidden = true;
    message("");
  } catch (error) { fail(error); }
  finally { sending = false; login.disabled = false; target.disabled = false; $<HTMLButtonElement>("discard").disabled = false; await refresh().catch(fail); }
});
$("discard").addEventListener("click", async () => { try { await request({ type: "discard", id: captureId }); window.close(); } catch (error) { fail(error); } });
$("close").addEventListener("click", () => window.close());
async function init() {
  if (params.has("error")) message(params.get("error")!, true);
  if (captureId) {
    $("intro").hidden = true; $("selection").hidden = true;
    const { preview } = await request({ type: "preview", id: captureId });
    if (!preview) throw new Error("预览已过期或已发送。请回到网页重新选取。");
    capture = preview.capture;
    const c = capture!;
    $("review").hidden = false;
    $<HTMLImageElement>("screenshot").src = `data:image/png;base64,${c.png}`;
    $("page-title").textContent = c.page.title || "未命名页面";
    $("page-url").textContent = c.page.url;
    $("dimensions").textContent = `${Math.round(c.page.rect.width)} × ${Math.round(c.page.rect.height)} CSS px · ${c.page.mode === "element" ? "元素点选" : "矩形框选"}`;
    $("dom").textContent = c.dom.html;
    $("warnings").textContent = c.dom.warnings.join("\n") || "已采集选区范围内的可访问 DOM。";
  }
  await refresh();
}
void init().catch(fail);
setInterval(() => { void refresh().catch(fail); }, 2000);
