import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import WebSocket from "ws";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CaptureStore } from "../src/pi/store.js";
import { capture, PNG } from "./helpers.js";

test("Pi 0.84.2 discovers the package, appends drafts, merges images and survives reload", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir; rmSync(root, { recursive: true, force: true }); });
  const settingsManager = SettingsManager.inMemory({ packages: [resolve(".")] });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0);
  assert.equal(loader.getExtensions().extensions.length, 1, "package manifest must auto-discover the built extension");
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  const model = runtime.getModels().find(m => m.input.includes("image"));
  assert.ok(model, "bundled vision model available offline");
  const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime: runtime, model, sessionManager: SessionManager.inMemory(root), noTools: "all" });
  let draft = "已有草稿", status = "";
  const errors: string[] = [];
  const ui = new Proxy({ getEditorText: () => draft, setEditorText: (value: string) => { draft = value; }, setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify: (value: string, level: string) => { if (level === "error") errors.push(value); } }, { get(target, prop) { return (target as any)[prop] ?? (() => {}); } }) as unknown as ExtensionUIContext;
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: error => errors.push(JSON.stringify(error)) });
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
  assert.deepEqual(errors, []);
  const port = Number(status.match(/:(\d+)/)?.[1]); assert.ok(port >= 43821);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `chrome-extension://${"b".repeat(32)}` }); t.after(() => ws.terminate());
  await once(ws, "open");
  let response = once(ws, "message"); ws.send(JSON.stringify({ type: "hello", version: 1, token: new CaptureStore(join(root, "browser-capture")).token() }));
  const welcome = JSON.parse((await response)[0].toString());
  const c = capture(); response = once(ws, "message"); ws.send(JSON.stringify({ type: "capture", version: 1, instanceId: welcome.session.instanceId, sessionId: welcome.session.sessionId, capture: c }));
  assert.equal(JSON.parse((await response)[0].toString()).type, "ack");
  assert.ok(draft.startsWith("已有草稿\n\n")); assert.ok(draft.includes(c.id));
  for (const behavior of [undefined, "steer", "followUp"] as const) {
    const result = await session.extensionRunner.emitInput(draft, [{ type: "image", mimeType: "image/png", data: PNG }], "interactive", behavior);
    assert.equal(result.action, "transform");
    if (result.action === "transform") { assert.equal(result.images?.length, 2); assert.ok(result.text.includes("<browser-capture")); }
  }
  assert.equal((await session.extensionRunner.emitInput("无标记", undefined, "interactive")).action, "continue");
  await session.reload();
  assert.deepEqual(errors, []); assert.ok(status.includes("浏览器"));
});
