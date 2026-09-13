import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CaptureStore, defaultRoot, draftAttachment, expandInput } from "./store.js";
import { BridgeServer } from "./server.js";
import { markerPattern, safeText, isId } from "../shared/protocol.js";

export default function browserCapture(pi: ExtensionAPI) {
  let store: CaptureStore;
  let bridge: BridgeServer | undefined;
  let current: ExtensionContext | undefined;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  const refreshWidget = () => {
    if (!current || current.mode !== "tui") return;
    const ids = [...current.ui.getEditorText().matchAll(markerPattern())].map(m => m[1]);
    const unique = [...new Set(ids)];
    current.ui.setWidget("browser-capture", unique.length ? [`网页附件 ${unique.length} 个 · 提交时附加截图 · 删除标记可取消`] : undefined);
  };
  const stop = async () => {
    if (widgetTimer) clearInterval(widgetTimer);
    widgetTimer = undefined;
    current?.ui.setWidget("browser-capture", undefined);
    current?.ui.setStatus("browser-capture", undefined);
    current = undefined;
    const old = bridge;
    bridge = undefined;
    await old?.close();
  };
  pi.on("session_start", async (_event, ctx) => {
    await stop();
    if (ctx.mode !== "tui") return;
    try {
      store = new CaptureStore(defaultRoot());
      current = ctx;
      bridge = new BridgeServer({ store, session: () => ({ sessionId: ctx.sessionManager.getSessionId(), name: safeText(ctx.sessionManager.getSessionName() || "未命名会话"), cwd: ctx.cwd, busy: !ctx.isIdle() }), attach: saved => {
        const existing = ctx.ui.getEditorText();
        ctx.ui.setEditorText(`${existing}${existing ? "\n\n" : ""}${draftAttachment(saved)}\n`);
        refreshWidget();
        ctx.ui.notify("网页选区已添加到草稿，提交时会附加截图。", "info");
      } });
      const port = await bridge.start();
      ctx.ui.setStatus("browser-capture", `浏览器 :${port} · /browser-capture pair`);
      widgetTimer = setInterval(refreshWidget, 1000);
      widgetTimer.unref();
    } catch (error) { await stop(); ctx.ui.notify(`浏览器扩展启动失败：${error instanceof Error ? error.message : error}`, "error"); }
  });
  pi.on("session_shutdown", stop);
  pi.on("session_info_changed", () => bridge?.broadcast());
  pi.on("agent_start", () => bridge?.broadcast());
  pi.on("agent_end", () => bridge?.broadcast());
  pi.on("input", async (event, ctx) => {
    if (ctx.mode !== "tui" || event.source !== "interactive" || !markerPattern().test(event.text)) return { action: "continue" as const };
    try {
      const result = expandInput(store, ctx.sessionManager.getSessionId(), event.text);
      if (result.count && !ctx.model?.input.includes("image")) {
        ctx.ui.notify("当前模型不支持图片，请切换到视觉模型后提交。", "warning");
        ctx.ui.setEditorText(event.text);
        return { action: "handled" as const };
      }
      return { action: "transform" as const, text: result.text, images: [...(event.images ?? []), ...result.images] };
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : "附件读取失败", "error");
      ctx.ui.setEditorText(event.text);
      return { action: "handled" as const };
    }
  });
  pi.registerCommand("browser-capture", {
    description: "浏览器选取：pair 配对 / list 列出当前会话附件 / delete <id> 删除附件 / status 状态",
    handler: async (args, ctx) => {
      if (!bridge || !store) { ctx.ui.notify("浏览器选取仅在本机交互式终端启用。", "warning"); return; }
      const [command = "status", id] = args.trim().split(/\s+/).filter(Boolean);
      if (command === "pair") { await ctx.ui.select(`将此令牌粘贴到浏览器扩展配对框：\n${store.token()}`, ["关闭"]); return; }
      if (command === "list") {
        const entries = store.list(ctx.sessionManager.getSessionId());
        await ctx.ui.select("当前会话网页附件", entries.length ? entries.map(s => `${s.id} · ${safeText(s.capture.page.title)} · ${s.directory}`) : ["暂无附件"]);
        return;
      }
      if (command === "delete") {
        if (!isId(id)) { ctx.ui.notify("用法：/browser-capture delete <完整附件 UUID>", "warning"); return; }
        store.remove(ctx.sessionManager.getSessionId(), id);
        ctx.ui.setEditorText(ctx.ui.getEditorText().replaceAll(`[pi-browser-capture:${id}]`, ""));
        refreshWidget();
        ctx.ui.notify("附件已删除。", "info");
        return;
      }
      ctx.ui.notify(`监听 127.0.0.1:${bridge.port}\n会话 ${ctx.sessionManager.getSessionId()}\n附件目录 ${store.root}\n首次使用：/browser-capture pair`, "info");
    }
  });
}
