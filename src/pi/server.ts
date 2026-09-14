import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { VERSION, FIRST_PORT, LAST_PORT, MAX_WIRE_BYTES, type SessionInfo, type ServerMessage, validateCapture } from "../shared/protocol.js";
import { CaptureStore, type SavedCapture } from "./store.js";

const extensionOrigin = (origin: string | undefined): boolean => !!origin && /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/.test(origin);
export interface BridgeOptions {
  store: CaptureStore;
  session: () => Omit<SessionInfo, "instanceId">;
  attach: (saved: SavedCapture) => void;
  ports?: number[];
}
export class BridgeServer {
  readonly instanceId = randomUUID();
  private server?: WebSocketServer;
  private httpServer?: Server;
  private connections = new Set<Socket>();
  private closing?: Promise<void>;
  private authenticated = new Set<WebSocket>();
  private active = false;
  port = 0;
  constructor(private options: BridgeOptions) {}
  info(): SessionInfo { return { ...this.options.session(), instanceId: this.instanceId }; }
  async start(): Promise<number> {
    await this.closing;
    const token = this.options.store.token();
    const ports = this.options.ports ?? Array.from({ length: LAST_PORT - FIRST_PORT + 1 }, (_, i) => FIRST_PORT + i);
    for (const port of ports) {
      const httpServer = createServer((_req, res) => {
        res.writeHead(426, { "Content-Type": "text/plain" });
        res.end("Upgrade Required");
      });
      // Track TCP connections before upgrade, including incomplete browser handshakes.
      httpServer.on("connection", socket => {
        this.connections.add(socket);
        socket.once("close", () => this.connections.delete(socket));
      });
      const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_WIRE_BYTES, perMessageDeflate: false, verifyClient: ({ origin }: { origin: string }) => extensionOrigin(origin) });
      try {
        await new Promise<void>((resolve, reject) => {
          wss.once("listening", resolve);
          wss.once("error", reject);
          httpServer.listen(port, "127.0.0.1");
        });
      } catch (error: any) {
        wss.close();
        httpServer.close();
        if (error.code === "EADDRINUSE") continue;
        throw error;
      }
      this.server = wss;
      this.httpServer = httpServer;
      this.port = (wss.address() as { port: number }).port;
      this.active = true;
      wss.on("error", () => {});
      wss.on("connection", socket => {
        const timer = setTimeout(() => socket.close(1008, "Authentication timeout"), 3000);
        timer.unref();
        socket.on("error", () => {});
        socket.on("close", () => { clearTimeout(timer); this.authenticated.delete(socket); });
        socket.on("message", (data, binary) => {
          let id: string | undefined;
          try {
            if (!this.active || binary) throw new Error("Unsupported message");
            const msg = JSON.parse(data.toString());
            if (!this.authenticated.has(socket)) {
              const supplied = typeof msg?.token === "string" ? Buffer.from(msg.token) : Buffer.alloc(0);
              if (msg?.type !== "hello" || msg.version !== VERSION || supplied.length !== Buffer.byteLength(token) || !timingSafeEqual(supplied, Buffer.from(token))) { socket.close(1008, "Pairing failed"); return; }
              clearTimeout(timer);
              this.authenticated.add(socket);
              this.send(socket, { type: "welcome", version: VERSION, session: this.info() });
              return;
            }
            if (msg?.type === "ping") { this.send(socket, { type: "pong" }); this.send(socket, { type: "session", session: this.info() }); return; }
            if (msg?.type !== "capture" || msg.version !== VERSION) throw new Error("Unsupported protocol message");
            id = typeof msg.capture?.id === "string" ? msg.capture.id.slice(0, 64) : undefined;
            const session = this.info();
            if (msg.instanceId !== this.instanceId || msg.sessionId !== session.sessionId) { this.send(socket, { type: "error", id, code: "SESSION_CHANGED", message: "目标会话已变化，请重新选择。" }); return; }
            validateCapture(msg.capture);
            const { saved, duplicate } = this.options.store.save(session.sessionId, msg.capture);
            // Synchronous commit: no session switch can occur between validation, persistence and editor update.
            if (!duplicate) {
              try { this.options.attach(saved); }
              catch (error) { this.options.store.remove(session.sessionId, saved.id); throw error; }
            }
            this.send(socket, { type: "ack", id: saved.id, duplicate });
          } catch (error) {
            this.send(socket, { type: "error", id, code: "INVALID_CAPTURE", message: error instanceof Error ? error.message : "Attachment failed" });
          }
        });
      });
      return this.port;
    }
    throw new Error(`Pi Browser Capture 端口 ${FIRST_PORT}–${LAST_PORT} 均被占用`);
  }
  private send(socket: WebSocket, message: ServerMessage) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
  broadcast() { if (this.active) for (const socket of this.authenticated) this.send(socket, { type: "session", session: this.info() }); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.active = false;
    const server = this.server;
    const httpServer = this.httpServer;
    this.server = undefined;
    this.httpServer = undefined;
    if (!server || !httpServer) return Promise.resolve();
    // Stop accepting connections before destroying both upgraded and raw sockets.
    const closed = Promise.all([
      new Promise<void>(resolve => server.close(() => resolve())),
      new Promise<void>(resolve => {
        // Bun can omit the HTTP close callback after a WebSocket upgrade.
        // Connections are forcibly released below; do not hold host shutdown
        // hostage to that callback (omp allows only 2000ms per handler).
        const timer = setTimeout(() => { httpServer.unref(); resolve(); }, 500);
        httpServer.close(() => { clearTimeout(timer); resolve(); });
      }),
    ]);
    for (const socket of server.clients) socket.terminate();
    for (const socket of this.connections) socket.destroy();
    httpServer.closeAllConnections();
    this.connections.clear();
    this.authenticated.clear();
    this.closing = closed.then(() => {}).finally(() => { this.closing = undefined; });
    return this.closing;
  }
}
