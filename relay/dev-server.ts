/**
 * The relay running on Node, for tests and for trying things locally:
 *
 *   node relay/dev-server.ts        (listens on http://127.0.0.1:8787)
 *   nusacode, then: /remote relay http://127.0.0.1:8787
 *
 * It runs the same Worker and Room code as Cloudflare does, with a small adapter in place of the
 * Durable Object runtime. It speaks plain HTTP, so use it only on this computer.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as NodeSocket } from "ws";
import worker from "./src/index.ts";
import { RelayRoom, type Platform } from "./src/room.ts";
import type { DurableObjectState, Env, RelaySocket } from "./src/types.d.ts";

/** A relay socket backed by a `ws` socket that may not exist yet (the room sends before the upgrade completes). */
class DevSocket implements RelaySocket {
  tags: string[] = [];
  private attachment: unknown = null;
  private ws: NodeSocket | null = null;
  private queued: (string | Uint8Array)[] = [];
  private closing: { code?: number; reason?: string } | null = null;

  attach(ws: NodeSocket, room: RelayRoom): void {
    this.ws = ws;
    for (const data of this.queued) ws.send(data);
    this.queued = [];
    if (this.closing) return void ws.close(this.closing.code, this.closing.reason);
    ws.on("message", (data, isBinary) => {
      const message = isBinary ? new Uint8Array(data as Buffer).slice().buffer : data.toString();
      room.webSocketMessage(this, message as string | ArrayBuffer);
    });
    ws.on("close", (code, reason) => room.webSocketClose(this, code, reason.toString()));
    ws.on("error", () => room.webSocketError(this));
  }

  send(data: string | ArrayBuffer | Uint8Array): void {
    const out = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (this.ws) this.ws.send(out);
    else this.queued.push(out);
  }

  close(code?: number, reason?: string): void {
    if (this.ws) this.ws.close(code, reason);
    else this.closing = { code, reason };
  }

  serializeAttachment(value: unknown): void {
    this.attachment = value;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  get open(): boolean {
    return this.ws === null || this.ws.readyState === 1;
  }
}

function newRoom() {
  const sockets = new Set<DevSocket>();
  const storage = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const state: DurableObjectState = {
    storage: {
      get: async <T>(key: string) => storage.get(key) as T | undefined,
      put: async (key, value) => void storage.set(key, value),
      setAlarm: async (time) => void (alarmAt = time),
      deleteAll: async () => storage.clear(),
    },
    acceptWebSocket: (socket, tags = []) => {
      (socket as DevSocket).tags = tags;
      sockets.add(socket as DevSocket);
    },
    getWebSockets: (tag) => [...sockets].filter((socket) => socket.open && (!tag || socket.tags.includes(tag))),
  };
  return { room: new RelayRoom(state), sockets, alarmAt: () => alarmAt };
}

export type DevRelay = { url: string; port: number; close(): Promise<void> };

export async function startDevRelay(port = 0): Promise<DevRelay> {
  const rooms = new Map<string, ReturnType<typeof newRoom>>();
  const upgrades = new WebSocketServer({ noServer: true });
  let pendingSocket: DevSocket | null = null;

  const platform: Platform = {
    makePair() {
      pendingSocket = new DevSocket();
      return { client: pendingSocket, server: pendingSocket };
    },
    upgraded: () => ({ status: 101 }) as unknown as Response,
  };

  const env = {
    ROOMS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (request: Request) => {
          const key = String(id);
          if (!rooms.has(key)) rooms.set(key, newRoom());
          return rooms.get(key)!.room.fetch(request, platform);
        },
      }),
    },
  } as unknown as Env;

  const toRequest = (req: IncomingMessage, origin: string) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers });
  };

  const server: Server = createServer(async (req, res) => {
    const response = await worker.fetch(toRequest(req, `http://${req.headers.host}`), env);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => (headers[name] = value));
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    pendingSocket = null;
    const response = await worker.fetch(toRequest(req, `http://${req.headers.host}`), env);
    const opened = pendingSocket as DevSocket | null;
    if (response.status !== 101 || !opened) {
      socket.write(`HTTP/1.1 ${response.status} ${response.statusText || "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? "/", "http://x");
    const room = rooms.get(url.pathname.split("/").filter(Boolean)[1])!.room;
    upgrades.handleUpgrade(req, socket, head, (ws) => opened.attach(ws, room));
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of upgrades.clients) client.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("relay/dev-server.ts")) {
  const relay = await startDevRelay(Number(process.env.PORT) || 8787);
  console.log(`NusaCode dev relay on ${relay.url}`);
}
