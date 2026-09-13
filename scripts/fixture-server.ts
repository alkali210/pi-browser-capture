// Local-only manual QA harness. Uses an isolated Pi runtime and synthetic credentials.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, SessionManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

const root = resolve("output/playwright/qa-agent");
mkdirSync(join(root, "browser-capture"), { recursive: true });
writeFileSync(join(root, "browser-capture/pairing-token"), "1".repeat(64));
process.env.PI_CODING_AGENT_DIR = root;
const settingsManager = SettingsManager.inMemory({ packages: [resolve(".")] });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader: loader, modelRuntime: runtime, model: runtime.getModels().find(m => m.input.includes("image")), sessionManager: SessionManager.inMemory(root), noTools: "all" });
let draft = "请保留这段已有草稿。", status = "";
const ui = new Proxy({ getEditorText: () => draft, setEditorText: (value: string) => { draft = value; writeFileSync(resolve("output/playwright/qa-draft.txt"), value); }, setStatus: (_key: string, value?: string) => { status = value ?? ""; }, notify: (value: string) => console.log(value) }, { get(target, prop) { return (target as any)[prop] ?? (() => {}); } }) as unknown as ExtensionUIContext;
await session.bindExtensions({ mode: "tui", uiContext: ui });
const fixture = `<!doctype html><html><meta charset="utf-8"><title>Capture QA · Product card</title><style>body{font:16px system-ui;background:#eef2ed;margin:0;padding:60px;color:#244534}h1{font-size:36px}article{background:white;border-radius:18px;padding:30px;width:460px;box-shadow:0 10px 35px #24453412}button{padding:12px 22px;background:#285f46;color:white;border:0;border-radius:8px}.hidden{display:none}iframe{width:300px;height:80px;border:1px solid #ccc}.spacer{height:1000px}</style><h1>Build something thoughtful.</h1><article id="product-card"><h2>Workspace essentials</h2><p>A calm place to plan, capture, and create.</p><button id="action">Explore collection</button><input type="password" value="SYNTHETIC_PASSWORD"><input type="hidden" value="SYNTHETIC_HIDDEN"><span class="hidden">HIDDEN_TEXT</span></article><p id="outside">This paragraph is outside the card.</p><custom-card></custom-card><iframe src="/frame"></iframe><div class="spacer"></div><script>localStorage.setItem('qa-token','SYNTHETIC_LOGIN_VALUE');sessionStorage.setItem('qa-session','SYNTHETIC_SESSION_VALUE');document.querySelector('custom-card').attachShadow({mode:'open'}).innerHTML='<div style="padding:16px">Open shadow content</div>';</script></html>`;
const server = createServer(async (req, res) => {
  if (req.url === "/state") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ draft, status })); return; }
  if (req.url === "/submit") {
    const result = await session.extensionRunner.emitInput(draft, undefined, "interactive");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result.action === "transform" ? { action: result.action, imageCount: result.images?.length, text: result.text } : result)); return;
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Set-Cookie", "qa-session=SYNTHETIC_HTTPONLY; HttpOnly; SameSite=Lax; Path=/");
  res.end(req.url === "/frame" ? "<html><body><strong>Same-origin frame content</strong></body></html>" : fixture);
});
server.listen(4173, "127.0.0.1", () => console.log(`QA fixture: http://127.0.0.1:4173 · ${status}`));
async function close() { server.close(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); process.exit(0); }
process.on("SIGINT", close); process.on("SIGTERM", close);
