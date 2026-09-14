import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect as connectTcp } from "node:net";
import { get } from "node:http";
import WebSocket from "ws";
import { BridgeServer } from "../src/pi/server.js";
import { CaptureStore } from "../src/pi/store.js";
import { capture } from "./helpers.js";

const origin = `chrome-extension://${"a".repeat(32)}`;
function receive(ws: WebSocket): Promise<any> { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Reply timed out")), 2000); ws.once("message", data => { clearTimeout(timer); resolve(JSON.parse(data.toString())); }); }); }
async function connect(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
  await once(ws, "open");
  const reply = receive(ws);
  ws.send(JSON.stringify({ type: "hello", version: 1, token }));
  const welcome = await reply;
  return { ws, welcome };
}

test("shutdown releases incomplete handshakes and connected clients within the host deadline", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-shutdown-"));
  const store = new CaptureStore(root);
  const options = { store, session: () => ({ sessionId: "shutdown", name: "Test", cwd: root, busy: false }), attach: () => {}, ports: [0] };
  const server = new BridgeServer(options);
  const port = await server.start();
  const sockets: Array<{ destroy?: () => void; terminate?: () => void }> = [];
  t.after(async () => {
    for (const socket of sockets) { socket.destroy?.(); socket.terminate?.(); }
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });
  for (const partial of [false, true]) {
    const socket = connectTcp({ host: "127.0.0.1", port });
    sockets.push(socket);
    await once(socket, "connect");
    if (partial) socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
  }
  const { ws } = await connect(port, store.token());
  sockets.push(ws);
  const unauthenticated = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } });
  sockets.push(unauthenticated);
  await once(unauthenticated, "open");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([server.close(), server.close()]),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Shutdown exceeded 1500ms")), 1500); }),
    ]);
  } finally { clearTimeout(timer); }
  const replacement = new BridgeServer({ ...options, ports: [port] });
  try { assert.equal(await replacement.start(), port); }
  finally { await replacement.close(); }
});

test("real WebSockets authenticate, route sessions, acknowledge retries and release ports", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-bridge-"));
  const store = new CaptureStore(root); let sid = randomUUID(), attachments = 0;
  const server = new BridgeServer({ store, session: () => ({ sessionId: sid, name: "Test", cwd: root, busy: false }), attach: () => { attachments++; }, ports: [0] });
  const port = await server.start();
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  const { ws, welcome } = await connect(port, store.token()); t.after(() => ws.terminate());
  assert.equal(welcome.session.sessionId, sid);
  const c = capture(), payload = { type: "capture", version: 1, instanceId: welcome.session.instanceId, sessionId: sid, capture: c };
  let reply = receive(ws); ws.send(JSON.stringify(payload)); assert.equal((await reply).duplicate, false);
  reply = receive(ws); ws.send(JSON.stringify(payload)); assert.equal((await reply).duplicate, true);
  assert.equal(attachments, 1);
  sid = randomUUID();
  reply = receive(ws); ws.send(JSON.stringify({ ...payload, capture: capture() })); assert.equal((await reply).code, "SESSION_CHANGED");
  assert.equal(attachments, 1);
  reply = receive(ws); ws.send(JSON.stringify({ type: "capture", version: 1, instanceId: welcome.session.instanceId, sessionId: sid, capture: { ...capture(), id: "../../escape" } })); assert.equal((await reply).code, "INVALID_CAPTURE");
  await server.close();
  const replacement = new BridgeServer({ store, session: () => ({ sessionId: sid, name: "New", cwd: root, busy: false }), attach: () => {}, ports: [port] });
  assert.equal(await replacement.start(), port); await replacement.close();
});
test("rejects ordinary web origins, invalid credentials and incompatible versions", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-auth-")); const store = new CaptureStore(root);
  const server = new BridgeServer({ store, session: () => ({ sessionId: randomUUID(), name: "Auth", cwd: root, busy: false }), attach: () => {}, ports: [0] });
  const port = await server.start();
  t.after(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); });
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = get(`http://127.0.0.1:${port}`, { headers: {
      Origin: "https://example.com", Connection: "Upgrade", Upgrade: "websocket",
      "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject);
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error("Disallowed origin was accepted")); });
  });
  assert.equal(status, 401);
  for (const hello of [{ type: "hello", version: 1, token: "0".repeat(64) }, { type: "hello", version: 99, token: store.token() }]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin } }); await once(ws, "open");
    const close = once(ws, "close"); ws.send(JSON.stringify(hello)); const [code] = await close; assert.equal(code, 1008);
  }
});
test("parallel Pi servers allocate distinct ports and do not share attachments", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi-multi-")); const store = new CaptureStore(root);
  let countA = 0, countB = 0;
  const sidA = randomUUID(), sidB = randomUUID();
  const a = new BridgeServer({ store, session: () => ({ sessionId: sidA, name: "A", cwd: root, busy: false }), attach: () => countA++, ports: [0] });
  const portA = await a.start();
  const b = new BridgeServer({ store, session: () => ({ sessionId: sidB, name: "B", cwd: root, busy: true }), attach: () => countB++, ports: [portA, 0] });
  const portB = await b.start();
  t.after(async () => { await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); });
  assert.notEqual(portA, portB);
  const { ws, welcome } = await connect(portB, store.token()); t.after(() => ws.terminate());
  const reply = receive(ws); ws.send(JSON.stringify({ type: "capture", version: 1, instanceId: welcome.session.instanceId, sessionId: sidB, capture: capture() }));
  await reply; assert.equal(countA, 0); assert.equal(countB, 1);
});
