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
      await bridge.start();
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
    description: "Browser capture: pair / list attachments / delete [id|all] / status",
    getArgumentCompletions: prefix => {
      const commands = [
        { value: "pair", label: "pair", description: "Show browser pairing token" },
        { value: "list", label: "list", description: "List attachments for current session" },
        { value: "delete", label: "delete", description: "Delete attachments: delete [UUID|all] (defaults to current session, all for everything)" },
        { value: "status", label: "status", description: "Show connection port and attachment directory" },
      ];
      const matches = commands.filter(item => item.value.startsWith(prefix));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      if (!args.trim() && ctx.mode === "tui") {
        ctx.ui.setEditorText("/browser-capture ");
        return;
      }
      if (!bridge || !store) { ctx.ui.notify("Browser capture is only enabled in local interactive terminal sessions.", "warning"); return; }
      const [command = "status", id] = args.trim().split(/\s+/).filter(Boolean);
      if (command === "pair") { await ctx.ui.select(`Paste this token into the browser extension pairing dialog:\n${store.token()}`, ["Close"]); return; }
      if (command === "list") {
        const entries = store.list(ctx.sessionManager.getSessionId());
        await ctx.ui.select("Current session web attachments", entries.length ? entries.map(s => `${s.id} · ${safeText(s.capture.page.title)} · ${s.directory}`) : ["No attachments"]);
        return;
      }
      if (command === "delete") {
        if (!id) {
          store.removeSession(ctx.sessionManager.getSessionId());
          ctx.ui.setEditorText(ctx.ui.getEditorText().replace(markerPattern(), ""));
          refreshWidget();
          ctx.ui.notify("Attachments for current session cleared.", "info");
          return;
        }
        if (id.toLowerCase() === "all") {
          store.removeAll();
          ctx.ui.setEditorText(ctx.ui.getEditorText().replace(markerPattern(), ""));
          refreshWidget();
          ctx.ui.notify("All session attachments cleared.", "info");
          return;
        }
        if (!isId(id)) { ctx.ui.notify("Usage: /browser-capture delete [UUID|all]", "warning"); return; }
        store.remove(ctx.sessionManager.getSessionId(), id);
        ctx.ui.setEditorText(ctx.ui.getEditorText().replaceAll(`[pi-browser-capture:${id}]`, ""));
        refreshWidget();
        ctx.ui.notify("Attachment deleted.", "info");
        return;
      }
      ctx.ui.notify(`Listening on 127.0.0.1:${bridge.port}\nSession ${ctx.sessionManager.getSessionId()}\nAttachment directory ${store.root}\nFirst time: /browser-capture pair`, "info");
    }
  });
}
